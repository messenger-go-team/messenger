import { act, render, screen } from '@testing-library/react'
import { StrictMode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AccessTokenResponse, User } from '@/api/auth'
import { AuthProvider } from '@/features/auth/AuthProvider'
import { useAuth } from '@/features/auth/useAuth'

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

function SessionProbe() {
  const auth = useAuth()

  return (
    <div>
      <p>{auth.isReady ? 'ready' : 'booting'}</p>
      <p>{auth.isAuthenticated ? 'in' : 'out'}</p>
      <p>{auth.user?.username ?? 'nobody'}</p>
      <button type="button" onClick={() => void auth.logout().catch(() => undefined)}>
        Выйти
      </button>
      <button
        type="button"
        onClick={() =>
          void auth
            .login({ username: 'alice_1', password: 'correct-horse-battery' })
            .catch(() => undefined)
        }
      >
        Войти
      </button>
      <button
        type="button"
        onClick={() =>
          void auth
            .register({ username: 'bob_2', password: 'correct-horse-battery' })
            .catch(() => undefined)
        }
      >
        Регистрация
      </button>
    </div>
  )
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

describe('AuthProvider session races', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.resetAllMocks()
  })

  it('shares one bootstrap refresh across StrictMode remounts', async () => {
    refresh.mockResolvedValue(session)
    getMe.mockResolvedValue(profile)

    render(
      <StrictMode>
        <AuthProvider>
          <SessionProbe />
        </AuthProvider>
      </StrictMode>,
    )

    expect(await screen.findByText('in')).toBeInTheDocument()
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it('ignores a refresh that resolves after logout', async () => {
    vi.useFakeTimers()
    const lateRefresh = deferred<AccessTokenResponse>()
    refresh.mockResolvedValueOnce(session).mockImplementationOnce(() => lateRefresh.promise)
    getMe.mockResolvedValue(profile)
    logout.mockResolvedValue(undefined)

    render(
      <AuthProvider>
        <SessionProbe />
      </AuthProvider>,
    )

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(screen.getByText('in')).toBeInTheDocument()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(840_000)
    })

    screen.getByRole('button', { name: 'Выйти' }).click()
    lateRefresh.resolve({ ...session, access_token: 'access-2' })

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })

    expect(screen.getByText('out')).toBeInTheDocument()
    expect(logout).toHaveBeenCalledTimes(1)
    expect(getMe).toHaveBeenCalledTimes(1)
  })

  it('keeps a newer login when the bootstrap refresh fails later', async () => {
    const bootstrap = deferred<AccessTokenResponse>()
    refresh.mockImplementationOnce(() => bootstrap.promise)
    login.mockResolvedValue(session)
    getMe.mockResolvedValue(profile)

    render(
      <AuthProvider>
        <SessionProbe />
      </AuthProvider>,
    )

    expect(screen.getByText('booting')).toBeInTheDocument()
    screen.getByRole('button', { name: 'Войти' }).click()
    bootstrap.reject(new Error('invalid_refresh_token'))

    expect(await screen.findByText('in')).toBeInTheDocument()
    expect(screen.getByText('ready')).toBeInTheDocument()
  })

  it('does not auto-login after a late register that finished after logout', async () => {
    const lateRegister = deferred<User>()
    refresh.mockRejectedValue(new Error('no session'))
    register.mockImplementationOnce(() => lateRegister.promise)
    login.mockResolvedValue(session)
    getMe.mockResolvedValue(profile)
    logout.mockResolvedValue(undefined)

    render(
      <AuthProvider>
        <SessionProbe />
      </AuthProvider>,
    )

    expect(await screen.findByText('ready')).toBeInTheDocument()
    screen.getByRole('button', { name: 'Регистрация' }).click()
    screen.getByRole('button', { name: 'Выйти' }).click()

    lateRegister.resolve({ id: 'bob', username: 'bob_2', created_at: profile.created_at })

    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(screen.getByText('out')).toBeInTheDocument()
    expect(screen.getByText('nobody')).toBeInTheDocument()
    expect(login).not.toHaveBeenCalled()
    expect(logout).toHaveBeenCalledTimes(1)
  })

  it('revokes a late login cookie that arrives after logout', async () => {
    const lateLogin = deferred<AccessTokenResponse>()
    refresh.mockRejectedValue(new Error('no session'))
    login.mockImplementationOnce(() => lateLogin.promise)
    logout.mockResolvedValue(undefined)

    render(
      <AuthProvider>
        <SessionProbe />
      </AuthProvider>,
    )

    expect(await screen.findByText('ready')).toBeInTheDocument()
    screen.getByRole('button', { name: 'Войти' }).click()

    const logoutClick = screen.getByRole('button', { name: 'Выйти' }).click()
    lateLogin.resolve({ ...session, access_token: 'access-late' })

    await act(async () => {
      await logoutClick
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(screen.getByText('out')).toBeInTheDocument()
    expect(logout).toHaveBeenCalledTimes(1)
  })

  it('still revokes the refresh cookie when a failed login starts during logout', async () => {
    const bootstrap = deferred<AccessTokenResponse>()
    refresh.mockImplementationOnce(() => bootstrap.promise)
    login.mockRejectedValue(new Error('invalid_credentials'))
    logout.mockResolvedValue(undefined)

    render(
      <AuthProvider>
        <SessionProbe />
      </AuthProvider>,
    )

    screen.getByRole('button', { name: 'Выйти' }).click()
    screen.getByRole('button', { name: 'Войти' }).click()
    bootstrap.reject(new Error('invalid_refresh_token'))

    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(await screen.findByText('out')).toBeInTheDocument()
    expect(logout).toHaveBeenCalledTimes(1)
  })

  it('waits for logout to finish before the next login sets a cookie', async () => {
    const lateLogout = deferred<void>()
    const calls: string[] = []
    refresh.mockRejectedValue(new Error('no session'))
    logout.mockImplementationOnce(() => {
      calls.push('logout')
      return lateLogout.promise
    })
    login.mockImplementationOnce(async () => {
      calls.push('login')
      return session
    })
    getMe.mockResolvedValue(profile)

    render(
      <AuthProvider>
        <SessionProbe />
      </AuthProvider>,
    )

    expect(await screen.findByText('ready')).toBeInTheDocument()
    screen.getByRole('button', { name: 'Выйти' }).click()
    screen.getByRole('button', { name: 'Войти' }).click()

    await act(async () => {
      await Promise.resolve()
    })
    expect(login).not.toHaveBeenCalled()

    lateLogout.resolve()
    expect(await screen.findByText('in')).toBeInTheDocument()
    expect(calls).toEqual(['logout', 'login'])
  })

  it('does not revoke the newer login when an older login response arrives first', async () => {
    const lateLogin = deferred<AccessTokenResponse>()
    const calls: string[] = []
    refresh.mockRejectedValue(new Error('no session'))
    login
      .mockImplementationOnce(() => {
        calls.push('login-old')
        return lateLogin.promise
      })
      .mockImplementationOnce(async () => {
        calls.push('login-new')
        return { ...session, access_token: 'access-new' }
      })
    logout.mockImplementation(async () => {
      calls.push('logout')
    })
    getMe.mockResolvedValue({ ...profile, username: 'bob_2' })

    render(
      <AuthProvider>
        <SessionProbe />
      </AuthProvider>,
    )

    expect(await screen.findByText('ready')).toBeInTheDocument()
    screen.getByRole('button', { name: 'Войти' }).click()
    await act(async () => {
      await Promise.resolve()
    })
    expect(calls).toEqual(['login-old'])

    screen.getByRole('button', { name: 'Выйти' }).click()
    screen.getByRole('button', { name: 'Войти' }).click()
    lateLogin.resolve(session)

    expect(await screen.findByText('bob_2')).toBeInTheDocument()
    expect(logout).toHaveBeenCalledTimes(1)
    expect(calls).toEqual(['login-old', 'logout', 'login-new'])
  })
})
