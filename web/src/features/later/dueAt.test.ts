import { afterEach, describe, expect, it, vi } from 'vitest'
import { dueAtEvening, dueAtInOneHour, toDueAtPayload } from '@/features/later/dueAt'

describe('dueAtEvening', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('maps 18:59 local to today 19:00 UTC Z', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 10, 14, 18, 59, 0, 0))
    expect(dueAtEvening()).toBe(new Date(2026, 10, 14, 19, 0, 0, 0).toISOString())
  })

  it('maps 19:00 local to next calendar day 19:00', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 10, 14, 19, 0, 0, 0))
    expect(dueAtEvening()).toBe(new Date(2026, 10, 15, 19, 0, 0, 0).toISOString())
  })

  it('maps time after threshold to next calendar day 19:00', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 10, 14, 22, 15, 0, 0))
    expect(dueAtEvening()).toBe(new Date(2026, 10, 15, 19, 0, 0, 0).toISOString())
  })

  it('rolls across month boundary', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 10, 30, 19, 0, 0, 0))
    expect(dueAtEvening()).toBe(new Date(2026, 11, 1, 19, 0, 0, 0).toISOString())
  })

  it('builds evening from local calendar parts across a spring-forward night', () => {
    // Device clock APIs: construct local Date for the night of a typical spring jump.
    // 2026-03-08 in America/New_York springs 02:00→03:00; local Date(y,m,d,h) still lands on civil 19:00.
    const beforeEvening = new Date(2026, 2, 8, 18, 30, 0, 0)
    const afterEvening = dueAtEvening(beforeEvening)
    const parsed = new Date(afterEvening)
    expect(afterEvening.endsWith('Z')).toBe(true)
    expect(parsed.getFullYear()).toBe(2026)
    expect(parsed.getMonth()).toBe(2)
    expect(parsed.getDate()).toBe(8)
    expect(parsed.getHours()).toBe(19)
    expect(parsed.getMinutes()).toBe(0)
  })

  it('builds next-day evening across a fall-back calendar day', () => {
    const atThreshold = new Date(2026, 10, 1, 19, 0, 0, 0)
    const afterEvening = dueAtEvening(atThreshold)
    const parsed = new Date(afterEvening)
    expect(afterEvening.endsWith('Z')).toBe(true)
    expect(parsed.getFullYear()).toBe(2026)
    expect(parsed.getMonth()).toBe(10)
    expect(parsed.getDate()).toBe(2)
    expect(parsed.getHours()).toBe(19)
    expect(parsed.getMinutes()).toBe(0)
  })
})

describe('dueAtInOneHour', () => {
  it('adds one hour and serializes as UTC Z', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 10, 14, 10, 0, 0, 0))
    expect(dueAtInOneHour()).toBe(new Date(2026, 10, 14, 11, 0, 0, 0).toISOString())
    vi.useRealTimers()
  })
})

describe('toDueAtPayload', () => {
  it('returns null for save-without-due', () => {
    expect(toDueAtPayload(null)).toBeNull()
  })

  it('keeps trailing Z on absolute instants', () => {
    expect(toDueAtPayload('2026-11-14T16:00:00.000Z')).toBe('2026-11-14T16:00:00.000Z')
  })
})
