import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  getMe,
  login as loginRequest,
  logout as logoutRequest,
  refresh as refreshRequest,
  register as registerRequest,
  type AccessTokenResponse,
  type LoginRequest,
  type RegisterRequest,
  type User,
} from '@/api/auth'
import {
  AuthFlowCancelledError,
  isLogoutSettled,
  LOGOUT_FAILED_MESSAGE,
} from '@/features/auth/authErrors'
import { AuthContext, type AuthContextValue } from '@/features/auth/auth-context'
import { readLogoutPending, writeLogoutPending } from '@/features/auth/logoutPending'

/** Обновляем access-токен за минуту до истечения `expires_in`. */
const REFRESH_SKEW_MS = 60_000

interface AuthProviderProps {
  children: ReactNode
}

export function AuthProvider({ children }: AuthProviderProps) {
  const [accessToken, setAccessToken] = useState<string | null>(null)
  const [user, setUser] = useState<User | null>(null)
  const [isReady, setIsReady] = useState(false)
  const [logoutError, setLogoutError] = useState<string | null>(null)
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const epochRef = useRef(0)
  const refreshInFlightRef = useRef<Promise<AccessTokenResponse> | null>(null)
  const queueTailRef = useRef(Promise.resolve())
  const acceptSessionRef = useRef<
    (token: string, expiresInSeconds: number, epoch: number) => Promise<void>
  >(async () => undefined)
  const rotateSessionRef = useRef<(epoch: number) => Promise<void>>(async () => undefined)

  const enqueue = useCallback(<T,>(task: () => Promise<T>): Promise<T> => {
    const run = queueTailRef.current.then(task, task)
    queueTailRef.current = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }, [])

  const refreshShared = useCallback(() => {
    if (!refreshInFlightRef.current) {
      const pending = refreshRequest().finally(() => {
        if (refreshInFlightRef.current === pending) {
          refreshInFlightRef.current = null
        }
      })
      refreshInFlightRef.current = pending
    }

    return refreshInFlightRef.current
  }, [])

  const clearRefreshTimer = useCallback(() => {
    if (refreshTimerRef.current !== null) {
      clearTimeout(refreshTimerRef.current)
      refreshTimerRef.current = null
    }
  }, [])

  const clearSession = useCallback(() => {
    clearRefreshTimer()
    setAccessToken(null)
    setUser(null)
  }, [clearRefreshTimer])

  /** true, если cookie уже отозвана или её не было. */
  const settleLogout = useCallback(async (): Promise<boolean> => {
    try {
      await logoutRequest()
      writeLogoutPending(false)
      return true
    } catch (error) {
      if (isLogoutSettled(error)) {
        writeLogoutPending(false)
        return true
      }
      writeLogoutPending(true)
      return false
    }
  }, [])

  const revokeIfCurrentCookieIsStale = useCallback(async () => {
    // Следующий выход уже в очереди и очистит cookie после этой операции.
    if (readLogoutPending()) return
    await settleLogout()
  }, [settleLogout])

  const reportLogout = useCallback(
    (cleared: boolean, epoch: number) => {
      if (!cleared) setLogoutError(LOGOUT_FAILED_MESSAGE)
      if (epochRef.current !== epoch) return
      clearSession()
      if (cleared) setLogoutError(null)
    },
    [clearSession],
  )

  const acceptSession = useCallback(
    async (token: string, expiresInSeconds: number, epoch: number) => {
      // Профиль не блокирует очередь: выход может отозвать cookie, не дожидаясь GET /me.
      const profile = await getMe(token)
      if (epochRef.current !== epoch) return

      writeLogoutPending(false)
      setLogoutError(null)
      setAccessToken(token)
      setUser(profile)
      clearRefreshTimer()
      const delayMs = Math.max(expiresInSeconds * 1000 - REFRESH_SKEW_MS, 5_000)
      refreshTimerRef.current = setTimeout(() => {
        void rotateSessionRef.current(epoch)
      }, delayMs)
    },
    [clearRefreshTimer],
  )

  const rotateSession = useCallback(
    async (epoch: number) => {
      try {
        const next = await enqueue(async () => {
          const rotated = await refreshShared()
          if (epochRef.current !== epoch) {
            await revokeIfCurrentCookieIsStale()
            return null
          }
          return rotated
        })
        if (!next || epochRef.current !== epoch) return
        await acceptSessionRef.current(next.access_token, next.expires_in, epoch)
      } catch {
        if (epochRef.current === epoch) clearSession()
      }
    },
    [clearSession, enqueue, refreshShared, revokeIfCurrentCookieIsStale],
  )

  useEffect(() => {
    acceptSessionRef.current = acceptSession
    rotateSessionRef.current = rotateSession
  }, [acceptSession, rotateSession])

  useEffect(() => {
    let cancelled = false
    const epoch = epochRef.current
    // Не стартуем refresh, пока незавершённый выход не отзовёт cookie.
    const pendingRefresh = readLogoutPending() ? null : refreshShared()

    const boot = enqueue(async () => {
      if (!pendingRefresh) {
        const cleared = await settleLogout()
        if (!cancelled) reportLogout(cleared, epoch)
        return null
      }

      let session: AccessTokenResponse | null
      try {
        session = await pendingRefresh
      } catch {
        session = null
      }

      if (readLogoutPending() || cancelled || epochRef.current !== epoch) {
        if (!cancelled && epochRef.current !== epoch && session && !readLogoutPending()) {
          await revokeIfCurrentCookieIsStale()
        }
        return null
      }

      if (!session) {
        clearSession()
        return null
      }

      return session
    })

    void boot
      .then(async (session) => {
        if (!session || cancelled || epochRef.current !== epoch) return
        try {
          await acceptSessionRef.current(session.access_token, session.expires_in, epoch)
        } catch {
          if (!cancelled && epochRef.current === epoch) clearSession()
        }
      })
      .finally(() => {
        if (!cancelled) setIsReady(true)
      })

    return () => {
      cancelled = true
      clearRefreshTimer()
    }
  }, [
    clearRefreshTimer,
    clearSession,
    enqueue,
    refreshShared,
    reportLogout,
    revokeIfCurrentCookieIsStale,
    settleLogout,
  ])

  const login = useCallback(
    async (credentials: LoginRequest) => {
      const epoch = ++epochRef.current
      clearRefreshTimer()
      const session = await enqueue(async () => {
        if (epochRef.current !== epoch) throw new AuthFlowCancelledError()

        const next = await loginRequest(credentials)
        if (epochRef.current !== epoch) {
          await revokeIfCurrentCookieIsStale()
          throw new AuthFlowCancelledError()
        }
        return next
      })
      await acceptSession(session.access_token, session.expires_in, epoch)
      if (epochRef.current !== epoch) throw new AuthFlowCancelledError()
    },
    [acceptSession, clearRefreshTimer, enqueue, revokeIfCurrentCookieIsStale],
  )

  const register = useCallback(
    async (data: RegisterRequest) => {
      const epoch = ++epochRef.current
      clearRefreshTimer()
      const session = await enqueue(async () => {
        if (epochRef.current !== epoch) throw new AuthFlowCancelledError()

        await registerRequest(data)
        if (epochRef.current !== epoch) throw new AuthFlowCancelledError()

        const next = await loginRequest(data)
        if (epochRef.current !== epoch) {
          await revokeIfCurrentCookieIsStale()
          throw new AuthFlowCancelledError()
        }
        return next
      })
      await acceptSession(session.access_token, session.expires_in, epoch)
      if (epochRef.current !== epoch) throw new AuthFlowCancelledError()
    },
    [acceptSession, clearRefreshTimer, enqueue, revokeIfCurrentCookieIsStale],
  )

  const logout = useCallback(async () => {
    const epoch = ++epochRef.current
    clearRefreshTimer()
    writeLogoutPending(true)
    setAccessToken(null)
    setUser(null)
    await enqueue(async () => {
      const cleared = await settleLogout()
      reportLogout(cleared, epoch)
    })
  }, [clearRefreshTimer, enqueue, reportLogout, settleLogout])

  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      accessToken,
      isReady,
      isAuthenticated: Boolean(accessToken && user),
      logoutError,
      login,
      register,
      logout,
    }),
    [user, accessToken, isReady, logoutError, login, register, logout],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}
