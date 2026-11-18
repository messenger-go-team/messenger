import {
  createMessageSendEvent,
  isValidOutgoingMessage,
  isValidUuid,
  parseServerMessage,
  serializeClientEvent,
} from './protocol'
import { ExponentialBackoff } from './reconnect'
import {
  MESSENGER_PROTOCOL,
  type AuthFailureReason,
  type AuthAdapter,
  type ErrorEvent,
  type HistoryAdapter,
  type HistoryMessage,
  type HistorySyncState,
  type KnownServerEvent,
  type MessageAckEvent,
  type MessageNewEvent,
  type PendingMessage,
  type ProtocolIssue,
  type StoredMessage,
  type TransportState,
  type UnknownServerEvent,
  type WebSocketClientSnapshot,
  type WebSocketFactory,
  type WebSocketLike,
} from './types'

const OPEN = 1
const HISTORY_SYNC_INTERVAL_MS = 30_000
const NON_RETRYABLE_PROTOCOL_CLOSES = new Set([1000, 1002, 1003, 1007, 1009])

function accessTokenExpiresAt(token: string): number | null {
  try {
    const parts = token.split('.')
    if (parts.length !== 3) return null
    const payload = parts[1]
    if (!payload || !/^[A-Za-z0-9_-]+$/.test(payload) || payload.length % 4 === 1) return null

    const base64 = payload.replace(/-/g, '+').replace(/_/g, '/')
    const paddedBase64 = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '=')
    const binary = atob(paddedBase64)
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0))
    const decoded: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))

    if (
      typeof decoded !== 'object' ||
      decoded === null ||
      Array.isArray(decoded) ||
      !('exp' in decoded)
    ) {
      return null
    }

    const expiresAt = decoded.exp

    return typeof expiresAt === 'number' && Number.isFinite(expiresAt) ? expiresAt : null
  } catch {
    return null
  }
}

function isAccessTokenExpired(token: string): boolean {
  const expiresAt = accessTokenExpiresAt(token)
  return expiresAt !== null && expiresAt <= Date.now() / 1000
}

export interface WebSocketClientOptions {
  wsOrigin?: string
  accessToken: string
  currentUserId: string
  webSocketFactory?: WebSocketFactory
  auth?: AuthAdapter
  history?: HistoryAdapter
  createId?: () => string
  now?: () => Date
  random?: () => number
  ackTimeoutMs?: number
  stableConnectionMs?: number
  maxAutomaticAttempts?: number
  /** @deprecated Retained for compatibility; temporary failures retry until success or stop. */
  maxRefreshAttempts?: number
  onServerEvent?: (event: KnownServerEvent) => void
  onUnknownEvent?: (event: UnknownServerEvent) => void
  onProtocolIssue?: (issue: ProtocolIssue) => void
}

interface MutablePending extends PendingMessage {
  retryTimer?: ReturnType<typeof setTimeout>
  ackTimer?: ReturnType<typeof setTimeout>
  retryBackoff: ExponentialBackoff
  automaticRetry: boolean
  sending: boolean
  inFlightEnvelopeId?: string
  sentEnvelopeIds: Set<string>
}

function defaultFactory(url: string, protocols: string[]): WebSocketLike {
  return new WebSocket(url, protocols) as unknown as WebSocketLike
}

function defaultWsOrigin(): string {
  const configured = import.meta.env.VITE_WS_ORIGIN as string | undefined
  if (configured) return configured.replace(/\/+$/, '')
  const scheme = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${scheme}//${window.location.host}`
}

function clonePending(message: MutablePending): PendingMessage {
  return {
    chatId: message.chatId,
    clientMsgId: message.clientMsgId,
    body: message.body,
    status: message.status,
    attempts: message.attempts,
    messageId: message.messageId,
    seq: message.seq,
    createdAt: message.createdAt,
    errorCode: message.errorCode,
  }
}

