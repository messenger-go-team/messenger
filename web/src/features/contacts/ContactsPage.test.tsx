import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { MemoryRouter, Route, Routes } from 'react-router'
import { describe, expect, it } from 'vitest'
import type { User } from '@/api/auth'
import { login } from '@/api/auth'
import { AuthContext, type AuthContextValue } from '@/features/auth/auth-context'
import { ContactsPage } from '@/features/contacts/ContactsPage'
import { server } from '../../../mocks/server'
import { addUser } from '../../../mocks/data/auth'

const ALICE: User = {
  id: '00000000-0000-4000-8000-000000000001',
  username: 'alice_1',
  created_at: '2026-01-01T00:00:00Z',
}

const CHARLIE_ID = '00000000-0000-4000-8000-000000000003'
const BOB_ID = '00000000-0000-4000-8000-000000000002'

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

function renderContacts(auth: AuthContextValue) {
  return render(
    <AuthContext.Provider value={auth}>
      <MemoryRouter initialEntries={['/contacts']}>
        <Routes>
          <Route path="/contacts" element={<ContactsPage />} />
          <Route path="/chats/:chatId" element={<h1>Чат</h1>} />
        </Routes>
      </MemoryRouter>
    </AuthContext.Provider>,
  )
}

describe('ContactsPage', () => {
  it('shows empty state when there are no contacts', async () => {
    server.use(http.get('/contacts', () => HttpResponse.json({ contacts: [] })))
    const auth = await authValue()
    renderContacts(auth)
    expect(await screen.findByText('Пока нет контактов')).toBeInTheDocument()
  })

  it('lists contacts and opens a chat', async () => {
    addUser({
      id: CHARLIE_ID,
      username: 'charlie_3',
      password: 'test-password',
      created_at: '2026-11-01T10:10:00Z',
    })
    server.use(
      http.get('/contacts', () =>
        HttpResponse.json({
          contacts: [{ id: CHARLIE_ID, username: 'charlie_3' }],
        }),
      ),
      http.post('/chats/personal', async () =>
        HttpResponse.json(
          {
            id: '10000000-0000-4000-8000-000000000099',
            type: 'personal',
            created_at: '2026-11-19T12:00:00Z',
            members: [
              { id: ALICE.id, username: 'alice_1' },
              { id: CHARLIE_ID, username: 'charlie_3' },
            ],
            last_seq: 0,
          },
          { status: 201 },
        ),
      ),
    )
    const auth = await authValue()
    const user = userEvent.setup()
    renderContacts(auth)

    expect(await screen.findByText('charlie_3')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /Написать charlie_3/i }))
    expect(await screen.findByRole('heading', { name: 'Чат' })).toBeInTheDocument()
  })

  it('shows an action error when create chat fails and allows retry', async () => {
    addUser({
      id: CHARLIE_ID,
      username: 'charlie_3',
      password: 'test-password',
      created_at: '2026-11-01T10:10:00Z',
    })
    let attempts = 0
    server.use(
      http.get('/contacts', () =>
        HttpResponse.json({
          contacts: [{ id: CHARLIE_ID, username: 'charlie_3' }],
        }),
      ),
      http.post('/chats/personal', () => {
        attempts += 1
        if (attempts === 1)
          return HttpResponse.json({ code: 'unavailable', message: 'down' }, { status: 503 })
        return HttpResponse.json(
          {
            id: '10000000-0000-4000-8000-000000000099',
            type: 'personal',
            created_at: '2026-11-19T12:00:00Z',
            members: [
              { id: ALICE.id, username: 'alice_1' },
              { id: CHARLIE_ID, username: 'charlie_3' },
            ],
            last_seq: 0,
          },
          { status: 201 },
        )
      }),
    )
    const auth = await authValue()
    const user = userEvent.setup()
    renderContacts(auth)

    expect(await screen.findByText('charlie_3')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /Написать charlie_3/i }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/не удалось начать чат/i)
    await user.click(screen.getByRole('button', { name: /Повторить действие/i }))
    expect(await screen.findByRole('heading', { name: 'Чат' })).toBeInTheDocument()
  })

  it('shows an action error when add contact fails', async () => {
    addUser({
      id: CHARLIE_ID,
      username: 'charlie_3',
      password: 'test-password',
      created_at: '2026-11-01T10:10:00Z',
    })
    server.use(
      http.get('/contacts', () => HttpResponse.json({ contacts: [] })),
      http.get('/users/search', () =>
        HttpResponse.json({ users: [{ id: CHARLIE_ID, username: 'charlie_3' }] }),
      ),
      http.put(`/contacts/${CHARLIE_ID}`, () =>
        HttpResponse.json({ code: 'not_found', message: 'missing' }, { status: 404 }),
      ),
    )
    const auth = await authValue()
    const user = userEvent.setup()
    renderContacts(auth)

    expect(await screen.findByText('Пока нет контактов')).toBeInTheDocument()
    await user.type(screen.getByRole('searchbox'), 'char')
    expect(await screen.findByRole('button', { name: /Добавить charlie_3/i })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /Добавить charlie_3/i }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/не удалось обновить контакт/i)
  })

  it('ignores a stale contacts GET after a newer reload', async () => {
    addUser({
      id: CHARLIE_ID,
      username: 'charlie_3',
      password: 'test-password',
      created_at: '2026-11-01T10:10:00Z',
    })
    addUser({
      id: BOB_ID,
      username: 'bob_2',
      password: 'test-password',
      created_at: '2026-11-01T10:00:00Z',
    })

    let releaseFirst!: () => void
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    let contactsCalls = 0

    server.use(
      http.get('/contacts', async () => {
        contactsCalls += 1
        if (contactsCalls === 1) {
          await firstGate
          return HttpResponse.json({ contacts: [] })
        }
        return HttpResponse.json({
          contacts: [{ id: CHARLIE_ID, username: 'charlie_3' }],
        })
      }),
      http.get('/users/search', () =>
        HttpResponse.json({ users: [{ id: CHARLIE_ID, username: 'charlie_3' }] }),
      ),
      http.put(`/contacts/${CHARLIE_ID}`, () => new HttpResponse(null, { status: 204 })),
    )

    const auth = await authValue()
    const user = userEvent.setup()
    renderContacts(auth)

    await user.type(screen.getByRole('searchbox'), 'char')
    expect(await screen.findByRole('button', { name: /Добавить charlie_3/i })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /Добавить charlie_3/i }))
    expect(await screen.findByRole('button', { name: /Удалить charlie_3/i })).toBeInTheDocument()

    releaseFirst()
    await waitFor(() => expect(contactsCalls).toBeGreaterThanOrEqual(2))
    expect(screen.getByRole('button', { name: /Удалить charlie_3/i })).toBeInTheDocument()
    expect(screen.queryByText('Пока нет контактов')).not.toBeInTheDocument()
  })

  it('keeps the last contacts list and shows retry when reload fails', async () => {
    addUser({
      id: CHARLIE_ID,
      username: 'charlie_3',
      password: 'test-password',
      created_at: '2026-11-01T10:10:00Z',
    })
    let contactsCalls = 0
    server.use(
      http.get('/contacts', () => {
        contactsCalls += 1
        if (contactsCalls === 1) {
          return HttpResponse.json({
            contacts: [{ id: CHARLIE_ID, username: 'charlie_3' }],
          })
        }
        return HttpResponse.json({ code: 'unavailable', message: 'down' }, { status: 503 })
      }),
      http.delete(`/contacts/${CHARLIE_ID}`, () => new HttpResponse(null, { status: 204 })),
    )

    const auth = await authValue()
    const user = userEvent.setup()
    renderContacts(auth)

    expect(await screen.findByText('charlie_3')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /Удалить charlie_3/i }))

    expect(await screen.findByRole('alert')).toHaveTextContent(/не удалось загрузить контакты/i)
    expect(screen.getByRole('button', { name: 'Повторить' })).toBeInTheDocument()
    expect(screen.getByText('charlie_3')).toBeInTheDocument()
  })

  it('does not keep previous empty search while a new prefix is loading', async () => {
    addUser({
      id: CHARLIE_ID,
      username: 'charlie_3',
      password: 'test-password',
      created_at: '2026-11-01T10:10:00Z',
    })
    server.use(
      http.get('/contacts', () => HttpResponse.json({ contacts: [] })),
      http.get('/users/search', ({ request }) => {
        const prefix = new URL(request.url).searchParams.get('prefix')
        if (prefix === 'zzzz') return HttpResponse.json({ users: [] })
        return HttpResponse.json({ users: [{ id: CHARLIE_ID, username: 'charlie_3' }] })
      }),
    )
    const auth = await authValue()
    const user = userEvent.setup()
    renderContacts(auth)

    await user.type(screen.getByRole('searchbox'), 'zzzz')
    expect(await screen.findByText('Никого не нашли')).toBeInTheDocument()

    await user.clear(screen.getByRole('searchbox'))
    await user.type(screen.getByRole('searchbox'), 'char')
    expect(screen.queryByText('Никого не нашли')).not.toBeInTheDocument()
    expect(await screen.findByText('charlie_3')).toBeInTheDocument()
  })

  it('retries only the global search after a network error', async () => {
    addUser({
      id: CHARLIE_ID,
      username: 'charlie_3',
      password: 'test-password',
      created_at: '2026-11-01T10:10:00Z',
    })
    let searchCalls = 0
    server.use(
      http.get('/contacts', () =>
        HttpResponse.json({
          contacts: [{ id: BOB_ID, username: 'bob_2' }],
        }),
      ),
      http.get('/users/search', () => {
        searchCalls += 1
        if (searchCalls === 1) {
          return HttpResponse.json({ code: 'unavailable', message: 'down' }, { status: 503 })
        }
        return HttpResponse.json({ users: [{ id: CHARLIE_ID, username: 'charlie_3' }] })
      }),
    )
    const auth = await authValue()
    const user = userEvent.setup()
    renderContacts(auth)

    expect(await screen.findByText('bob_2')).toBeInTheDocument()
    await user.type(screen.getByRole('searchbox'), 'bob')
    expect(await screen.findByRole('alert')).toHaveTextContent(/не удалось найти пользователей/i)
    // Локальный фильтр сохраняет контакт при ошибке глобального поиска.
    expect(screen.getByText('bob_2')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /Повторить поиск/i }))
    expect(await screen.findByText('charlie_3')).toBeInTheDocument()
    expect(screen.getByText('bob_2')).toBeInTheDocument()
  })
})
