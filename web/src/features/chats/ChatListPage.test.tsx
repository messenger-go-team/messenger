import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import {
  createMemoryRouter,
  MemoryRouter,
  Route,
  RouterProvider,
  Routes,
  useLocation,
} from 'react-router'
import { describe, expect, it } from 'vitest'
import type { User } from '@/api/auth'
import { login } from '@/api/auth'
import { AuthContext, type AuthContextValue } from '@/features/auth/auth-context'
import { ChatListPage } from '@/features/chats/ChatListPage'
import { WsProvider } from '@/features/ws/WsProvider'
import { MockWebSocketServer } from '@/ws/mock/server'
import { server } from '../../../mocks/server'
import { addUser } from '../../../mocks/data/auth'
import { INITIAL_CHAT_ID } from '../../../mocks/data/history'

const ALICE: User = {
  id: '00000000-0000-4000-8000-000000000001',
  username: 'alice_1',
  created_at: '2026-01-01T00:00:00Z',
}

const BOB_ID = '00000000-0000-4000-8000-000000000002'
const CHARLIE_ID = '00000000-0000-4000-8000-000000000003'
const LATER_CHAT_ID = '10000000-0000-4000-8000-000000000099'

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

function renderChats(
  auth: AuthContextValue,
  initialPath = '/',
  mockWs = new MockWebSocketServer({ senderId: auth.user?.id ?? ALICE.id }),
) {
  return render(
    <AuthContext.Provider value={auth}>
      <WsProvider webSocketFactory={mockWs.webSocketFactory} disableApiMockSocket>
        <MemoryRouter initialEntries={[initialPath]}>
          <Routes>
            <Route path="/" element={<ChatListPage />} />
            <Route path="/chats/:chatId" element={<ChatListPage />} />
            <Route path="/contacts" element={<h1>Контакты</h1>} />
          </Routes>
        </MemoryRouter>
      </WsProvider>
    </AuthContext.Provider>,
  )
}

