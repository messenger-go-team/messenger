import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MessengerWebSocketClient } from './client'
import { MockWebSocket, MockWebSocketServer } from './mock/server'
import type { ErrorEvent, ErrorPayload, MessageAckEvent, WebSocketFactory } from './types'

const USER_ID = '60000000-0000-4000-8000-000000000001'
const OTHER_USER_ID = '60000000-0000-4000-8000-000000000002'
const CHAT_ID = '20000000-0000-4000-8000-000000000001'
const CLIENT_ID = '30000000-0000-4000-8000-000000000001'
const UNKNOWN_CLIENT_ID = '30000000-0000-4000-8000-000000000002'

function ids() {
  let value = 0
  return () => `10000000-0000-4000-8000-${String(++value).padStart(12, '0')}`
}

function flushMicrotasks() {
  return Promise.resolve().then(() => Promise.resolve())
}

function latestConnection(server: MockWebSocketServer): MockWebSocket {
  const connections = Array.from(server.connections)
  const connection = connections.at(-1)
  if (!connection) throw new Error('Expected a mock connection')
  return connection
}

function errorEvent(
  payload: ErrorPayload,
  id = '10000000-0000-4000-8000-000000000099',
): ErrorEvent {
  return {
    type: 'error',
    id,
    ts: '2026-11-08T12:00:00Z',
    payload,
  }
}

function ackEvent(
  id: string,
  message: {
    chatId: string
    clientMsgId: string
    messageId: string
    seq: number
    createdAt: string
  },
): MessageAckEvent {
  return {
    type: 'message.ack',
    id,
    ts: '2026-11-08T12:00:00Z',
    payload: {
      chat_id: message.chatId,
      client_msg_id: message.clientMsgId,
      message_id: message.messageId,
      seq: message.seq,
      created_at: message.createdAt,
    },
  }
}

