import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  getMe,
  login as loginRequest,
  logout as logoutRequest,
  refresh as refreshRequest,
  register as registerRequest,
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
  const applySessionRef = useRef<(token: string, expiresInSeconds: number) => Promise<void>>(
    async () => undefined,
  )

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
    async (token: string, expiresInSeconds: number) => {
      setAccessToken(token)
      const profile = await getMe(token)
      setUser(profile)

      clearRefreshTimer()
      const delayMs = Math.max(expiresInSeconds * 1000 - REFRESH_SKEW_MS, 5_000)
      refreshTimerRef.current = setTimeout(() => {
        void (async () => {
          try {
            const next = await refreshRequest()
            await applySessionRef.current(next.access_token, next.expires_in)
          } catch {
            clearSession()
          }
        })()
      }, delayMs)
    },
    [clearRefreshTimer, clearSession],
  )

  useEffect(() => {
    applySessionRef.current = applySession
  }, [applySession])

  useEffect(() => {
    let cancelled = false

    void (async () => {
      try {
        const session = await refreshRequest()
        if (cancelled) {
          return
        }
        await applySessionRef.current(session.access_token, session.expires_in)
      } catch {
        if (!cancelled) {
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
  }, [clearRefreshTimer, clearSession])

  const login = useCallback(
    async (credentials: LoginRequest) => {
      const session = await loginRequest(credentials)
      await applySession(session.access_token, session.expires_in)
    },
    [applySession],
  )

  const register = useCallback(
    async (data: RegisterRequest) => {
      await registerRequest(data)
      const session = await loginRequest(data)
      await applySession(session.access_token, session.expires_in)
    },
    [applySession],
  )

  const logout = useCallback(async () => {
    try {
      await logoutRequest()
    } finally {
      clearSession()
    }
  }, [clearSession])

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