describe('ChatListPage', () => {
  it('loads chats sorted by last message and hides zero unread badges', async () => {
    server.use(
      http.get('/chats', () =>
        HttpResponse.json({
          chats: [
            {
              id: LATER_CHAT_ID,
              type: 'personal',
              created_at: '2026-11-07T11:00:00Z',
              members: [
                { id: ALICE.id, username: 'alice_1' },
                { id: CHARLIE_ID, username: 'charlie_3' },
              ],
              last_message: {
                id: 'm-new',
                chat_id: LATER_CHAT_ID,
                seq: 1,
                sender_id: CHARLIE_ID,
                body: 'новое',
                created_at: '2026-11-19T12:00:00Z',
              },
              unread_count: 0,
            },
            {
              id: INITIAL_CHAT_ID,
              type: 'personal',
              created_at: '2026-11-07T11:00:00Z',
              members: [
                { id: ALICE.id, username: 'alice_1' },
                { id: BOB_ID, username: 'bob_2' },
              ],
              last_message: {
                id: 'm-old',
                chat_id: INITIAL_CHAT_ID,
                seq: 1,
                sender_id: BOB_ID,
                body: 'старое',
                created_at: '2026-11-19T10:00:00Z',
              },
              unread_count: 2,
            },
          ],
        }),
      ),
    )
    const auth = await authValue()
    renderChats(auth)

    expect(await screen.findByRole('heading', { name: 'Чаты' })).toBeInTheDocument()
    const rows = await screen.findAllByRole('link', { name: /charlie_3|bob_2/i })
    expect(rows).toHaveLength(2)
    expect(rows[0]).toHaveAccessibleName(/charlie_3/i)
    expect(rows[1]).toHaveAccessibleName(/bob_2/i)
    expect(within(rows[0]).queryByText(/^\d+$/)).not.toBeInTheDocument()
    expect(within(rows[1]).getByText('2')).toBeInTheDocument()
  })

  it('refreshes the server unread count after catching up with a missed message', async () => {
    const incoming = {
      id: '20000000-0000-4000-8000-000000000042',
      chat_id: INITIAL_CHAT_ID,
      seq: 1,
      sender_id: BOB_ID,
      body: 'Получено во время разрыва',
      created_at: '2026-11-25T10:00:00Z',
    }
    let missedMessage = false
    let historyReads = 0
    server.use(
      http.get('/chats', () =>
        HttpResponse.json({
          chats: [
            {
              id: INITIAL_CHAT_ID,
              type: 'personal',
              created_at: '2026-11-07T11:00:00Z',
              members: [ALICE, { id: BOB_ID, username: 'bob_2' }],
              last_message: missedMessage ? incoming : null,
              unread_count: missedMessage ? 1 : 0,
            },
          ],
        }),
      ),
      http.get(`/chats/${INITIAL_CHAT_ID}/messages`, ({ request }) => {
        expect(new URL(request.url).searchParams.get('after_seq')).toBe('0')
        historyReads += 1
        return HttpResponse.json({
          messages: missedMessage ? [incoming] : [],
          next_after_seq: missedMessage ? incoming.seq : null,
          has_more_after: false,
        })
      }),
    )
    const mockWs = new MockWebSocketServer({ senderId: ALICE.id })
    renderChats(await authValue(), '/', mockWs)
    const row = await screen.findByRole('link', { name: /bob_2/i })
    expect(within(row).queryByText('1')).not.toBeInTheDocument()
    await waitFor(() => expect(historyReads).toBe(1))

    act(() => {
      mockWs.disconnectAll()
      missedMessage = true
    })

    expect(await within(row).findByText(incoming.body)).toBeInTheDocument()
    expect(within(row).getByText('1')).toBeInTheDocument()
  })

  it('shows empty state when there are no chats', async () => {
    server.use(http.get('/chats', () => HttpResponse.json({ chats: [] })))
    const auth = await authValue()
    renderChats(auth)

    expect(await screen.findByText('Начните переписку')).toBeInTheDocument()
    expect(screen.getByText(/пока нет чатов/i)).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: 'Найти человека' }).length).toBeGreaterThan(0)
  })

  it('shows not-selected panel on the right when no chat is open', async () => {
    const auth = await authValue()
    renderChats(auth)
    expect(await screen.findByRole('heading', { name: 'Выберите чат' })).toBeInTheDocument()
  })

  it('shows loading then list', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    server.use(
      http.get('/chats', async () => {
        await gate
        return HttpResponse.json({
          chats: [
            {
              id: INITIAL_CHAT_ID,
              type: 'personal',
              created_at: '2026-11-07T11:00:00Z',
              members: [
                { id: ALICE.id, username: 'alice_1' },
                { id: BOB_ID, username: 'bob_2' },
              ],
              last_message: {
                id: 'm1',
                chat_id: INITIAL_CHAT_ID,
                seq: 1,
                sender_id: BOB_ID,
                body: 'привет',
                created_at: '2026-11-19T10:48:00Z',
              },
              unread_count: 0,
            },
          ],
        })
      }),
    )
    const auth = await authValue()
    renderChats(auth)

    expect(await screen.findByText('Загрузка чатов…')).toBeInTheDocument()
    release()
    expect(await screen.findByText('bob_2')).toBeInTheDocument()
    expect(screen.queryByText('Загрузка чатов…')).not.toBeInTheDocument()
  })

  it('shows error with retry when list fails', async () => {
    server.use(
      http.get('/chats', () =>
        HttpResponse.json({ code: 'unknown_error', message: 'unavailable' }, { status: 503 }),
      ),
    )
    const auth = await authValue()
    const user = userEvent.setup()
    renderChats(auth)

    expect(await screen.findByRole('alert')).toHaveTextContent(/не удалось загрузить/i)
    server.resetHandlers()
    await user.click(screen.getByRole('button', { name: 'Повторить' }))
    expect(await screen.findByText('bob_2')).toBeInTheDocument()
  })

  it('clears previous search results as soon as the prefix changes', async () => {
    addUser({
      id: CHARLIE_ID,
      username: 'charlie_3',
      password: 'test-password',
      created_at: '2026-11-01T10:10:00Z',
    })
    const auth = await authValue()
    const user = userEvent.setup()
    renderChats(auth)

    await screen.findByRole('heading', { name: 'Чаты' })
    const search = screen.getByRole('searchbox', { name: 'Поиск по логину' })
    await user.type(search, 'bob')
    expect(await screen.findByRole('button', { name: /Написать bob_2/i })).toBeInTheDocument()

    await user.clear(search)
    await user.type(search, 'char')
    expect(screen.queryByRole('button', { name: /Написать bob_2/i })).not.toBeInTheDocument()
    expect(await screen.findByRole('button', { name: /Написать charlie_3/i })).toBeInTheDocument()
  })

  it('opens a chat from POST even when refreshing the list fails', async () => {
    addUser({
      id: CHARLIE_ID,
      username: 'charlie_3',
      password: 'test-password',
      created_at: '2026-11-01T10:10:00Z',
    })
    // После create список падает; до create оба клиента получают [].
    let failListAfterCreate = false
    let createdChat = false
    server.use(
      http.get('/chats', () => {
        if (failListAfterCreate) {
          return HttpResponse.json(
            { code: 'unknown_error', message: 'unavailable' },
            { status: 503 },
          )
        }
        if (!createdChat) {
          return HttpResponse.json({ chats: [] })
        }
        return HttpResponse.json({
          chats: [
            {
              id: LATER_CHAT_ID,
              type: 'personal',
              created_at: '2026-11-19T12:00:00Z',
              members: [
                { id: ALICE.id, username: 'alice_1' },
                { id: CHARLIE_ID, username: 'charlie_3' },
              ],
              last_message: null,
              unread_count: 0,
            },
          ],
        })
      }),
      http.post('/chats/personal', async ({ request }) => {
        failListAfterCreate = true
        createdChat = true
        const body = (await request.json()) as { user_id: string }
        return HttpResponse.json(
          {
            id: LATER_CHAT_ID,
            type: 'personal',
            created_at: '2026-11-19T12:00:00Z',
            members: [
              { id: ALICE.id, username: 'alice_1' },
              { id: body.user_id, username: 'charlie_3' },
            ],
            last_seq: 0,
          },
          { status: 201 },
        )
      }),
    )
    const auth = await authValue()
    const user = userEvent.setup()
    renderChats(auth)

    await screen.findByText('Начните переписку')
    await user.type(screen.getByRole('searchbox', { name: 'Поиск по логину' }), 'char')
    await user.click(await screen.findByRole('button', { name: /Написать charlie_3/i }))

    expect(await screen.findByRole('heading', { name: 'charlie_3' })).toBeInTheDocument()

    await user.clear(screen.getByRole('searchbox', { name: 'Поиск по логину' }))
    const listAlert = await screen.findByText(/Не удалось загрузить чаты/i)
    const retry = within(listAlert.closest('[role="alert"]') as HTMLElement).getByRole('button', {
      name: 'Повторить',
    })
    expect(screen.getByText(/пока нет чатов/i)).toBeInTheDocument()

    failListAfterCreate = false
    await user.click(retry)
    expect(await screen.findByRole('link', { name: /charlie_3/i })).toBeInTheDocument()
    expect(screen.queryByText(/Не удалось загрузить чаты/i)).not.toBeInTheDocument()
  })

  it('keeps preview and unread when refresh after opening an existing chat fails', async () => {
    let failListAfterCreate = false
    const existingList = {
      chats: [
        {
          id: INITIAL_CHAT_ID,
          type: 'personal' as const,
          created_at: '2026-11-07T11:00:00Z',
          members: [
            { id: ALICE.id, username: 'alice_1' },
            { id: BOB_ID, username: 'bob_2' },
          ],
          last_message: {
            id: 'm-old',
            chat_id: INITIAL_CHAT_ID,
            seq: 1,
            sender_id: BOB_ID,
            body: 'старое превью',
            created_at: '2026-11-19T10:00:00Z',
          },
          unread_count: 3,
        },
      ],
    }
    server.use(
      http.get('/chats', () => {
        if (failListAfterCreate) {
          return HttpResponse.json(
            { code: 'unknown_error', message: 'unavailable' },
            { status: 503 },
          )
        }
        return HttpResponse.json(existingList)
      }),
      http.post('/chats/personal', async () => {
        failListAfterCreate = true
        return HttpResponse.json({
          id: INITIAL_CHAT_ID,
          type: 'personal',
          created_at: '2026-11-07T11:00:00Z',
          members: [
            { id: ALICE.id, username: 'alice_1' },
            { id: BOB_ID, username: 'bob_2' },
          ],
          last_seq: 1,
        })
      }),
    )
    const auth = await authValue()
    const user = userEvent.setup()
    renderChats(auth)

    const bobRow = await screen.findByRole('link', { name: /bob_2/i })
    expect(within(bobRow).getByText('3')).toBeInTheDocument()
    expect(within(bobRow).getByText('старое превью')).toBeInTheDocument()

    await user.type(screen.getByRole('searchbox', { name: 'Поиск по логину' }), 'bob')
    await user.click(await screen.findByRole('button', { name: /Написать bob_2/i }))

    expect(await screen.findByRole('heading', { name: 'bob_2' })).toBeInTheDocument()
    await user.clear(screen.getByRole('searchbox', { name: 'Поиск по логину' }))

    const rowAfter = await screen.findByRole('link', { name: /bob_2/i })
    expect(within(rowAfter).getByText('3')).toBeInTheDocument()
    expect(within(rowAfter).getByText('старое превью')).toBeInTheDocument()
    const listAlertText = await screen.findByText(/Не удалось загрузить чаты/i)
    expect(
      within(listAlertText.closest('[role="alert"]') as HTMLElement).getByRole('button', {
        name: 'Повторить',
      }),
    ).toBeInTheDocument()
  })

  it('ignores a stale initial GET that arrives after a newer refresh', async () => {
    addUser({
      id: CHARLIE_ID,
      username: 'charlie_3',
      password: 'test-password',
      created_at: '2026-11-01T10:10:00Z',
    })
    let releaseInitial!: () => void
    const initialGate = new Promise<void>((resolve) => {
      releaseInitial = resolve
    })
    let listCalls = 0
    server.use(
      http.get('/chats', async () => {
        listCalls += 1
        if (listCalls === 1) {
          await initialGate
          return HttpResponse.json({ chats: [] })
        }
        return HttpResponse.json({
          chats: [
            {
              id: LATER_CHAT_ID,
              type: 'personal',
              created_at: '2026-11-19T12:00:00Z',
              members: [
                { id: ALICE.id, username: 'alice_1' },
                { id: CHARLIE_ID, username: 'charlie_3' },
              ],
              last_message: null,
              unread_count: 0,
            },
          ],
        })
      }),
      http.post('/chats/personal', async ({ request }) => {
        const body = (await request.json()) as { user_id: string }
        return HttpResponse.json(
          {
            id: LATER_CHAT_ID,
            type: 'personal',
            created_at: '2026-11-19T12:00:00Z',
            members: [
              { id: ALICE.id, username: 'alice_1' },
              { id: body.user_id, username: 'charlie_3' },
            ],
            last_seq: 0,
          },
          { status: 201 },
        )
      }),
    )
    const auth = await authValue()
    const user = userEvent.setup()
    renderChats(auth)

    expect(await screen.findByText('Загрузка чатов…')).toBeInTheDocument()
    await user.type(screen.getByRole('searchbox', { name: 'Поиск по логину' }), 'char')
    await user.click(await screen.findByRole('button', { name: /Написать charlie_3/i }))
    expect(await screen.findByRole('heading', { name: 'charlie_3' })).toBeInTheDocument()

    await user.clear(screen.getByRole('searchbox', { name: 'Поиск по логину' }))
    expect(await screen.findByRole('link', { name: /charlie_3/i })).toBeInTheDocument()

    await act(async () => {
      releaseInitial()
    })

    await waitFor(() => {
      expect(screen.getByRole('link', { name: /charlie_3/i })).toBeInTheDocument()
    })
    expect(screen.queryByText('Начните переписку')).not.toBeInTheDocument()
  })

  it('shows not-found search empty state', async () => {
    server.use(http.get('/users/search', () => HttpResponse.json({ users: [] })))
    const auth = await authValue()
    const user = userEvent.setup()
    renderChats(auth)

    await screen.findByRole('heading', { name: 'Чаты' })
    await user.type(screen.getByRole('searchbox', { name: 'Поиск по логину' }), 'zzz')
    expect(await screen.findByText('Никого не нашли')).toBeInTheDocument()
    expect(screen.getByText(/Проверьте логин/i)).toBeInTheDocument()
  })

  it('does not navigate when the user goes back before POST resolves', async () => {
    addUser({
      id: CHARLIE_ID,
      username: 'charlie_3',
      password: 'test-password',
      created_at: '2026-11-01T10:10:00Z',
    })
    let releaseCreate!: () => void
    const createGate = new Promise<void>((resolve) => {
      releaseCreate = resolve
    })
    server.use(
      http.get('/chats', () =>
        HttpResponse.json({
          chats: [
            {
              id: INITIAL_CHAT_ID,
              type: 'personal',
              created_at: '2026-11-07T11:00:00Z',
              members: [
                { id: ALICE.id, username: 'alice_1' },
                { id: BOB_ID, username: 'bob_2' },
              ],
              last_message: {
                id: 'm1',
                chat_id: INITIAL_CHAT_ID,
                seq: 1,
                sender_id: BOB_ID,
                body: 'привет',
                created_at: '2026-11-19T10:48:00Z',
              },
              unread_count: 0,
            },
          ],
        }),
      ),
      http.post('/chats/personal', async ({ request }) => {
        await createGate
        const body = (await request.json()) as { user_id: string }
        return HttpResponse.json(
          {
            id: LATER_CHAT_ID,
            type: 'personal',
            created_at: '2026-11-19T12:00:00Z',
            members: [
              { id: ALICE.id, username: 'alice_1' },
              { id: body.user_id, username: 'charlie_3' },
            ],
            last_seq: 0,
          },
          { status: 201 },
        )
      }),
    )
    const auth = await authValue()
    const mockWs = new MockWebSocketServer({ senderId: auth.user?.id ?? ALICE.id })
    const router = createMemoryRouter(
      [
        { path: '/', element: <ChatListPage /> },
        { path: '/chats/:chatId', element: <ChatListPage /> },
      ],
      { initialEntries: ['/', `/chats/${INITIAL_CHAT_ID}`], initialIndex: 1 },
    )
    render(
      <AuthContext.Provider value={auth}>
        <WsProvider webSocketFactory={mockWs.webSocketFactory} disableApiMockSocket>
          <RouterProvider router={router} />
        </WsProvider>
      </AuthContext.Provider>,
    )

    expect(await screen.findByRole('heading', { name: 'bob_2' })).toBeInTheDocument()
    const user = userEvent.setup()
    await user.type(screen.getByRole('searchbox', { name: 'Поиск по логину' }), 'char')
    await user.click(await screen.findByRole('button', { name: /Написать charlie_3/i }))

    await act(async () => {
      await router.navigate(-1)
    })
    expect(await screen.findByText(/Выберите чат/i)).toBeInTheDocument()

    await act(async () => {
      releaseCreate()
    })

    await waitFor(() => {
      expect(screen.queryByRole('heading', { name: 'charlie_3' })).not.toBeInTheDocument()
    })
    expect(screen.getByText(/Выберите чат/i)).toBeInTheDocument()
    expect(router.state.location.pathname).toBe('/')
  })

  it('retries opening the selected user after a failed create', async () => {
    addUser({
      id: CHARLIE_ID,
      username: 'charlie_3',
      password: 'test-password',
      created_at: '2026-11-01T10:10:00Z',
    })
    let createCalls = 0
    server.use(
      http.post('/chats/personal', async ({ request }) => {
        createCalls += 1
        if (createCalls === 1) {
          return HttpResponse.json(
            { code: 'unknown_error', message: 'unavailable' },
            { status: 503 },
          )
        }
        const body = (await request.json()) as { user_id: string }
        return HttpResponse.json(
          {
            id: LATER_CHAT_ID,
            type: 'personal',
            created_at: '2026-11-19T12:00:00Z',
            members: [
              { id: ALICE.id, username: 'alice_1' },
              { id: body.user_id, username: 'charlie_3' },
            ],
            last_seq: 0,
          },
          { status: 201 },
        )
      }),
    )
    const auth = await authValue()
    const user = userEvent.setup()
    renderChats(auth)

    await screen.findByRole('heading', { name: 'Чаты' })
    await user.type(screen.getByRole('searchbox', { name: 'Поиск по логину' }), 'char')
    await user.click(await screen.findByRole('button', { name: /Написать charlie_3/i }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/не удалось открыть чат/i)

    await user.click(screen.getByRole('button', { name: 'Повторить' }))
    expect(await screen.findByRole('heading', { name: 'charlie_3' })).toBeInTheDocument()
    expect(createCalls).toBe(2)
  })

  it('shows a hint for invalid search input instead of calling the API', async () => {
    const auth = await authValue()
    const user = userEvent.setup()
    renderChats(auth)

    await screen.findByRole('heading', { name: 'Чаты' })
    await user.type(screen.getByRole('searchbox', { name: 'Поиск по логину' }), 'алиса')
    expect(await screen.findByText(/латинские буквы/i)).toBeInTheDocument()
  })

  it('disables every write button while one chat is opening', async () => {
    addUser({
      id: CHARLIE_ID,
      username: 'charlie_3',
      password: 'test-password',
      created_at: '2026-11-01T10:10:00Z',
    })
    addUser({
      id: '00000000-0000-4000-8000-000000000004',
      username: 'dana_4',
      password: 'test-password',
      created_at: '2026-11-01T10:10:00Z',
    })
    let releaseCreate!: () => void
    const createGate = new Promise<void>((resolve) => {
      releaseCreate = resolve
    })
    server.use(
      http.get('/users/search', () =>
        HttpResponse.json({
          users: [
            { id: CHARLIE_ID, username: 'charlie_3' },
            { id: '00000000-0000-4000-8000-000000000004', username: 'dana_4' },
          ],
        }),
      ),
      http.post('/chats/personal', async ({ request }) => {
        await createGate
        const body = (await request.json()) as { user_id: string }
        return HttpResponse.json(
          {
            id: LATER_CHAT_ID,
            type: 'personal',
            created_at: '2026-11-19T12:00:00Z',
            members: [
              { id: ALICE.id, username: 'alice_1' },
              { id: body.user_id, username: 'charlie_3' },
            ],
            last_seq: 0,
          },
          { status: 201 },
        )
      }),
    )
    const auth = await authValue()
    const user = userEvent.setup()
    renderChats(auth)

    await screen.findByRole('heading', { name: 'Чаты' })
    await user.type(screen.getByRole('searchbox', { name: 'Поиск по логину' }), 'a')
    const writeCharlie = await screen.findByRole('button', { name: /Написать charlie_3/i })
    const writeDana = screen.getByRole('button', { name: /Написать dana_4/i })
    await user.click(writeCharlie)
    expect(writeCharlie).toBeDisabled()
    expect(writeDana).toBeDisabled()
    releaseCreate()
    expect(await screen.findByRole('heading', { name: 'charlie_3' })).toBeInTheDocument()
  })
  it('opens the chat at focusMessageId from navigation state and consumes it once', async () => {
    const auth = await authValue()
    const mockWs = new MockWebSocketServer({ senderId: ALICE.id })
    const targetId = '20000000-0000-4000-8000-000000000003'

    function LocationState() {
      const location = useLocation()
      return <output data-testid="nav-state">{JSON.stringify(location.state)}</output>
    }

    render(
      <AuthContext.Provider value={auth}>
        <WsProvider webSocketFactory={mockWs.webSocketFactory} disableApiMockSocket>
          <MemoryRouter
            initialEntries={[
              {
                pathname: `/chats/${INITIAL_CHAT_ID}`,
                state: { peerUsername: 'bob_2', focusMessageId: targetId },
              },
            ]}
          >
            <LocationState />
            <Routes>
              <Route path="/chats/:chatId" element={<ChatListPage />} />
            </Routes>
          </MemoryRouter>
        </WsProvider>
      </AuthContext.Provider>,
    )

    expect(await screen.findByText('Как дела?')).toBeInTheDocument()
    await waitFor(() => {
      expect(document.querySelector(`[data-message-id="${targetId}"]`)).toHaveAttribute(
        'data-highlighted',
        'true',
      )
    })
    // One-shot: focusMessageId is dropped, peerUsername is kept for the header.
    await waitFor(() =>
      expect(screen.getByTestId('nav-state')).toHaveTextContent('{"peerUsername":"bob_2"}'),
    )
  })
})
