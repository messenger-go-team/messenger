import { isValidOutgoingMessage, isValidUuid } from '../protocol'
import {
  MESSENGER_PROTOCOL,
  type ErrorPayload,
  type MessageAckEvent,
  type MessageNewEvent,
  type MessageSendEvent,
  type WebSocketCloseEventLike,
  type WebSocketFactory,
  type WebSocketLike,
  type WebSocketMessageEventLike,
} from '../types'

const CONNECTING = 0
const OPEN = 1
const CLOSING = 2
const CLOSED = 3

interface StoredMockMessage {
  chatId: string
  clientMsgId: string
  messageId: string
  senderId: string
  seq: number
  body: string
  createdAt: string
}

export interface MockWebSocketServerOptions {
  senderId: string
  now?: () => Date
  createId?: () => string
  expectedAccessToken?: string
  ackDelayMs?: number
  newDelayMs?: number
  dropAcks?: number
}

export class MockWebSocketServer {
  readonly webSocketFactory: WebSocketFactory
  readonly connections = new Set<MockWebSocket>()
  readonly received: MessageSendEvent[] = []
  private readonly senderId: string
  private readonly now: () => Date
  private readonly createId: () => string
  private readonly expectedAccessToken?: string
  private readonly messages = new Map<string, StoredMockMessage>()
  private readonly nextSequence = new Map<string, number>()
  private ackDelayMs: number
  private newDelayMs: number
  private dropAcks: number
  private queuedError: ErrorPayload | null = null

  constructor(options: MockWebSocketServerOptions) {
    this.senderId = options.senderId
    this.now = options.now ?? (() => new Date())
    this.createId = options.createId ?? crypto.randomUUID.bind(crypto)
    this.expectedAccessToken = options.expectedAccessToken
    this.ackDelayMs = options.ackDelayMs ?? 0
    this.newDelayMs = options.newDelayMs ?? 0
    this.dropAcks = options.dropAcks ?? 0
    this.webSocketFactory = (url, protocols) => this.connect(url, protocols)
  }

  setAckDelay(delayMs: number): void {
    this.ackDelayMs = delayMs
  }

  setNewDelay(delayMs: number): void {
    this.newDelayMs = delayMs
  }

  dropNextAcks(count = 1): void {
    this.dropAcks += count
  }

  failNextCommand(payload: ErrorPayload): void {
    this.queuedError = payload
  }

  disconnectAll(code = 1013, reason = 'mock disconnect'): void {
    for (const connection of Array.from(this.connections)) connection.serverClose(code, reason)
  }

  get storedMessages(): readonly StoredMockMessage[] {
    return Array.from(this.messages.values())
  }

  private connect(url: string, protocols: string[]): MockWebSocket {
    const socket = new MockWebSocket(this, url, protocols)
    this.connections.add(socket)
    queueMicrotask(() => {
      const bearer = protocols.filter((protocol) => protocol.startsWith('bearer.'))
      const tokenAccepted =
        this.expectedAccessToken === undefined || bearer[0] === `bearer.${this.expectedAccessToken}`
      if (
        protocols.filter((protocol) => protocol === MESSENGER_PROTOCOL).length !== 1 ||
        bearer.length !== 1 ||
        !tokenAccepted
      ) {
        socket.failHandshake()
        return
      }
      socket.serverOpen()
    })
    return socket
  }

  receive(socket: MockWebSocket, data: string): void {
    let event: unknown
    try {
      event = JSON.parse(data)
    } catch {
      this.sendError(socket, this.createId(), {
        code: 'invalid_json',
        message: 'Invalid JSON',
        retryable: false,
        request_type: null,
        client_msg_id: null,
      })
      return
    }
    if (!this.isMessageSend(event)) {
      this.sendError(socket, this.createId(), {
        code: 'invalid_payload',
        message: 'Invalid message.send',
        retryable: false,
        request_type: null,
        client_msg_id: null,
      })
      return
    }
    this.received.push(event)
    if (this.queuedError) {
      const payload = this.queuedError
      this.queuedError = null
      this.sendError(socket, event.id, {
        ...payload,
        client_msg_id: payload.client_msg_id ?? event.payload.client_msg_id,
      })
      return
    }

    const key = `${this.senderId}:${event.payload.chat_id}:${event.payload.client_msg_id}`
    const existing = this.messages.get(key)
    if (existing && existing.body !== event.payload.body) {
      this.sendError(socket, event.id, {
        code: 'idempotency_conflict',
        message: 'client_msg_id is already associated with another body',
        retryable: false,
        request_type: 'message.send',
        client_msg_id: event.payload.client_msg_id,
      })
      return
    }

    const stored = existing ?? this.storeMessage(event)
    if (this.dropAcks > 0) this.dropAcks--
    else {
      const ack: MessageAckEvent = {
        type: 'message.ack',
        id: event.id,
        ts: this.now().toISOString(),
        payload: {
          chat_id: stored.chatId,
          client_msg_id: stored.clientMsgId,
          message_id: stored.messageId,
          seq: stored.seq,
          created_at: stored.createdAt,
        },
      }
      setTimeout(() => socket.serverMessage(JSON.stringify(ack)), this.ackDelayMs)
    }
    if (!existing) {
      const message: MessageNewEvent = {
        type: 'message.new',
        id: this.createId(),
        ts: this.now().toISOString(),
        payload: {
          chat_id: stored.chatId,
          client_msg_id: stored.clientMsgId,
          message_id: stored.messageId,
          sender_id: stored.senderId,
          seq: stored.seq,
          body: stored.body,
          created_at: stored.createdAt,
        },
      }
      setTimeout(() => {
        for (const connection of this.connections) {
          if (connection.readyState === OPEN) connection.serverMessage(JSON.stringify(message))
        }
      }, this.newDelayMs)
    }
  }

