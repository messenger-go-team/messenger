import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MESSENGER_PROTOCOL } from '../types'
import { MockWebSocket, MockWebSocketServer } from './server'

const USER_ID = '60000000-0000-4000-8000-000000000001'
const CHAT_ID = '20000000-0000-4000-8000-000000000001'
const CLIENT_ID = '30000000-0000-4000-8000-000000000001'
const INVALID_ENVELOPE_ID = '10000000-0000-4000-8000-000000000001'
const VALID_ENVELOPE_ID = '10000000-0000-4000-8000-000000000002'

async function flushMicrotasks() {
  await Promise.resolve()
  await Promise.resolve()
}

describe('MockWebSocketServer input validation', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  it('rejects body null and accepts a following valid command on the same connection', async () => {
    const server = new MockWebSocketServer({ senderId: USER_ID })
    const socket = server.webSocketFactory('ws://localhost/ws', [
      MESSENGER_PROTOCOL,
      'bearer.access',
    ]) as MockWebSocket
    const received: unknown[] = []
    socket.onmessage = (event) => {
      if (typeof event.data === 'string') received.push(JSON.parse(event.data))
    }
    await flushMicrotasks()

    const invalidCommand = {
      type: 'message.send',
      id: INVALID_ENVELOPE_ID,
      ts: '2026-11-08T12:00:00Z',
      payload: { chat_id: CHAT_ID, client_msg_id: CLIENT_ID, body: null },
    }

    expect(() => socket.send(JSON.stringify(invalidCommand))).not.toThrow()
    expect(received).toContainEqual({
      type: 'error',
      id: INVALID_ENVELOPE_ID,
      ts: expect.any(String),
      payload: {
        code: 'invalid_payload',
        message: 'Invalid message.send',
        retryable: false,
        request_type: 'message.send',
        client_msg_id: CLIENT_ID,
      },
    })
    expect(server.received).toHaveLength(0)
    expect(server.storedMessages).toHaveLength(0)
    expect(socket.readyState).toBe(1)
    expect(server.connections.has(socket)).toBe(true)

    socket.send(
      JSON.stringify({
        ...invalidCommand,
        id: VALID_ENVELOPE_ID,
        payload: { chat_id: CHAT_ID, client_msg_id: CLIENT_ID, body: 'valid body' },
      }),
    )
    await vi.advanceTimersByTimeAsync(0)

    expect(received).toContainEqual(
      expect.objectContaining({ type: 'message.ack', id: VALID_ENVELOPE_ID }),
    )
    expect(server.received).toHaveLength(1)
    expect(server.storedMessages).toHaveLength(1)
    expect(server.storedMessages[0]?.body).toBe('valid body')
    expect(socket.readyState).toBe(1)
  })

  it.each([
    ['body as a number', { chat_id: CHAT_ID, client_msg_id: CLIENT_ID, body: 42 }, CLIENT_ID],
    ['body as an array', { chat_id: CHAT_ID, client_msg_id: CLIENT_ID, body: [] }, CLIENT_ID],
    ['body as an object', { chat_id: CHAT_ID, client_msg_id: CLIENT_ID, body: {} }, CLIENT_ID],
    ['missing body', { chat_id: CHAT_ID, client_msg_id: CLIENT_ID }, CLIENT_ID],
    ['null payload', null, null],
    ['array payload', [], null],
    ['non-string chat_id', { chat_id: 42, client_msg_id: CLIENT_ID, body: 'body' }, CLIENT_ID],
    ['non-string client_msg_id', { chat_id: CHAT_ID, client_msg_id: 42, body: 'body' }, null],
  ])('rejects %s without closing the connection', async (_case, payload, expectedClientMsgId) => {
    const server = new MockWebSocketServer({ senderId: USER_ID })
    const socket = server.webSocketFactory('ws://localhost/ws', [
      MESSENGER_PROTOCOL,
      'bearer.access',
    ]) as MockWebSocket
    const received: unknown[] = []
    socket.onmessage = (event) => {
      if (typeof event.data === 'string') received.push(JSON.parse(event.data))
    }
    await flushMicrotasks()

    const command = {
      type: 'message.send',
      id: INVALID_ENVELOPE_ID,
      ts: '2026-11-08T12:00:00Z',
      payload,
    }

    expect(() => socket.send(JSON.stringify(command))).not.toThrow()
    expect(received).toContainEqual(
      expect.objectContaining({
        type: 'error',
        id: INVALID_ENVELOPE_ID,
        payload: expect.objectContaining({
          code: 'invalid_payload',
          retryable: false,
          request_type: 'message.send',
          client_msg_id: expectedClientMsgId,
        }),
      }),
    )
    expect(server.received).toHaveLength(0)
    expect(server.storedMessages).toHaveLength(0)
    expect(socket.readyState).toBe(1)
    expect(server.connections.has(socket)).toBe(true)
  })
})
