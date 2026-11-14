import { describe, expect, it, vi } from 'vitest'
import { MessengerWebSocketClient } from './client'
import { MockWebSocketServer } from './mock/server'
import type { HistoryAdapter, HistoryMessage, HistoryPage, MessageNewEvent } from './types'

const USER_ID = '60000000-0000-4000-8000-000000000001'
const OTHER_USER_ID = '60000000-0000-4000-8000-000000000002'
const CHAT_ID = '20000000-0000-4000-8000-000000000001'

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
  })
})
