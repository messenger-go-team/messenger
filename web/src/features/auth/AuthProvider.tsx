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
import { AuthFlowCancelledError } from '@/features/auth/authErrors'
import { AuthContext, type AuthContextValue } from '@/features/auth/auth-context'

/** Обновляем access-токен за минуту до истечения `expires_in`. */
const REFRESH_SKEW_MS = 60_000

interface AuthProviderProps {
  children: ReactNode
}

export function AuthProvider({ children }: AuthProviderProps) {
  const [accessToken, setAccessToken] = useState<string | null>(null)
  const [user, setUser] = useState<User | null>(null)
  const [isReady, setIsReady] = useState(false)
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const epochRef = useRef(0)
  const refreshInFlightRef = useRef<Promise<AccessTokenResponse> | null>(null)
  const queueTailRef = useRef(Promise.resolve())
  const applySessionRef = useRef<
    (token: string, expiresInSeconds: number, epoch: number) => Promise<void>
  >(async () => undefined)

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

  const applySession = useCallback(
    async (token: string, expiresInSeconds: number, epoch: number) => {
      if (epochRef.current !== epoch) {
        return
      }

      setAccessToken(token)
      const profile = await getMe(token)
      if (epochRef.current !== epoch) {
        return
      }

      setUser(profile)

      clearRefreshTimer()
      const delayMs = Math.max(expiresInSeconds * 1000 - REFRESH_SKEW_MS, 5_000)
      refreshTimerRef.current = setTimeout(() => {
        const scheduledEpoch = epoch
        void enqueue(async () => {
          try {
            const next = await refreshShared()
            if (epochRef.current !== scheduledEpoch) {
              return
            }
            await applySessionRef.current(next.access_token, next.expires_in, scheduledEpoch)
          } catch {
            if (epochRef.current === scheduledEpoch) {
              clearSession()
            }
          }
        })
      }, delayMs)
    },
    [clearRefreshTimer, clearSession, enqueue, refreshShared],
  )

  useEffect(() => {
    applySessionRef.current = applySession
  }, [applySession])

  useEffect(() => {
    let cancelled = false
    const epoch = epochRef.current
    const pendingRefresh = refreshShared()

    void enqueue(async () => {
      try {
        const session = await pendingRefresh
        if (cancelled || epochRef.current !== epoch) {
          return
        }
        await applySessionRef.current(session.access_token, session.expires_in, epoch)
      } catch {
        if (!cancelled && epochRef.current === epoch) {
          clearSession()
        }
      } finally {
        if (!cancelled) {
          setIsReady(true)
        }
      }
    })

    return () => {
      cancelled = true
      clearRefreshTimer()
    }
  }, [clearRefreshTimer, clearSession, enqueue, refreshShared])

  const login = useCallback(
    async (credentials: LoginRequest) => {
      const epoch = ++epochRef.current
      clearRefreshTimer()
      await enqueue(async () => {
        if (epochRef.current !== epoch) {
          throw new AuthFlowCancelledError()
        }

        const session = await loginRequest(credentials)
        if (epochRef.current !== epoch) {
          throw new AuthFlowCancelledError()
        }
        await applySession(session.access_token, session.expires_in, epoch)
      })
    },
    [applySession, clearRefreshTimer, enqueue],
  )

  const register = useCallback(
    async (data: RegisterRequest) => {
      const epoch = ++epochRef.current
      clearRefreshTimer()
      await enqueue(async () => {
        if (epochRef.current !== epoch) {
          throw new AuthFlowCancelledError()
        }

        await registerRequest(data)
        if (epochRef.current !== epoch) {
          throw new AuthFlowCancelledError()
        }

        const session = await loginRequest(data)
        if (epochRef.current !== epoch) {
          throw new AuthFlowCancelledError()
        }
        await applySession(session.access_token, session.expires_in, epoch)
      })
    },
    [applySession, clearRefreshTimer, enqueue],
  )

  const logout = useCallback(async () => {
    const epoch = ++epochRef.current
    clearRefreshTimer()
    setAccessToken(null)
    setUser(null)
    await enqueue(async () => {
      try {
        // Запрос на отзыв cookie уходит всегда: более новый вход ждёт эту очередь
        // и не должен отменять уже начатый выход.
        await logoutRequest()
      } finally {
        if (epochRef.current === epoch) {
          clearSession()
        }
      }
    })
  }, [clearRefreshTimer, clearSession, enqueue])

  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      accessToken,
      isReady,
      isAuthenticated: Boolean(accessToken && user),
      login,
      register,
      logout,
    }),
    [user, accessToken, isReady, login, register, logout],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}
