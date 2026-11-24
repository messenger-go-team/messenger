import type { LaterEntry } from '@/api/later'

/** Максимальный интервал между успешными GET /later, пока вкладка видима. */
export const MAX_POLL_INTERVAL_MS = 30_000

/** Не чаще одного GET в секунду из-за due-таймера, даже при расхождении часов. */
export const MIN_DUE_REFETCH_MS = 1_000

const BACKOFF_DELAYS_MS = [5_000, 10_000, 20_000, 30_000] as const

/** Задержка повтора после `failureCount` подряд неудачных GET: 5 → 10 → 20 → 30 s. */
export function nextBackoffDelayMs(failureCount: number): number {
  const index = Math.min(Math.max(0, Math.trunc(failureCount)), BACKOFF_DELAYS_MS.length - 1)
  return BACKOFF_DELAYS_MS[index]
}

/**
 * Через сколько мс (по серверным часам) наступит `dueAt`; 0 для прошедшего срока.
 * Разница двух серверных значений не зависит от локальных часов клиента.
 */
export function dueDelayMs(dueAt: string, serverTime: string): number | null {
  const due = Date.parse(dueAt)
  const server = Date.parse(serverTime)
  if (Number.isNaN(due) || Number.isNaN(server)) return null
  return Math.max(0, due - server)
}

/** Ближайший срок среди запланированных записей относительно `server_time`; иначе null. */
export function nextDueWakeMs(entries: readonly LaterEntry[], serverTime: string): number | null {
  let nearest: number | null = null
  for (const entry of entries) {
    if (entry.status !== 'scheduled' || entry.due_at === null) continue
    const delay = dueDelayMs(entry.due_at, serverTime)
    if (delay === null) continue
    if (nearest === null || delay < nearest) nearest = delay
  }
  return nearest
}

/** Ключ напоминания: после переноса срока запись снова может показать toast. */
export function reminderKey(entry: Pick<LaterEntry, 'id' | 'due_at'>): string {
  return `${entry.id}|${entry.due_at ?? ''}`
}
