import { afterEach, describe, expect, it, vi } from 'vitest'
import { dueAtEvening, dueAtInOneHour, toDueAtPayload } from '@/features/later/dueAt'

describe('dueAtEvening', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllEnvs()
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

  it.each([
    ['2026-03-08T00:00:00Z', '2026-03-08T23:00:00.000Z'],
    ['2026-10-31T23:00:00Z', '2026-11-02T00:00:00.000Z'],
  ])('keeps local 19:00 across an overnight DST change from %s', (now, expected) => {
    vi.stubEnv('TZ', 'America/New_York')
    const local = new Date(now)
    expect(local.getHours()).toBe(19)
    expect(dueAtEvening(local)).toBe(expected)
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