describe('MessengerWebSocketClient connection and events', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  it('connects to /ws with messenger.v1 and access JWT', async () => {
    const server = new MockWebSocketServer({ senderId: USER_ID, expectedAccessToken: 'access' })
    const client = new MessengerWebSocketClient({
      wsOrigin: 'ws://localhost:8080/',
      accessToken: 'access',
      currentUserId: USER_ID,
      webSocketFactory: server.webSocketFactory,
    })
    client.start()
    await flushMicrotasks()

    const connection = latestConnection(server)
    expect(connection.url).toBe('ws://localhost:8080/ws')
    expect(connection.protocols).toEqual(['messenger.v1', 'bearer.access'])
    expect(connection.protocol).toBe('messenger.v1')
    expect(client.getSnapshot().transport).toBe('connected')
  })

  it('handles a failed handshake using only browser-visible information', async () => {
    const server = new MockWebSocketServer({ senderId: USER_ID, expectedAccessToken: 'valid' })
    const client = new MessengerWebSocketClient({
      wsOrigin: 'ws://localhost',
      accessToken: 'invalid',
      currentUserId: USER_ID,
      webSocketFactory: server.webSocketFactory,
      random: () => 0.5,
    })
    client.start()
    await flushMicrotasks()
    expect(client.getSnapshot().transport).toBe('disconnected')
    expect(vi.getTimerCount()).toBe(1)
  })

  it('does not create parallel sockets for repeated start calls', async () => {
    const server = new MockWebSocketServer({ senderId: USER_ID })
    const client = new MessengerWebSocketClient({
      wsOrigin: 'ws://localhost',
      accessToken: 'access',
      currentUserId: USER_ID,
      webSocketFactory: server.webSocketFactory,
    })
    client.start()
    client.start()
    await flushMicrotasks()
    client.start()
    expect(server.connections.size).toBe(1)
  })

  it('reports malformed JSON and payloads without closing the socket', async () => {
    const issues = vi.fn()
    const server = new MockWebSocketServer({ senderId: USER_ID })
    const client = new MessengerWebSocketClient({
      wsOrigin: 'ws://localhost',
      accessToken: 'access',
      currentUserId: USER_ID,
      webSocketFactory: server.webSocketFactory,
      onProtocolIssue: issues,
    })
    client.start()
    await flushMicrotasks()
    const connection = latestConnection(server)
    connection.serverMessage('{')
    connection.serverMessage(
      JSON.stringify({
        type: 'message.new',
        id: '10000000-0000-4000-8000-000000000001',
        ts: '2026-11-08T12:00:00Z',
        payload: {},
      }),
    )
    expect(issues).toHaveBeenCalledTimes(2)
    expect(client.getSnapshot().transport).toBe('connected')
  })

  it('passes unknown event types to the compatibility callback', async () => {
    const unknown = vi.fn()
    const server = new MockWebSocketServer({ senderId: USER_ID })
    const client = new MessengerWebSocketClient({
      wsOrigin: 'ws://localhost',
      accessToken: 'access',
      currentUserId: USER_ID,
      webSocketFactory: server.webSocketFactory,
      onUnknownEvent: unknown,
    })
    client.start()
    await flushMicrotasks()
    latestConnection(server).serverMessage(
      JSON.stringify({
        type: 'typing',
        id: '10000000-0000-4000-8000-000000000001',
        ts: '2026-11-08T12:00:00Z',
        payload: { value: true },
      }),
    )
    expect(unknown).toHaveBeenCalledOnce()
    expect(client.getSnapshot().transport).toBe('connected')
  })

  it('supports ack before new without duplicate messages', async () => {
    const makeId = ids()
    const server = new MockWebSocketServer({
      senderId: USER_ID,
      createId: makeId,
      ackDelayMs: 0,
      newDelayMs: 10,
    })
    const client = new MessengerWebSocketClient({
      wsOrigin: 'ws://localhost',
      accessToken: 'access',
      currentUserId: USER_ID,
      webSocketFactory: server.webSocketFactory,
      createId: makeId,
    })
    client.start()
    await flushMicrotasks()
    client.sendMessage(CHAT_ID, 'hello', CLIENT_ID)
    await vi.advanceTimersByTimeAsync(1)
    expect(client.getSnapshot().pending[0]?.status).toBe('sent')
    expect(client.getSnapshot().messages).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(10)
    expect(client.getSnapshot().messages).toHaveLength(1)
  })

  it('supports new before ack and keeps sent after the late ack', async () => {
    const makeId = ids()
    const server = new MockWebSocketServer({
      senderId: USER_ID,
      createId: makeId,
      ackDelayMs: 10,
      newDelayMs: 0,
    })
    const client = new MessengerWebSocketClient({
      wsOrigin: 'ws://localhost',
      accessToken: 'access',
      currentUserId: USER_ID,
      webSocketFactory: server.webSocketFactory,
      createId: makeId,
    })
    client.start()
    await flushMicrotasks()
    client.sendMessage(CHAT_ID, 'hello', CLIENT_ID)
    await vi.advanceTimersByTimeAsync(0)
    expect(client.getSnapshot().pending[0]?.status).toBe('sent')
    await vi.advanceTimersByTimeAsync(10)
    expect(client.getSnapshot().pending[0]?.status).toBe('sent')
    expect(client.getSnapshot().messages).toHaveLength(1)
  })

  it('accepts ack only from an envelope ID that was actually sent', async () => {
    const makeId = ids()
    const server = new MockWebSocketServer({
      senderId: OTHER_USER_ID,
      createId: makeId,
      dropAcks: 1,
    })
    const client = new MessengerWebSocketClient({
      wsOrigin: 'ws://localhost',
      accessToken: 'access',
      currentUserId: USER_ID,
      webSocketFactory: server.webSocketFactory,
      createId: makeId,
    })
    client.start()
    await flushMicrotasks()
    client.sendMessage(CHAT_ID, 'hello', CLIENT_ID)
    const attemptId = server.received[0]?.id
    const stored = server.storedMessages[0]
    if (!attemptId || !stored) throw new Error('Expected a sent attempt')

    const payload = {
      chatId: stored.chatId,
      clientMsgId: stored.clientMsgId,
      messageId: stored.messageId,
      seq: stored.seq,
      createdAt: stored.createdAt,
    }
    latestConnection(server).serverMessage(
      JSON.stringify(ackEvent('10000000-0000-4000-8000-000000000999', payload)),
    )
    expect(client.getSnapshot().pending[0]?.status).toBe('pending')

    latestConnection(server).serverMessage(JSON.stringify(ackEvent(attemptId, payload)))
    expect(client.getSnapshot().pending[0]?.status).toBe('sent')
  })

  it('accepts a late ack from a previous sent attempt after a manual retry', async () => {
    const makeId = ids()
    const server = new MockWebSocketServer({
      senderId: OTHER_USER_ID,
      createId: makeId,
      dropAcks: 2,
    })
    const client = new MessengerWebSocketClient({
      wsOrigin: 'ws://localhost',
      accessToken: 'access',
      currentUserId: USER_ID,
      webSocketFactory: server.webSocketFactory,
      createId: makeId,
      ackTimeoutMs: 100,
      maxAutomaticAttempts: 1,
    })
    client.start()
    await flushMicrotasks()
    client.sendMessage(CHAT_ID, 'hello', CLIENT_ID)
    const firstAttemptId = server.received[0]?.id
    const stored = server.storedMessages[0]
    if (!firstAttemptId || !stored) throw new Error('Expected a sent attempt')
    await vi.advanceTimersByTimeAsync(100)
    expect(client.getSnapshot().pending[0]?.status).toBe('failed')

    client.retryMessage(CLIENT_ID)
    expect(server.received).toHaveLength(2)
    latestConnection(server).serverMessage(
      JSON.stringify(
        ackEvent(firstAttemptId, {
          chatId: stored.chatId,
          clientMsgId: stored.clientMsgId,
          messageId: stored.messageId,
          seq: stored.seq,
          createdAt: stored.createdAt,
        }),
      ),
    )
    expect(client.getSnapshot().pending[0]?.status).toBe('sent')
  })

  it('recovers a lost ack with the same client_msg_id and a new envelope id', async () => {
    const makeId = ids()
    const server = new MockWebSocketServer({
      senderId: OTHER_USER_ID,
      createId: makeId,
      dropAcks: 1,
    })
    const client = new MessengerWebSocketClient({
      wsOrigin: 'ws://localhost',
      accessToken: 'access',
      currentUserId: USER_ID,
      webSocketFactory: server.webSocketFactory,
      createId: makeId,
      random: () => 0.5,
      ackTimeoutMs: 1_000,
    })
    client.start()
    await flushMicrotasks()
    client.sendMessage(CHAT_ID, 'unchanged', CLIENT_ID)
    await vi.advanceTimersByTimeAsync(2_000)
    await vi.advanceTimersByTimeAsync(1)

    expect(server.received).toHaveLength(2)
    expect(server.received[0]?.payload).toEqual(server.received[1]?.payload)
    expect(server.received[0]?.id).not.toBe(server.received[1]?.id)
    expect(server.storedMessages).toHaveLength(1)
    expect(client.getSnapshot().pending[0]?.status).toBe('sent')
  })

  it('allows a late ack to move failed back to sent', async () => {
    const makeId = ids()
    const server = new MockWebSocketServer({
      senderId: OTHER_USER_ID,
      createId: makeId,
      ackDelayMs: 5_000,
    })
    const client = new MessengerWebSocketClient({
      wsOrigin: 'ws://localhost',
      accessToken: 'access',
      currentUserId: USER_ID,
      webSocketFactory: server.webSocketFactory,
      createId: makeId,
      ackTimeoutMs: 100,
      maxAutomaticAttempts: 1,
    })
    client.start()
    await flushMicrotasks()
    client.sendMessage(CHAT_ID, 'hello', CLIENT_ID)
    await vi.advanceTimersByTimeAsync(100)
    expect(client.getSnapshot().pending[0]?.status).toBe('failed')
    await vi.advanceTimersByTimeAsync(4_900)
    expect(client.getSnapshot().pending[0]?.status).toBe('sent')
  })

  it('ignores a late correlated error after sent', async () => {
    const makeId = ids()
    const server = new MockWebSocketServer({ senderId: USER_ID, createId: makeId })
    const client = new MessengerWebSocketClient({
      wsOrigin: 'ws://localhost',
      accessToken: 'access',
      currentUserId: USER_ID,
      webSocketFactory: server.webSocketFactory,
      createId: makeId,
    })
    client.start()
    await flushMicrotasks()
    client.sendMessage(CHAT_ID, 'hello', CLIENT_ID)
    await vi.advanceTimersByTimeAsync(0)
    latestConnection(server).serverMessage(
      JSON.stringify(
        errorEvent({
          code: 'forbidden',
          message: 'late',
          retryable: false,
          request_type: 'message.send',
          client_msg_id: CLIENT_ID,
        }),
      ),
    )
    expect(client.getSnapshot().pending[0]?.status).toBe('sent')
  })

  it('does not fail pending messages for an uncorrelated error', async () => {
    const makeId = ids()
    const server = new MockWebSocketServer({
      senderId: OTHER_USER_ID,
      createId: makeId,
      ackDelayMs: 10_000,
    })
    const client = new MessengerWebSocketClient({
      wsOrigin: 'ws://localhost',
      accessToken: 'access',
      currentUserId: USER_ID,
      webSocketFactory: server.webSocketFactory,
      createId: makeId,
    })
    client.start()
    await flushMicrotasks()
    client.sendMessage(CHAT_ID, 'hello', CLIENT_ID)
    latestConnection(server).serverMessage(
      JSON.stringify(
        errorEvent({
          code: 'forbidden',
          message: 'other command',
          retryable: false,
          request_type: 'message.send',
          client_msg_id: UNKNOWN_CLIENT_ID,
        }),
      ),
    )
    expect(client.getSnapshot().pending[0]?.status).toBe('pending')
  })

  it('ignores an error from an older attempt and requires message.send request_type', async () => {
    const makeId = ids()
    const server = new MockWebSocketServer({
      senderId: OTHER_USER_ID,
      createId: makeId,
      dropAcks: 2,
    })
    const client = new MessengerWebSocketClient({
      wsOrigin: 'ws://localhost',
      accessToken: 'access',
      currentUserId: USER_ID,
      webSocketFactory: server.webSocketFactory,
      createId: makeId,
      random: () => 0.5,
      ackTimeoutMs: 100,
    })
    client.start()
    await flushMicrotasks()
    client.sendMessage(CHAT_ID, 'hello', CLIENT_ID)
    const firstAttemptId = server.received[0]?.id
    await vi.advanceTimersByTimeAsync(1_100)
    const secondAttemptId = server.received[1]?.id
    expect(firstAttemptId).toBeDefined()
    expect(secondAttemptId).toBeDefined()

    const permanentError: ErrorPayload = {
      code: 'forbidden',
      message: 'denied',
      retryable: false,
      request_type: 'message.send',
      client_msg_id: CLIENT_ID,
    }
    latestConnection(server).serverMessage(
      JSON.stringify(errorEvent(permanentError, firstAttemptId)),
    )
    expect(client.getSnapshot().pending[0]?.status).toBe('pending')

    latestConnection(server).serverMessage(
      JSON.stringify(errorEvent({ ...permanentError, request_type: 'typing' }, secondAttemptId)),
    )
    expect(client.getSnapshot().pending[0]?.status).toBe('pending')

    latestConnection(server).serverMessage(
      JSON.stringify(errorEvent(permanentError, secondAttemptId)),
    )
    expect(client.getSnapshot().pending[0]).toMatchObject({
      status: 'failed',
      errorCode: 'forbidden',
    })
  })

  it('marks a correlated permanent error failed and stops automatic retry', async () => {
    const server = new MockWebSocketServer({ senderId: USER_ID })
    server.failNextCommand({
      code: 'forbidden',
      message: 'denied',
      retryable: false,
      request_type: 'message.send',
      client_msg_id: null,
    })
    const client = new MessengerWebSocketClient({
      wsOrigin: 'ws://localhost',
      accessToken: 'access',
      currentUserId: USER_ID,
      webSocketFactory: server.webSocketFactory,
    })
    client.start()
    await flushMicrotasks()
    client.sendMessage(CHAT_ID, 'hello', CLIENT_ID)
    expect(client.getSnapshot().pending[0]).toMatchObject({
      status: 'failed',
      errorCode: 'forbidden',
    })
    await vi.advanceTimersByTimeAsync(30_000)
    expect(server.received).toHaveLength(1)
  })

  it('allows an explicit retry with the same logical message after the automatic limit', async () => {
    const server = new MockWebSocketServer({ senderId: OTHER_USER_ID, dropAcks: 1 })
    const client = new MessengerWebSocketClient({
      wsOrigin: 'ws://localhost',
      accessToken: 'access',
      currentUserId: USER_ID,
      webSocketFactory: server.webSocketFactory,
      ackTimeoutMs: 100,
      maxAutomaticAttempts: 1,
    })
    client.start()
    await flushMicrotasks()
    client.sendMessage(CHAT_ID, 'same body', CLIENT_ID)
    await vi.advanceTimersByTimeAsync(100)
    expect(client.getSnapshot().pending[0]?.status).toBe('failed')

    client.retryMessage(CLIENT_ID)
    await vi.advanceTimersByTimeAsync(1)
    expect(server.received).toHaveLength(2)
    expect(server.received[0]?.payload).toEqual(server.received[1]?.payload)
    expect(client.getSnapshot().pending[0]?.status).toBe('sent')
  })

  it('does not send a parallel attempt for repeated manual or logical retries', async () => {
    const server = new MockWebSocketServer({
      senderId: OTHER_USER_ID,
      dropAcks: 1,
      ackDelayMs: 10_000,
    })
    const client = new MessengerWebSocketClient({
      wsOrigin: 'ws://localhost',
      accessToken: 'access',
      currentUserId: USER_ID,
      webSocketFactory: server.webSocketFactory,
    })
    client.start()
    await flushMicrotasks()
    client.sendMessage(CHAT_ID, 'same body', CLIENT_ID)

    client.retryMessage(CLIENT_ID)
    client.retryMessage(CLIENT_ID)
    client.sendMessage(CHAT_ID, 'same body', CLIENT_ID)
    expect(server.received).toHaveLength(1)
    expect(client.getSnapshot().pending[0]).toMatchObject({ status: 'pending', attempts: 1 })
  })

  it('preserves pending state and retries when socket.send throws synchronously', async () => {
    const server = new MockWebSocketServer({ senderId: USER_ID })
    const client = new MessengerWebSocketClient({
      wsOrigin: 'ws://localhost',
      accessToken: 'access',
      currentUserId: USER_ID,
      webSocketFactory: server.webSocketFactory,
      random: () => 0.5,
    })
    client.start()
    await flushMicrotasks()
    const connection = latestConnection(server)
    const send = connection.send.bind(connection)
    let throws = true
    connection.send = (data) => {
      if (throws) {
        throws = false
        throw new Error('send failed')
      }
      send(data)
    }

    expect(() => client.sendMessage(CHAT_ID, 'safe retry', CLIENT_ID)).not.toThrow()
    expect(client.getSnapshot().pending[0]).toMatchObject({
      status: 'pending',
      attempts: 1,
      errorCode: 'send_failed',
    })
    expect(server.received).toHaveLength(0)

    await vi.advanceTimersByTimeAsync(1_001)
    expect(server.received).toHaveLength(1)
    expect(client.getSnapshot().pending[0]?.status).toBe('sent')
  })

  it('does not create pending messages after stop', () => {
    const client = new MessengerWebSocketClient({
      wsOrigin: 'ws://localhost',
      accessToken: 'access',
      currentUserId: USER_ID,
    })
    client.stop()

    expect(() => client.sendMessage(CHAT_ID, 'blocked', CLIENT_ID)).toThrow(
      'WebSocket client is stopped',
    )
    expect(client.getSnapshot().pending).toHaveLength(0)
  })

  it('does not mutate a failed pending message when retrying after stop', async () => {
    const server = new MockWebSocketServer({ senderId: USER_ID })
    server.failNextCommand({
      code: 'forbidden',
      message: 'denied',
      retryable: false,
      request_type: 'message.send',
      client_msg_id: null,
    })
    const client = new MessengerWebSocketClient({
      wsOrigin: 'ws://localhost',
      accessToken: 'access',
      currentUserId: USER_ID,
      webSocketFactory: server.webSocketFactory,
    })
    client.start()
    await flushMicrotasks()
    client.sendMessage(CHAT_ID, 'failed', CLIENT_ID)
    expect(client.getSnapshot().pending[0]?.status).toBe('failed')
    client.stop()
    const beforeRetry = client.getSnapshot().pending[0]

    client.retryMessage(CLIENT_ID)
    expect(client.getSnapshot().pending[0]).toEqual(beforeRetry)
    expect(server.received).toHaveLength(1)
  })
})

