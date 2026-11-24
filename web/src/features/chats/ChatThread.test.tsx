import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { User } from '@/api/auth'
import { login } from '@/api/auth'
import { AuthContext, type AuthContextValue } from '@/features/auth/auth-context'
import { ChatThread } from '@/features/chats/ChatThread'
import { WsProvider } from '@/features/ws/WsProvider'
import { MockWebSocketServer } from '@/ws/mock/server'
import { server } from '../../../mocks/server'
import { INITIAL_CHAT_ID } from '../../../mocks/data/history'

const ALICE: User = {
  id: '00000000-0000-4000-8000-000000000001',
  username: 'alice_1',
  created_at: '2026-01-01T00:00:00Z',
}

async function authValue(): Promise<AuthContextValue> {
  const session = await login({ username: 'alice_1', password: 'correct-horse-battery' })
  return {
    user: ALICE,
    accessToken: session.access_token,
    isReady: true,
    isAuthenticated: true,
    logoutError: null,
    login: async () => undefined,
    register: async () => undefined,
    logout: async () => undefined,
  }
}

function renderThread(
  auth: AuthContextValue,
  mockWs: MockWebSocketServer,
  onReadCommitted?: () => void,
) {
  return render(
    <AuthContext.Provider value={auth}>
      <WsProvider webSocketFactory={mockWs.webSocketFactory} disableApiMockSocket>
        <MemoryRouter>
          <ChatThread
            chatId={INITIAL_CHAT_ID}
            peerUsername="bob_2"
            onReadCommitted={onReadCommitted}
          />
        </MemoryRouter>
      </WsProvider>
    </AuthContext.Provider>,
  )
}

