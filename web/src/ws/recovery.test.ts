import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MessengerWebSocketClient } from './client'
import { MockWebSocketServer } from './mock/server'
import type { HistoryAdapter, HistoryMessage, HistoryPage, MessageNewEvent } from './types'

const USER_ID = '60000000-0000-4000-8000-000000000001'
const OTHER_USER_ID = '60000000-0000-4000-8000-000000000002'
const CHAT_ID = '20000000-0000-4000-8000-000000000001'
const CLIENT_ID = '30000000-0000-4000-8000-000000000001'

function message(seq: number): HistoryMessage {
  return {
    id: `40000000-0000-4000-8000-${String(seq).padStart(12, '0')}`,
    chat_id: CHAT_ID,
    seq,
    sender_id: OTHER_USER_ID,
    body: `message ${seq}`,
    created_at: `2026-11-08T12:00:${String(seq).padStart(2, '0')}Z`,
  }
}

function wsMessage(seq: number): MessageNewEvent {
  const value = message(seq)
  return {
    type: 'message.new',
    id: `50000000-0000-4000-8000-${String(seq).padStart(12, '0')}`,
    ts: value.created_at,
    payload: {
      chat_id: value.chat_id,
      client_msg_id: `30000000-0000-4000-8000-${String(seq).padStart(12, '0')}`,
      message_id: value.id,
      sender_id: value.sender_id,
      seq: value.seq,
      body: value.body,
      created_at: value.created_at,
    },
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

async function flushMicrotasks() {
  for (let index = 0; index < 6; index++) await Promise.resolve()
}

function createClient(history: HistoryAdapter, server: MockWebSocketServer) {
  return new MessengerWebSocketClient({
    wsOrigin: 'ws://localhost',
    accessToken: 'access',
    currentUserId: USER_ID,
    webSocketFactory: server.webSocketFactory,
    history,
  })
}

function rateLimitNextMessage(server: MockWebSocketServer): void {
  server.failNextCommand({
    code: 'rate_limited',
    message: 'retry later',
    retryable: true,
    request_type: 'message.send',
    client_msg_id: null,
  })
}

describe('history recovery', () => {
  it('completes an empty history without advancing a cursor', async () => {
    const server = new MockWebSocketServer({ senderId: USER_ID })
    const history: HistoryAdapter = {
      listChats: vi.fn().mockResolvedValue([]),
      getMessages: vi.fn(),
    }
    const client = createClient(history, server)
    client.start()
    await flushMicrotasks()
    expect(client.getSnapshot().history).toBe('ready')
    expect(client.getSyncedCursor(CHAT_ID)).toBe(0)
    expect(history.getMessages).not.toHaveBeenCalled()
  })

  it('uses next_after_seq until has_more_after is false', async () => {
    const server = new MockWebSocketServer({ senderId: USER_ID })
    const getMessages = vi
      .fn()
      .mockResolvedValueOnce({
        messages: [message(1), message(2)],
        next_after_seq: 2,
        has_more_after: true,
      })
      .mockResolvedValueOnce({ messages: [message(3)], next_after_seq: 3, has_more_after: false })
    const history: HistoryAdapter = {
      listChats: vi.fn().mockResolvedValue([{ id: CHAT_ID }]),
      getMessages,
    }
    const client = createClient(history, server)
    client.start()
    await flushMicrotasks()
    expect(getMessages).toHaveBeenNthCalledWith(1, CHAT_ID, 'access', { afterSeq: 0, limit: 100 })
    expect(getMessages).toHaveBeenNthCalledWith(2, CHAT_ID, 'access', { afterSeq: 2, limit: 100 })
    expect(client.getSnapshot().messages.map((item) => item.seq)).toEqual([1, 2, 3])
    expect(client.getSyncedCursor(CHAT_ID)).toBe(3)
  })

  it('accepts an empty final page and keeps its last safe cursor', async () => {
    const server = new MockWebSocketServer({ senderId: USER_ID })
    const history: HistoryAdapter = {
      listChats: vi.fn().mockResolvedValue([{ id: CHAT_ID }]),
      getMessages: vi
        .fn()
        .mockResolvedValueOnce({ messages: [message(1)], next_after_seq: 1, has_more_after: true })
        .mockResolvedValueOnce({ messages: [], next_after_seq: null, has_more_after: false }),
    }
    const client = createClient(history, server)
    client.start()
    await flushMicrotasks()
    expect(client.getSnapshot().history).toBe('ready')
    expect(client.getSyncedCursor(CHAT_ID)).toBe(1)
  })

  it('buffers WebSocket messages during loading and merges without gaps or duplicates', async () => {
    const page = deferred<HistoryPage>()
    const server = new MockWebSocketServer({ senderId: USER_ID })
    const history: HistoryAdapter = {
      listChats: vi.fn().mockResolvedValue([{ id: CHAT_ID }]),
      getMessages: vi.fn().mockReturnValue(page.promise),
    }
    const client = createClient(history, server)
    client.start()
    await flushMicrotasks()
    const connection = Array.from(server.connections)[0]
    if (!connection) throw new Error('Expected a connection')
    connection.serverMessage(JSON.stringify(wsMessage(2)))
    connection.serverMessage(JSON.stringify(wsMessage(3)))
    page.resolve({ messages: [message(1), message(3)], next_after_seq: 3, has_more_after: false })
    await flushMicrotasks()
    expect(client.getSnapshot().messages.map((item) => item.seq)).toEqual([1, 2, 3])
    expect(client.getSnapshot().messages).toHaveLength(3)
    expect(client.getSyncedCursor(CHAT_ID)).toBe(3)
  })

  it('does not advance the synchronized cursor after a failed sync', async () => {
    const server = new MockWebSocketServer({ senderId: USER_ID })
    const getMessages = vi
      .fn()
      .mockResolvedValueOnce({ messages: [message(1)], next_after_seq: 1, has_more_after: false })
      .mockRejectedValueOnce(new Error('history unavailable'))
    const history: HistoryAdapter = {
      listChats: vi.fn().mockResolvedValue([{ id: CHAT_ID }]),
      getMessages,
    }
    const client = createClient(history, server)
    client.start()
    await flushMicrotasks()
    expect(client.getSyncedCursor(CHAT_ID)).toBe(1)
    await client.synchronizeHistory()
    expect(client.getSnapshot().history).toBe('error')
    expect(client.getSyncedCursor(CHAT_ID)).toBe(1)
    client.stop()
  })

  it('preserves existing, partial and buffered messages after a History error', async () => {
    const failedPage = deferred<HistoryPage>()
    const server = new MockWebSocketServer({ senderId: USER_ID })
    const getMessages = vi
      .fn()
      .mockResolvedValueOnce({ messages: [message(1)], next_after_seq: 1, has_more_after: false })
      .mockResolvedValueOnce({ messages: [message(3)], next_after_seq: 3, has_more_after: true })
      .mockReturnValueOnce(failedPage.promise)
    const history: HistoryAdapter = {
      listChats: vi.fn().mockResolvedValue([{ id: CHAT_ID }]),
      getMessages,
    }
    const client = createClient(history, server)
    client.start()
    await flushMicrotasks()
    expect(client.getSnapshot().messages.map((item) => item.seq)).toEqual([1])

    const sync = client.synchronizeHistory()
    await flushMicrotasks()
    const connection = Array.from(server.connections)[0]
    if (!connection) throw new Error('Expected a connection')
    connection.serverMessage(JSON.stringify(wsMessage(2)))
    failedPage.reject(new Error('history unavailable'))
    await sync

    expect(client.getSnapshot().history).toBe('error')
    expect(client.getSnapshot().messages.map((item) => item.seq)).toEqual([1, 2, 3])
    expect(client.getSyncedCursor(CHAT_ID)).toBe(1)
    client.stop()
  })

  it('rejects a non-advancing page instead of looping forever', async () => {
    const server = new MockWebSocketServer({ senderId: USER_ID })
    const history: HistoryAdapter = {
      listChats: vi.fn().mockResolvedValue([{ id: CHAT_ID }]),
      getMessages: vi
        .fn()
        .mockResolvedValue({ messages: [], next_after_seq: null, has_more_after: true }),
    }
    const client = createClient(history, server)
    client.start()
    await flushMicrotasks()
    expect(client.getSnapshot().history).toBe('error')
    expect(client.getSyncedCursor(CHAT_ID)).toBe(0)
    expect(history.getMessages).toHaveBeenCalledOnce()
    client.stop()
  })
})

describe('automatic history retry', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    vi.restoreAllMocks()
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  it('recovers History in a hidden tab and sends pending on the same WebSocket', async () => {
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    const listChats = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(new Error('503 service unavailable'))
      .mockResolvedValueOnce([])
    const history: HistoryAdapter = { listChats, getMessages: vi.fn() }
    const server = new MockWebSocketServer({ senderId: USER_ID })
    const webSocketFactory = vi.fn(server.webSocketFactory)
    const client = new MessengerWebSocketClient({
      wsOrigin: 'ws://localhost',
      accessToken: 'access',
      currentUserId: USER_ID,
      webSocketFactory,
      history,
      random: () => 0.5,
    })

    client.start()
    await flushMicrotasks()
    expect(client.getSnapshot().history).toBe('ready')

    server.disconnectAll(1013, 'temporary disconnect')
    client.sendMessage(CHAT_ID, 'pending body', CLIENT_ID)
    expect(client.getSnapshot().pending[0]).toMatchObject({
      clientMsgId: CLIENT_ID,
      body: 'pending body',
      status: 'pending',
      attempts: 0,
    })

    await vi.advanceTimersByTimeAsync(1_000)
    await flushMicrotasks()

    expect(webSocketFactory).toHaveBeenCalledTimes(2)
    expect(client.getSnapshot().history).toBe('error')
    expect(client.getSnapshot().pending[0]?.attempts).toBe(0)
    expect(server.received).toHaveLength(0)

    await vi.advanceTimersByTimeAsync(1_000)
    await flushMicrotasks()
    await vi.advanceTimersByTimeAsync(0)

    expect(listChats).toHaveBeenCalledTimes(3)
    expect(client.getSnapshot().history).toBe('ready')
    expect(client.getSnapshot().transport).toBe('connected')
    expect(client.getSnapshot().pending[0]).toMatchObject({
      clientMsgId: CLIENT_ID,
      body: 'pending body',
      attempts: 1,
    })
    expect(server.received).toHaveLength(1)
    expect(server.received[0]?.payload).toEqual({
      chat_id: CHAT_ID,
      client_msg_id: CLIENT_ID,
      body: 'pending body',
    })
    expect(webSocketFactory).toHaveBeenCalledTimes(2)

    client.stop()
  })

  it('queues messages sent after reconnect until History has caught up', async () => {
    const delayed = deferred<HistoryPage>()
    const getMessages = vi.fn().mockReturnValueOnce(delayed.promise)
    const listChats = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValue([{ id: CHAT_ID }])
    const server = new MockWebSocketServer({ senderId: USER_ID })
    const client = new MessengerWebSocketClient({
      wsOrigin: 'ws://localhost',
      accessToken: 'access',
      currentUserId: USER_ID,
      webSocketFactory: server.webSocketFactory,
      history: { listChats, getMessages },
      random: () => 0.5,
    })
    client.start()
    await flushMicrotasks()
    server.disconnectAll(1013)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(client.getSnapshot()).toMatchObject({ transport: 'connected', history: 'syncing' })

    client.sendMessage(CHAT_ID, 'queued while catching up', CLIENT_ID)
    expect(server.received).toHaveLength(0)
    expect(client.getSnapshot().pending[0]).toMatchObject({ status: 'pending', attempts: 0 })

    delayed.resolve({ messages: [], next_after_seq: null, has_more_after: false })
    await flushMicrotasks()
    expect(client.getSnapshot().history).toBe('ready')
    expect(server.received).toHaveLength(1)
    expect(server.received[0]?.payload.client_msg_id).toBe(CLIENT_ID)
    client.stop()
  })

  it('does not fetch History pages if listChats resolves after stop', async () => {
    const delayed = deferred<readonly { id: string }[]>()
    const listChats = vi.fn().mockReturnValue(delayed.promise)
    const getMessages = vi.fn().mockResolvedValue({
      messages: [message(1)],
      next_after_seq: 1,
      has_more_after: false,
    })
    const server = new MockWebSocketServer({ senderId: USER_ID })
    const client = createClient({ listChats, getMessages }, server)
    client.start()
    await flushMicrotasks()
    expect(listChats).toHaveBeenCalledOnce()

    client.stop()
    delayed.resolve([{ id: CHAT_ID }])
    await flushMicrotasks()
    expect(getMessages).not.toHaveBeenCalled()
    expect(client.getSyncedCursor(CHAT_ID)).toBe(0)
    expect(client.getSnapshot().messages).toEqual([])
  })

  it('keeps a scheduled History recovery retry when the tab becomes hidden', async () => {
    let visibilityState: DocumentVisibilityState = 'visible'
    vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibilityState)
    const listChats = vi
      .fn()
      .mockRejectedValueOnce(new Error('503 service unavailable'))
      .mockResolvedValueOnce([])
    const history: HistoryAdapter = { listChats, getMessages: vi.fn() }
    const server = new MockWebSocketServer({ senderId: USER_ID })
    const client = new MessengerWebSocketClient({
      wsOrigin: 'ws://localhost',
      accessToken: 'access',
      currentUserId: USER_ID,
      webSocketFactory: server.webSocketFactory,
      history,
      random: () => 0.5,
    })

    client.start()
    await flushMicrotasks()
    expect(client.getSnapshot().history).toBe('error')

    visibilityState = 'hidden'
    document.dispatchEvent(new Event('visibilitychange'))
    await vi.advanceTimersByTimeAsync(1_000)
    await flushMicrotasks()

    expect(listChats).toHaveBeenCalledTimes(2)
    expect(client.getSnapshot().history).toBe('ready')

    client.stop()
  })

  it('deduplicates visibility synchronization with an active hidden-tab recovery retry', async () => {
    let visibilityState: DocumentVisibilityState = 'hidden'
    vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibilityState)
    const retry = deferred<readonly { id: string }[]>()
    const listChats = vi
      .fn()
      .mockRejectedValueOnce(new Error('503 service unavailable'))
      .mockReturnValueOnce(retry.promise)
    const history: HistoryAdapter = { listChats, getMessages: vi.fn() }
    const server = new MockWebSocketServer({ senderId: USER_ID })
    const client = new MessengerWebSocketClient({
      wsOrigin: 'ws://localhost',
      accessToken: 'access',
      currentUserId: USER_ID,
      webSocketFactory: server.webSocketFactory,
      history,
      random: () => 0.5,
    })

    client.start()
    await flushMicrotasks()
    expect(client.getSnapshot().history).toBe('error')

    await vi.advanceTimersByTimeAsync(1_000)
    await flushMicrotasks()
    expect(listChats).toHaveBeenCalledTimes(2)

    visibilityState = 'visible'
    document.dispatchEvent(new Event('visibilitychange'))
    await vi.advanceTimersByTimeAsync(5_000)
    expect(listChats).toHaveBeenCalledTimes(2)

    retry.resolve([])
    await flushMicrotasks()
    expect(client.getSnapshot().history).toBe('ready')

    client.stop()
  })

  it('uses exponential backoff across failures and resets it after success', async () => {
    const listChats = vi
      .fn()
      .mockRejectedValueOnce(new Error('first failure'))
      .mockRejectedValueOnce(new Error('second failure'))
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(new Error('failure after recovery'))
      .mockResolvedValueOnce([])
    const history: HistoryAdapter = { listChats, getMessages: vi.fn() }
    const server = new MockWebSocketServer({ senderId: USER_ID })
    const client = new MessengerWebSocketClient({
      wsOrigin: 'ws://localhost',
      accessToken: 'access',
      currentUserId: USER_ID,
      webSocketFactory: server.webSocketFactory,
      history,
      random: () => 0.5,
    })

    client.start()
    await flushMicrotasks()
    expect(client.getSnapshot().history).toBe('error')

    await vi.advanceTimersByTimeAsync(999)
    expect(listChats).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    await flushMicrotasks()
    expect(listChats).toHaveBeenCalledTimes(2)
    expect(client.getSnapshot().history).toBe('error')

    await vi.advanceTimersByTimeAsync(1_999)
    expect(listChats).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1)
    await flushMicrotasks()
    expect(listChats).toHaveBeenCalledTimes(3)
    expect(client.getSnapshot().history).toBe('ready')

    await client.synchronizeHistory()
    expect(listChats).toHaveBeenCalledTimes(4)
    expect(client.getSnapshot().history).toBe('error')
    await vi.advanceTimersByTimeAsync(999)
    expect(listChats).toHaveBeenCalledTimes(4)
    await vi.advanceTimersByTimeAsync(1)
    await flushMicrotasks()
    expect(listChats).toHaveBeenCalledTimes(5)
    expect(client.getSnapshot().history).toBe('ready')

    client.stop()
  })

  it('retries an interrupted page from the last confirmed safe cursor', async () => {
    const getMessages = vi
      .fn()
      .mockResolvedValueOnce({ messages: [message(1)], next_after_seq: 1, has_more_after: false })
      .mockResolvedValueOnce({ messages: [message(2)], next_after_seq: 2, has_more_after: true })
      .mockRejectedValueOnce(new Error('next page unavailable'))
      .mockResolvedValueOnce({
        messages: [message(2), message(3)],
        next_after_seq: 3,
        has_more_after: false,
      })
    const history: HistoryAdapter = {
      listChats: vi.fn().mockResolvedValue([{ id: CHAT_ID }]),
      getMessages,
    }
    const server = new MockWebSocketServer({ senderId: USER_ID })
    const client = new MessengerWebSocketClient({
      wsOrigin: 'ws://localhost',
      accessToken: 'access',
      currentUserId: USER_ID,
      webSocketFactory: server.webSocketFactory,
      history,
      random: () => 0.5,
    })

    client.start()
    await flushMicrotasks()
    expect(client.getSyncedCursor(CHAT_ID)).toBe(1)

    await client.synchronizeHistory()
    expect(client.getSnapshot().history).toBe('error')
    expect(client.getSyncedCursor(CHAT_ID)).toBe(1)

    await vi.advanceTimersByTimeAsync(1_000)
    await flushMicrotasks()

    expect(getMessages).toHaveBeenNthCalledWith(4, CHAT_ID, 'access', {
      afterSeq: 1,
      limit: 100,
    })
    expect(client.getSnapshot().messages.map((item) => item.seq)).toEqual([1, 2, 3])
    expect(client.getSyncedCursor(CHAT_ID)).toBe(3)
    expect(client.getSnapshot().history).toBe('ready')

    client.stop()
  })

  it('does not start parallel History requests or keep an obsolete retry timer', async () => {
    const recovered = deferred<readonly { id: string }[]>()
    const listChats = vi
      .fn()
      .mockRejectedValueOnce(new Error('temporary failure'))
      .mockReturnValueOnce(recovered.promise)
    const history: HistoryAdapter = { listChats, getMessages: vi.fn() }
    const server = new MockWebSocketServer({ senderId: USER_ID })
    const client = new MessengerWebSocketClient({
      wsOrigin: 'ws://localhost',
      accessToken: 'access',
      currentUserId: USER_ID,
      webSocketFactory: server.webSocketFactory,
      history,
      random: () => 0.5,
    })

    client.start()
    await flushMicrotasks()
    expect(client.getSnapshot().history).toBe('error')

    const firstSync = client.synchronizeHistory()
    const duplicateSync = client.synchronizeHistory()
    expect(duplicateSync).toBe(firstSync)
    expect(listChats).toHaveBeenCalledTimes(2)

    await vi.advanceTimersByTimeAsync(5_000)
    expect(listChats).toHaveBeenCalledTimes(2)

    recovered.resolve([])
    await firstSync
    expect(client.getSnapshot().history).toBe('ready')

    client.stop()
  })

  it('cancels a scheduled History retry on stop', async () => {
    const listChats = vi.fn().mockRejectedValue(new Error('temporary failure'))
    const history: HistoryAdapter = { listChats, getMessages: vi.fn() }
    const server = new MockWebSocketServer({ senderId: USER_ID })
    const client = new MessengerWebSocketClient({
      wsOrigin: 'ws://localhost',
      accessToken: 'access',
      currentUserId: USER_ID,
      webSocketFactory: server.webSocketFactory,
      history,
      random: () => 0.5,
    })

    client.start()
    await flushMicrotasks()
    expect(client.getSnapshot().history).toBe('error')

    client.stop()
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(60_000)

    expect(listChats).toHaveBeenCalledOnce()
    expect(client.getSnapshot().transport).toBe('stopped')
  })

  it('discards a scheduled History retry when a new WebSocket generation starts', async () => {
    const listChats = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(new Error('temporary failure'))
      .mockResolvedValueOnce([])
    const history: HistoryAdapter = { listChats, getMessages: vi.fn() }
    const server = new MockWebSocketServer({ senderId: USER_ID })
    const webSocketFactory = vi.fn(server.webSocketFactory)
    const client = new MessengerWebSocketClient({
      wsOrigin: 'ws://localhost',
      accessToken: 'access',
      currentUserId: USER_ID,
      webSocketFactory,
      history,
      random: () => 0.5,
    })

    client.start()
    await flushMicrotasks()
    await client.synchronizeHistory()
    expect(client.getSnapshot().history).toBe('error')

    server.disconnectAll(1013, 'new generation')
    await vi.advanceTimersByTimeAsync(1_000)
    await flushMicrotasks()

    expect(webSocketFactory).toHaveBeenCalledTimes(2)
    expect(listChats).toHaveBeenCalledTimes(3)
    expect(client.getSnapshot().history).toBe('ready')

    await vi.advanceTimersByTimeAsync(2_000)
    expect(listChats).toHaveBeenCalledTimes(3)

    client.stop()
  })

  it('ignores completion of an in-flight History request from an old generation', async () => {
    const staleRequest = deferred<readonly { id: string }[]>()
    const listChats = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockReturnValueOnce(staleRequest.promise)
      .mockResolvedValueOnce([])
    const history: HistoryAdapter = { listChats, getMessages: vi.fn() }
    const server = new MockWebSocketServer({ senderId: USER_ID })
    const client = new MessengerWebSocketClient({
      wsOrigin: 'ws://localhost',
      accessToken: 'access',
      currentUserId: USER_ID,
      webSocketFactory: server.webSocketFactory,
      history,
      random: () => 0.5,
    })

    client.start()
    await flushMicrotasks()
    const staleSync = client.synchronizeHistory()
    await flushMicrotasks()

    server.disconnectAll(1013, 'new generation')
    await vi.advanceTimersByTimeAsync(1_000)
    await flushMicrotasks()
    expect(client.getSnapshot().history).toBe('ready')

    staleRequest.reject(new Error('stale failure'))
    await staleSync
    await flushMicrotasks()

    expect(client.getSnapshot().history).toBe('ready')
    await vi.advanceTimersByTimeAsync(2_000)
    expect(listChats).toHaveBeenCalledTimes(3)

    client.stop()
  })
})

