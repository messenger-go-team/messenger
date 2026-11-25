/**
 * Client-side Later due_at helpers (SPEC FR-LATER-1).
 * API receives RFC 3339 UTC with `Z`, or `null` for «Просто сохранить».
 */

/** «Вечером»: local 19:00 today before threshold; from 19:00 inclusive → next calendar day. */
export function dueAtEvening(now: Date = new Date()): string {
  const year = now.getFullYear()
  const month = now.getMonth()
  const day = now.getDate()
  const hour = now.getHours()

  const targetDay = hour >= 19 ? day + 1 : day
  return new Date(year, month, targetDay, 19, 0, 0, 0).toISOString()
}

/** «Через 1 час» from device clock → UTC Z. */
export function dueAtInOneHour(now: Date = new Date()): string {
  return new Date(now.getTime() + 60 * 60 * 1000).toISOString()
}

/** Normalize chosen instant or pass-through null for unscheduled save. */
export function toDueAtPayload(dueAt: string | null): string | null {
  if (dueAt === null) return null
  const parsed = new Date(dueAt)
  if (Number.isNaN(parsed.getTime())) {
    throw new Error('Invalid due_at')
  }
  return parsed.toISOString()
}
