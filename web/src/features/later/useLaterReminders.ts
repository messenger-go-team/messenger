import { useContext } from 'react'
import {
  LaterRemindersContext,
  type LaterRemindersContextValue,
} from '@/features/later/later-reminders-context'

/** Единый источник Later entries и активного напоминания. */
export function useLaterReminders(): LaterRemindersContextValue {
  const value = useContext(LaterRemindersContext)
  if (!value) {
    throw new Error('useLaterReminders must be used within LaterRemindersProvider')
  }
  return value
}

/** Вариант для компонентов, которые могут жить и без провайдера (меню сообщения в тестах). */
export function useOptionalLaterReminders(): LaterRemindersContextValue | null {
  return useContext(LaterRemindersContext)
}
