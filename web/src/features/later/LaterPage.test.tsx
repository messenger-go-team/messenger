import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
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

const MESSAGE = {
  id: '20000000-0000-4000-8000-000000000001',
  chat_id: '10000000-0000-4000-8000-000000000001',
  seq: 1,
  sender_id: ALICE.id,
  body: 'Не забыть ответить',
  created_at: '2026-11-14T15:00:00Z',
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

  it('groups entries into three sections', async () => {
    seedLaterMocks([
      {
        id: '98fcaed4-d453-4cba-b561-4100fe7aa314',
        message: MESSAGE,
        due_at: '2020-01-01T00:00:00.000Z',
        created_at: '2026-11-14T15:00:00Z',
        updated_at: '2026-11-14T15:00:00Z',
      },
      {
        id: 'a2e461f6-e1d8-44ec-b633-4debfda53b9f',
        message: { ...MESSAGE, id: '20000000-0000-4000-8000-000000000002', body: 'Позже' },
        due_at: '2099-01-01T00:00:00.000Z',
        created_at: '2026-11-14T15:01:00Z',
        updated_at: '2026-11-14T15:01:00Z',
      },
      {
        id: 'b5ab7aaa-6a79-4e1a-a2db-0582d215fc4b',
        message: {
          ...MESSAGE,
          id: '20000000-0000-4000-8000-000000000003',
          body: 'Сохранить на потом',
        },
        due_at: null,
        created_at: '2026-11-14T15:02:00Z',
        updated_at: '2026-11-14T15:02:00Z',
      },
    ])
    const auth = await authValue()
    renderLater(auth)
    expect(await screen.findByRole('heading', { name: 'Сейчас' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Запланировано' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Без срока' })).toBeInTheDocument()
    expect(screen.getByText('Не забыть ответить')).toBeInTheDocument()
    expect(screen.getByText('Позже')).toBeInTheDocument()
    expect(screen.getByText('Сохранить на потом')).toBeInTheDocument()
  })

  it('removes entry after Готово confirmation', async () => {
    seedLaterMocks([
      {
        id: '98fcaed4-d453-4cba-b561-4100fe7aa314',
        message: MESSAGE,
        due_at: null,
        created_at: '2026-11-14T15:00:00Z',
        updated_at: '2026-11-14T15:00:00Z',
      },
    ])
    const auth = await authValue()
    renderLater(auth)
    expect(await screen.findByText('Не забыть ответить')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Готово' }))
    const dialog = await screen.findByRole('alertdialog')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Готово' }))
    expect(await screen.findByText('Пока пусто')).toBeInTheDocument()
  })

  it('shows error and retry', async () => {
    server.use(
      http.get('/later', () =>
        HttpResponse.json({ code: 'unavailable', message: 'down' }, { status: 503 }),
      ),
    )
    const auth = await authValue()
    renderLater(auth)
    expect(await screen.findByRole('alert')).toHaveTextContent(/Не удалось загрузить/i)
    expect(screen.getByRole('button', { name: 'Повторить' })).toBeInTheDocument()
  })

  it('clears list when session ends', async () => {
    seedLaterMocks([
      {
        id: '98fcaed4-d453-4cba-b561-4100fe7aa314',
        message: MESSAGE,
        due_at: null,
        created_at: '2026-11-14T15:00:00Z',
        updated_at: '2026-11-14T15:00:00Z',
      },
    ])
    const auth = await authValue()
    const { rerender } = renderLater(auth)
    expect(await screen.findByText('Не забыть ответить')).toBeInTheDocument()
    rerender(
      <AuthContext.Provider
        value={{
          ...auth,
          accessToken: null,
          isAuthenticated: false,
          user: null,
        }}
      >
        <MemoryRouter initialEntries={['/later']}>
          <Routes>
            <Route path="/later" element={<LaterPage />} />
          </Routes>
        </MemoryRouter>
      </AuthContext.Provider>,
    )
    expect(await screen.findByText('Пока пусто')).toBeInTheDocument()
  })
})
