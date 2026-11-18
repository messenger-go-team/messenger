import { describe, expect, it } from 'vitest'
import { createMessageSendEvent, isValidOutgoingMessage, parseServerMessage } from './protocol'

const ENVELOPE_ID = '10000000-0000-4000-8000-000000000001'
const CHAT_ID = '20000000-0000-4000-8000-000000000001'
const CLIENT_ID = '30000000-0000-4000-8000-000000000001'
const MESSAGE_ID = '40000000-0000-4000-8000-000000000001'

function envelope(type: string, payload: object) {
  return JSON.stringify({ type, id: ENVELOPE_ID, ts: '2026-11-08T12:00:00Z', payload })
}

describe('WebSocket protocol', () => {
  it('creates a contract-compatible message.send event', () => {
    expect(
      createMessageSendEvent(
        { chat_id: CHAT_ID, client_msg_id: CLIENT_ID, body: 'Привет!' },
        ENVELOPE_ID,
        '2026-11-08T12:00:00Z',
      ),
    ).toEqual({
      type: 'message.send',
      id: ENVELOPE_ID,
      ts: '2026-11-08T12:00:00Z',
      payload: { chat_id: CHAT_ID, client_msg_id: CLIENT_ID, body: 'Привет!' },
    })
  })

  it('parses message.ack and ignores additional fields', () => {
    const result = parseServerMessage(
      envelope('message.ack', {
        chat_id: CHAT_ID,
        client_msg_id: CLIENT_ID,
        message_id: MESSAGE_ID,
        seq: 1,
        created_at: '2026-11-08T12:00:00Z',
        future_field: true,
      }),
    )
    expect(result.kind).toBe('known')
  })

  it('parses message.new', () => {
    const result = parseServerMessage(
      envelope('message.new', {
        chat_id: CHAT_ID,
        client_msg_id: CLIENT_ID,
        message_id: MESSAGE_ID,
        sender_id: '60000000-0000-4000-8000-000000000001',
        seq: 1,
        body: 'Привет!',
        created_at: '2026-11-08T12:00:00Z',
      }),
    )
    expect(result.kind).toBe('known')
  })

  it('parses a correlated error', () => {
    const result = parseServerMessage(
      envelope('error', {
        code: 'forbidden',
        message: 'Нет доступа',
        retryable: false,
        request_type: 'message.send',
        client_msg_id: CLIENT_ID,
      }),
    )
    expect(result.kind).toBe('known')
  })

  it('keeps an unknown server event non-fatal', () => {
    expect(parseServerMessage(envelope('future.event', { value: 1 })).kind).toBe('unknown')
  })

  it.each([
    ['invalid JSON', '{', 'invalid_json'],
    ['array envelope', '[]', 'invalid_envelope'],
    ['invalid payload', envelope('message.ack', { chat_id: CHAT_ID, seq: '1' }), 'invalid_payload'],
  ])('rejects %s at runtime', (_name, input, expectedIssue) => {
    const result = parseServerMessage(input)
    expect(result.kind).toBe('invalid')
    if (result.kind === 'invalid') expect(result.issue.kind).toBe(expectedIssue)
  })

  it('validates message body by Unicode code points without trimming it', () => {
    expect(
      isValidOutgoingMessage({ chat_id: CHAT_ID, client_msg_id: CLIENT_ID, body: '  a  ' }),
    ).toBe(true)
    expect(
      isValidOutgoingMessage({ chat_id: CHAT_ID, client_msg_id: CLIENT_ID, body: ' \n ' }),
    ).toBe(false)
    expect(isValidOutgoingMessage({ chat_id: CHAT_ID, client_msg_id: CLIENT_ID, body: '\0' })).toBe(
      false,
    )
  })

  it('rejects unpaired UTF-16 surrogates but preserves valid Unicode and literal text', () => {
    const payload = (body: string) => ({ chat_id: CHAT_ID, client_msg_id: CLIENT_ID, body })

    expect(isValidOutgoingMessage(payload(String.fromCharCode(0xd800)))).toBe(false)
    expect(isValidOutgoingMessage(payload(String.fromCharCode(0xdc00)))).toBe(false)
    expect(isValidOutgoingMessage(payload(`${String.fromCharCode(0xd800)}a`))).toBe(false)
    expect(isValidOutgoingMessage(payload(`a${String.fromCharCode(0xdc00)}`))).toBe(false)
    const supported = '😀\ufffd\\uD800'
    expect(isValidOutgoingMessage(payload(supported))).toBe(true)
    expect(
      createMessageSendEvent(payload(supported), ENVELOPE_ID, '2026-11-08T12:00:00Z').payload.body,
    ).toBe(supported)
  })
})
