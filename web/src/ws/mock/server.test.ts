import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MESSENGER_PROTOCOL } from '../types'
import { MockWebSocket, MockWebSocketServer } from './server'

const USER_ID = '60000000-0000-4000-8000-000000000001'
const CHAT_ID = '20000000-0000-4000-8000-000000000001'
const CLIENT_ID = '30000000-0000-4000-8000-000000000001'
const INVALID_ENVELOPE_ID = '10000000-0000-4000-8000-000000000001'
const VALID_ENVELOPE_ID = '10000000-0000-4000-8000-000000000002'
const GENERATED_ERROR_ID = '10000000-0000-4000-8000-000000000003'

async function flushMicrotasks() {
  await Promise.resolve()
  await Promise.resolve()
}

async function connect(server: MockWebSocketServer) {
  const socket = server.webSocketFactory('ws://localhost/ws', [
    MESSENGER_PROTOCOL,
    'bearer.access',
  ]) as MockWebSocket
  const received: unknown[] = []
  socket.onmessage = (event) => {
    if (typeof event.data === 'string') received.push(JSON.parse(event.data))
  }
  await flushMicrotasks()
  return { socket, received }
}

function validMessageSend(id = VALID_ENVELOPE_ID) {
  return {
    type: 'message.send',
    id,
    ts: '2026-11-08T12:00:00Z',
    payload: { chat_id: CHAT_ID, client_msg_id: CLIENT_ID, body: 'valid body' },
  }
}

describe('MockWebSocketServer input validation', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  it.each(['future.command', 'message.read', 'message.ack', 'message.new'])(
    'classifies client command %s as unsupported_type',
    async (requestType) => {
      const server = new MockWebSocketServer({ senderId: USER_ID })
      const { socket, received } = await connect(server)

      socket.send(
        JSON.stringify({
          type: requestType,
          id: VALID_ENVELOPE_ID,
          ts: '2026-11-08T12:00:00Z',
          payload: { client_msg_id: CLIENT_ID },
        }),
      )

      expect(received).toContainEqual({
        type: 'error',
        id: VALID_ENVELOPE_ID,
        ts: expect.any(String),
        payload: {
          code: 'unsupported_type',
          message: 'Unsupported command type',
          retryable: false,
          request_type: requestType,
          client_msg_id: null,
        },
      })
      expect(server.received).toHaveLength(0)
      expect(server.storedMessages).toHaveLength(0)
      expect(socket.readyState).toBe(1)
      expect(server.connections.has(socket)).toBe(true)
    },
  )

  it('uses a generated error id for an unsupported command with an invalid envelope id', async () => {
    const createId = vi.fn(() => GENERATED_ERROR_ID)
    const server = new MockWebSocketServer({ senderId: USER_ID, createId })
    const { socket, received } = await connect(server)

    socket.send(
      JSON.stringify({
        type: 'future.command',
        id: 'not-a-uuid',
        ts: '2026-11-08T12:00:00Z',
        payload: {},
      }),
    )

    expect(received).toContainEqual(
      expect.objectContaining({
        type: 'error',
        id: GENERATED_ERROR_ID,
        payload: expect.objectContaining({
          code: 'unsupported_type',
          retryable: false,
          request_type: 'future.command',
          client_msg_id: null,
        }),
      }),
    )
    expect(createId).toHaveBeenCalledOnce()
    expect(server.received).toHaveLength(0)
    expect(server.storedMessages).toHaveLength(0)
    expect(socket.readyState).toBe(1)
  })

  it.each([
    ['missing type', undefined],
    ['non-string type', 42],
  ])('classifies %s as invalid_payload without throwing', async (_case, type) => {
    const server = new MockWebSocketServer({ senderId: USER_ID })
    const { socket, received } = await connect(server)
    const command: Record<string, unknown> = {
      id: VALID_ENVELOPE_ID,
      ts: '2026-11-08T12:00:00Z',
      payload: {},
    }
    if (type !== undefined) command.type = type

    expect(() => socket.send(JSON.stringify(command))).not.toThrow()
    expect(received).toContainEqual(
      expect.objectContaining({
        type: 'error',
        id: VALID_ENVELOPE_ID,
        payload: expect.objectContaining({
          code: 'invalid_payload',
          retryable: false,
          request_type: null,
          client_msg_id: null,
        }),
      }),
    )
    expect(server.received).toHaveLength(0)
    expect(server.storedMessages).toHaveLength(0)
    expect(socket.readyState).toBe(1)
  })

  it('classifies malformed JSON as invalid_json', async () => {
    const createId = vi.fn(() => GENERATED_ERROR_ID)
    const server = new MockWebSocketServer({ senderId: USER_ID, createId })
    const { socket, received } = await connect(server)

    expect(() => socket.send('{')).not.toThrow()
    expect(received).toContainEqual({
      type: 'error',
      id: GENERATED_ERROR_ID,
      ts: expect.any(String),
      payload: {
        code: 'invalid_json',
        message: 'Invalid JSON',
        retryable: false,
        request_type: null,
        client_msg_id: null,
      },
    })
    expect(server.received).toHaveLength(0)
    expect(server.storedMessages).toHaveLength(0)
    expect(socket.readyState).toBe(1)
  })

  it('accepts message.send on the same socket after unsupported_type', async () => {
    const server = new MockWebSocketServer({ senderId: USER_ID })
    const { socket, received } = await connect(server)

    socket.send(
      JSON.stringify({
        type: 'message.read',
        id: INVALID_ENVELOPE_ID,
        ts: '2026-11-08T12:00:00Z',
        payload: { client_msg_id: CLIENT_ID },
      }),
    )

    expect(received).toContainEqual(
      expect.objectContaining({
        type: 'error',
        id: INVALID_ENVELOPE_ID,
        payload: expect.objectContaining({ code: 'unsupported_type' }),
      }),
    )
    expect(server.received).toHaveLength(0)
    expect(server.storedMessages).toHaveLength(0)
    expect(server.connections.size).toBe(1)
    expect(server.connections.has(socket)).toBe(true)
    expect(socket.readyState).toBe(1)

    socket.send(JSON.stringify(validMessageSend()))
    await vi.advanceTimersByTimeAsync(0)

    expect(received).toContainEqual(
      expect.objectContaining({ type: 'message.ack', id: VALID_ENVELOPE_ID }),
    )
    expect(server.received).toHaveLength(1)
    expect(server.storedMessages).toHaveLength(1)
    expect(server.storedMessages[0]?.body).toBe('valid body')
    expect(server.connections.size).toBe(1)
    expect(server.connections.has(socket)).toBe(true)
    expect(socket.readyState).toBe(1)
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
