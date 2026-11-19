import { render, screen } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { MemoryRouter, Route, Routes } from 'react-router'
import { describe, expect, it } from 'vitest'
import type { User } from '@/api/auth'
import { login } from '@/api/auth'
import { AuthContext, type AuthContextValue } from '@/features/auth/auth-context'
import { LaterPage } from '@/features/later/LaterPage'
import { server } from '../../../mocks/server'
import { seedLaterMocks } from '../../../mocks/handlers/later'

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

function renderLater(auth: AuthContextValue) {
  return render(
    <AuthContext.Provider value={auth}>
      <MemoryRouter initialEntries={['/later']}>
        <Routes>
          <Route path="/later" element={<LaterPage />} />
        </Routes>
      </MemoryRouter>
    </AuthContext.Provider>,
  )
}

describe('LaterPage', () => {
  it('shows empty Important state', async () => {
    seedLaterMocks([])
    const auth = await authValue()
    renderLater(auth)
    expect(await screen.findByText('Пока пусто')).toBeInTheDocument()
  })

  it('lists later entries', async () => {
    seedLaterMocks([
      {
        id: '98fcaed4-d453-4cba-b561-4100fe7aa314',
        status: 'due',
        message: {
          id: '20000000-0000-4000-8000-000000000001',
          chat_id: '10000000-0000-4000-8000-000000000001',
          body: 'Не забыть ответить',
        },
        due_at: '2026-11-14T16:00:00Z',
        created_at: '2026-11-14T15:00:00Z',
      },
    ])
    server.use(
      http.get('/later', () =>
        HttpResponse.json({
          server_time: '2026-11-14T16:00:00Z',
          entries: [
            {
              id: '98fcaed4-d453-4cba-b561-4100fe7aa314',
              status: 'due',
              message: {
                id: '20000000-0000-4000-8000-000000000001',
                chat_id: '10000000-0000-4000-8000-000000000001',
                body: 'Не забыть ответить',
              },
              due_at: '2026-11-14T16:00:00Z',
              created_at: '2026-11-14T15:00:00Z',
            },
          ],
        }),
      ),
    )
    const auth = await authValue()
    renderLater(auth)
    expect(await screen.findByText('Не забыть ответить')).toBeInTheDocument()
    expect(screen.getByText('Сейчас')).toBeInTheDocument()
  })
})
