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
  const credentialInFlightRef = useRef(new Set<Promise<unknown>>())
  const applySessionRef = useRef<
    (token: string, expiresInSeconds: number, epoch: number) => Promise<void>
  >(async () => undefined)

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

  const settleInFlightRefresh = useCallback(async () => {
    const pending = refreshInFlightRef.current
    if (!pending) {
      return
    }

    try {
      await pending
    } catch {
      // Устаревший ответ не меняет сессию: решение принимает вызывающий код по epoch.
    }
  }, [])

  const trackCredential = useCallback((operation: Promise<unknown>) => {
    credentialInFlightRef.current.add(operation)
    // finally-цепочка тоже реджектится — глушим только её, исходный operation ждут вызывающие.
    void operation
      .finally(() => {
        credentialInFlightRef.current.delete(operation)
      })
      .catch(() => undefined)
    return operation
  }, [])

  const settleInFlightCredentials = useCallback(async () => {
    while (credentialInFlightRef.current.size > 0) {
      await Promise.allSettled([...credentialInFlightRef.current])
    }
  }, [])

  /** Поздний login/register уже успел выставить Set-Cookie — отзываем его logout'ом. */
  const revokeStaleSessionCookie = useCallback(async () => {
    try {
      await logoutRequest()
    } catch {
      // Cookie могла уже быть недействительной.
    }
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
        void (async () => {
          try {
            const next = await refreshShared()
            if (epochRef.current !== epoch) {
              return
            }
            await applySessionRef.current(next.access_token, next.expires_in, epoch)
          } catch {
            if (epochRef.current === epoch) {
              clearSession()
            }
          }
        })()
      }, delayMs)
    },
    [clearRefreshTimer, clearSession, refreshShared],
  )

  useEffect(() => {
    applySessionRef.current = applySession
  }, [applySession])

  useEffect(() => {
    let cancelled = false
    const epoch = epochRef.current

    void (async () => {
      try {
        const session = await refreshShared()
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
    })()

    return () => {
      cancelled = true
      clearRefreshTimer()
    }
  }, [clearRefreshTimer, clearSession, refreshShared])

  const login = useCallback(
    async (credentials: LoginRequest) => {
      const epoch = ++epochRef.current
      clearRefreshTimer()
      await settleInFlightRefresh()
      if (epochRef.current !== epoch) {
        return
      }

      await trackCredential(
        (async () => {
          const session = await loginRequest(credentials)
          if (epochRef.current !== epoch) {
            await revokeStaleSessionCookie()
            return
          }
          await applySession(session.access_token, session.expires_in, epoch)
        })(),
      )
    },
    [
      applySession,
      clearRefreshTimer,
      revokeStaleSessionCookie,
      settleInFlightRefresh,
      trackCredential,
    ],
  )

  const register = useCallback(
    async (data: RegisterRequest) => {
      const epoch = ++epochRef.current
      clearRefreshTimer()
      await settleInFlightRefresh()
      if (epochRef.current !== epoch) {
        return
      }

      await trackCredential(
        (async () => {
          await registerRequest(data)
          if (epochRef.current !== epoch) {
            return
          }

          const session = await loginRequest(data)
          if (epochRef.current !== epoch) {
            await revokeStaleSessionCookie()
            return
          }
          await applySession(session.access_token, session.expires_in, epoch)
        })(),
      )
    },
    [
      applySession,
      clearRefreshTimer,
      revokeStaleSessionCookie,
      settleInFlightRefresh,
      trackCredential,
    ],
  )

  const logout = useCallback(async () => {
    const epoch = ++epochRef.current
    clearRefreshTimer()
    setAccessToken(null)
    setUser(null)
    await settleInFlightRefresh()
    // Дожидаемся login/register: их Set-Cookie успеет прийти и будет отозван внутри операции или ниже.
    await settleInFlightCredentials()
    if (epochRef.current !== epoch) {
      return
    }

    try {
      await logoutRequest()
    } finally {
      if (epochRef.current === epoch) {
        clearSession()
      }
    }
  }, [clearRefreshTimer, clearSession, settleInFlightCredentials, settleInFlightRefresh])

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
