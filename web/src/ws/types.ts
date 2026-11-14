export const MESSENGER_PROTOCOL = 'messenger.v1'

export type TransportState =
  'idle' | 'connecting' | 'connected' | 'reconnecting' | 'disconnected' | 'auth_failed' | 'stopped'

export type AuthFailureReason =
  | 'missing_refresh_adapter'
  | 'refresh_rejected'
  | 'refresh_retry_exhausted'
  | 'refreshed_token_rejected'

export type HistorySyncState = 'not_started' | 'syncing' | 'ready' | 'error'

export interface Envelope<TType extends string, TPayload extends object> {
  type: TType
  id: string
  ts: string
  payload: TPayload
}

export interface MessageSendPayload {
  chat_id: string
  client_msg_id: string
  body: string
}

export type MessageSendEvent = Envelope<'message.send', MessageSendPayload>

export interface MessageAckPayload {
  chat_id: string
  client_msg_id: string
  message_id: string
  seq: number
  created_at: string
}

export type MessageAckEvent = Envelope<'message.ack', MessageAckPayload>

export interface MessageNewPayload extends MessageAckPayload {
  sender_id: string
  body: string
}

export type MessageNewEvent = Envelope<'message.new', MessageNewPayload>

export interface ErrorPayload {
  code: string
  message: string
  retryable: boolean
  request_type: string | null
  client_msg_id: string | null
}

export type ErrorEvent = Envelope<'error', ErrorPayload>
export type KnownServerEvent = MessageAckEvent | MessageNewEvent | ErrorEvent

export type UnknownServerEvent = Envelope<string, Record<string, unknown>>

export interface HistoryMessage {
  id: string
  chat_id: string
  seq: number
  sender_id: string
  body: string
  created_at: string
}

export interface HistoryPage {
  messages: HistoryMessage[]
  next_after_seq: number | null
  has_more_after: boolean
}

export interface HistoryAdapter {
  listChats(accessToken: string): Promise<readonly { id: string }[]>
  getMessages(
    chatId: string,
    accessToken: string,
    options: { afterSeq: number; limit: number },
  ): Promise<HistoryPage>
}

export type RefreshResult =
  | { kind: 'success'; accessToken: string }
  | { kind: 'temporary_failure' }
  | { kind: 'unauthorized' }

export interface AuthAdapter {
  refreshAccessToken(): Promise<RefreshResult>
}

export type PendingStatus = 'pending' | 'sent' | 'failed'

export interface PendingMessage {
  chatId: string
  clientMsgId: string
  body: string
  status: PendingStatus
  attempts: number
  messageId?: string
  seq?: number
  createdAt?: string
  errorCode?: string
}

export interface StoredMessage extends HistoryMessage {
  client_msg_id?: string
}

export interface WebSocketCloseEventLike {
  code: number
  reason: string
  wasClean: boolean
}

export interface WebSocketMessageEventLike {
  data: unknown
}

export interface WebSocketLike {
  readonly readyState: number
  readonly protocol: string
  onopen: (() => void) | null
  onmessage: ((event: WebSocketMessageEventLike) => void) | null
  onerror: (() => void) | null
  onclose: ((event: WebSocketCloseEventLike) => void) | null
  send(data: string): void
  close(code?: number, reason?: string): void
}

export type WebSocketFactory = (url: string, protocols: string[]) => WebSocketLike

export interface WebSocketClientSnapshot {
  transport: TransportState
  history: HistorySyncState
  authFailure?: AuthFailureReason
  pending: readonly PendingMessage[]
  messages: readonly StoredMessage[]
}

export interface ProtocolIssue {
  kind: 'invalid_json' | 'invalid_envelope' | 'invalid_payload' | 'unsupported_data'
  message: string
}
