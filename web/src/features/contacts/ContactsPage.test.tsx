import { render, screen } from '@testing-library/react'
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
})
