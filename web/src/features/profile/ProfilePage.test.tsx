import { render, screen, waitFor, within } from '@testing-library/react'
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

function renderProfile(logout: AuthContextValue['logout'] = vi.fn(async () => undefined)) {
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
  return {
    logout,
    user: userEvent.setup(),
    ...render(
      <AuthContext.Provider value={auth}>
        <MemoryRouter initialEntries={['/profile']}>
          <Routes>
            <Route path="/profile" element={<ProfilePage />} />
            <Route path="/change-password" element={<h1>Смена пароля</h1>} />
          </Routes>
        </MemoryRouter>
      </AuthContext.Provider>,
    ),
  }
}

describe('ProfilePage', () => {
  it('shows username and logout confirmation dialog', async () => {
    const { user, logout } = renderProfile()

    expect(screen.getByRole('heading', { name: 'Профиль' })).toBeInTheDocument()
    expect(screen.getByText('alice_1')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Выйти' }))
    expect(screen.getByRole('alertdialog')).toHaveTextContent(/Выйти из аккаунта/i)
    await user.click(screen.getByRole('button', { name: 'Выйти из аккаунта' }))
    expect(logout).toHaveBeenCalledTimes(1)
  })

  it('moves focus into the dialog, traps Tab, and restores focus on Escape', async () => {
    const { user, logout } = renderProfile()
    const logoutButton = screen.getByRole('button', { name: 'Выйти' })
    logoutButton.focus()
    expect(logoutButton).toHaveFocus()

    await user.keyboard('{Enter}')
    const dialog = await screen.findByRole('alertdialog')
    const cancel = within(dialog).getByRole('button', { name: 'Отмена' })
    const confirm = within(dialog).getByRole('button', { name: 'Выйти из аккаунта' })
    await waitFor(() => expect(cancel).toHaveFocus())

    const focusStaysInModal = () => {
      const active = document.activeElement
      expect(active).toBeTruthy()
      expect(active).not.toBe(logoutButton)
      expect(dialog.contains(active) || active?.hasAttribute('data-base-ui-focus-guard')).toBe(true)
    }

    await user.tab()
    expect(confirm).toHaveFocus()
    await user.tab()
    focusStaysInModal()
    await user.tab({ shift: true })
    focusStaysInModal()

    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument())
    expect(logoutButton).toHaveFocus()
    expect(logout).not.toHaveBeenCalled()
  })

  it('closes the dialog via Cancel without logging out and restores focus', async () => {
    const { user, logout } = renderProfile()
    const logoutButton = screen.getByRole('button', { name: 'Выйти' })
    await user.click(logoutButton)
    const dialog = await screen.findByRole('alertdialog')
    await user.click(within(dialog).getByRole('button', { name: 'Отмена' }))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument())
    expect(logoutButton).toHaveFocus()
    expect(logout).not.toHaveBeenCalled()
  })

  it('keeps the profile main region scrollable', () => {
    renderProfile()
    const main = screen.getByRole('main')
    expect(main.className).toMatch(/overflow-y-auto/)
  })

  it('opens change-password from the profile action', async () => {
    const { user } = renderProfile()
    await user.click(screen.getByRole('link', { name: 'Сменить пароль' }))
    expect(await screen.findByRole('heading', { name: 'Смена пароля' })).toBeInTheDocument()
  })
})
