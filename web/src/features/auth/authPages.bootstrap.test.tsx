import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AccessTokenResponse, User } from '@/api/auth'
import { ApiError } from '@/api/client'
import { LOGOUT_FAILED_MESSAGE } from '@/features/auth/authErrors'
import { AuthProvider } from '@/features/auth/AuthProvider'
import { LoginPage } from '@/features/auth/LoginPage'
import { RegisterPage } from '@/features/auth/RegisterPage'
import { LOGOUT_PENDING_KEY } from '@/features/auth/logoutPending'
import { resetSharedRefreshCoordinatorForTests } from '@/features/auth/refreshCoordinator'

const { refresh, login, logout, getMe, register } = vi.hoisted(() => ({
  refresh: vi.fn(),
  login: vi.fn(),
  logout: vi.fn(),
  getMe: vi.fn(),
  register: vi.fn(),
}))

vi.mock('@/api/auth', () => ({
  refresh,
  login,
  logout,
  getMe,
  register,
}))

const session: AccessTokenResponse = {
  token_type: 'Bearer',
  access_token: 'access-1',
  expires_in: 900,
}

const profile: User = {
  id: '00000000-0000-4000-8000-000000000001',
  username: 'alice_1',
  created_at: '2026-01-01T00:00:00Z',
}

function deferred<T>() {
  let resolvePromise: (value: T) => void = () => undefined
  let rejectPromise: (error: unknown) => void = () => undefined
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve
    rejectPromise = reject
  })

  return { promise, resolve: resolvePromise, reject: rejectPromise }
}

describe('Auth pages bootstrap and revoke retry', () => {
  afterEach(() => {
    vi.resetAllMocks()
    sessionStorage.clear()
    resetSharedRefreshCoordinatorForTests()
  })

  it('keeps login behind a session check until bootstrap profile finishes', async () => {
    const lateProfile = deferred<User>()
    refresh.mockResolvedValue(session)
    getMe.mockImplementationOnce(() => lateProfile.promise)

    render(
      <AuthProvider>
        <MemoryRouter initialEntries={['/login']}>
          <Routes>
            <Route path="/login" element={<LoginPage />} />
            <Route path="/" element={<h1>Домашняя</h1>} />
          </Routes>
        </MemoryRouter>
      </AuthProvider>,
    )

    expect(await screen.findByRole('status')).toHaveTextContent('Проверяем сессию…')
    expect(screen.queryByLabelText('Логин')).not.toBeInTheDocument()

    lateProfile.resolve(profile)

    expect(await screen.findByRole('heading', { name: 'Домашняя' })).toBeInTheDocument()
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Логин')).not.toBeInTheDocument()
  })

  it('keeps register behind a session check until bootstrap profile finishes', async () => {
    const lateProfile = deferred<User>()
    refresh.mockResolvedValue(session)
    getMe.mockImplementationOnce(() => lateProfile.promise)

    render(
      <AuthProvider>
        <MemoryRouter initialEntries={['/register']}>
          <Routes>
            <Route path="/register" element={<RegisterPage />} />
            <Route path="/" element={<h1>Домашняя</h1>} />
          </Routes>
        </MemoryRouter>
      </AuthProvider>,
    )

    expect(await screen.findByRole('status')).toHaveTextContent('Проверяем сессию…')
    expect(screen.queryByLabelText('Логин')).not.toBeInTheDocument()

    lateProfile.resolve(profile)

    expect(await screen.findByRole('heading', { name: 'Домашняя' })).toBeInTheDocument()
    expect(screen.queryByLabelText('Логин')).not.toBeInTheDocument()
  })

  it('shows the login form after bootstrap refresh returns 401', async () => {
    refresh.mockRejectedValue(new ApiError(401, 'invalid_refresh_token', 'missing'))

    render(
      <AuthProvider>
        <MemoryRouter initialEntries={['/login']}>
          <Routes>
            <Route path="/login" element={<LoginPage />} />
          </Routes>
        </MemoryRouter>
      </AuthProvider>,
    )

    expect(await screen.findByLabelText('Логин')).toBeInTheDocument()
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('offers logout retry on LoginPage when automatic revoke fails after a profile error', async () => {
    const user = userEvent.setup()
    refresh.mockRejectedValue(new ApiError(401, 'invalid_refresh_token', 'missing'))
    login.mockResolvedValue(session)
    getMe.mockRejectedValueOnce(new ApiError(500, 'unknown_error', 'unavailable'))
    logout
      .mockRejectedValueOnce(new ApiError(500, 'unknown_error', 'unavailable'))
      .mockResolvedValueOnce(undefined)

    render(
      <AuthProvider>
        <MemoryRouter initialEntries={['/login']}>
          <Routes>
            <Route path="/login" element={<LoginPage />} />
            <Route path="/" element={<h1>Домашняя</h1>} />
          </Routes>
        </MemoryRouter>
      </AuthProvider>,
    )

    expect(await screen.findByLabelText('Логин')).toBeInTheDocument()

    await user.type(screen.getByLabelText('Логин'), 'alice_1')
    await user.type(screen.getByLabelText('Пароль'), 'correct-horse-battery')
    await user.click(screen.getByRole('button', { name: 'Войти' }))

    expect(await screen.findByRole('button', { name: 'Повторить выход' })).toBeInTheDocument()
    expect(screen.getByText(LOGOUT_FAILED_MESSAGE)).toBeInTheDocument()
    expect(sessionStorage.getItem(LOGOUT_PENDING_KEY)).toBe('1')
    expect(screen.queryByRole('heading', { name: 'Домашняя' })).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Повторить выход' }))

    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Повторить выход' })).not.toBeInTheDocument()
    })
    expect(sessionStorage.getItem(LOGOUT_PENDING_KEY)).toBeNull()
    expect(logout).toHaveBeenCalledTimes(2)
  })
})