export class MessengerWebSocketClient {
  private readonly wsOrigin: string
  private accessToken: string
  private readonly currentUserId: string
  private readonly webSocketFactory: WebSocketFactory
  private readonly auth?: AuthAdapter
  private readonly history?: HistoryAdapter
  private readonly createId: () => string
  private readonly now: () => Date
  private readonly random: () => number
  private readonly ackTimeoutMs: number
  private readonly stableConnectionMs: number
  private readonly maxAutomaticAttempts: number
  private readonly onServerEvent?: (event: KnownServerEvent) => void
  private readonly onUnknownEvent?: (event: UnknownServerEvent) => void
  private readonly onProtocolIssue?: (issue: ProtocolIssue) => void
  private readonly reconnectBackoff: ExponentialBackoff
  private readonly historyRetryBackoff: ExponentialBackoff
  private readonly listeners = new Set<(snapshot: WebSocketClientSnapshot) => void>()
  private readonly pending = new Map<string, MutablePending>()
  private readonly messagesById = new Map<string, StoredMessage>()
  private readonly messageIdBySequence = new Map<string, string>()
  private readonly syncedCursors = new Map<string, number>()
  private socket: WebSocketLike | null = null
  private transport: TransportState = 'idle'
  private historyState: HistorySyncState = 'not_started'
  private recoveringHistory = false
  private authFailure: AuthFailureReason | undefined
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private stableTimer: ReturnType<typeof setTimeout> | null = null
  private generation = 0
  private stopped = false
  private refreshPromise: Promise<void> | null = null
  private refreshGuard = false
  private refreshedTokenLifetime: { accessToken: string; expiresAt: number } | null = null
  private historyGeneration = 0
  private historyPromise: Promise<void> | null = null
  private historyRetryTimer: ReturnType<typeof setTimeout> | null = null
  private historyPeriodicTimer: ReturnType<typeof setTimeout> | null = null
  private visibilityDocument: Document | null = null
  private bufferingMessages = false
  private bufferedMessages: MessageNewEvent[] = []
  private readonly handleVisibilityChange = (): void => {
    if (this.stopped || !this.history) return
    if (!this.isPageVisible()) {
      this.clearHistoryPeriodicTimer()
      return
    }
    if (this.canSynchronizeVisibleHistory()) void this.synchronizeHistory()
  }

  constructor(options: WebSocketClientOptions) {
    if (!isValidUuid(options.currentUserId)) throw new Error('currentUserId must be a UUID')
    this.wsOrigin = (options.wsOrigin ?? defaultWsOrigin()).replace(/\/+$/, '')
    this.accessToken = options.accessToken
    this.currentUserId = options.currentUserId
    this.webSocketFactory = options.webSocketFactory ?? defaultFactory
    this.auth = options.auth
    this.history = options.history
    this.createId = options.createId ?? crypto.randomUUID.bind(crypto)
    this.now = options.now ?? (() => new Date())
    this.random = options.random ?? Math.random
    this.ackTimeoutMs = options.ackTimeoutMs ?? 10_000
    this.stableConnectionMs = options.stableConnectionMs ?? 30_000
    this.maxAutomaticAttempts = options.maxAutomaticAttempts ?? 5
    this.onServerEvent = options.onServerEvent
    this.onUnknownEvent = options.onUnknownEvent
    this.onProtocolIssue = options.onProtocolIssue
    this.reconnectBackoff = new ExponentialBackoff({ random: this.random })
    this.historyRetryBackoff = new ExponentialBackoff({ random: this.random })
  }

  start(): void {
    if (this.stopped) return
    this.attachVisibilityListener()
    if (
      this.socket ||
      this.refreshPromise ||
      this.reconnectTimer !== null ||
      (this.transport !== 'idle' && this.transport !== 'disconnected')
    )
      return
    this.openSocket(this.transport === 'disconnected')
  }