describe('MessengerWebSocketClient reconnect and authorization', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  it('reconnects once for duplicate disconnect notifications', async () => {
    const server = new MockWebSocketServer({ senderId: USER_ID })
    const client = new MessengerWebSocketClient({
      wsOrigin: 'ws://localhost',
      accessToken: 'access',
      currentUserId: USER_ID,
      webSocketFactory: server.webSocketFactory,
      random: () => 0.5,
    })
    client.start()
    await flushMicrotasks()
    const connection = latestConnection(server)
    connection.serverClose(1013, 'retry later')
    connection.serverClose(1013, 'duplicate')
    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(1_000)
    await flushMicrotasks()
    expect(server.connections.size).toBe(1)
    expect(client.getSnapshot().transport).toBe('connected')
  })

  it('cancels reconnect and pending timers on logout/stop', async () => {
    const server = new MockWebSocketServer({ senderId: USER_ID })
    const client = new MessengerWebSocketClient({
      wsOrigin: 'ws://localhost',
      accessToken: 'access',
      currentUserId: USER_ID,
      webSocketFactory: server.webSocketFactory,
      random: () => 0.5,
    })
    client.start()
    await flushMicrotasks()
    latestConnection(server).serverClose(1001, 'away')
    client.stop()
    expect(client.getSnapshot().transport).toBe('stopped')
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(server.connections.size).toBe(0)
  })

  it.each([1002, 1003, 1007, 1009])(
    'does not reconnect after non-retryable protocol close %s',
    async (code) => {
      const server = new MockWebSocketServer({ senderId: USER_ID })
      const client = new MessengerWebSocketClient({
        wsOrigin: 'ws://localhost',
        accessToken: 'access',
        currentUserId: USER_ID,
        webSocketFactory: server.webSocketFactory,
      })
      client.start()
      await flushMicrotasks()
      latestConnection(server).serverClose(code, 'protocol failure')
      expect(client.getSnapshot().transport).toBe('disconnected')
      expect(vi.getTimerCount()).toBe(0)
    },
  )

  it('resets reconnect backoff after thirty seconds of stable connection', async () => {
    const server = new MockWebSocketServer({ senderId: USER_ID })
    const factory = vi.fn(server.webSocketFactory)
    const client = new MessengerWebSocketClient({
      wsOrigin: 'ws://localhost',
      accessToken: 'access',
      currentUserId: USER_ID,
      webSocketFactory: factory,
      random: () => 0.5,
    })
    client.start()
    await flushMicrotasks()
    latestConnection(server).serverClose(1013, 'first')
    await vi.advanceTimersByTimeAsync(1_000)
    await flushMicrotasks()
    expect(factory).toHaveBeenCalledTimes(2)

    await vi.advanceTimersByTimeAsync(30_000)
    latestConnection(server).serverClose(1013, 'after stable period')
    await vi.advanceTimersByTimeAsync(999)
    expect(factory).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(factory).toHaveBeenCalledTimes(3)
  })

  it('refreshes once on 4401 and reconnects with the new access token', async () => {
    const server = new MockWebSocketServer({ senderId: USER_ID })
    const refreshAccessToken = vi.fn().mockResolvedValue({ kind: 'success', accessToken: 'new' })
    const client = new MessengerWebSocketClient({
      wsOrigin: 'ws://localhost',
      accessToken: 'old',
      currentUserId: USER_ID,
      webSocketFactory: server.webSocketFactory,
      auth: { refreshAccessToken },
      random: () => 0.5,
    })
    client.start()
    await flushMicrotasks()
    latestConnection(server).serverClose(4401, 'expired')
    await flushMicrotasks()
    await vi.advanceTimersByTimeAsync(1_000)
    await flushMicrotasks()
    expect(refreshAccessToken).toHaveBeenCalledOnce()
    expect(latestConnection(server).protocols).toContain('bearer.new')

    latestConnection(server).serverClose(4401, 'still rejected')
    await flushMicrotasks()
    expect(refreshAccessToken).toHaveBeenCalledOnce()
    expect(client.getSnapshot()).toMatchObject({
      transport: 'auth_failed',
      authFailure: 'refreshed_token_rejected',
    })
    expect(vi.getTimerCount()).toBe(0)
    client.start()
    await flushMicrotasks()
    expect(server.connections.size).toBe(0)
  })

  it('retries a temporary refresh failure with backoff', async () => {
    const server = new MockWebSocketServer({ senderId: USER_ID })
    const refreshAccessToken = vi
      .fn()
      .mockResolvedValueOnce({ kind: 'temporary_failure' })
      .mockResolvedValueOnce({ kind: 'success', accessToken: 'new' })
    const client = new MessengerWebSocketClient({
      wsOrigin: 'ws://localhost',
      accessToken: 'old',
      currentUserId: USER_ID,
      webSocketFactory: server.webSocketFactory,
      auth: { refreshAccessToken },
      random: () => 0.5,
    })
    client.start()
    await flushMicrotasks()
    latestConnection(server).serverClose(4401, 'expired')
    await flushMicrotasks()
    expect(refreshAccessToken).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1_000)
    await flushMicrotasks()
    expect(refreshAccessToken).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(2_000)
    await flushMicrotasks()
    expect(latestConnection(server).protocols).toContain('bearer.new')
  })

  it('does not reconnect after a final refresh rejection', async () => {
    const server = new MockWebSocketServer({ senderId: USER_ID })
    const refreshAccessToken = vi.fn().mockResolvedValue({ kind: 'unauthorized' })
    const client = new MessengerWebSocketClient({
      wsOrigin: 'ws://localhost',
      accessToken: 'old',
      currentUserId: USER_ID,
      webSocketFactory: server.webSocketFactory,
      auth: { refreshAccessToken },
    })
    client.start()
    await flushMicrotasks()
    latestConnection(server).serverClose(4401, 'expired')
    await flushMicrotasks()
    expect(client.getSnapshot()).toMatchObject({
      transport: 'auth_failed',
      authFailure: 'refresh_rejected',
    })
    expect(refreshAccessToken).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('reports terminal auth failure after temporary refresh retries are exhausted', async () => {
    const server = new MockWebSocketServer({ senderId: USER_ID })
    const refreshAccessToken = vi.fn().mockResolvedValue({ kind: 'temporary_failure' })
    const client = new MessengerWebSocketClient({
      wsOrigin: 'ws://localhost',
      accessToken: 'old',
      currentUserId: USER_ID,
      webSocketFactory: server.webSocketFactory,
      auth: { refreshAccessToken },
      random: () => 0.5,
      maxRefreshAttempts: 2,
    })
    client.start()
    await flushMicrotasks()
    latestConnection(server).serverClose(4401, 'expired')
    await flushMicrotasks()
    await vi.advanceTimersByTimeAsync(1_000)
    await flushMicrotasks()

    expect(refreshAccessToken).toHaveBeenCalledTimes(2)
    expect(client.getSnapshot()).toMatchObject({
      transport: 'auth_failed',
      authFailure: 'refresh_retry_exhausted',
    })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('never sends reserved close code 1006', async () => {
    let socket: MockWebSocket | undefined
    const factory: WebSocketFactory = (url, protocols) => {
      const server = new MockWebSocketServer({ senderId: USER_ID })
      socket = server.webSocketFactory(url, protocols) as MockWebSocket
      return socket
    }
    const close = vi.spyOn(MockWebSocket.prototype, 'close')
    const client = new MessengerWebSocketClient({
      wsOrigin: 'ws://localhost',
      accessToken: 'access',
      currentUserId: USER_ID,
      webSocketFactory: factory,
    })
    client.start()
    await flushMicrotasks()
    client.stop()
    expect(socket).toBeDefined()
    expect(close).toHaveBeenCalledWith(1000, 'client stopped')
    expect(close).not.toHaveBeenCalledWith(1006, expect.anything())
    close.mockRestore()
  })
})
