import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { MemoryRouter, Route, Routes } from 'react-router'
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

function renderChats(auth: AuthContextValue, initialPath = '/') {
  const mockWs = new MockWebSocketServer({ senderId: auth.user?.id ?? ALICE.id })
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

  it('shows empty state when there are no chats', async () => {
    server.use(http.get('/chats', () => HttpResponse.json({ chats: [] })))
    const auth = await authValue()
    renderChats(auth)

    expect(await screen.findByText('У вас нет чатов')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Найти человека' })).toBeInTheDocument()
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
    // После create список падает; до create оба клиента (UI + WS history sync) получают [].
    let failListAfterCreate = false
    server.use(
      http.get('/chats', () => {
        if (failListAfterCreate) {
          return HttpResponse.json({ code: 'unknown_error', message: 'unavailable' }, { status: 503 })
        }
        return HttpResponse.json({ chats: [] })
      }),
      http.post('/chats/personal', async ({ request }) => {
        failListAfterCreate = true
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

    await screen.findByText('У вас нет чатов')
    await user.type(screen.getByRole('searchbox', { name: 'Поиск по логину' }), 'char')
    await user.click(await screen.findByRole('button', { name: /Написать charlie_3/i }))

    expect(await screen.findByRole('heading', { name: 'charlie_3' })).toBeInTheDocument()
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
})
