import { act, render, screen, waitFor } from '@testing-library/react'
import { StrictMode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AccessTokenResponse, User } from '@/api/auth'
import { ApiError } from '@/api/client'
import { LOGOUT_FAILED_MESSAGE } from '@/features/auth/authErrors'
import { AuthProvider } from '@/features/auth/AuthProvider'
import { LOGOUT_PENDING_KEY } from '@/features/auth/logoutPending'
import { resetSharedRefreshCoordinatorForTests } from '@/features/auth/refreshCoordinator'
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
      {auth.logoutError ? (
        <>
          <p role="alert">{auth.logoutError}</p>
          <button type="button" onClick={() => void auth.logout()}>
            Повторить выход
          </button>
        </>
      ) : null}
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
    sessionStorage.clear()
    localStorage.clear()
    resetSharedRefreshCoordinatorForTests()
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

  it('revokes a superseded login before the next login sets a cookie', async () => {
    let cookie: string | null = null
    const lateLogin = deferred<AccessTokenResponse>()
    const calls: string[] = []
    refresh.mockImplementation(async () => {
      if (!cookie) throw new Error('no session')
      return session
    })
    login
      .mockImplementationOnce(async () => {
        calls.push('login-old')
        const value = await lateLogin.promise
        cookie = 'old'
        return value
      })
      .mockImplementationOnce(async () => {
        calls.push('login-new')
        cookie = 'new'
        return { ...session, access_token: 'access-new' }
      })
    logout.mockImplementation(async () => {
      calls.push('logout')
      cookie = null
    })
    getMe.mockResolvedValue({ ...profile, username: 'bob_2' })

    const first = render(
      <AuthProvider>
        <SessionProbe />
      </AuthProvider>,
    )

    expect(await screen.findByText('ready')).toBeInTheDocument()
    screen.getByRole('button', { name: 'Войти' }).click()
    await waitFor(() => expect(calls).toEqual(['login-old']))

    screen.getByRole('button', { name: 'Войти' }).click()
    lateLogin.resolve(session)

    await waitFor(() => expect(calls).toEqual(['login-old', 'logout', 'login-new']))
    expect(await screen.findByText('bob_2')).toBeInTheDocument()

    first.unmount()
    render(
      <AuthProvider>
        <SessionProbe />
      </AuthProvider>,
    )

    expect(await screen.findByText('bob_2')).toBeInTheDocument()
    expect(screen.getByText('in')).toBeInTheDocument()
  })

  it('does not restore account A after a rejected second login', async () => {
    let cookie: string | null = null
    const lateLogin = deferred<AccessTokenResponse>()
    const calls: string[] = []
    refresh.mockImplementation(async () => {
      if (!cookie) throw new Error('no session')
      return { ...session, access_token: 'restored-a' }
    })
    login
      .mockImplementationOnce(async () => {
        calls.push('login-a')
        const value = await lateLogin.promise
        cookie = 'account-a'
        return value
      })
      .mockImplementationOnce(async () => {
        calls.push('login-b')
        throw new Error('invalid_credentials')
      })
    logout.mockImplementation(async () => {
      calls.push('logout')
      cookie = null
    })
    getMe.mockResolvedValue(profile)

    const first = render(
      <AuthProvider>
        <SessionProbe />
      </AuthProvider>,
    )

    expect(await screen.findByText('ready')).toBeInTheDocument()
    screen.getByRole('button', { name: 'Войти' }).click()
    await waitFor(() => expect(calls).toEqual(['login-a']))

    screen.getByRole('button', { name: 'Войти' }).click()
    lateLogin.resolve(session)

    await waitFor(() => expect(calls).toEqual(['login-a', 'logout', 'login-b']))
    expect(screen.getByText('out')).toBeInTheDocument()
    expect(sessionStorage.getItem(LOGOUT_PENDING_KEY)).toBeNull()

    first.unmount()
    render(
      <AuthProvider>
        <SessionProbe />
      </AuthProvider>,
    )

    expect(await screen.findByText('nobody')).toBeInTheDocument()
    expect(screen.getByText('out')).toBeInTheDocument()
  })

  it('revokes a superseded registration login before a rejected login', async () => {
    let cookie: string | null = null
    const lateAutoLogin = deferred<AccessTokenResponse>()
    const calls: string[] = []
    refresh.mockImplementation(async () => {
      if (!cookie) throw new Error('no session')
      return session
    })
    register.mockImplementation(async () => {
      calls.push('register')
      return { id: 'bob', username: 'bob_2', created_at: profile.created_at }
    })
    login
      .mockImplementationOnce(async () => {
        calls.push('auto-login')
        const value = await lateAutoLogin.promise
        cookie = 'bob'
        return value
      })
      .mockImplementationOnce(async () => {
        calls.push('login-b')
        throw new Error('invalid_credentials')
      })
    logout.mockImplementation(async () => {
      calls.push('logout')
      cookie = null
    })
    getMe.mockResolvedValue({ ...profile, username: 'bob_2' })

    const first = render(
      <AuthProvider>
        <SessionProbe />
      </AuthProvider>,
    )

    expect(await screen.findByText('ready')).toBeInTheDocument()
    screen.getByRole('button', { name: 'Регистрация' }).click()
    await waitFor(() => expect(calls).toEqual(['register', 'auto-login']))

    screen.getByRole('button', { name: 'Войти' }).click()
    lateAutoLogin.resolve({ ...session, access_token: 'access-bob' })

    await waitFor(() => expect(calls).toEqual(['register', 'auto-login', 'logout', 'login-b']))
    expect(screen.getByText('out')).toBeInTheDocument()

    first.unmount()
    render(
      <AuthProvider>
        <SessionProbe />
      </AuthProvider>,
    )

    expect(await screen.findByText('nobody')).toBeInTheDocument()
    expect(screen.queryByText('bob_2')).not.toBeInTheDocument()
  })

  it('sends logout while profile loading is still in flight', async () => {
    vi.useFakeTimers()
    let cookie: string | null = 'session-a'
    const lateProfile = deferred<User>()
    refresh.mockImplementation(async () => {
      if (!cookie) throw new Error('no session')
      return session
    })
    refresh
      .mockImplementationOnce(async () => session)
      .mockImplementationOnce(async () => {
        cookie = 'rotated-a'
        return { ...session, access_token: 'rotated' }
      })
    getMe.mockResolvedValue(profile)
    getMe
      .mockImplementationOnce(async () => profile)
      .mockImplementationOnce(() => lateProfile.promise)
    logout.mockImplementation(async () => {
      cookie = null
    })

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
    expect(getMe).toHaveBeenCalledTimes(2)
    expect(logout).not.toHaveBeenCalled()

    await act(async () => {
      screen.getByRole('button', { name: 'Выйти' }).click()
    })

    expect(screen.getByText('out')).toBeInTheDocument()
    expect(logout).toHaveBeenCalledTimes(1)
  })

  it('finishes a pending logout before bootstrap refresh on reload', async () => {
    let cookie: string | null = 'session-a'
    const lateLogout = deferred<void>()
    const calls: string[] = []
    refresh.mockImplementation(async () => {
      calls.push('refresh')
      if (!cookie) throw new Error('no session')
      return session
    })
    getMe.mockResolvedValue(profile)
    logout.mockImplementation(() => {
      calls.push('logout')
      return lateLogout.promise.then(() => {
        cookie = null
      })
    })

    const first = render(
      <AuthProvider>
        <SessionProbe />
      </AuthProvider>,
    )

    expect(await screen.findByText('in')).toBeInTheDocument()
    screen.getByRole('button', { name: 'Выйти' }).click()
    await waitFor(() => expect(calls).toContain('logout'))
    expect(sessionStorage.getItem(LOGOUT_PENDING_KEY)).toBe('1')

    calls.length = 0
    first.unmount()
    render(
      <AuthProvider>
        <SessionProbe />
      </AuthProvider>,
    )

    await waitFor(() => expect(calls[0]).toBe('logout'))
    expect(calls).not.toContain('refresh')

    lateLogout.resolve()
    expect(await screen.findByText('nobody')).toBeInTheDocument()
    expect(screen.getByText('out')).toBeInTheDocument()
    expect(calls).not.toContain('refresh')
  })

  it('keeps the user logged out when logout fails and retry can finish it', async () => {
    let cookie: string | null = 'session-a'
    refresh.mockImplementation(async () => {
      if (!cookie) throw new Error('no session')
      return session
    })
    getMe.mockResolvedValue(profile)
    logout.mockRejectedValue(new ApiError(500, 'unknown_error', 'unavailable'))

    const first = render(
      <AuthProvider>
        <SessionProbe />
      </AuthProvider>,
    )

    expect(await screen.findByText('in')).toBeInTheDocument()
    screen.getByRole('button', { name: 'Выйти' }).click()

    expect(await screen.findByRole('alert')).toHaveTextContent(LOGOUT_FAILED_MESSAGE)
    expect(screen.getByText('out')).toBeInTheDocument()
    expect(sessionStorage.getItem(LOGOUT_PENDING_KEY)).toBe('1')

    first.unmount()
    render(
      <AuthProvider>
        <SessionProbe />
      </AuthProvider>,
    )

    expect(await screen.findByRole('alert')).toHaveTextContent(LOGOUT_FAILED_MESSAGE)
    expect(screen.getByText('nobody')).toBeInTheDocument()
    expect(screen.queryByText('alice_1')).not.toBeInTheDocument()

    logout.mockImplementation(async () => {
      cookie = null
    })
    screen.getByRole('button', { name: 'Повторить выход' }).click()

    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument())
    expect(screen.getByText('out')).toBeInTheDocument()
    expect(sessionStorage.getItem(LOGOUT_PENDING_KEY)).toBeNull()
  })

  it('treats logout 401 as an already cleared cookie', async () => {
    let cookie: string | null = 'session-a'
    refresh.mockImplementation(async () => {
      if (!cookie) throw new Error('no session')
      return session
    })
    getMe.mockResolvedValue(profile)
    logout.mockImplementation(async () => {
      cookie = null
      throw new ApiError(401, 'invalid_refresh_token', 'missing')
    })

    const first = render(
      <AuthProvider>
        <SessionProbe />
      </AuthProvider>,
    )

    expect(await screen.findByText('in')).toBeInTheDocument()
    screen.getByRole('button', { name: 'Выйти' }).click()

    await waitFor(() => expect(screen.getByText('out')).toBeInTheDocument())
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(sessionStorage.getItem(LOGOUT_PENDING_KEY)).toBeNull()

    first.unmount()
    render(
      <AuthProvider>
        <SessionProbe />
      </AuthProvider>,
    )

    expect(await screen.findByText('nobody')).toBeInTheDocument()
    expect(screen.getByText('out')).toBeInTheDocument()
  })

  it('drops a pending logout once a newer login succeeds', async () => {
    let cookie: string | null = 'session-a'
    refresh.mockImplementation(async () => {
      if (!cookie) throw new Error('no session')
      return session
    })
    getMe.mockResolvedValue(profile)
    logout.mockRejectedValueOnce(new ApiError(500, 'unknown_error', 'unavailable'))
    login.mockImplementation(async () => {
      cookie = 'session-b'
      return { ...session, access_token: 'access-b' }
    })

    const first = render(
      <AuthProvider>
        <SessionProbe />
      </AuthProvider>,
    )

    expect(await screen.findByText('in')).toBeInTheDocument()
    screen.getByRole('button', { name: 'Выйти' }).click()
    expect(await screen.findByRole('alert')).toHaveTextContent(LOGOUT_FAILED_MESSAGE)
    expect(sessionStorage.getItem(LOGOUT_PENDING_KEY)).toBe('1')

    screen.getByRole('button', { name: 'Войти' }).click()
    expect(await screen.findByText('in')).toBeInTheDocument()
    expect(sessionStorage.getItem(LOGOUT_PENDING_KEY)).toBeNull()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()

    first.unmount()
    render(
      <AuthProvider>
        <SessionProbe />
      </AuthProvider>,
    )

    expect(await screen.findByText('in')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('does not restore account A when a later login fails while its profile is loading', async () => {
    let cookie: string | null = null
    const lateProfile = deferred<User>()
    const lateLogout = deferred<void>()
    const calls: string[] = []
    refresh.mockImplementation(async () => {
      calls.push('refresh')
      if (!cookie) throw new Error('no session')
      return { ...session, access_token: 'restored-a' }
    })
    login
      .mockImplementationOnce(async () => {
        calls.push('login-a')
        cookie = 'account-a'
        return session
      })
      .mockImplementationOnce(async () => {
        calls.push('login-b')
        throw new Error('invalid_credentials')
      })
    logout.mockImplementation(() => {
      calls.push('logout')
      return lateLogout.promise.then(() => {
        cookie = null
      })
    })
    getMe.mockResolvedValue(profile)
    getMe.mockImplementationOnce(() => lateProfile.promise)

    const first = render(
      <AuthProvider>
        <SessionProbe />
      </AuthProvider>,
    )

    expect(await screen.findByText('ready')).toBeInTheDocument()
    screen.getByRole('button', { name: 'Войти' }).click()
    await waitFor(() => expect(getMe).toHaveBeenCalledTimes(1))
    expect(logout).not.toHaveBeenCalled()

    screen.getByRole('button', { name: 'Войти' }).click()
    await waitFor(() => expect(calls).toContain('logout'))
    expect(calls).not.toContain('login-b')
    expect(sessionStorage.getItem(LOGOUT_PENDING_KEY)).toBe('1')
    expect(screen.getByText('out')).toBeInTheDocument()

    calls.length = 0
    first.unmount()
    render(
      <AuthProvider>
        <SessionProbe />
      </AuthProvider>,
    )

    await waitFor(() => expect(calls[0]).toBe('logout'))
    expect(calls).not.toContain('refresh')
    lateLogout.resolve()

    expect(await screen.findByText('nobody')).toBeInTheDocument()
    expect(screen.getByText('out')).toBeInTheDocument()
    expect(screen.queryByText('alice_1')).not.toBeInTheDocument()
  })

  it('does not restore a registration when a later login fails while its profile is loading', async () => {
    let cookie: string | null = null
    const lateProfile = deferred<User>()
    refresh.mockImplementation(async () => {
      if (!cookie) throw new Error('no session')
      return { ...session, access_token: 'restored-bob' }
    })
    register.mockResolvedValue({
      id: 'bob',
      username: 'bob_2',
      created_at: profile.created_at,
    })
    login
      .mockImplementationOnce(async () => {
        cookie = 'account-bob'
        return { ...session, access_token: 'access-bob' }
      })
      .mockRejectedValueOnce(new Error('invalid_credentials'))
    logout.mockImplementation(async () => {
      cookie = null
    })
    getMe.mockResolvedValue({ ...profile, username: 'bob_2' })
    getMe.mockImplementationOnce(() => lateProfile.promise)

    const first = render(
      <AuthProvider>
        <SessionProbe />
      </AuthProvider>,
    )

    expect(await screen.findByText('ready')).toBeInTheDocument()
    screen.getByRole('button', { name: 'Регистрация' }).click()
    await waitFor(() => expect(getMe).toHaveBeenCalledTimes(1))

    screen.getByRole('button', { name: 'Войти' }).click()
    await waitFor(() => expect(login).toHaveBeenCalledTimes(2))
    lateProfile.resolve({ ...profile, username: 'bob_2' })

    await waitFor(() => expect(logout).toHaveBeenCalledTimes(1))
    expect(screen.getByText('out')).toBeInTheDocument()

    first.unmount()
    render(
      <AuthProvider>
        <SessionProbe />
      </AuthProvider>,
    )

    expect(await screen.findByText('nobody')).toBeInTheDocument()
    expect(screen.queryByText('bob_2')).not.toBeInTheDocument()
    expect(screen.getByText('out')).toBeInTheDocument()
  })

  it('keeps the newer account when login succeeds while the previous profile is loading', async () => {
    let cookie: string | null = null
    const lateProfile = deferred<User>()
    refresh.mockImplementation(async () => {
      if (!cookie) throw new Error('no session')
      return { ...session, access_token: `restored-${cookie}` }
    })
    login
      .mockImplementationOnce(async () => {
        cookie = 'account-a'
        return session
      })
      .mockImplementationOnce(async () => {
        cookie = 'account-b'
        return { ...session, access_token: 'access-b' }
      })
    logout.mockImplementation(async () => {
      cookie = null
    })
    getMe.mockResolvedValue({ ...profile, username: 'bob_2' })
    getMe.mockImplementationOnce(() => lateProfile.promise)

    const first = render(
      <AuthProvider>
        <SessionProbe />
      </AuthProvider>,
    )

    expect(await screen.findByText('ready')).toBeInTheDocument()
    screen.getByRole('button', { name: 'Войти' }).click()
    await waitFor(() => expect(getMe).toHaveBeenCalledTimes(1))

    screen.getByRole('button', { name: 'Войти' }).click()
    expect(await screen.findByText('bob_2')).toBeInTheDocument()
    lateProfile.resolve(profile)
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(screen.getByText('bob_2')).toBeInTheDocument()
    expect(screen.getByText('in')).toBeInTheDocument()
    expect(logout).toHaveBeenCalledTimes(1)
    expect(cookie).toBe('account-b')

    first.unmount()
    render(
      <AuthProvider>
        <SessionProbe />
      </AuthProvider>,
    )

    expect(await screen.findByText('bob_2')).toBeInTheDocument()
    expect(screen.getByText('in')).toBeInTheDocument()
  })

  it('keeps account B when it succeeds after the previous profile was already cancelled', async () => {
    let cookie: string | null = null
    const lateProfile = deferred<User>()
    const lateLogin = deferred<AccessTokenResponse>()
    refresh.mockImplementation(async () => {
      if (!cookie) throw new Error('no session')
      return { ...session, access_token: `restored-${cookie}` }
    })
    login
      .mockImplementationOnce(async () => {
        cookie = 'account-a'
        return session
      })
      .mockImplementationOnce(async () => {
        const value = await lateLogin.promise
        cookie = 'account-b'
        return value
      })
    logout.mockImplementation(async () => {
      cookie = null
    })
    getMe.mockResolvedValue({ ...profile, username: 'bob_2' })
    getMe.mockImplementationOnce(() => lateProfile.promise)

    const first = render(
      <AuthProvider>
        <SessionProbe />
      </AuthProvider>,
    )

    expect(await screen.findByText('ready')).toBeInTheDocument()
    screen.getByRole('button', { name: 'Войти' }).click()
    await waitFor(() => expect(getMe).toHaveBeenCalledTimes(1))

    screen.getByRole('button', { name: 'Войти' }).click()
    await waitFor(() => expect(logout).toHaveBeenCalledTimes(1))
    expect(cookie).toBeNull()

    lateProfile.resolve(profile)
    lateLogin.resolve({ ...session, access_token: 'access-b' })
    expect(await screen.findByText('bob_2')).toBeInTheDocument()
    expect(logout).toHaveBeenCalledTimes(1)
    expect(cookie).toBe('account-b')
    expect(sessionStorage.getItem(LOGOUT_PENDING_KEY)).toBeNull()

    first.unmount()
    render(
      <AuthProvider>
        <SessionProbe />
      </AuthProvider>,
    )

    expect(await screen.findByText('bob_2')).toBeInTheDocument()
    expect(screen.getByText('in')).toBeInTheDocument()
  })

  it('marks an automatic revoke before logout so reload cannot restore the cancelled login', async () => {
    let cookie: string | null = null
    const lateLogin = deferred<AccessTokenResponse>()
    const lateLogout = deferred<void>()
    const calls: string[] = []
    refresh.mockImplementation(async () => {
      calls.push('refresh')
      if (!cookie) throw new Error('no session')
      return { ...session, access_token: 'restored-a' }
    })
    login
      .mockImplementationOnce(async () => {
        const value = await lateLogin.promise
        cookie = 'account-a'
        return value
      })
      .mockRejectedValueOnce(new Error('invalid_credentials'))
    logout.mockImplementation(() => {
      calls.push('logout')
      return lateLogout.promise.then(() => {
        cookie = null
      })
    })
    getMe.mockResolvedValue(profile)

    const first = render(
      <AuthProvider>
        <SessionProbe />
      </AuthProvider>,
    )

    expect(await screen.findByText('ready')).toBeInTheDocument()
    screen.getByRole('button', { name: 'Войти' }).click()
    await waitFor(() => expect(login).toHaveBeenCalledTimes(1))

    screen.getByRole('button', { name: 'Войти' }).click()
    lateLogin.resolve(session)

    await waitFor(() => expect(logout).toHaveBeenCalledTimes(1))
    expect(sessionStorage.getItem(LOGOUT_PENDING_KEY)).toBe('1')

    calls.length = 0
    first.unmount()
    render(
      <AuthProvider>
        <SessionProbe />
      </AuthProvider>,
    )

    await waitFor(() => expect(calls[0]).toBe('logout'))
    expect(calls).not.toContain('refresh')
    lateLogout.resolve()

    expect(await screen.findByText('nobody')).toBeInTheDocument()
    expect(screen.getByText('out')).toBeInTheDocument()
    expect(screen.queryByText('alice_1')).not.toBeInTheDocument()
  })

  it('marks revoke when a newer login cancels an in-flight profile, before that profile returns', async () => {
    let cookie: string | null = null
    const lateProfile = deferred<User>()
    const lateLogout = deferred<void>()
    const calls: string[] = []
    refresh.mockImplementation(async () => {
      calls.push('refresh')
      if (!cookie) throw new Error('no session')
      return { ...session, access_token: 'restored-a' }
    })
    login
      .mockImplementationOnce(async () => {
        calls.push('login-a')
        cookie = 'account-a'
        return session
      })
      .mockImplementationOnce(async () => {
        calls.push('login-b')
        throw new Error('invalid_credentials')
      })
    logout.mockImplementation(() => {
      calls.push('logout')
      return lateLogout.promise.then(() => {
        cookie = null
      })
    })
    getMe.mockResolvedValue(profile)
    getMe.mockImplementationOnce(() => lateProfile.promise)

    const first = render(
      <AuthProvider>
        <SessionProbe />
      </AuthProvider>,
    )

    expect(await screen.findByText('ready')).toBeInTheDocument()
    screen.getByRole('button', { name: 'Войти' }).click()
    await waitFor(() => expect(getMe).toHaveBeenCalledTimes(1))

    calls.length = 0
    screen.getByRole('button', { name: 'Войти' }).click()
    expect(sessionStorage.getItem(LOGOUT_PENDING_KEY)).toBe('1')
    expect(calls).not.toContain('refresh')

    first.unmount()
    render(
      <AuthProvider>
        <SessionProbe />
      </AuthProvider>,
    )

    await waitFor(() => expect(calls[0]).toBe('logout'))
    expect(calls).not.toContain('refresh')
    lateLogout.resolve()
    lateProfile.resolve(profile)

    expect(await screen.findByText('nobody')).toBeInTheDocument()
    expect(screen.getByText('out')).toBeInTheDocument()
    expect(screen.queryByText('alice_1')).not.toBeInTheDocument()
  })

  it('marks revoke when a newer login cancels an in-flight registration profile', async () => {
    let cookie: string | null = null
    const lateProfile = deferred<User>()
    const lateLogout = deferred<void>()
    const calls: string[] = []
    refresh.mockImplementation(async () => {
      calls.push('refresh')
      if (!cookie) throw new Error('no session')
      return { ...session, access_token: 'restored-bob' }
    })
    register.mockResolvedValue({
      id: 'bob',
      username: 'bob_2',
      created_at: profile.created_at,
    })
    login
      .mockImplementationOnce(async () => {
        cookie = 'account-bob'
        return { ...session, access_token: 'access-bob' }
      })
      .mockImplementationOnce(async () => {
        throw new Error('invalid_credentials')
      })
    logout.mockImplementation(() => {
      calls.push('logout')
      return lateLogout.promise.then(() => {
        cookie = null
      })
    })
    getMe.mockResolvedValue({ ...profile, username: 'bob_2' })
    getMe.mockImplementationOnce(() => lateProfile.promise)

    const first = render(
      <AuthProvider>
        <SessionProbe />
      </AuthProvider>,
    )

    expect(await screen.findByText('ready')).toBeInTheDocument()
    screen.getByRole('button', { name: 'Регистрация' }).click()
    await waitFor(() => expect(getMe).toHaveBeenCalledTimes(1))

    calls.length = 0
    screen.getByRole('button', { name: 'Войти' }).click()
    expect(sessionStorage.getItem(LOGOUT_PENDING_KEY)).toBe('1')

    first.unmount()
    render(
      <AuthProvider>
        <SessionProbe />
      </AuthProvider>,
    )

    await waitFor(() => expect(calls[0]).toBe('logout'))
    expect(calls).not.toContain('refresh')
    lateLogout.resolve()
    lateProfile.resolve({ ...profile, username: 'bob_2' })

    expect(await screen.findByText('nobody')).toBeInTheDocument()
    expect(screen.queryByText('bob_2')).not.toBeInTheDocument()
    expect(screen.getByText('out')).toBeInTheDocument()
  })

  it('revokes the refresh cookie when profile loading fails so reload cannot restore it', async () => {
    let cookie: string | null = null
    refresh.mockImplementation(async () => {
      if (!cookie) throw new Error('no session')
      return { ...session, access_token: 'restored-a' }
    })
    login.mockImplementationOnce(async () => {
      cookie = 'account-a'
      return session
    })
    logout.mockImplementation(async () => {
      cookie = null
    })
    getMe.mockRejectedValueOnce(new ApiError(500, 'unknown_error', 'unavailable'))
    getMe.mockResolvedValue(profile)

    const first = render(
      <AuthProvider>
        <SessionProbe />
      </AuthProvider>,
    )

    expect(await screen.findByText('ready')).toBeInTheDocument()
    screen.getByRole('button', { name: 'Войти' }).click()
    await waitFor(() => expect(logout).toHaveBeenCalledTimes(1))
    expect(screen.getByText('out')).toBeInTheDocument()
    expect(screen.queryByText('alice_1')).not.toBeInTheDocument()

    first.unmount()
    render(
      <AuthProvider>
        <SessionProbe />
      </AuthProvider>,
    )

    expect(await screen.findByText('nobody')).toBeInTheDocument()
    expect(screen.getByText('out')).toBeInTheDocument()
    expect(screen.queryByText('alice_1')).not.toBeInTheDocument()
  })
})