  stop(): void {
    if (this.stopped) return
    this.stopped = true
    this.generation++
    this.historyGeneration++
    this.historyPromise = null
    this.clearReconnectTimer()
    this.clearHistoryRetryTimer()
    this.clearHistoryPeriodicTimer()
    this.clearStableTimer()
    this.clearPendingTimers()
    this.bufferingMessages = false
    this.bufferedMessages = []
    this.detachVisibilityListener()
    const socket = this.socket
    this.socket = null
    if (socket) {
      if (socket.readyState !== 3) socket.close(1000, 'client stopped')
      socket.onopen = null
      socket.onmessage = null
      socket.onerror = null
      socket.onclose = null
    }
    this.setTransport('stopped')
    this.listeners.clear()
  }

  subscribe(listener: (snapshot: WebSocketClientSnapshot) => void): () => void {
    this.listeners.add(listener)
    listener(this.getSnapshot())
    return () => this.listeners.delete(listener)
  }

  getSnapshot(): WebSocketClientSnapshot {
    return {
      transport: this.transport,
      history: this.historyState,
      authFailure: this.authFailure,
      pending: Array.from(this.pending.values(), clonePending),
      messages: Array.from(this.messagesById.values()).sort(
        (left, right) => left.chat_id.localeCompare(right.chat_id) || left.seq - right.seq,
      ),
    }
  }

  getSyncedCursor(chatId: string): number {
    return this.syncedCursors.get(chatId) ?? 0
  }

  sendMessage(chatId: string, body: string, clientMsgId = this.createId()): PendingMessage {
    if (this.stopped) throw new Error('WebSocket client is stopped')
    const existing = this.pending.get(clientMsgId)
    if (existing) {
      if (existing.chatId !== chatId || existing.body !== body) {
        throw new Error('client_msg_id is already associated with another message')
      }
      if (existing.status === 'failed') this.retryMessage(clientMsgId)
      return clonePending(existing)
    }

    const payload = { chat_id: chatId, client_msg_id: clientMsgId, body }
    if (!isValidOutgoingMessage(payload)) throw new Error('Invalid message.send payload')

    const pending: MutablePending = {
      chatId,
      clientMsgId,
      body,
      status: 'pending',
      attempts: 0,
      retryBackoff: new ExponentialBackoff({ random: this.random }),
      automaticRetry: true,
      sending: false,
      sentEnvelopeIds: new Set(),
    }
    this.pending.set(clientMsgId, pending)
    this.emit()
    this.dispatchPending(pending)
    return clonePending(pending)
  }

  retryMessage(clientMsgId: string): void {
    if (this.stopped) return
    const pending = this.pending.get(clientMsgId)
    if (!pending || pending.status !== 'failed') return
    pending.status = 'pending'
    pending.errorCode = undefined
    pending.automaticRetry = true
    pending.attempts = 0
    pending.retryBackoff.reset()
    this.clearMessageTimers(pending)
    this.emit()
    this.dispatchPending(pending)
  }

  synchronizeHistory(): Promise<void> {
    this.clearHistoryRetryTimer()
    this.clearHistoryPeriodicTimer()
    if (this.historyPromise) return this.historyPromise
    const promise = this.runHistorySync().finally(() => {
      if (this.historyPromise === promise) this.historyPromise = null
    })
    this.historyPromise = promise
    return promise
  }

