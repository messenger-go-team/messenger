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
import {
  getSharedRefreshCoordinator,
  isFinalRefreshFailure,
  RefreshCancelledError,
} from '@/features/auth/refreshCoordinator'

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
  const queueTailRef = useRef(Promise.resolve())
  /** Эпоха входа, чья refresh-cookie уже записана, но ещё может быть отменена. */
  const cookieOwnerRef = useRef<number | null>(null)
  /** Эпоха, чей профиль уже показан. Повторный /me этой эпохи cookie не отзывает. */
  const publishedEpochRef = useRef<number | null>(null)
  const acceptSessionRef = useRef<
    (token: string, expiresInSeconds: number, epoch: number) => Promise<void>
  >(async () => undefined)
  const rotateSessionRef = useRef<(epoch: number) => Promise<void>>(async () => undefined)
  const coordinatorRef = useRef(getSharedRefreshCoordinator((signal) => refreshRequest({ signal })))

  const enqueue = useCallback(<T,>(task: () => Promise<T>): Promise<T> => {
    const run = queueTailRef.current.then(task, task)
    queueTailRef.current = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }, [])

  const refreshShared = useCallback(() => coordinatorRef.current.requestRefresh(), [])

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

  /**
   * Отзыв refresh-cookie: отметка до запроса, ошибка повтора сразу после сбоя.
   * 204 и 401 снимают отметку и сообщение; временный сбой оставляет оба.
   */
  const settleLogout = useCallback(async (): Promise<boolean> => {
    writeLogoutPending(true)

    let cleared = true
    try {
      await logoutRequest()
    } catch (error) {
      cleared = isLogoutSettled(error)
    }

    writeLogoutPending(!cleared)
    setLogoutError(cleared ? null : LOGOUT_FAILED_MESSAGE)
    return cleared
  }, [])

  const revokeIfCurrentCookieIsStale = useCallback(async () => {
    // Выход уже отмечен и сам очистит cookie. Повторный logout снял бы более новый вход.
    if (readLogoutPending()) return
    await settleLogout()
  }, [settleLogout])

  const claimCookie = useCallback((epoch: number) => {
    cookieOwnerRef.current = epoch
    writeLogoutPending(false)
  }, [])

  /**
   * Вход записал cookie, но его профиль так и не стал текущей сессией.
   * Отметка ставится синхронно, в момент отмены, и logout встаёт в очередь
   * сразу — старый GET /me её не задерживает. Перед самим logout владелец
   * проверяется ещё раз: успешный более новый вход уже мог записать свою cookie.
   */
  const abandonOwnedCookie = useCallback(
    (epoch: number, waitForRefreshAbort?: Promise<void>): Promise<void> => {
      if (cookieOwnerRef.current !== epoch) return Promise.resolve()
      if (publishedEpochRef.current === epoch) return Promise.resolve()
      writeLogoutPending(true)
      clearSession()
      return enqueue(async () => {
        if (waitForRefreshAbort) await waitForRefreshAbort
        if (cookieOwnerRef.current !== epoch) return
        cookieOwnerRef.current = null
        await settleLogout()
      })
    },
    [clearSession, enqueue, settleLogout],
  )

  const acceptSession = useCallback(
    async (token: string, expiresInSeconds: number, epoch: number) => {
      // Профиль не блокирует очередь: выход может отозвать cookie, не дожидаясь GET /me.
      let profile: User
      try {
        profile = await getMe(token)
      } catch (error) {
        await abandonOwnedCookie(epoch)
        if (epochRef.current !== epoch) return
        throw error
      }
      if (epochRef.current !== epoch) {
        await abandonOwnedCookie(epoch)
        return
      }

      publishedEpochRef.current = epoch
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
    [abandonOwnedCookie, clearRefreshTimer],
  )

  const rotateSession = useCallback(
    async (epoch: number) => {
      try {
        await enqueue(async () => {
          await refreshShared()
          if (epochRef.current !== epoch) {
            await revokeIfCurrentCookieIsStale()
          }
        })
        // JWT и таймер обновляет subscribeSuccess (локальный success тоже уведомляет).
      } catch (error) {
        if (error instanceof RefreshCancelledError) return
        if (isFinalRefreshFailure(error)) {
          if (epochRef.current === epoch) clearSession()
          return
        }
        // Сеть / 5xx / timeout: сессию не сбрасываем — WS backoff и повторный refresh остаются возможны.
        if (epochRef.current === epoch) {
          clearRefreshTimer()
          refreshTimerRef.current = setTimeout(() => {
            void rotateSessionRef.current(epoch)
          }, 5_000)
        }
      }
    },
    [clearRefreshTimer, clearSession, enqueue, refreshShared, revokeIfCurrentCookieIsStale],
  )

  useEffect(() => {
    acceptSessionRef.current = acceptSession
    rotateSessionRef.current = rotateSession
  }, [acceptSession, rotateSession])

  useEffect(() => {
    const coordinator = coordinatorRef.current
    const unsubscribeSuccess = coordinator.subscribeSuccess((session) => {
      // JWT с другой вкладки или локального WS-refresh: обновляем REST access token.
      if (publishedEpochRef.current === null) return
      const epoch = epochRef.current
      void acceptSessionRef.current(session.access_token, session.expires_in, epoch)
    })
    const unsubscribeInvalidated = coordinator.subscribeInvalidated(() => {
      if (publishedEpochRef.current === null) return
      publishedEpochRef.current = null
      clearRefreshTimer()
      setAccessToken(null)
      setUser(null)
    })
    return () => {
      unsubscribeSuccess()
      unsubscribeInvalidated()
    }
  }, [clearRefreshTimer])

  useEffect(() => {
    let cancelled = false
    const epoch = epochRef.current
    // Не стартуем refresh, пока незавершённый выход не отзовёт cookie.
    const pendingRefresh = readLogoutPending() ? null : refreshShared()

    const boot = enqueue(async () => {
      if (!pendingRefresh) {
        await settleLogout()
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
    revokeIfCurrentCookieIsStale,
    settleLogout,
  ])

  const login = useCallback(
    async (credentials: LoginRequest) => {
      const previousOwner = cookieOwnerRef.current
      const epoch = ++epochRef.current
      clearRefreshTimer()
      const refreshAborted = coordinatorRef.current.cancel('account_switch')
      // Отметка отзыва синхронна; сам logout POST ждёт abort refresh.
      if (previousOwner !== null) void abandonOwnedCookie(previousOwner, refreshAborted)
      else await refreshAborted
      const session = await enqueue(async () => {
        if (epochRef.current !== epoch) throw new AuthFlowCancelledError()

        const next = await loginRequest(credentials)
        if (epochRef.current !== epoch) {
          await revokeIfCurrentCookieIsStale()
          throw new AuthFlowCancelledError()
        }
        claimCookie(epoch)
        return next
      })
      await acceptSession(session.access_token, session.expires_in, epoch)
      if (epochRef.current !== epoch) throw new AuthFlowCancelledError()
    },
    [
      abandonOwnedCookie,
      acceptSession,
      claimCookie,
      clearRefreshTimer,
      enqueue,
      revokeIfCurrentCookieIsStale,
    ],
  )

  const register = useCallback(
    async (data: RegisterRequest) => {
      const previousOwner = cookieOwnerRef.current
      const epoch = ++epochRef.current
      clearRefreshTimer()
      const refreshAborted = coordinatorRef.current.cancel('account_switch')
      if (previousOwner !== null) void abandonOwnedCookie(previousOwner, refreshAborted)
      else await refreshAborted
      const session = await enqueue(async () => {
        if (epochRef.current !== epoch) throw new AuthFlowCancelledError()

        await registerRequest(data)
        if (epochRef.current !== epoch) throw new AuthFlowCancelledError()

        const next = await loginRequest(data)
        if (epochRef.current !== epoch) {
          await revokeIfCurrentCookieIsStale()
          throw new AuthFlowCancelledError()
        }
        claimCookie(epoch)
        return next
      })
      await acceptSession(session.access_token, session.expires_in, epoch)
      if (epochRef.current !== epoch) throw new AuthFlowCancelledError()
    },
    [
      abandonOwnedCookie,
      acceptSession,
      claimCookie,
      clearRefreshTimer,
      enqueue,
      revokeIfCurrentCookieIsStale,
    ],
  )

  const logout = useCallback(async () => {
    ++epochRef.current
    cookieOwnerRef.current = null
    publishedEpochRef.current = null
    clearRefreshTimer()
    writeLogoutPending(true)
    setAccessToken(null)
    setUser(null)
    // Abort refresh до logout POST: иначе запоздалый Set-Cookie перезапишет отзыв.
    const refreshAborted = coordinatorRef.current.cancel('logout')
    await enqueue(async () => {
      await refreshAborted
      await settleLogout()
    })
  }, [clearRefreshTimer, enqueue, settleLogout])

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
