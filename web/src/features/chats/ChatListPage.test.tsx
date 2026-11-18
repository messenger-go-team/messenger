import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { MemoryRouter, Route, Routes } from 'react-router'
import { describe, expect, it } from 'vitest'
import type { User } from '@/api/auth'
import { login } from '@/api/auth'
import { AuthContext, type AuthContextValue } from '@/features/auth/auth-context'
import { ChatListPage } from '@/features/chats/ChatListPage'
import { server } from '../../../mocks/server'
import { addUser } from '../../../mocks/data/auth'
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

function renderChats(auth: AuthContextValue, initialPath = '/') {
  return render(
    <AuthContext.Provider value={auth}>
      <MemoryRouter initialEntries={[initialPath]}>
        <Routes>
          <Route path="/" element={<ChatListPage />} />
          <Route path="/chats/:chatId" element={<ChatListPage />} />
          <Route path="/contacts" element={<h1>Контакты</h1>} />
        </Routes>
      </MemoryRouter>
    </AuthContext.Provider>,
  )
}

describe('ChatListPage', () => {
  it('loads chats sorted by last message and shows unread badge', async () => {
    const auth = await authValue()
    renderChats(auth)

    expect(await screen.findByRole('heading', { name: 'Чаты' })).toBeInTheDocument()
    expect(await screen.findByText('bob_2')).toBeInTheDocument()
    const row = screen.getByRole('link', { name: /bob_2/i })
    expect(within(row).getByText('1')).toBeInTheDocument()
    expect(within(row).queryByText(/^0$/)).not.toBeInTheDocument()
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
                { id: '00000000-0000-4000-8000-000000000002', username: 'bob_2' },
              ],
              last_message: {
                id: 'm1',
                chat_id: INITIAL_CHAT_ID,
                seq: 1,
                sender_id: '00000000-0000-4000-8000-000000000002',
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

  it('searches users by username prefix and opens a personal chat', async () => {
    addUser({
      id: '00000000-0000-4000-8000-000000000003',
      username: 'charlie_3',
      password: 'test-password',
      created_at: '2026-11-01T10:10:00Z',
    })
    const auth = await authValue()
    const user = userEvent.setup()
    renderChats(auth)

    await screen.findByRole('heading', { name: 'Чаты' })
    await user.type(screen.getByRole('searchbox', { name: 'найти' }), 'char')
    expect(await screen.findByText('charlie_3')).toBeInTheDocument()
    expect(screen.queryByText('alice_1')).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /Написать charlie_3/i }))
    await waitFor(() => {
      expect(screen.getByText(/чат с charlie_3/i)).toBeInTheDocument()
    })
  })

  it('shows a hint for invalid search input instead of calling the API', async () => {
    const auth = await authValue()
    const user = userEvent.setup()
    renderChats(auth)

    await screen.findByRole('heading', { name: 'Чаты' })
    await user.type(screen.getByRole('searchbox', { name: 'найти' }), 'алиса')
    expect(await screen.findByText(/латинские буквы/i)).toBeInTheDocument()
  })
})
