import { describe, expect, it } from 'vitest'
import { ExponentialBackoff } from './reconnect'

describe('ExponentialBackoff', () => {
  it('uses 1, 2, 4, 8, 16 and then a 30 second cap', () => {
    const backoff = new ExponentialBackoff({ random: () => 0.5 })
    expect(Array.from({ length: 8 }, () => backoff.nextDelay())).toEqual([
      1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000,
    ])
  })

  it('applies the full plus or minus twenty percent jitter range', () => {
    expect(new ExponentialBackoff({ random: () => 0 }).nextDelay()).toBe(800)
    expect(new ExponentialBackoff({ random: () => 1 }).nextDelay()).toBe(1_200)
  })

  it('resets to the initial delay', () => {
    const backoff = new ExponentialBackoff({ random: () => 0.5 })
    backoff.nextDelay()
    backoff.nextDelay()
    backoff.reset()
    expect(backoff.nextDelay()).toBe(1_000)
  })
})