describe('ChatThread', () => {
  beforeEach(() => {
    class MockIntersectionObserver {
      readonly callback: IntersectionObserverCallback

      constructor(callback: IntersectionObserverCallback) {
        this.callback = callback
      }

      observe(target: Element) {
        queueMicrotask(() => {
          this.callback(
            [
              {
                isIntersecting: true,
                target,
                intersectionRatio: 1,
                time: 0,
                boundingClientRect: target.getBoundingClientRect(),
                intersectionRect: target.getBoundingClientRect(),
                rootBounds: null,
              },
            ],
            this as unknown as IntersectionObserver,
          )
        })
      }

      unobserve() {}

      disconnect() {}

      takeRecords(): IntersectionObserverEntry[] {
        return []
      }

      readonly root = null
      readonly rootMargin = ''
      readonly thresholds = [0.6]
    }

    vi.stubGlobal('IntersectionObserver', MockIntersectionObserver)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('loads history and shows peer header', async () => {
    const auth = await authValue()
    const mockWs = new MockWebSocketServer({ senderId: ALICE.id })
    mockWs.ensureSequenceAtLeast(INITIAL_CHAT_ID, 6)
    renderThread(auth, mockWs)

    expect(await screen.findByRole('heading', { name: 'bob_2' })).toBeInTheDocument()
    expect(await screen.findByText('Привет, Боб!')).toBeInTheDocument()
    expect(screen.getByText('Да, договорились.')).toBeInTheDocument()
  })

  it('exposes Later menu with four options and saves without due', async () => {
    const auth = await authValue()
    const mockWs = new MockWebSocketServer({ senderId: ALICE.id })
    mockWs.ensureSequenceAtLeast(INITIAL_CHAT_ID, 6)
    renderThread(auth, mockWs)

    await screen.findByText('Да, договорились.')
    const menus = screen.getAllByRole('button', { name: 'Действия с сообщением' })
    expect(menus.length).toBeGreaterThan(0)
    await userEvent.click(menus[0]!)
    expect(screen.getByRole('menuitem', { name: 'Просто сохранить' })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: 'Через 1 час' })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: /Вечером/ })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: 'Выбрать время' })).toBeInTheDocument()
    await userEvent.click(screen.getByRole('menuitem', { name: 'Просто сохранить' }))
    expect(await screen.findByRole('status')).toHaveTextContent(/Сохранено без срока/i)
  })

  it('shows loading then error with retry', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let calls = 0
    server.use(
      http.get(`/chats/${INITIAL_CHAT_ID}/messages`, async () => {
        calls += 1
        await gate
        if (calls === 1) {
          return HttpResponse.json({ code: 'unknown_error', message: 'down' }, { status: 503 })
        }
        return HttpResponse.json({
          messages: [],
          next_before_seq: null,
          next_after_seq: null,
          has_more_before: false,
          has_more_after: false,
        })
      }),
    )
    const auth = await authValue()
    const mockWs = new MockWebSocketServer({ senderId: ALICE.id })
    renderThread(auth, mockWs)

    expect(screen.getByText(/Загрузка сообщений/i)).toBeInTheDocument()
    await act(async () => {
      release()
    })
    expect(await screen.findByRole('alert')).toHaveTextContent(/Не удалось загрузить сообщения/i)
    await userEvent.click(screen.getByRole('button', { name: 'Повторить' }))
    expect(await screen.findByText(/Напишите первое сообщение/i)).toBeInTheDocument()
  })

  it('sends a message over WebSocket and moves sending → sent', async () => {
    const auth = await authValue()
    const mockWs = new MockWebSocketServer({ senderId: ALICE.id })
    mockWs.ensureSequenceAtLeast(INITIAL_CHAT_ID, 6)
    renderThread(auth, mockWs)

    await screen.findByText('Да, договорились.')
    await waitFor(() => expect(mockWs.connections.size).toBeGreaterThan(0))

    const user = userEvent.setup()
    await user.type(screen.getByLabelText('Сообщение'), 'новое из теста')
    await user.click(screen.getByRole('button', { name: 'Отправить' }))

    const sentBubble = (await screen.findByText('новое из теста')).closest('li')
    expect(sentBubble).toBeTruthy()
    await waitFor(() => {
      expect(within(sentBubble as HTMLElement).getByText('отправлено')).toBeInTheDocument()
    })
    expect(mockWs.received).toHaveLength(1)
    expect(mockWs.received[0]?.payload.body).toBe('новое из теста')
  })

  it('saves an acked message into Later mocks', async () => {
    const auth = await authValue()
    const mockWs = new MockWebSocketServer({ senderId: ALICE.id })
    mockWs.ensureSequenceAtLeast(INITIAL_CHAT_ID, 6)
    renderThread(auth, mockWs)

    await screen.findByText('Да, договорились.')
    await waitFor(() => expect(mockWs.connections.size).toBeGreaterThan(0))
    const user = userEvent.setup()
    await user.type(screen.getByLabelText('Сообщение'), 'сохранить после ack')
    await user.click(screen.getByRole('button', { name: 'Отправить' }))
    const sentBubble = (await screen.findByText('сохранить после ack')).closest('li')
    expect(sentBubble).toBeTruthy()
    await waitFor(() => {
      expect(within(sentBubble as HTMLElement).getByText('отправлено')).toBeInTheDocument()
    })
    await user.click(
      within(sentBubble as HTMLElement).getByRole('button', { name: 'Действия с сообщением' }),
    )
    await user.click(screen.getByRole('menuitem', { name: 'Просто сохранить' }))
    expect(await screen.findByRole('status')).toHaveTextContent(/Сохранено без срока/i)
  })

  it('shows failed status and retries with the same client_msg_id', async () => {
    const auth = await authValue()
    const mockWs = new MockWebSocketServer({ senderId: ALICE.id })
    mockWs.ensureSequenceAtLeast(INITIAL_CHAT_ID, 6)
    mockWs.failNextCommand({
      code: 'invalid_payload',
      message: 'bad body',
      retryable: false,
      request_type: 'message.send',
      client_msg_id: null,
    })
    renderThread(auth, mockWs)

    await screen.findByText('Да, договорились.')
    await waitFor(() => expect(mockWs.connections.size).toBeGreaterThan(0))

    const user = userEvent.setup()
    await user.type(screen.getByLabelText('Сообщение'), 'повтор')
    await user.click(screen.getByRole('button', { name: 'Отправить' }))

    const bubble = (await screen.findByText('повтор')).closest('li')
    expect(bubble).toBeTruthy()
    expect(await within(bubble as HTMLElement).findByText('ошибка')).toBeInTheDocument()
    await user.click(
      within(bubble as HTMLElement).getByRole('button', { name: 'Повторить отправку' }),
    )

    await waitFor(() => {
      expect(mockWs.received.length).toBeGreaterThanOrEqual(2)
    })
    expect(mockWs.received[0]?.payload.client_msg_id).toBe(
      mockWs.received[1]?.payload.client_msg_id,
    )
  })

  it('loads older messages when scrolled to the top', async () => {
    server.use(
      http.get(`/chats/${INITIAL_CHAT_ID}/messages`, ({ request }) => {
        const url = new URL(request.url)
        const before = url.searchParams.get('before_seq')
        if (before === '4') {
          return HttpResponse.json({
            messages: [
              {
                id: '20000000-0000-4000-8000-000000000001',
                chat_id: INITIAL_CHAT_ID,
                seq: 1,
                sender_id: ALICE.id,
                body: 'Привет, Боб!',
                created_at: '2026-11-01T11:01:00Z',
              },
              {
                id: '20000000-0000-4000-8000-000000000002',
                chat_id: INITIAL_CHAT_ID,
                seq: 2,
                sender_id: '00000000-0000-4000-8000-000000000002',
                body: 'Привет, Алиса!',
                created_at: '2026-11-01T11:02:00Z',
              },
              {
                id: '20000000-0000-4000-8000-000000000003',
                chat_id: INITIAL_CHAT_ID,
                seq: 3,
                sender_id: ALICE.id,
                body: 'Как дела?',
                created_at: '2026-11-01T11:03:00Z',
              },
            ],
            next_before_seq: null,
            next_after_seq: 3,
            has_more_before: false,
            has_more_after: true,
          })
        }
        return HttpResponse.json({
          messages: [
            {
              id: '20000000-0000-4000-8000-000000000004',
              chat_id: INITIAL_CHAT_ID,
              seq: 4,
              sender_id: '00000000-0000-4000-8000-000000000002',
              body: 'Всё хорошо.',
              created_at: '2026-11-01T11:04:00Z',
            },
            {
              id: '20000000-0000-4000-8000-000000000005',
              chat_id: INITIAL_CHAT_ID,
              seq: 5,
              sender_id: ALICE.id,
              body: 'Увидимся вечером?',
              created_at: '2026-11-01T11:05:00Z',
            },
            {
              id: '20000000-0000-4000-8000-000000000006',
              chat_id: INITIAL_CHAT_ID,
              seq: 6,
              sender_id: '00000000-0000-4000-8000-000000000002',
              body: 'Да, договорились.',
              created_at: '2026-11-01T11:06:00Z',
            },
          ],
          next_before_seq: 4,
          next_after_seq: null,
          has_more_before: true,
          has_more_after: false,
        })
      }),
    )

    const auth = await authValue()
    const mockWs = new MockWebSocketServer({ senderId: ALICE.id })
    mockWs.ensureSequenceAtLeast(INITIAL_CHAT_ID, 6)
    renderThread(auth, mockWs)

    expect(await screen.findByText('Да, договорились.')).toBeInTheDocument()
    expect(screen.queryByText('Привет, Боб!')).not.toBeInTheDocument()

    const scroller = screen.getByTestId('chat-thread-scroll')
    Object.defineProperty(scroller, 'scrollHeight', { configurable: true, value: 2000 })
    Object.defineProperty(scroller, 'clientHeight', { configurable: true, value: 400 })
    await act(async () => {
      scroller.scrollTop = 0
      scroller.dispatchEvent(new Event('scroll', { bubbles: true }))
    })

    expect(await screen.findByText('Привет, Боб!')).toBeInTheDocument()
  })

  it('marks the highest visible confirmed seq as read and notifies the list', async () => {
    const readBodies: unknown[] = []
    server.use(
      http.post(`/chats/${INITIAL_CHAT_ID}/read`, async ({ request }) => {
        readBodies.push(await request.json())
        return new HttpResponse(null, { status: 204 })
      }),
    )
    const onRead = vi.fn()
    const auth = await authValue()
    const mockWs = new MockWebSocketServer({ senderId: ALICE.id })
    mockWs.ensureSequenceAtLeast(INITIAL_CHAT_ID, 6)
    renderThread(auth, mockWs, onRead)

    await screen.findByText('Да, договорились.')
    await waitFor(() => {
      expect(readBodies.length).toBeGreaterThan(0)
    })
    expect(readBodies.at(-1)).toEqual({ seq: 6 })
    await waitFor(() => {
      expect(onRead).toHaveBeenCalled()
    })
  })

  it('queues the next mark-read while a previous POST is in flight', async () => {
    const readBodies: number[] = []
    let releaseFirst!: () => void
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    let readCalls = 0
    server.use(
      http.post(`/chats/${INITIAL_CHAT_ID}/read`, async ({ request }) => {
        readCalls += 1
        const body = (await request.json()) as { seq: number }
        readBodies.push(body.seq)
        if (readCalls === 1) await firstGate
        return new HttpResponse(null, { status: 204 })
      }),
      http.get(`/chats/${INITIAL_CHAT_ID}/messages`, () =>
        HttpResponse.json({
          messages: [
            {
              id: 'm1',
              chat_id: INITIAL_CHAT_ID,
              seq: 1,
              sender_id: '00000000-0000-4000-8000-000000000002',
              body: 'one',
              created_at: '2026-11-19T10:00:00Z',
            },
            {
              id: 'm2',
              chat_id: INITIAL_CHAT_ID,
              seq: 2,
              sender_id: '00000000-0000-4000-8000-000000000002',
              body: 'two',
              created_at: '2026-11-19T10:01:00Z',
            },
          ],
          next_before_seq: null,
          next_after_seq: 2,
          has_more_before: false,
          has_more_after: false,
        }),
      ),
    )
    const auth = await authValue()
    const mockWs = new MockWebSocketServer({ senderId: ALICE.id })
    renderThread(auth, mockWs)

    await screen.findByText('two')
    await waitFor(() => expect(readBodies).toContain(2))

    await waitFor(() => expect(mockWs.connections.size).toBeGreaterThan(0))
    const connection = Array.from(mockWs.connections)[0]!
    await act(async () => {
      connection.serverMessage(
        JSON.stringify({
          type: 'message.new',
          id: '50000000-0000-4000-8000-000000000003',
          ts: '2026-11-19T10:02:00Z',
          payload: {
            chat_id: INITIAL_CHAT_ID,
            client_msg_id: '30000000-0000-4000-8000-000000000003',
            message_id: '40000000-0000-4000-8000-000000000003',
            sender_id: '00000000-0000-4000-8000-000000000002',
            seq: 3,
            body: 'three',
            created_at: '2026-11-19T10:02:00Z',
          },
        }),
      )
    })
    expect(await screen.findByText('three')).toBeInTheDocument()

    await act(async () => {
      releaseFirst()
    })
    await waitFor(() => {
      expect(readBodies.at(-1)).toBe(3)
    })
  })

  it('does not render WS cache below the REST history window', async () => {
    server.use(
      http.get(`/chats/${INITIAL_CHAT_ID}/messages`, () =>
        HttpResponse.json({
          messages: [
            {
              id: 'm50',
              chat_id: INITIAL_CHAT_ID,
              seq: 50,
              sender_id: '00000000-0000-4000-8000-000000000002',
              body: 'page-start',
              created_at: '2026-11-19T12:00:00Z',
            },
            {
              id: 'm51',
              chat_id: INITIAL_CHAT_ID,
              seq: 51,
              sender_id: '00000000-0000-4000-8000-000000000002',
              body: 'page-end',
              created_at: '2026-11-19T12:01:00Z',
            },
          ],
          next_before_seq: 50,
          next_after_seq: 51,
          has_more_before: true,
          has_more_after: false,
        }),
      ),
      http.post(`/chats/${INITIAL_CHAT_ID}/read`, () => new HttpResponse(null, { status: 204 })),
    )
    const auth = await authValue()
    const mockWs = new MockWebSocketServer({ senderId: ALICE.id })
    mockWs.ensureSequenceAtLeast(INITIAL_CHAT_ID, 51)
    renderThread(auth, mockWs)

    expect(await screen.findByText('page-start')).toBeInTheDocument()
    expect(screen.getByText('page-end')).toBeInTheDocument()

    await waitFor(() => expect(mockWs.connections.size).toBeGreaterThan(0))
    const connection = Array.from(mockWs.connections)[0]!
    await act(async () => {
      connection.serverMessage(
        JSON.stringify({
          type: 'message.new',
          id: '50000000-0000-4000-8000-000000000001',
          ts: '2026-11-19T09:00:00Z',
          payload: {
            chat_id: INITIAL_CHAT_ID,
            client_msg_id: '30000000-0000-4000-8000-000000000001',
            message_id: '40000000-0000-4000-8000-000000000001',
            sender_id: '00000000-0000-4000-8000-000000000002',
            seq: 1,
            body: 'ancient-from-cache',
            created_at: '2026-11-19T09:00:00Z',
          },
        }),
      )
    })

    expect(screen.queryByText('ancient-from-cache')).not.toBeInTheDocument()
    expect(screen.getByText('page-start')).toBeInTheDocument()
  })

  it('shows connection banner while reconnecting', async () => {
    const auth = await authValue()
    const mockWs = new MockWebSocketServer({ senderId: ALICE.id })
    mockWs.ensureSequenceAtLeast(INITIAL_CHAT_ID, 6)
    renderThread(auth, mockWs)

    await screen.findByText('Да, договорились.')
    await waitFor(() => expect(mockWs.connections.size).toBeGreaterThan(0))

    await act(async () => {
      mockWs.disconnectAll(1013, 'mock disconnect')
    })

    expect(await screen.findAllByText(/Переподключение/i)).not.toHaveLength(0)
  })

  it('does not POST /read for synced seq that never entered the viewport', async () => {
    type Observed = {
      target: Element
      callback: IntersectionObserverCallback
      observer: IntersectionObserver
    }
    const observed: Observed[] = []

    class SelectiveIntersectionObserver {
      readonly callback: IntersectionObserverCallback

      constructor(callback: IntersectionObserverCallback) {
        this.callback = callback
      }

      observe(target: Element) {
        observed.push({
          target,
          callback: this.callback,
          observer: this as unknown as IntersectionObserver,
        })
      }

      unobserve() {}

      disconnect() {}

      takeRecords(): IntersectionObserverEntry[] {
        return []
      }

      readonly root = null
      readonly rootMargin = ''
      readonly thresholds = [0.6]
    }

    vi.stubGlobal('IntersectionObserver', SelectiveIntersectionObserver)

    const revealSeqs = (seqs: number[]) => {
      const want = new Set(seqs)
      const byCallback = new Map<
        IntersectionObserverCallback,
        { observer: IntersectionObserver; entries: IntersectionObserverEntry[] }
      >()
      for (const item of observed) {
        const seq = Number((item.target as HTMLElement).dataset.seq)
        if (!want.has(seq)) continue
        const bucket = byCallback.get(item.callback) ?? {
          observer: item.observer,
          entries: [],
        }
        bucket.entries.push({
          isIntersecting: true,
          target: item.target,
          intersectionRatio: 1,
          time: 0,
          boundingClientRect: item.target.getBoundingClientRect(),
          intersectionRect: item.target.getBoundingClientRect(),
          rootBounds: null,
        } as IntersectionObserverEntry)
        byCallback.set(item.callback, bucket)
      }
      for (const [callback, bucket] of byCallback) {
        callback(bucket.entries, bucket.observer)
      }
    }

    const bobId = '00000000-0000-4000-8000-000000000002'
    let syncedThrough = 2
    let releaseThreadHistory!: () => void
    const threadHistoryGate = new Promise<void>((resolve) => {
      releaseThreadHistory = resolve
    })
    const readBodies: number[] = []

    const historyMessage = (seq: number, body: string) => ({
      id: `20000000-0000-4000-8000-00000000000${seq}`,
      chat_id: INITIAL_CHAT_ID,
      seq,
      sender_id: bobId,
      body,
      created_at: `2026-11-19T10:0${seq}:00Z`,
    })

    server.use(
      http.get(`/chats/${INITIAL_CHAT_ID}/messages`, async ({ request }) => {
        const url = new URL(request.url)
        const afterRaw = url.searchParams.get('after_seq')
        if (afterRaw != null) {
          const after = Number(afterRaw)
          const messages = []
          for (let seq = after + 1; seq <= syncedThrough; seq += 1) {
            if (seq === 3 || seq === 4) continue
            messages.push(historyMessage(seq, `msg-${seq}`))
          }
          return HttpResponse.json({
            messages,
            next_before_seq: messages[0]?.seq ?? null,
            next_after_seq: syncedThrough,
            has_more_before: false,
            has_more_after: false,
          })
        }
        await threadHistoryGate
        return HttpResponse.json({
          messages: [historyMessage(1, 'msg-1'), historyMessage(2, 'msg-2')],
          next_before_seq: null,
          next_after_seq: 2,
          has_more_before: false,
          has_more_after: false,
        })
      }),
      http.post(`/chats/${INITIAL_CHAT_ID}/read`, async ({ request }) => {
        const body = (await request.json()) as { seq: number }
        readBodies.push(body.seq)
        return new HttpResponse(null, { status: 204 })
      }),
    )

    const auth = await authValue()
    const mockWs = new MockWebSocketServer({ senderId: ALICE.id })
    mockWs.ensureSequenceAtLeast(INITIAL_CHAT_ID, 2)
    renderThread(auth, mockWs)

    await waitFor(() => expect(mockWs.connections.size).toBeGreaterThan(0))
    const connection = Array.from(mockWs.connections)[0]!
    await act(async () => {
      connection.serverMessage(
        JSON.stringify({
          type: 'message.new',
          id: '50000000-0000-4000-8000-000000000005',
          ts: '2026-11-19T10:05:00Z',
          payload: {
            chat_id: INITIAL_CHAT_ID,
            client_msg_id: '30000000-0000-4000-8000-000000000005',
            message_id: '40000000-0000-4000-8000-000000000005',
            sender_id: bobId,
            seq: 5,
            body: 'msg-5',
            created_at: '2026-11-19T10:05:00Z',
          },
        }),
      )
    })

    await act(async () => {
      releaseThreadHistory()
    })
    expect(await screen.findByText('msg-5')).toBeInTheDocument()
    expect(screen.getByText('msg-1')).toBeInTheDocument()
    expect(screen.getByText('msg-2')).toBeInTheDocument()

    await act(async () => {
      revealSeqs([5])
    })
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 40))
    })
    expect(readBodies).toEqual([])

    syncedThrough = 5
    mockWs.ensureSequenceAtLeast(INITIAL_CHAT_ID, 5)
    await act(async () => {
      mockWs.disconnectAll(1013, 'mock disconnect for catch-up')
    })
    await waitFor(() => expect(mockWs.connections.size).toBeGreaterThan(0), {
      timeout: 5_000,
    })
    await waitFor(() => expect(screen.queryByText(/Переподключение/i)).not.toBeInTheDocument(), {
      timeout: 5_000,
    })
    await act(async () => {
      revealSeqs([5])
    })
    await waitFor(() => {
      expect(readBodies.at(-1)).toBe(5)
    })
    expect(readBodies).not.toContain(2)
  })

  const LIST_TOP = 0
  const LIST_BOTTOM = 400

  function stubRect(
    el: Element,
    rect: { top: number; bottom: number; left?: number; right?: number },
  ) {
    const left = rect.left ?? 0
    const right = rect.right ?? 300
    vi.spyOn(el, 'getBoundingClientRect').mockReturnValue({
      x: left,
      y: rect.top,
      top: rect.top,
      bottom: rect.bottom,
      left,
      right,
      width: right - left,
      height: rect.bottom - rect.top,
      toJSON() {
        return {}
      },
    } as DOMRect)
  }

  async function scrollThreadAwayFromBottom() {
    const scroller = screen.getByTestId('chat-thread-scroll')
    Object.defineProperty(scroller, 'scrollHeight', { configurable: true, value: 2000 })
    Object.defineProperty(scroller, 'clientHeight', { configurable: true, value: LIST_BOTTOM })
    stubRect(scroller, { top: LIST_TOP, bottom: LIST_BOTTOM })
    await act(async () => {
      scroller.scrollTop = 0
      scroller.dispatchEvent(new Event('scroll', { bubbles: true }))
    })
    return scroller
  }

  async function flushChipLayout() {
    await act(async () => {
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      })
    })
  }

  type RowPlacement = 'below' | 'inside' | 'above' | 'partial-bottom'

  async function placeRows(placements: Record<string, RowPlacement>) {
    const scroller = screen.getByTestId('chat-thread-scroll')
    stubRect(scroller, { top: LIST_TOP, bottom: LIST_BOTTOM })
    for (const [body, place] of Object.entries(placements)) {
      const row = screen.getByText(body).closest('li')
      expect(row).toBeTruthy()
      const rect =
        place === 'below'
          ? { top: LIST_BOTTOM, bottom: LIST_BOTTOM + 40 }
          : place === 'partial-bottom'
            ? { top: LIST_BOTTOM - 20, bottom: LIST_BOTTOM + 20 }
            : place === 'above'
              ? { top: LIST_TOP - 40, bottom: LIST_TOP - 8 }
              : { top: 120, bottom: 160 }
      stubRect(row as HTMLElement, rect)
    }
    await flushChipLayout()
  }

  function pushMessageNew(
    connection: { serverMessage: (raw: string) => void },
    {
      seq,
      body,
      senderId,
      messageId,
    }: { seq: number; body: string; senderId: string; messageId?: string },
  ) {
    const id = messageId ?? `40000000-0000-4000-8000-0000000000${String(seq).padStart(2, '0')}`
    connection.serverMessage(
      JSON.stringify({
        type: 'message.new',
        id: `50000000-0000-4000-8000-0000000000${String(seq).padStart(2, '0')}`,
        ts: `2026-11-21T12:${String(seq).padStart(2, '0')}:00Z`,
        payload: {
          chat_id: INITIAL_CHAT_ID,
          client_msg_id: `30000000-0000-4000-8000-0000000000${String(seq).padStart(2, '0')}`,
          message_id: id,
          sender_id: senderId,
          seq,
          body,
          created_at: `2026-11-21T12:${String(seq).padStart(2, '0')}:00Z`,
        },
      }),
    )
  }

  function pushIncoming(
    connection: { serverMessage: (raw: string) => void },
    seq: number,
    body: string,
    messageId?: string,
  ) {
    pushMessageNew(connection, {
      seq,
      body,
      senderId: '00000000-0000-4000-8000-000000000002',
      messageId,
    })
  }

  it('1a · chip for late incoming seq=21 below fold via message.new after own seq=22', async () => {
    const gapIncomingId = '40000000-0000-4000-8000-000000000021'
    server.use(
      http.get(`/chats/${INITIAL_CHAT_ID}/messages`, () =>
        HttpResponse.json({
          messages: [
            {
              id: '40000000-0000-4000-8000-000000000020',
              chat_id: INITIAL_CHAT_ID,
              seq: 20,
              sender_id: ALICE.id,
              body: 'mine-seq-20',
              created_at: '2026-11-21T12:20:00Z',
            },
          ],
          next_before_seq: null,
          next_after_seq: 20,
          has_more_before: false,
          has_more_after: false,
        }),
      ),
      http.post(`/chats/${INITIAL_CHAT_ID}/read`, () => new HttpResponse(null, { status: 204 })),
    )

    const auth = await authValue()
    const mockWs = new MockWebSocketServer({ senderId: ALICE.id })
    mockWs.ensureSequenceAtLeast(INITIAL_CHAT_ID, 20)
    renderThread(auth, mockWs)

    expect(await screen.findByText('mine-seq-20')).toBeInTheDocument()
    await waitFor(() => expect(mockWs.connections.size).toBeGreaterThan(0))
    const connection = Array.from(mockWs.connections)[0]!
    await act(async () => {
      pushMessageNew(connection, {
        seq: 22,
        body: 'mine-seq-22',
        senderId: ALICE.id,
        messageId: '40000000-0000-4000-8000-000000000022',
      })
    })
    expect(await screen.findByText('mine-seq-22')).toBeInTheDocument()

    await scrollThreadAwayFromBottom()
    await act(async () => {
      pushIncoming(connection, 21, 'gap-incoming-ws', gapIncomingId)
    })
    expect(await screen.findByText('gap-incoming-ws')).toBeInTheDocument()
    await placeRows({ 'gap-incoming-ws': 'below', 'mine-seq-22': 'below', 'mine-seq-20': 'inside' })
    expect(await screen.findByRole('button', { name: 'Новые сообщения' })).toBeInTheDocument()
  })

  it('1b · chip for late incoming seq=21 below fold via after_seq after reconnect', async () => {
    const bobId = '00000000-0000-4000-8000-000000000002'
    const gapIncomingId = '40000000-0000-4000-8000-000000000031'
    let afterSeqCatchUp: Array<{
      id: string
      chat_id: string
      seq: number
      sender_id: string
      body: string
      created_at: string
    }> = []
    server.use(
      http.get(`/chats/${INITIAL_CHAT_ID}/messages`, ({ request }) => {
        const url = new URL(request.url)
        const afterRaw = url.searchParams.get('after_seq')
        if (afterRaw != null) {
          const after = Number(afterRaw)
          const messages = afterSeqCatchUp.filter((item) => item.seq > after)
          const nextAfter =
            messages.length > 0 ? Math.max(...messages.map((item) => item.seq)) : after
          return HttpResponse.json({
            messages,
            next_before_seq: messages[0]?.seq ?? null,
            next_after_seq: nextAfter,
            has_more_before: false,
            has_more_after: false,
          })
        }
        return HttpResponse.json({
          messages: [
            {
              id: '40000000-0000-4000-8000-000000000030',
              chat_id: INITIAL_CHAT_ID,
              seq: 20,
              sender_id: ALICE.id,
              body: 'mine-seq-20',
              created_at: '2026-11-21T12:20:00Z',
            },
          ],
          next_before_seq: null,
          next_after_seq: 20,
          has_more_before: false,
          has_more_after: false,
        })
      }),
      http.post(`/chats/${INITIAL_CHAT_ID}/read`, () => new HttpResponse(null, { status: 204 })),
    )

    const auth = await authValue()
    const mockWs = new MockWebSocketServer({ senderId: ALICE.id })
    mockWs.ensureSequenceAtLeast(INITIAL_CHAT_ID, 20)
    renderThread(auth, mockWs)

    expect(await screen.findByText('mine-seq-20')).toBeInTheDocument()
    await waitFor(() => expect(mockWs.connections.size).toBeGreaterThan(0))
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 40))
    })
    const connection = Array.from(mockWs.connections)[0]!
    await act(async () => {
      pushMessageNew(connection, {
        seq: 22,
        body: 'mine-seq-22',
        senderId: ALICE.id,
        messageId: '40000000-0000-4000-8000-000000000032',
      })
    })
    expect(await screen.findByText('mine-seq-22')).toBeInTheDocument()

    await scrollThreadAwayFromBottom()
    afterSeqCatchUp = [
      {
        id: gapIncomingId,
        chat_id: INITIAL_CHAT_ID,
        seq: 21,
        sender_id: bobId,
        body: 'gap-incoming-after-seq',
        created_at: '2026-11-21T12:21:00Z',
      },
    ]
    mockWs.ensureSequenceAtLeast(INITIAL_CHAT_ID, 22)
    await act(async () => {
      mockWs.disconnectAll(1013, 'mock disconnect for after_seq gap')
    })
    await waitFor(() => expect(mockWs.connections.size).toBeGreaterThan(0), { timeout: 5_000 })
    await waitFor(() => expect(screen.queryByText(/Переподключение/i)).not.toBeInTheDocument(), {
      timeout: 5_000,
    })
    expect(await screen.findByText('gap-incoming-after-seq')).toBeInTheDocument()
    await placeRows({
      'gap-incoming-after-seq': 'below',
      'mine-seq-22': 'below',
      'mine-seq-20': 'inside',
    })
    expect(await screen.findByRole('button', { name: 'Новые сообщения' })).toBeInTheDocument()
  })

  it('2 · chip stays hidden for inside / partial-bottom / above placements', async () => {
    server.use(
      http.get(`/chats/${INITIAL_CHAT_ID}/messages`, () =>
        HttpResponse.json({
          messages: [
            {
              id: '40000000-0000-4000-8000-000000000050',
              chat_id: INITIAL_CHAT_ID,
              seq: 1,
              sender_id: ALICE.id,
              body: 'anchor-mine',
              created_at: '2026-11-21T12:00:00Z',
            },
          ],
          next_before_seq: null,
          next_after_seq: 1,
          has_more_before: false,
          has_more_after: false,
        }),
      ),
      http.post(`/chats/${INITIAL_CHAT_ID}/read`, () => new HttpResponse(null, { status: 204 })),
    )
    const auth = await authValue()
    const mockWs = new MockWebSocketServer({ senderId: ALICE.id })
    mockWs.ensureSequenceAtLeast(INITIAL_CHAT_ID, 1)
    renderThread(auth, mockWs)
    expect(await screen.findByText('anchor-mine')).toBeInTheDocument()
    await waitFor(() => expect(mockWs.connections.size).toBeGreaterThan(0))
    await scrollThreadAwayFromBottom()
    const connection = Array.from(mockWs.connections)[0]!

    for (const [body, place, seq] of [
      ['inside-incoming', 'inside', 2],
      ['partial-incoming', 'partial-bottom', 3],
      ['above-incoming', 'above', 4],
    ] as const) {
      await act(async () => {
        pushIncoming(connection, seq, body)
      })
      expect(await screen.findByText(body)).toBeInTheDocument()
      await placeRows({ [body]: place, 'anchor-mine': 'inside' })
      expect(screen.queryByRole('button', { name: 'Новые сообщения' })).not.toBeInTheDocument()
    }
  })

  it('2b · visible incoming does not clear chip already shown for below-fold message', async () => {
    server.use(
      http.get(`/chats/${INITIAL_CHAT_ID}/messages`, () =>
        HttpResponse.json({
          messages: [
            {
              id: '40000000-0000-4000-8000-000000000060',
              chat_id: INITIAL_CHAT_ID,
              seq: 1,
              sender_id: ALICE.id,
              body: 'anchor-mine',
              created_at: '2026-11-21T12:00:00Z',
            },
          ],
          next_before_seq: null,
          next_after_seq: 1,
          has_more_before: false,
          has_more_after: false,
        }),
      ),
      http.post(`/chats/${INITIAL_CHAT_ID}/read`, () => new HttpResponse(null, { status: 204 })),
    )
    const auth = await authValue()
    const mockWs = new MockWebSocketServer({ senderId: ALICE.id })
    mockWs.ensureSequenceAtLeast(INITIAL_CHAT_ID, 1)
    renderThread(auth, mockWs)
    expect(await screen.findByText('anchor-mine')).toBeInTheDocument()
    await waitFor(() => expect(mockWs.connections.size).toBeGreaterThan(0))
    await scrollThreadAwayFromBottom()
    const connection = Array.from(mockWs.connections)[0]!

    await act(async () => {
      pushIncoming(connection, 2, 'below-incoming')
    })
    expect(await screen.findByText('below-incoming')).toBeInTheDocument()
    await placeRows({ 'below-incoming': 'below', 'anchor-mine': 'inside' })
    await waitFor(async () => {
      await placeRows({ 'below-incoming': 'below', 'anchor-mine': 'inside' })
      expect(screen.getByRole('button', { name: 'Новые сообщения' })).toBeInTheDocument()
    })

    await act(async () => {
      pushIncoming(connection, 3, 'visible-incoming')
    })
    expect(await screen.findByText('visible-incoming')).toBeInTheDocument()
    await placeRows({
      'below-incoming': 'below',
      'visible-incoming': 'inside',
      'anchor-mine': 'inside',
    })
    expect(screen.getByRole('button', { name: 'Новые сообщения' })).toBeInTheDocument()
  })

  it('3 · before_seq prepend hides chip; WS below fold during before_seq shows it', async () => {
    let releaseBefore!: () => void
    const beforeGate = new Promise<void>((resolve) => {
      releaseBefore = resolve
    })
    server.use(
      http.get(`/chats/${INITIAL_CHAT_ID}/messages`, async ({ request }) => {
        const url = new URL(request.url)
        const before = url.searchParams.get('before_seq')
        if (before === '2') {
          await beforeGate
          return HttpResponse.json({
            messages: [
              {
                id: '20000000-0000-4000-8000-000000000001',
                chat_id: INITIAL_CHAT_ID,
                seq: 1,
                sender_id: '00000000-0000-4000-8000-000000000002',
                body: 'old-incoming-page',
                created_at: '2026-11-21T11:00:00Z',
              },
            ],
            next_before_seq: null,
            next_after_seq: 1,
            has_more_before: false,
            has_more_after: true,
          })
        }
        return HttpResponse.json({
          messages: Array.from({ length: 5 }, (_, index) => {
            const seq = index + 2
            return {
              id: `20000000-0000-4000-8000-00000000000${seq}`,
              chat_id: INITIAL_CHAT_ID,
              seq,
              sender_id: ALICE.id,
              body: `mine-${seq}`,
              created_at: `2026-11-21T12:${String(seq).padStart(2, '0')}:00Z`,
            }
          }),
          next_before_seq: 2,
          next_after_seq: null,
          has_more_before: true,
          has_more_after: false,
        })
      }),
      http.post(`/chats/${INITIAL_CHAT_ID}/read`, () => new HttpResponse(null, { status: 204 })),
    )
    const auth = await authValue()
    const mockWs = new MockWebSocketServer({ senderId: ALICE.id })
    mockWs.ensureSequenceAtLeast(INITIAL_CHAT_ID, 6)
    renderThread(auth, mockWs)

    expect(await screen.findByText('mine-6')).toBeInTheDocument()
    await waitFor(() => expect(mockWs.connections.size).toBeGreaterThan(0))
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30))
    })

    const scroller = screen.getByTestId('chat-thread-scroll')
    Object.defineProperty(scroller, 'scrollHeight', { configurable: true, value: 4000 })
    Object.defineProperty(scroller, 'clientHeight', { configurable: true, value: LIST_BOTTOM })
    stubRect(scroller, { top: LIST_TOP, bottom: LIST_BOTTOM })
    await act(async () => {
      scroller.scrollTop = 0
      scroller.dispatchEvent(new Event('scroll', { bubbles: true }))
    })

    const connection = Array.from(mockWs.connections)[0]!
    await act(async () => {
      pushIncoming(connection, 7, 'fresh-during-before')
    })
    expect(await screen.findByText('fresh-during-before')).toBeInTheDocument()

    await act(async () => {
      releaseBefore()
    })
    expect(await screen.findByText('old-incoming-page')).toBeInTheDocument()
    await waitFor(async () => {
      await placeRows({
        'old-incoming-page': 'above',
        'fresh-during-before': 'below',
        'mine-6': 'inside',
      })
      expect(screen.getByRole('button', { name: 'Новые сообщения' })).toBeInTheDocument()
    })
  })

  it('4 · chip click / manual bottom hide; same id after re-scroll keeps chip hidden', async () => {
    const messageId = '40000000-0000-4000-8000-000000000041'
    let afterSeqCatchUp: Array<{
      id: string
      chat_id: string
      seq: number
      sender_id: string
      body: string
      created_at: string
    }> = []
    server.use(
      http.get(`/chats/${INITIAL_CHAT_ID}/messages`, ({ request }) => {
        const url = new URL(request.url)
        const afterRaw = url.searchParams.get('after_seq')
        if (afterRaw != null) {
          const after = Number(afterRaw)
          const messages = afterSeqCatchUp.filter((item) => item.seq > after)
          const nextAfter =
            messages.length > 0 ? Math.max(...messages.map((item) => item.seq)) : after
          return HttpResponse.json({
            messages,
            next_before_seq: messages[0]?.seq ?? null,
            next_after_seq: nextAfter,
            has_more_before: false,
            has_more_after: false,
          })
        }
        return HttpResponse.json({
          messages: [
            {
              id: '40000000-0000-4000-8000-000000000040',
              chat_id: INITIAL_CHAT_ID,
              seq: 1,
              sender_id: ALICE.id,
              body: 'only-mine',
              created_at: '2026-11-21T12:00:00Z',
            },
          ],
          next_before_seq: null,
          next_after_seq: 1,
          has_more_before: false,
          has_more_after: false,
        })
      }),
      http.post(`/chats/${INITIAL_CHAT_ID}/read`, () => new HttpResponse(null, { status: 204 })),
    )

    const auth = await authValue()
    const mockWs = new MockWebSocketServer({ senderId: ALICE.id })
    mockWs.ensureSequenceAtLeast(INITIAL_CHAT_ID, 1)
    renderThread(auth, mockWs)

    expect(await screen.findByText('only-mine')).toBeInTheDocument()
    await waitFor(() => expect(mockWs.connections.size).toBeGreaterThan(0))
    const scroller = await scrollThreadAwayFromBottom()

    const connection = Array.from(mockWs.connections)[0]!
    await act(async () => {
      pushIncoming(connection, 2, 'same-incoming', messageId)
    })
    expect(await screen.findByText('same-incoming')).toBeInTheDocument()
    await placeRows({ 'same-incoming': 'below', 'only-mine': 'inside' })
    expect(await screen.findByRole('button', { name: 'Новые сообщения' })).toBeInTheDocument()
    expect(screen.getAllByText('same-incoming')).toHaveLength(1)

    afterSeqCatchUp = [
      {
        id: messageId,
        chat_id: INITIAL_CHAT_ID,
        seq: 2,
        sender_id: '00000000-0000-4000-8000-000000000002',
        body: 'same-incoming',
        created_at: '2026-11-21T12:02:00Z',
      },
    ]
    mockWs.ensureSequenceAtLeast(INITIAL_CHAT_ID, 2)
    await act(async () => {
      mockWs.disconnectAll(1013, 'mock disconnect for rest twin')
    })
    await waitFor(() => expect(mockWs.connections.size).toBeGreaterThan(0), { timeout: 5_000 })
    await waitFor(() => expect(screen.queryByText(/Переподключение/i)).not.toBeInTheDocument(), {
      timeout: 5_000,
    })
    expect(screen.getAllByText('same-incoming')).toHaveLength(1)
    expect(screen.getByRole('button', { name: 'Новые сообщения' })).toBeInTheDocument()
    const liveConnection = Array.from(mockWs.connections)[0]!

    Object.defineProperty(scroller, 'scrollHeight', { configurable: true, value: 2000 })
    Object.defineProperty(scroller, 'clientHeight', { configurable: true, value: LIST_BOTTOM })
    await act(async () => {
      await userEvent.click(screen.getByRole('button', { name: 'Новые сообщения' }))
    })
    expect(screen.queryByRole('button', { name: 'Новые сообщения' })).not.toBeInTheDocument()
    expect(scroller.scrollTop).toBe(scroller.scrollHeight)

    await scrollThreadAwayFromBottom()
    await act(async () => {
      pushIncoming(liveConnection, 2, 'same-incoming', messageId)
    })
    await placeRows({ 'same-incoming': 'below', 'only-mine': 'inside' })
    expect(screen.getAllByText('same-incoming')).toHaveLength(1)
    expect(screen.queryByRole('button', { name: 'Новые сообщения' })).not.toBeInTheDocument()

    // Снова у низа: новое входящее — автопрокрутка, без chip.
    await act(async () => {
      scroller.scrollTop = scroller.scrollHeight
      scroller.dispatchEvent(new Event('scroll', { bubbles: true }))
    })
    await act(async () => {
      pushIncoming(liveConnection, 3, 'tail-incoming')
    })
    expect(await screen.findByText('tail-incoming')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Новые сообщения' })).not.toBeInTheDocument()

    await scrollThreadAwayFromBottom()
    await act(async () => {
      pushIncoming(liveConnection, 4, 'manual-hide-setup')
    })
    await placeRows({ 'manual-hide-setup': 'below' })
    expect(await screen.findByRole('button', { name: 'Новые сообщения' })).toBeInTheDocument()
    await act(async () => {
      scroller.scrollTop = scroller.scrollHeight
      scroller.dispatchEvent(new Event('scroll', { bubbles: true }))
    })
    expect(screen.queryByRole('button', { name: 'Новые сообщения' })).not.toBeInTheDocument()
  })
})
