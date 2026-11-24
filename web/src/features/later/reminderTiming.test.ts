import { describe, expect, it } from 'vitest'
import type { LaterEntry } from '@/api/later'
import {
  MAX_POLL_INTERVAL_MS,
  dueDelayMs,
  nextBackoffDelayMs,
  nextDueWakeMs,
  reminderKey,
} from '@/features/later/reminderTiming'

function entry(overrides: Partial<LaterEntry>): LaterEntry {
  return {
    id: 'e1',
    status: 'scheduled',
    message: {
      id: 'm1',
      chat_id: 'c1',
      seq: 1,
      sender_id: 's1',
      body: 'Привет',
      created_at: '2026-11-24T10:00:00Z',
    },
    due_at: null,
    created_at: '2026-11-24T10:00:00Z',
    updated_at: '2026-11-24T10:00:00Z',
    ...overrides,
  }
}

describe('nextBackoffDelayMs', () => {
  it('walks 5 → 10 → 20 → 30 s and stays at 30 s', () => {
    expect([0, 1, 2, 3, 4, 10].map(nextBackoffDelayMs)).toEqual([
      5_000, 10_000, 20_000, 30_000, 30_000, 30_000,
    ])
  })

  it('never exceeds the 30 s poll ceiling', () => {
    expect(nextBackoffDelayMs(99)).toBeLessThanOrEqual(MAX_POLL_INTERVAL_MS)
  })
})

describe('dueDelayMs', () => {
  it('measures due_at relative to the server clock, not the local one', () => {
    expect(dueDelayMs('2026-11-24T10:00:12Z', '2026-11-24T10:00:02Z')).toBe(10_000)
  })

  it('is zero for an instant in the past and null for invalid input', () => {
    expect(dueDelayMs('2026-11-24T09:00:00Z', '2026-11-24T10:00:00Z')).toBe(0)
    expect(dueDelayMs('nope', '2026-11-24T10:00:00Z')).toBeNull()
  })
})

describe('nextDueWakeMs', () => {
  const serverTime = '2026-11-24T10:00:00Z'

  it('returns the nearest scheduled due_at', () => {
    const entries = [
      entry({ id: 'a', due_at: '2026-11-24T10:05:00Z' }),
      entry({ id: 'b', due_at: '2026-11-24T10:01:00Z' }),
      entry({ id: 'c', status: 'unscheduled' }),
      entry({ id: 'd', status: 'due', due_at: '2026-11-24T09:00:00Z' }),
    ]

    expect(nextDueWakeMs(entries, serverTime)).toBe(60_000)
  })

  it('is null for an empty list or when nothing is scheduled', () => {
    expect(nextDueWakeMs([], serverTime)).toBeNull()
    expect(nextDueWakeMs([entry({ status: 'unscheduled' })], serverTime)).toBeNull()
  })
})

describe('reminderKey', () => {
  it('changes when due_at changes so a rescheduled entry can remind again', () => {
    const first = reminderKey(entry({ due_at: '2026-11-24T10:00:00Z' }))
    const second = reminderKey(entry({ due_at: '2026-11-24T11:00:00Z' }))

    expect(first).not.toBe(second)
  })
})