describe('message retry backoff during History synchronization', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    vi.restoreAllMocks()
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  it('backs off the queued sends after message.send is rate limited', async () => {
    const server = new MockWebSocketServer({
      senderId: USER_ID,
      ackDelayMs: 50,
      newDelayMs: 50,
    })
    const client = new MessengerWebSocketClient({
      wsOrigin: 'ws://localhost',
      accessToken: 'access',
      currentUserId: USER_ID,
      webSocketFactory: server.webSocketFactory,
      random: () => 0.5,
    })

    client.start()
    await flushMicrotasks()
    server.disconnectAll(1013)
    const first = client.sendMessage(CHAT_ID, 'first in queue', CLIENT_ID)
    const second = client.sendMessage(CHAT_ID, 'second in queue')
    rateLimitNextMessage(server)

    await vi.advanceTimersByTimeAsync(1_000)
    expect(server.received.map((event) => event.payload.client_msg_id)).toEqual([first.clientMsgId])
    await vi.advanceTimersByTimeAsync(999)
    expect(server.received).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(1)
    expect(server.received).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(50)
    expect(server.received.map((event) => event.payload.client_msg_id)).toEqual([
      first.clientMsgId,
      first.clientMsgId,
      second.clientMsgId,
    ])
    expect(server.received[1]?.payload).toEqual(server.received[0]?.payload)
    expect(server.received[1]?.id).not.toBe(server.received[0]?.id)
    client.stop()
  })

  it('preserves a rate-limited retry deadline across periodic History sync', async () => {
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
    const listChats = vi.fn().mockResolvedValue([])
    const history: HistoryAdapter = { listChats, getMessages: vi.fn() }
    const server = new MockWebSocketServer({ senderId: USER_ID })
    const client = new MessengerWebSocketClient({
      wsOrigin: 'ws://localhost',
      accessToken: 'access',
      currentUserId: USER_ID,
      webSocketFactory: server.webSocketFactory,
      history,
      random: () => 0.5,
    })

    client.start()
    await flushMicrotasks()
    await vi.advanceTimersByTimeAsync(29_900)

    rateLimitNextMessage(server)
    client.sendMessage(CHAT_ID, 'rate limited', CLIENT_ID)
    expect(server.received).toHaveLength(1)
    expect(client.getSnapshot().pending[0]).toMatchObject({ attempts: 1, status: 'pending' })

    await vi.advanceTimersByTimeAsync(100)
    await flushMicrotasks()
    expect(listChats).toHaveBeenCalledTimes(2)
    expect(server.received).toHaveLength(1)
    expect(client.getSnapshot().pending[0]?.attempts).toBe(1)

    await vi.advanceTimersByTimeAsync(899)
    expect(server.received).toHaveLength(1)
    expect(client.getSnapshot().pending[0]?.attempts).toBe(1)

    await vi.advanceTimersByTimeAsync(1)
    expect(server.received).toHaveLength(2)
    expect(server.received[1]?.id).not.toBe(server.received[0]?.id)
    expect(server.received[1]?.payload).toEqual(server.received[0]?.payload)
    expect(client.getSnapshot().pending[0]?.attempts).toBe(2)

    client.stop()
  })

  it('preserves a rate-limited retry deadline across visibility History sync', async () => {
    let visibilityState: DocumentVisibilityState = 'hidden'
    vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibilityState)
    const listChats = vi.fn().mockResolvedValue([])
    const history: HistoryAdapter = { listChats, getMessages: vi.fn() }
    const server = new MockWebSocketServer({ senderId: USER_ID })
    const client = new MessengerWebSocketClient({
      wsOrigin: 'ws://localhost',
      accessToken: 'access',
      currentUserId: USER_ID,
      webSocketFactory: server.webSocketFactory,
      history,
      random: () => 0.5,
    })

    client.start()
    await flushMicrotasks()
    rateLimitNextMessage(server)
    client.sendMessage(CHAT_ID, 'rate limited', CLIENT_ID)

    await vi.advanceTimersByTimeAsync(100)
    visibilityState = 'visible'
    document.dispatchEvent(new Event('visibilitychange'))
    await flushMicrotasks()

    expect(listChats).toHaveBeenCalledTimes(2)
    expect(server.received).toHaveLength(1)
    expect(client.getSnapshot().pending[0]?.attempts).toBe(1)

    await vi.advanceTimersByTimeAsync(899)
    expect(server.received).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(server.received).toHaveLength(2)
    expect(client.getSnapshot().pending[0]?.attempts).toBe(2)

    client.stop()
  })

  it('does not bypass maxAutomaticAttempts after successful History sync', async () => {
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    const history: HistoryAdapter = {
      listChats: vi.fn().mockResolvedValue([]),
      getMessages: vi.fn(),
    }
    const server = new MockWebSocketServer({ senderId: USER_ID })
    const client = new MessengerWebSocketClient({
      wsOrigin: 'ws://localhost',
      accessToken: 'access',
      currentUserId: USER_ID,
      webSocketFactory: server.webSocketFactory,
      history,
      maxAutomaticAttempts: 1,
      random: () => 0.5,
    })

    client.start()
    await flushMicrotasks()
    rateLimitNextMessage(server)
    client.sendMessage(CHAT_ID, 'limited attempts', CLIENT_ID)
    expect(client.getSnapshot().pending[0]).toMatchObject({
      attempts: 1,
      status: 'failed',
      errorCode: 'retry_limit_reached',
    })

    await client.synchronizeHistory()
    await vi.advanceTimersByTimeAsync(10_000)

    expect(server.received).toHaveLength(1)
    expect(client.getSnapshot().pending[0]?.attempts).toBe(1)

    client.stop()
  })

  it('keeps the scheduled send backoff across a reconnect and completed recovery', async () => {
    const history: HistoryAdapter = {
      listChats: vi.fn().mockResolvedValue([]),
      getMessages: vi.fn(),
    }
    const server = new MockWebSocketServer({
      senderId: USER_ID,
      ackDelayMs: 50,
      newDelayMs: 50,
    })
    const client = new MessengerWebSocketClient({
      wsOrigin: 'ws://localhost',
      accessToken: 'access',
      currentUserId: USER_ID,
      webSocketFactory: server.webSocketFactory,
      history,
      random: () => 0.5,
    })
    client.start()
    await flushMicrotasks()

    rateLimitNextMessage(server)
    client.sendMessage(CHAT_ID, 'wait for retry', CLIENT_ID)
    rateLimitNextMessage(server)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(server.received).toHaveLength(2)
    server.disconnectAll(1013)
    const queued = client.sendMessage(CHAT_ID, 'queued across reconnect')

    await vi.advanceTimersByTimeAsync(1_000)
    expect(client.getSnapshot()).toMatchObject({ transport: 'connected', history: 'ready' })
    expect(server.received).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(999)
    expect(server.received).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(server.received).toHaveLength(3)
    await vi.advanceTimersByTimeAsync(50)
    expect(server.received).toHaveLength(4)
    expect(server.received[2]?.payload.client_msg_id).toBe(CLIENT_ID)
    expect(server.received[3]?.payload.client_msg_id).toBe(queued.clientMsgId)
    client.stop()
  })

  it('ignores an ack from the retired socket and retries after recovering history', async () => {
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    const history: HistoryAdapter = {
      listChats: vi.fn().mockResolvedValue([]),
      getMessages: vi.fn(),
    }
    const server = new MockWebSocketServer({ senderId: OTHER_USER_ID, dropAcks: 1 })
    const client = new MessengerWebSocketClient({
      wsOrigin: 'ws://localhost',
      accessToken: 'access',
      currentUserId: USER_ID,
      webSocketFactory: server.webSocketFactory,
      history,
      ackTimeoutMs: 100,
      random: () => 0.5,
    })

    client.start()
    await flushMicrotasks()
    client.sendMessage(CHAT_ID, 'late ack', CLIENT_ID)
    const firstAttempt = server.received[0]
    const stored = server.storedMessages[0]
    const connection = Array.from(server.connections)[0]
    const onmessage = connection?.onmessage
    if (!firstAttempt || !stored || !onmessage) throw new Error('Expected a sent attempt')

    await vi.advanceTimersByTimeAsync(100)
    onmessage({
      data: JSON.stringify({
        type: 'message.ack',
        id: firstAttempt.id,
        ts: '2026-11-08T12:00:00Z',
        payload: {
          chat_id: stored.chatId,
          client_msg_id: stored.clientMsgId,
          message_id: stored.messageId,
          seq: stored.seq,
          created_at: stored.createdAt,
        },
      }),
    })
    expect(client.getSnapshot().pending[0]?.status).toBe('pending')
    await vi.advanceTimersByTimeAsync(1_001)

    expect(server.received).toHaveLength(2)
    expect(server.received[1]?.payload).toEqual(firstAttempt.payload)
    expect(client.getSnapshot().pending[0]).toMatchObject({ attempts: 2, status: 'sent' })

    client.stop()
  })

  it('cancels a scheduled message retry on stop', async () => {
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    const history: HistoryAdapter = {
      listChats: vi.fn().mockResolvedValue([]),
      getMessages: vi.fn(),
    }
    const server = new MockWebSocketServer({ senderId: USER_ID })
    const client = new MessengerWebSocketClient({
      wsOrigin: 'ws://localhost',
      accessToken: 'access',
      currentUserId: USER_ID,
      webSocketFactory: server.webSocketFactory,
      history,
      random: () => 0.5,
    })

    client.start()
    await flushMicrotasks()
    rateLimitNextMessage(server)
    client.sendMessage(CHAT_ID, 'stop during retry', CLIENT_ID)

    client.stop()
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(1_000)

    expect(server.received).toHaveLength(1)
    expect(client.getSnapshot().pending[0]?.attempts).toBe(1)
  })
})

