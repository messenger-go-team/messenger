import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { MemoryRouter } from 'react-router'
import { describe, expect, it, vi } from 'vitest'
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
  it('loads history and shows peer header', async () => {
    const auth = await authValue()
    const mockWs = new MockWebSocketServer({ senderId: ALICE.id })
    mockWs.ensureSequenceAtLeast(INITIAL_CHAT_ID, 6)
    renderThread(auth, mockWs)

    expect(await screen.findByRole('heading', { name: 'bob_2' })).toBeInTheDocument()
    expect(await screen.findByText('Привет, Боб!')).toBeInTheDocument()
    expect(screen.getByText('Да, договорились.')).toBeInTheDocument()
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

  it('marks the highest visible contiguous seq as read and notifies the list', async () => {
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
    expect(onRead).toHaveBeenCalled()
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
})
