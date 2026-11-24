import type { LaterStatus } from '@/api/later'

/** Поля, по которым OpenAPI сортирует активный список Later. */
export type LaterOrderEntry = {
  id: string
  status: LaterStatus
  due_at: string | null
  created_at: string
}

const STATUS_RANK: Record<LaterStatus, number> = { due: 0, scheduled: 1, unscheduled: 2 }

/** Сравнение RFC 3339 по моменту времени, включая дробные секунды. */
export function compareRfc3339(left: string, right: string): number {
  const leftMs = Date.parse(left)
  const rightMs = Date.parse(right)
  if (Number.isFinite(leftMs) && Number.isFinite(rightMs)) {
    if (leftMs === rightMs) return 0
    return leftMs < rightMs ? -1 : 1
  }
  return left.localeCompare(right)
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
