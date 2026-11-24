import { useEffect, useMemo, useSyncExternalStore, type ReactNode } from 'react'
import { refresh as refreshRequest } from '@/api/auth'
import { useAuth } from '@/features/auth/useAuth'
import { getSharedRefreshCoordinator } from '@/features/auth/refreshCoordinator'
import { LaterReminderToast } from '@/features/later/LaterReminderToast'
import { LaterRemindersContext } from '@/features/later/later-reminders-context'
import { LaterRemindersStore } from '@/features/later/LaterRemindersStore'

interface LaterRemindersProviderProps {
  children: ReactNode
  /** Подмена восстановления сессии на 401 (тесты). */
  recoverAuth?: () => Promise<unknown>
}

function defaultRecoverAuth() {
  return getSharedRefreshCoordinator((signal) => refreshRequest({ signal })).requestRefresh()
}

/**
 * Владелец GET /later и напоминаний для авторизованной вкладки.
 * Store создаётся на `user.id`: logout или смена аккаунта останавливает прежний
 * (таймеры, ответы в полёте) и начинает с пустого состояния.
 */
export function LaterRemindersProvider({
  children,
  recoverAuth = defaultRecoverAuth,
}: LaterRemindersProviderProps) {
  const { accessToken, isAuthenticated, user } = useAuth()
  const ownerId = isAuthenticated ? (user?.id ?? null) : null

  const store = useMemo(() => new LaterRemindersStore(ownerId), [ownerId])

  // Объявлен раньше start/tokenChanged: эффекты одного коммита идут по порядку.
  useEffect(() => {
    store.setCredentials({ accessToken, recoverAuth })
  })

  useEffect(() => {
    if (!ownerId) return
    store.start()
    return () => store.stop()
  }, [ownerId, store])

  useEffect(() => {
    if (ownerId) store.tokenChanged()
  }, [accessToken, ownerId, store])

  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot)

  const value = useMemo(
    () => ({
      ...snapshot,
      refresh: store.refresh,
      removeEntry: (entryId: string) => store.removeEntry(entryId),
      replaceEntry: (...args: Parameters<LaterRemindersStore['replaceEntry']>) =>
        store.replaceEntry(...args),
      dismissReminder: (entryId: string) => store.dismissReminder(entryId),
    }),
    [snapshot, store],
  )

  return (
    <LaterRemindersContext.Provider value={value}>
      {children}
      {ownerId ? <LaterReminderToast /> : null}
    </LaterRemindersContext.Provider>
  )
}
