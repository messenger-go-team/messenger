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
import { ApiError } from '@/api/client'
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
  refreshBackoffMs,
  RefreshCancelledError,
  RefreshTimeoutError,
} from '@/features/auth/refreshCoordinator'

/** Обновляем access-токен за минуту до истечения `expires_in`. */
const REFRESH_SKEW_MS = 60_000

interface AuthProviderProps {
  children: ReactNode
}

function isTemporaryRefreshFailure(error: unknown): boolean {
  if (error instanceof RefreshTimeoutError) return true
  if (error instanceof ApiError && error.status >= 500) return true
  if (error instanceof TypeError) return true
  return false
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

  /** Инвалидация с другой вкладки / final failure: гасим bootstrap и in-flight acceptSession. */
  const invalidateLocalAuth = useCallback(
    (nextEpochHint?: number) => {
      if (typeof nextEpochHint === 'number' && nextEpochHint > epochRef.current) {
        epochRef.current = nextEpochHint
      } else {
        epochRef.current += 1
      }
      cookieOwnerRef.current = null
      publishedEpochRef.current = null
      clearSession()
    },
    [clearSession],
  )

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
    if (readLogoutPending()) return
    await settleLogout()
  }, [settleLogout])

  const claimCookie = useCallback((epoch: number) => {
    cookieOwnerRef.current = epoch
    writeLogoutPending(false)
  }, [])

  const abandonOwnedCookie = useCallback(
    (epoch: number): Promise<void> => {
      if (cookieOwnerRef.current !== epoch) return Promise.resolve()
      if (publishedEpochRef.current === epoch) return Promise.resolve()
      writeLogoutPending(true)
      clearSession()
      return enqueue(async () => {
        if (cookieOwnerRef.current !== epoch) return
        cookieOwnerRef.current = null
        await settleLogout()
      })
    },
    [clearSession, enqueue, settleLogout],
  )

  const acceptSession = useCallback(
    async (token: string, expiresInSeconds: number, epoch: number) => {
      if (epochRef.current !== epoch) return

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
    async (epoch: number, attempt = 0) => {
      try {
        await enqueue(async () => {
          await refreshShared()
          if (epochRef.current !== epoch) {
            await revokeIfCurrentCookieIsStale()
          }
        })
      } catch (error) {
        if (error instanceof RefreshCancelledError) return
        if (isFinalRefreshFailure(error)) {
          if (epochRef.current === epoch) clearSession()
          return
        }
        if (epochRef.current !== epoch) return
        clearRefreshTimer()
        refreshTimerRef.current = setTimeout(() => {
          void rotateSession(epoch, attempt + 1)
        }, refreshBackoffMs(attempt))
      }
    },
    [clearRefreshTimer, clearSession, enqueue, refreshShared, revokeIfCurrentCookieIsStale],
  )

  useEffect(() => {
    acceptSessionRef.current = acceptSession
    rotateSessionRef.current = async (epoch: number) => {
      await rotateSession(epoch, 0)
    }
  }, [acceptSession, rotateSession])

  useEffect(() => {
    const coordinator = coordinatorRef.current
    const unsubscribeSuccess = coordinator.subscribeSuccess((session) => {
      if (publishedEpochRef.current === null) return
      const epoch = epochRef.current
      void acceptSessionRef.current(session.access_token, session.expires_in, epoch)
    })
    const unsubscribeInvalidated = coordinator.subscribeInvalidated((sessionEpoch) => {
      invalidateLocalAuth(sessionEpoch)
      writeLogoutPending(true)
    })
    const unsubscribeFinal = coordinator.subscribeFinalFailure((_status, sessionEpoch) => {
      invalidateLocalAuth(sessionEpoch)
    })
    return () => {
      unsubscribeSuccess()
      unsubscribeInvalidated()
      unsubscribeFinal()
    }
  }, [invalidateLocalAuth])

  useEffect(() => {
    let cancelled = false
    const epoch = epochRef.current
    // Фиксируем на старте эффекта: поздний logout() сам делает settleLogout.
    const pendingLogoutAtMount = readLogoutPending()
    // Стартуем refresh сразу (не внутри enqueue), чтобы abort/reject не были unhandled.
    const initialRefresh = pendingLogoutAtMount ? null : refreshShared()

    const boot = enqueue(async () => {
      if (!initialRefresh) {
        await settleLogout()
        return null
      }

      let attempt = 0
      let pending: Promise<AccessTokenResponse> | null = initialRefresh
      for (;;) {
        if (cancelled || epochRef.current !== epoch) return null
        try {
          return await (pending ?? refreshShared())
        } catch (error) {
          pending = null
          if (cancelled || epochRef.current !== epoch) return null
          if (error instanceof RefreshCancelledError || isFinalRefreshFailure(error)) {
            return null
          }
          if (!isTemporaryRefreshFailure(error)) return null
          await new Promise<void>((resolve) => {
            window.setTimeout(resolve, refreshBackoffMs(attempt))
          })
          attempt += 1
        }
      }
    })

    void boot
      .then(async (session: AccessTokenResponse | null) => {
        if (!session || cancelled || epochRef.current !== epoch) {
          if (!cancelled && epochRef.current === epoch && !readLogoutPending()) {
            clearSession()
          }
          return
        }
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
  }, [clearRefreshTimer, clearSession, enqueue, refreshShared, settleLogout])

  const login = useCallback(
    async (credentials: LoginRequest) => {
      const previousOwner = cookieOwnerRef.current
      const epoch = ++epochRef.current
      clearRefreshTimer()
      const shouldAbandon = previousOwner !== null && publishedEpochRef.current !== previousOwner
      // Синхронная отметка до await — reload не должен поднять отменённый вход.
      if (shouldAbandon) {
        writeLogoutPending(true)
        clearSession()
      }

      const session = await enqueue(async () => {
        return coordinatorRef.current.withSessionChange('account_switch', async () => {
          if (shouldAbandon) {
            if (cookieOwnerRef.current === previousOwner) cookieOwnerRef.current = null
            await settleLogout()
          }
          if (epochRef.current !== epoch) throw new AuthFlowCancelledError()
          const next = await loginRequest(credentials)
          if (epochRef.current !== epoch) {
            await revokeIfCurrentCookieIsStale()
            throw new AuthFlowCancelledError()
          }
          claimCookie(epoch)
          return next
        })
      })
      await acceptSession(session.access_token, session.expires_in, epoch)
      if (epochRef.current !== epoch) throw new AuthFlowCancelledError()
    },
    [
      acceptSession,
      claimCookie,
      clearRefreshTimer,
      clearSession,
      enqueue,
      revokeIfCurrentCookieIsStale,
      settleLogout,
    ],
  )

  const register = useCallback(
    async (data: RegisterRequest) => {
      const previousOwner = cookieOwnerRef.current
      const epoch = ++epochRef.current
      clearRefreshTimer()
      const shouldAbandon = previousOwner !== null && publishedEpochRef.current !== previousOwner
      if (shouldAbandon) {
        writeLogoutPending(true)
        clearSession()
      }

      const session = await enqueue(async () => {
        return coordinatorRef.current.withSessionChange('account_switch', async () => {
          if (shouldAbandon) {
            if (cookieOwnerRef.current === previousOwner) cookieOwnerRef.current = null
            await settleLogout()
          }
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
      })
      await acceptSession(session.access_token, session.expires_in, epoch)
      if (epochRef.current !== epoch) throw new AuthFlowCancelledError()
    },
    [
      acceptSession,
      claimCookie,
      clearRefreshTimer,
      clearSession,
      enqueue,
      revokeIfCurrentCookieIsStale,
      settleLogout,
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
    await enqueue(async () => {
      await coordinatorRef.current.withSessionChange('logout', async () => {
        await settleLogout()
      })
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
