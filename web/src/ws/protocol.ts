import type {
  ErrorEvent,
  KnownServerEvent,
  MessageAckEvent,
  MessageNewEvent,
  MessageSendEvent,
  MessageSendPayload,
  ProtocolIssue,
  UnknownServerEvent,
} from './types'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const UTC_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/
const MAX_SEQUENCE = Number.MAX_SAFE_INTEGER

type ParseResult =
  | { kind: 'known'; event: KnownServerEvent }
  | { kind: 'unknown'; event: UnknownServerEvent }
  | { kind: 'invalid'; issue: ProtocolIssue }

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value)
}

function isTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || !UTC_TIMESTAMP_PATTERN.test(value)) return false
  return Number.isFinite(Date.parse(value))
}

function isSequence(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 1 && Number(value) <= MAX_SEQUENCE
}

function issue(kind: ProtocolIssue['kind'], message: string): ParseResult {
  return { kind: 'invalid', issue: { kind, message } }
}

function hasBaseEnvelope(value: Record<string, unknown>): boolean {
  return (
    typeof value.type === 'string' &&
    isUuid(value.id) &&
    isTimestamp(value.ts) &&
    isObject(value.payload)
  )
}

function isAckPayload(value: Record<string, unknown>): boolean {
  return (
    isUuid(value.chat_id) &&
    isUuid(value.client_msg_id) &&
    isUuid(value.message_id) &&
    isSequence(value.seq) &&
    isTimestamp(value.created_at)
  )
}

function isNewPayload(value: Record<string, unknown>): boolean {
  return isAckPayload(value) && isUuid(value.sender_id) && typeof value.body === 'string'
}

function isErrorPayload(value: Record<string, unknown>): boolean {
  return (
    typeof value.code === 'string' &&
    typeof value.message === 'string' &&
    typeof value.retryable === 'boolean' &&
    (typeof value.request_type === 'string' || value.request_type === null) &&
    (isUuid(value.client_msg_id) || value.client_msg_id === null)
  )
}

export function parseServerMessage(data: unknown): ParseResult {
  if (typeof data !== 'string') {
    return issue('unsupported_data', 'WebSocket event must contain a text message')
  }

  let value: unknown
  try {
    value = JSON.parse(data)
  } catch {
    return issue('invalid_json', 'WebSocket event is not valid JSON')
  }

  if (!isObject(value) || !hasBaseEnvelope(value)) {
    return issue('invalid_envelope', 'WebSocket event has an invalid envelope')
  }

  const payload = value.payload
  if (!isObject(payload)) {
    return issue('invalid_envelope', 'WebSocket event has an invalid payload object')
  }

  switch (value.type) {
    case 'message.ack':
      if (!isAckPayload(payload)) {
        return issue('invalid_payload', 'message.ack has an invalid payload')
      }
      return { kind: 'known', event: value as unknown as MessageAckEvent }
    case 'message.new':
      if (!isNewPayload(payload)) {
        return issue('invalid_payload', 'message.new has an invalid payload')
      }
      return { kind: 'known', event: value as unknown as MessageNewEvent }
    case 'error':
      if (!isErrorPayload(payload)) {
        return issue('invalid_payload', 'error has an invalid payload')
      }
      return { kind: 'known', event: value as unknown as ErrorEvent }
    default:
      return { kind: 'unknown', event: value as unknown as UnknownServerEvent }
  }
}

export function createMessageSendEvent(
  payload: MessageSendPayload,
  id: string,
  timestamp: string,
): MessageSendEvent {
  return { type: 'message.send', id, ts: timestamp, payload }
}

export function serializeClientEvent(event: MessageSendEvent): string {
  return JSON.stringify(event)
}

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const codeUnit = value.charCodeAt(index)
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      if (index + 1 >= value.length) return true
      const next = value.charCodeAt(index + 1)
      if (next < 0xdc00 || next > 0xdfff) return true
      index++
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return true
    }
  }
  return false
}

export function isValidOutgoingMessage(payload: MessageSendPayload): boolean {
  if (hasUnpairedSurrogate(payload.body)) return false
  const codePoints = Array.from(payload.body).length
  return (
    isUuid(payload.chat_id) &&
    isUuid(payload.client_msg_id) &&
    codePoints >= 1 &&
    codePoints <= 4096 &&
    !/^\p{White_Space}+$/u.test(payload.body) &&
    !payload.body.includes('\0')
  )
}

export function isValidUuid(value: string): boolean {
  return isUuid(value)
}
