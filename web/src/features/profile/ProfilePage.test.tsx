import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router'
import { describe, expect, it, vi } from 'vitest'
import type { User } from '@/api/auth'
import { AuthContext, type AuthContextValue } from '@/features/auth/auth-context'
import { ProfilePage } from '@/features/profile/ProfilePage'

const ALICE: User = {
  id: '00000000-0000-4000-8000-000000000001',
  username: 'alice_1',
  created_at: '2026-01-01T00:00:00Z',
}

describe('ProfilePage', () => {
  it('shows username and logout confirmation dialog', async () => {
    const logout = vi.fn(async () => undefined)
    const auth: AuthContextValue = {
      user: ALICE,
      accessToken: 'token',
      isReady: true,
      isAuthenticated: true,
      logoutError: null,
      login: async () => undefined,
      register: async () => undefined,
      logout,
    }
    const user = userEvent.setup()
    render(
      <AuthContext.Provider value={auth}>
        <MemoryRouter initialEntries={['/profile']}>
          <Routes>
            <Route path="/profile" element={<ProfilePage />} />
          </Routes>
        </MemoryRouter>
      </AuthContext.Provider>,
    )

    expect(screen.getByRole('heading', { name: 'Профиль' })).toBeInTheDocument()
    expect(screen.getByText('alice_1')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Выйти' }))
    expect(screen.getByRole('alertdialog')).toHaveTextContent(/Выйти из аккаунта/i)
    await user.click(screen.getByRole('button', { name: 'Выйти из аккаунта' }))
    expect(logout).toHaveBeenCalled()
  })
})
