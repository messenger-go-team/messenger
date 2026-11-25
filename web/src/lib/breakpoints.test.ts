import { describe, expect, it } from 'vitest'
import { BREAKPOINTS, layoutBucket } from '@/lib/breakpoints'

describe('layoutBucket', () => {
  it('uses #45 thresholds: mobile <580, tablet 580–1079, desktop ≥1080', () => {
    expect(layoutBucket(375)).toBe('mobile')
    expect(layoutBucket(579)).toBe('mobile')
    expect(layoutBucket(BREAKPOINTS.tablet)).toBe('tablet')
    expect(layoutBucket(767)).toBe('tablet')
    expect(layoutBucket(1079)).toBe('tablet')
    expect(layoutBucket(BREAKPOINTS.desktop)).toBe('desktop')
    expect(layoutBucket(1440)).toBe('desktop')
  })
})