  remove(socket: MockWebSocket): void {
    this.connections.delete(socket)
  }

  private storeMessage(event: MessageSendEvent): StoredMockMessage {
    const chatId = event.payload.chat_id
    const seq = (this.nextSequence.get(chatId) ?? 0) + 1
    this.nextSequence.set(chatId, seq)
    const stored: StoredMockMessage = {
      chatId,
      clientMsgId: event.payload.client_msg_id,
      messageId: this.createId(),
      senderId: this.senderId,
      seq,
      body: event.payload.body,
      createdAt: this.now().toISOString(),
    }
    this.messages.set(`${this.senderId}:${chatId}:${stored.clientMsgId}`, stored)
    return stored
  }

  private sendError(socket: MockWebSocket, id: string, payload: ErrorPayload): void {
    socket.serverMessage(
      JSON.stringify({ type: 'error', id, ts: this.now().toISOString(), payload }),
    )
  }

  private isMessageSend(value: unknown): value is MessageSendEvent {
    if (typeof value !== 'object' || value === null) return false
    const event = value as Partial<MessageSendEvent>
    const envelopeKeys = Object.keys(value).sort()
    const payloadKeys = event.payload ? Object.keys(event.payload).sort() : []
    return (
      JSON.stringify(envelopeKeys) === JSON.stringify(['id', 'payload', 'ts', 'type']) &&
      JSON.stringify(payloadKeys) === JSON.stringify(['body', 'chat_id', 'client_msg_id']) &&
      event.type === 'message.send' &&
      typeof event.id === 'string' &&
      isValidUuid(event.id) &&
      typeof event.ts === 'string' &&
      Number.isFinite(Date.parse(event.ts)) &&
      event.payload !== undefined &&
      isValidOutgoingMessage(event.payload)
    )
  }
}

export class MockWebSocket implements WebSocketLike {
  readyState = CONNECTING
  protocol = ''
  onopen: (() => void) | null = null
  onmessage: ((event: WebSocketMessageEventLike) => void) | null = null
  onerror: (() => void) | null = null
  onclose: ((event: WebSocketCloseEventLike) => void) | null = null
  private readonly server: MockWebSocketServer
  readonly url: string
  readonly protocols: readonly string[]

  constructor(server: MockWebSocketServer, url: string, protocols: readonly string[]) {
    this.server = server
    this.url = url
    this.protocols = protocols
  }

  send(data: string): void {
    if (this.readyState !== OPEN) throw new Error('Mock WebSocket is not open')
    this.server.receive(this, data)
  }

  close(code = 1000, reason = ''): void {
    if (code === 1006) throw new Error('1006 is a reserved close code')
    if (this.readyState === CLOSED) return
    this.readyState = CLOSING
    queueMicrotask(() => this.finishClose(code, reason, true))
  }

  serverOpen(): void {
    if (this.readyState !== CONNECTING) return
    this.readyState = OPEN
    this.protocol = MESSENGER_PROTOCOL
    this.onopen?.()
  }

  serverMessage(data: string): void {
    if (this.readyState === OPEN) this.onmessage?.({ data })
  }

  serverClose(code: number, reason: string): void {
    if (this.readyState === CLOSED) return
    this.readyState = CLOSING
    this.finishClose(code, reason, code === 1000)
  }

  failHandshake(): void {
    if (this.readyState !== CONNECTING) return
    this.onerror?.()
    this.finishClose(1006, '', false)
  }

  private finishClose(code: number, reason: string, wasClean: boolean): void {
    this.readyState = CLOSED
    this.server.remove(this)
    this.onclose?.({ code, reason, wasClean })
  }
}