  private openSocket(reconnecting: boolean): void {
    if (this.stopped || this.socket) return
    this.clearReconnectTimer()
    this.setTransport(reconnecting ? 'reconnecting' : 'connecting')
    if (this.stopped) return
    const generation = ++this.generation
    let socket: WebSocketLike
    try {
      socket = this.webSocketFactory(`${this.wsOrigin}/ws`, [
        MESSENGER_PROTOCOL,
        `bearer.${this.accessToken}`,
      ])
    } catch {
      this.scheduleReconnect()
      if (!this.stopped) this.setTransport('disconnected')
      return
    }
    this.socket = socket

    socket.onopen = () => {
      if (!this.isCurrent(socket, generation)) return
      if (socket.protocol !== MESSENGER_PROTOCOL) {
        socket.close(1000, 'unexpected subprotocol')
        return
      }
      // A replacement socket must catch up with History before sending queued messages.
      this.recoveringHistory = reconnecting && this.history !== undefined
      this.authFailure = undefined
      this.setTransport('connected')
      if (!this.isCurrent(socket, generation)) return
      this.clearStableTimer()
      this.stableTimer = setTimeout(() => {
        this.reconnectBackoff.reset()
        this.refreshGuard = false
        this.refreshedTokenLifetime = null
      }, this.stableConnectionMs)
      if (this.history) void this.synchronizeHistory()
      else this.resendPendingAfterReconnect()
    }

    socket.onmessage = (event) => {
      if (!this.isCurrent(socket, generation)) return
      this.handleIncoming(event.data)
    }

    socket.onerror = () => {
      // Browser WebSocket intentionally hides handshake status and response body.
    }

    socket.onclose = (event) => {
      if (!this.isCurrent(socket, generation)) return
      this.socket = null
      this.clearStableTimer()
      const shouldRefresh =
        event.code === 4401 || (event.code === 1006 && isAccessTokenExpired(this.accessToken))
      const shouldReconnect = !NON_RETRYABLE_PROTOCOL_CLOSES.has(event.code)
      // ACK timers belong to the old socket. Send backoff survives a recoverable close.
      this.clearPendingTimers(shouldRefresh || shouldReconnect)
      this.historyGeneration++
      this.historyPromise = null
      this.clearHistoryRetryTimer()
      this.clearHistoryPeriodicTimer()
      const historyWasSyncing = this.historyState === 'syncing'
      if (this.bufferingMessages) this.commitBufferedMessages()
      if (historyWasSyncing) this.setHistoryState('error')
      if (this.stopped) return
      // Arm recovery before notifying subscribers that the socket is disconnected.
      if (shouldRefresh) void this.refreshAndReconnect()
      else if (shouldReconnect) this.scheduleReconnect()
      if (this.transport !== 'auth_failed') this.setTransport('disconnected')
    }
  }

