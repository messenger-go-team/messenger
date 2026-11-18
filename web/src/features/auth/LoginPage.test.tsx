import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router'
import { describe, expect, it, vi } from 'vitest'
import { AuthContext } from '@/features/auth/auth-context'
import { LOGOUT_FAILED_MESSAGE } from '@/features/auth/authErrors'
import { AuthProvider } from '@/features/auth/AuthProvider'
import { LoginPage } from '@/features/auth/LoginPage'

function renderLogin() {
  return render(
    <AuthProvider>
      <MemoryRouter initialEntries={['/login']}>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/" element={<h1>Домашняя</h1>} />
          <Route path="/register" element={<h1>Регистрация</h1>} />
        </Routes>
      </MemoryRouter>
    </AuthProvider>,
  )
}

describe('LoginPage', () => {
  it('shows client validation for invalid username', async () => {
    const user = userEvent.setup()
    renderLogin()

    await screen.findByLabelText('Логин')

    await user.type(screen.getByLabelText('Логин'), 'ab')
    await user.type(screen.getByLabelText('Пароль'), 'correct-horse-battery')
    await user.click(screen.getByRole('button', { name: 'Войти' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(/3–32/)
  })

  it('logs in with mock credentials and redirects home', async () => {
    const user = userEvent.setup()
    renderLogin()

    await screen.findByLabelText('Логин')

    await user.type(screen.getByLabelText('Логин'), 'alice_1')
    await user.type(screen.getByLabelText('Пароль'), 'correct-horse-battery')
    await user.click(screen.getByRole('button', { name: 'Войти' }))

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Домашняя' })).toBeInTheDocument()
    })
  })

  it('shows API error for wrong password', async () => {
    const user = userEvent.setup()
    renderLogin()

    await screen.findByLabelText('Логин')

    await user.type(screen.getByLabelText('Логин'), 'alice_1')
    await user.type(screen.getByLabelText('Пароль'), 'wrong-password')
    await user.click(screen.getByRole('button', { name: 'Войти' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(/логин или пароль/i)
  })

  it('exposes remember-me and forgot-password controls from the mockup', async () => {
    renderLogin()

    await screen.findByLabelText('Логин')
    expect(screen.getByRole('checkbox', { name: 'Запомнить меня' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Забыли пароль' })).toHaveAttribute(
      'href',
      '/forgot-password',
    )
  })

  it('offers a retry when the previous logout did not finish', async () => {
    const user = userEvent.setup()
    const logout = vi.fn().mockResolvedValue(undefined)

    render(
      <AuthContext.Provider
        value={{
          user: null,
          accessToken: null,
          isReady: true,
          isAuthenticated: false,
          logoutError: LOGOUT_FAILED_MESSAGE,
          login: vi.fn(),
          register: vi.fn(),
          logout,
        }}
      >
        <MemoryRouter>
          <LoginPage />
        </MemoryRouter>
      </AuthContext.Provider>,
    )

    expect(screen.getByRole('alert')).toHaveTextContent(LOGOUT_FAILED_MESSAGE)
    await user.click(screen.getByRole('button', { name: 'Повторить выход' }))
    expect(logout).toHaveBeenCalledTimes(1)
  })
})
