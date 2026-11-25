import { createContext } from 'react'
import type { LaterEntry } from '@/api/later'
import type { LaterRemindersSnapshot } from '@/features/later/LaterRemindersStore'

export interface LaterRemindersContextValue extends LaterRemindersSnapshot {
  /** Single-flight GET /later; параллельные вызовы делят один запрос. */
  refresh: () => Promise<void>
  removeEntry: (entryId: string) => void
  replaceEntry: (entry: LaterEntry, serverTime?: string) => void
  /** «Позже»: скрыть toast в этой сессии, не завершая запись. */
  dismissReminder: (entryId: string) => void
}

export const LaterRemindersContext = createContext<LaterRemindersContextValue | null>(null)