describe('active tab history synchronization', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  it('recovers a lost message from History after thirty seconds without reconnecting', async () => {
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
    const getMessages = vi
      .fn()
      .mockResolvedValueOnce({ messages: [], next_after_seq: null, has_more_after: false })
      .mockResolvedValueOnce({
        messages: [message(1)],
        next_after_seq: 1,
        has_more_after: false,
      })
    const history: HistoryAdapter = {
      listChats: vi.fn().mockResolvedValue([{ id: CHAT_ID }]),
      getMessages,
    }
    const server = new MockWebSocketServer({ senderId: USER_ID })
    const webSocketFactory = vi.fn(server.webSocketFactory)
    const client = new MessengerWebSocketClient({
      wsOrigin: 'ws://localhost',
      accessToken: 'access',
      currentUserId: USER_ID,
      webSocketFactory,
      history,
    })

    client.start()
    await flushMicrotasks()
    expect(client.getSnapshot().messages).toHaveLength(0)

    await vi.advanceTimersByTimeAsync(29_999)
    expect(getMessages).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(1)
    await flushMicrotasks()

    expect(getMessages).toHaveBeenCalledTimes(2)
    expect(client.getSnapshot().messages.map((item) => item.seq)).toEqual([1])
    expect(client.getSyncedCursor(CHAT_ID)).toBe(1)
    expect(webSocketFactory).toHaveBeenCalledOnce()
    expect(server.connections.size).toBe(1)

    client.stop()
  })

  it('pauses periodic sync while hidden and synchronizes immediately when visible', async () => {
    let visibilityState: DocumentVisibilityState = 'hidden'
    vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibilityState)
    const getMessages = vi
      .fn()
      .mockResolvedValueOnce({ messages: [], next_after_seq: null, has_more_after: false })
      .mockResolvedValueOnce({
        messages: [message(1)],
        next_after_seq: 1,
        has_more_after: false,
      })
    const history: HistoryAdapter = {
      listChats: vi.fn().mockResolvedValue([{ id: CHAT_ID }]),
      getMessages,
    }
    const server = new MockWebSocketServer({ senderId: USER_ID })
    const client = createClient(history, server)

    client.start()
    await flushMicrotasks()
    expect(getMessages).toHaveBeenCalledOnce()

    await vi.advanceTimersByTimeAsync(60_000)
    expect(getMessages).toHaveBeenCalledOnce()

    visibilityState = 'visible'
    document.dispatchEvent(new Event('visibilitychange'))
    await flushMicrotasks()

    expect(getMessages).toHaveBeenCalledTimes(2)
    expect(client.getSnapshot().messages.map((item) => item.seq)).toEqual([1])
    expect(client.getSyncedCursor(CHAT_ID)).toBe(1)

    client.stop()
  })

  it('deduplicates periodic and visibility synchronization while a request is active', async () => {
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
    const activeSync = deferred<readonly { id: string }[]>()
    const listChats = vi.fn().mockResolvedValueOnce([]).mockReturnValueOnce(activeSync.promise)
    const history: HistoryAdapter = { listChats, getMessages: vi.fn() }
    const server = new MockWebSocketServer({ senderId: USER_ID })
    const client = createClient(history, server)

    client.start()
    await flushMicrotasks()
    await vi.advanceTimersByTimeAsync(30_000)
    await flushMicrotasks()
    expect(listChats).toHaveBeenCalledTimes(2)

    document.dispatchEvent(new Event('visibilitychange'))
    document.dispatchEvent(new Event('visibilitychange'))
    await vi.advanceTimersByTimeAsync(60_000)
    expect(listChats).toHaveBeenCalledTimes(2)

    activeSync.resolve([])
    await flushMicrotasks()
    expect(client.getSnapshot().history).toBe('ready')

    client.stop()
  })

  it('hands a periodic failure to History backoff without advancing the safe cursor', async () => {
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
    const getMessages = vi
      .fn()
      .mockResolvedValueOnce({ messages: [message(1)], next_after_seq: 1, has_more_after: false })
      .mockResolvedValueOnce({ messages: [message(2)], next_after_seq: 2, has_more_after: true })
      .mockRejectedValueOnce(new Error('history unavailable'))
      .mockResolvedValueOnce({
        messages: [message(2), message(3)],
        next_after_seq: 3,
        has_more_after: false,
      })
    const history: HistoryAdapter = {
      listChats: vi.fn().mockResolvedValue([{ id: CHAT_ID }]),
      getMessages,
    }
    const server = new MockWebSocketServer({ senderId: USER_ID })
    const client = new MessengerWebSocketClient({
      wsOrigin: 'ws://localhost',
      accessToken: 'access',
      currentUserId: USER_ID,
      webSocketFactory: server.webSocketFactory,
      history,
      random: () => 0.5,
    })

    client.start()
    await flushMicrotasks()
    expect(client.getSyncedCursor(CHAT_ID)).toBe(1)

    await vi.advanceTimersByTimeAsync(30_000)
    await flushMicrotasks()
    expect(client.getSnapshot().history).toBe('error')
    expect(client.getSyncedCursor(CHAT_ID)).toBe(1)

    await vi.advanceTimersByTimeAsync(999)
    expect(getMessages).toHaveBeenCalledTimes(3)
    await vi.advanceTimersByTimeAsync(1)
    await flushMicrotasks()

    expect(getMessages).toHaveBeenNthCalledWith(4, CHAT_ID, 'access', {
      afterSeq: 1,
      limit: 100,
    })
    expect(client.getSnapshot().messages.map((item) => item.seq)).toEqual([1, 2, 3])
    expect(client.getSyncedCursor(CHAT_ID)).toBe(3)
    expect(client.getSnapshot().history).toBe('ready')

    client.stop()
  })

  it('removes periodic timers and the visibility listener on stop', async () => {
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
    const removeEventListener = vi.spyOn(document, 'removeEventListener')
    const listChats = vi.fn().mockResolvedValue([])
    const history: HistoryAdapter = { listChats, getMessages: vi.fn() }
    const server = new MockWebSocketServer({ senderId: USER_ID })
    const client = createClient(history, server)

    client.start()
    await flushMicrotasks()
    client.stop()

    expect(removeEventListener).toHaveBeenCalledWith('visibilitychange', expect.any(Function))
    expect(vi.getTimerCount()).toBe(0)

    document.dispatchEvent(new Event('visibilitychange'))
    await vi.advanceTimersByTimeAsync(60_000)
    expect(listChats).toHaveBeenCalledOnce()
  })

  it('does not require document in a non-browser environment', async () => {
    vi.stubGlobal('document', undefined)
    const history: HistoryAdapter = {
      listChats: vi.fn().mockResolvedValue([]),
      getMessages: vi.fn(),
    }
    const server = new MockWebSocketServer({ senderId: USER_ID })
    const client = createClient(history, server)

    expect(() => client.start()).not.toThrow()
    await flushMicrotasks()
    expect(client.getSnapshot().history).toBe('ready')

    client.stop()
    expect(vi.getTimerCount()).toBe(0)
  })
})