  private isCurrent(socket: WebSocketLike, generation: number): boolean {
    return this.socket === socket && this.generation === generation
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer || this.socket) return
    const delay = this.reconnectBackoff.nextDelay()
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.openSocket(true)
    }, delay)
  }

  private async refreshAndReconnect(): Promise<void> {
    if (this.stopped) return
    const auth = this.auth
    if (!auth) {
      this.setAuthFailed('missing_refresh_adapter')
      return
    }
    if (this.refreshGuard && !this.hasRefreshedTokenNaturallyExpired()) {
      this.setAuthFailed('refreshed_token_rejected')
      return
    }
    if (this.refreshPromise) return this.refreshPromise
    const refreshPromise = (async () => {
      try {
        const result = await Promise.resolve().then(() => auth.refreshAccessToken())
        if (this.stopped) return
        if (result.kind === 'success') {
          this.accessToken = result.accessToken
          this.refreshGuard = true
          const expiresAt = accessTokenExpiresAt(result.accessToken)
          this.refreshedTokenLifetime =
            expiresAt !== null && expiresAt > Date.now() / 1000
              ? { accessToken: result.accessToken, expiresAt }
              : null
          this.scheduleReconnect()
        } else if (result.kind === 'temporary_failure') {
          this.scheduleRefreshRetry()
        } else {
          this.setAuthFailed('refresh_rejected')
        }
      } catch {
        if (!this.stopped) this.scheduleRefreshRetry()
      }
    })()
    this.refreshPromise = refreshPromise
    try {
      await refreshPromise
    } finally {
      if (this.refreshPromise === refreshPromise) this.refreshPromise = null
    }
  }

  private hasRefreshedTokenNaturallyExpired(): boolean {
    const lifetime = this.refreshedTokenLifetime
    return (
      lifetime !== null &&
      lifetime.accessToken === this.accessToken &&
      lifetime.expiresAt <= Date.now() / 1000
    )
  }

  private scheduleRefreshRetry(): void {
    if (this.stopped || this.reconnectTimer) {
      return
    }
    const delay = this.reconnectBackoff.nextDelay()
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      void this.refreshAndReconnect()
    }, delay)
  }

  private handleIncoming(data: unknown): void {
    const parsed = parseServerMessage(data)
    if (parsed.kind === 'invalid') {
      this.onProtocolIssue?.(parsed.issue)
      return
    }
    if (parsed.kind === 'unknown') {
      this.onUnknownEvent?.(parsed.event)
      return
    }
    this.onServerEvent?.(parsed.event)
    switch (parsed.event.type) {
      case 'message.ack':
        this.handleAck(parsed.event)
        break
      case 'message.new':
        this.handleNew(parsed.event)
        break
      case 'error':
        this.handleError(parsed.event)
        break
    }
  }

  private handleAck(event: MessageAckEvent): void {
    const pending = this.pending.get(event.payload.client_msg_id)
    if (
      !pending ||
      pending.chatId !== event.payload.chat_id ||
      !pending.sentEnvelopeIds.has(event.id)
    ) {
      return
    }
    this.markSent(pending, event.payload)
  }

  private handleNew(event: MessageNewEvent): void {
    const pending = this.pending.get(event.payload.client_msg_id)
    if (
      pending &&
      event.payload.sender_id === this.currentUserId &&
      pending.chatId === event.payload.chat_id
    ) {
      this.markSent(pending, event.payload)
    }
    if (this.bufferingMessages) this.bufferedMessages.push(event)
    else {
      this.mergeNew(event)
      this.emit()
    }
  }

  private handleError(event: ErrorEvent): void {
    const clientMsgId = event.payload.client_msg_id
    if (!clientMsgId || event.payload.request_type !== 'message.send') return
    const pending = this.pending.get(clientMsgId)
    if (!pending || pending.status === 'sent' || pending.inFlightEnvelopeId !== event.id) {
      return
    }
    this.clearMessageTimers(pending)
    pending.errorCode = event.payload.code
    if (event.payload.retryable && pending.automaticRetry) {
      this.scheduleMessageRetry(pending)
    } else {
      pending.status = 'failed'
      pending.automaticRetry = false
      this.emit()
    }
  }

  private markSent(
    pending: MutablePending,
    server: { message_id: string; seq: number; created_at: string },
  ): void {
    this.clearMessageTimers(pending)
    pending.status = 'sent'
    pending.automaticRetry = false
    pending.errorCode = undefined
    pending.messageId = server.message_id
    pending.seq = server.seq
    pending.createdAt = server.created_at
    this.emit()
  }

  private dispatchPending(pending: MutablePending): void {
    const socket = this.socket
    if (
      this.stopped ||
      !socket ||
      socket.readyState !== OPEN ||
      this.transport !== 'connected' ||
      this.recoveringHistory ||
      pending.status === 'sent' ||
      !pending.automaticRetry ||
      pending.sending ||
      pending.retryTimer !== undefined ||
      pending.ackTimer !== undefined
    ) {
      return
    }
    if (pending.attempts >= this.maxAutomaticAttempts) {
      pending.status = 'failed'
      pending.errorCode = 'retry_limit_reached'
      pending.automaticRetry = false
      this.emit()
      return
    }
    const event = createMessageSendEvent(
      { chat_id: pending.chatId, client_msg_id: pending.clientMsgId, body: pending.body },
      this.createId(),
      this.now().toISOString(),
    )
    pending.attempts++
    pending.sending = true
    pending.inFlightEnvelopeId = event.id
    pending.sentEnvelopeIds.add(event.id)
    try {
      socket.send(serializeClientEvent(event))
    } catch {
      pending.sending = false
      pending.sentEnvelopeIds.delete(event.id)
      if (pending.inFlightEnvelopeId === event.id) pending.inFlightEnvelopeId = undefined
      pending.errorCode = 'send_failed'
      this.emit()
      this.scheduleMessageRetry(pending)
      return
    }
    pending.sending = false
    if (
      pending.status === 'pending' &&
      pending.automaticRetry &&
      pending.inFlightEnvelopeId === event.id &&
      !pending.retryTimer
    ) {
      pending.errorCode = undefined
      pending.ackTimer = setTimeout(() => this.scheduleMessageRetry(pending), this.ackTimeoutMs)
    }
    this.emit()
  }

  private scheduleMessageRetry(pending: MutablePending): void {
    if (pending.status === 'sent' || !pending.automaticRetry || pending.retryTimer) return
    if (pending.ackTimer) clearTimeout(pending.ackTimer)
    pending.ackTimer = undefined
    if (pending.attempts >= this.maxAutomaticAttempts) {
      pending.status = 'failed'
      pending.errorCode = 'retry_limit_reached'
      pending.automaticRetry = false
      this.emit()
      return
    }
    const delay = pending.retryBackoff.nextDelay()
    pending.retryTimer = setTimeout(() => {
      pending.retryTimer = undefined
      this.dispatchPending(pending)
    }, delay)
  }

  private resendPendingAfterReconnect(): void {
    for (const pending of this.pending.values()) {
      if (pending.status !== 'sent' && pending.automaticRetry) this.dispatchPending(pending)
    }
  }

  private async runHistorySync(): Promise<void> {
    if (!this.history || this.stopped || this.transport !== 'connected') return
    const syncGeneration = ++this.historyGeneration
    this.bufferingMessages = true
    this.bufferedMessages = []
    this.setHistoryState('syncing')
    const stagedCursors = new Map(this.syncedCursors)
    try {
      const chats = await this.history.listChats(this.accessToken)
      if (syncGeneration !== this.historyGeneration || this.stopped) return
      for (const chat of chats) {
        let cursor = stagedCursors.get(chat.id) ?? 0
        let hasMore = true
        while (hasMore) {
          const page = await this.history.getMessages(chat.id, this.accessToken, {
            afterSeq: cursor,
            limit: 100,
          })
          if (syncGeneration !== this.historyGeneration || this.stopped) return
          for (const message of page.messages) this.mergeHistory(message)
          hasMore = page.has_more_after
          if (page.next_after_seq !== null) {
            if (page.next_after_seq <= cursor) throw new Error('History cursor did not advance')
            cursor = page.next_after_seq
          } else if (hasMore) {
            throw new Error('History returned has_more_after without next_after_seq')
          }
        }
        stagedCursors.set(chat.id, cursor)
      }
      if (syncGeneration !== this.historyGeneration || this.stopped) return
      this.commitBufferedMessages()
      this.syncedCursors.clear()
      for (const [chatId, cursor] of stagedCursors) this.syncedCursors.set(chatId, cursor)
      this.recoveringHistory = false
      this.setHistoryState('ready')
      this.historyRetryBackoff.reset()
      this.resendPendingAfterReconnect()
      this.scheduleHistoryPeriodicSync()
    } catch {
      if (syncGeneration !== this.historyGeneration || this.stopped) return
      this.commitBufferedMessages()
      this.setHistoryState('error')
      this.scheduleHistoryRetry()
    }
  }

  private scheduleHistoryRetry(): void {
    this.clearHistoryPeriodicTimer()
    if (this.historyRetryTimer || !this.canSynchronizeHistory()) return
    const retryGeneration = this.historyGeneration
    const delay = this.historyRetryBackoff.nextDelay()
    this.historyRetryTimer = setTimeout(() => {
      this.historyRetryTimer = null
      if (retryGeneration !== this.historyGeneration || !this.canSynchronizeHistory()) {
        return
      }
      void this.synchronizeHistory()
    }, delay)
  }

  private scheduleHistoryPeriodicSync(): void {
    this.clearHistoryPeriodicTimer()
    if (!this.canSynchronizeVisibleHistory()) return
    this.historyPeriodicTimer = setTimeout(() => {
      this.historyPeriodicTimer = null
      if (this.canSynchronizeVisibleHistory()) void this.synchronizeHistory()
    }, HISTORY_SYNC_INTERVAL_MS)
  }

  private canSynchronizeHistory(): boolean {
    return (
      !this.stopped &&
      Boolean(this.history) &&
      this.transport === 'connected' &&
      this.socket?.readyState === OPEN
    )
  }

  private canSynchronizeVisibleHistory(): boolean {
    return this.canSynchronizeHistory() && this.isPageVisible()
  }

  private isPageVisible(): boolean {
    if (this.visibilityDocument) return this.visibilityDocument.visibilityState === 'visible'
    if (typeof document === 'undefined') return true
    return document.visibilityState === 'visible'
  }

  private attachVisibilityListener(): void {
    if (!this.history || this.visibilityDocument || typeof document === 'undefined') return
    this.visibilityDocument = document
    this.visibilityDocument.addEventListener('visibilitychange', this.handleVisibilityChange)
  }

  private detachVisibilityListener(): void {
    if (!this.visibilityDocument) return
    this.visibilityDocument.removeEventListener('visibilitychange', this.handleVisibilityChange)
    this.visibilityDocument = null
  }

  private commitBufferedMessages(): void {
    const messages = this.bufferedMessages
    this.bufferedMessages = []
    this.bufferingMessages = false
    for (const event of messages) this.mergeNew(event)
    this.emit()
  }

  private mergeNew(event: MessageNewEvent): void {
    this.mergeMessage({
      id: event.payload.message_id,
      chat_id: event.payload.chat_id,
      client_msg_id: event.payload.client_msg_id,
      seq: event.payload.seq,
      sender_id: event.payload.sender_id,
      body: event.payload.body,
      created_at: event.payload.created_at,
    })
  }

  private mergeHistory(message: HistoryMessage): void {
    this.mergeMessage(message)
  }

  private mergeMessage(message: StoredMessage): void {
    const sequenceKey = `${message.chat_id}:${message.seq}`
    const existingBySequence = this.messageIdBySequence.get(sequenceKey)
    if (existingBySequence && existingBySequence !== message.id) return
    const existing = this.messagesById.get(message.id)
    if (existing) {
      this.messagesById.set(message.id, {
        ...message,
        client_msg_id: message.client_msg_id ?? existing.client_msg_id,
      })
      return
    }
    this.messagesById.set(message.id, message)
    this.messageIdBySequence.set(sequenceKey, message.id)
  }

  private clearMessageTimers(pending: MutablePending, preserveRetry = false): void {
    if (pending.ackTimer) clearTimeout(pending.ackTimer)
    pending.ackTimer = undefined
    pending.sending = false
    if (!preserveRetry && pending.retryTimer !== undefined) {
      clearTimeout(pending.retryTimer)
      pending.retryTimer = undefined
    }
  }

  private clearPendingTimers(preserveRetries = false): void {
    for (const pending of this.pending.values()) this.clearMessageTimers(pending, preserveRetries)
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
  }

  private clearHistoryRetryTimer(): void {
    if (this.historyRetryTimer) clearTimeout(this.historyRetryTimer)
    this.historyRetryTimer = null
  }

  private clearHistoryPeriodicTimer(): void {
    if (this.historyPeriodicTimer) clearTimeout(this.historyPeriodicTimer)
    this.historyPeriodicTimer = null
  }

  private clearStableTimer(): void {
    if (this.stableTimer) clearTimeout(this.stableTimer)
    this.stableTimer = null
  }

  private setTransport(state: TransportState): void {
    if (this.transport === state) return
    this.transport = state
    this.emit()
  }

  private setHistoryState(state: HistorySyncState): void {
    if (this.historyState === state) return
    this.historyState = state
    this.emit()
  }

  private setAuthFailed(reason: AuthFailureReason): void {
    this.clearReconnectTimer()
    this.clearStableTimer()
    this.clearPendingTimers()
    this.authFailure = reason
    this.setTransport('auth_failed')
  }

  private emit(): void {
    const snapshot = this.getSnapshot()
    for (const listener of this.listeners) listener(snapshot)
  }
}
