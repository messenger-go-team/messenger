import type { LaterStatus } from '@/api/later'

/** Поля, по которым OpenAPI сортирует активный список Later. */
export type LaterOrderEntry = {
  id: string
  status: LaterStatus
  due_at: string | null
  created_at: string
}

const STATUS_RANK: Record<LaterStatus, number> = { due: 0, scheduled: 1, unscheduled: 2 }
const RFC3339 = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/i

/** Сравнение RFC 3339 по моменту времени, включая дробные секунды. */
export function compareRfc3339(left: string, right: string): number {
  const a = RFC3339.exec(left)
  const b = RFC3339.exec(right)
  if (!a || !b) return left.localeCompare(right)

  const leftSecond = Date.parse(a[1] + a[3])
  const rightSecond = Date.parse(b[1] + b[3])
  if (!Number.isFinite(leftSecond) || !Number.isFinite(rightSecond)) {
    return left.localeCompare(right)
  }
  if (leftSecond !== rightSecond) return leftSecond - rightSecond

  // Date truncates sub-millisecond values. Within one second the normalized
  // decimal digits can be compared directly, without rounding.
  const leftFraction = (a[2] ?? '').replace(/0+$/, '')
  const rightFraction = (b[2] ?? '').replace(/0+$/, '')
  if (leftFraction === rightFraction) return 0
  return leftFraction < rightFraction ? -1 : 1
}

/**
 * due, затем scheduled, затем unscheduled.
 * В группах со сроком: due_at, created_at, id. Без срока: created_at, id.
 * Одинаковый момент с разной записью дроби не считается различием.
 */
export function compareLaterEntries(left: LaterOrderEntry, right: LaterOrderEntry): number {
  if (STATUS_RANK[left.status] !== STATUS_RANK[right.status]) {
    return STATUS_RANK[left.status] - STATUS_RANK[right.status]
  }
  if (left.status !== 'unscheduled' && left.due_at && right.due_at) {
    const due = compareRfc3339(left.due_at, right.due_at)
    if (due !== 0) return due
  }
  const created = compareRfc3339(left.created_at, right.created_at)
  if (created !== 0) return created
  return left.id.localeCompare(right.id)
}
