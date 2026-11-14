import { describe, expect, it } from 'vitest'
import { resolveRefreshToken } from './cookies'

describe('MSW refresh cookies', () => {
  it('reads refresh token from MSW cookies without a raw Cookie header', () => {
    expect(resolveRefreshToken({ refresh_token: 'msw-token' }, null)).toBe('msw-token')
  })

  it('prefers the MSW resolver cookie when both sources are present', () => {
    expect(resolveRefreshToken({ refresh_token: 'msw-token' }, 'refresh_token=header-token')).toBe(
      'msw-token',
    )
  })

  it('falls back to the raw Cookie header used by Node tests', () => {
    expect(resolveRefreshToken({}, 'other=value; refresh_token=header=token')).toBe('header=token')
  })

  it('returns null for a missing or empty refresh token', () => {
    expect(resolveRefreshToken({}, null)).toBeNull()
    expect(resolveRefreshToken({ refresh_token: '' }, 'refresh_token=')).toBeNull()
  })
})
