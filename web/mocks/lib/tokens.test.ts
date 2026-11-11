import { describe, expect, it } from 'vitest'
import { createAccessToken, verifyAccessToken } from './tokens'

// JWT tests проверяют happy path и отказ при нарушении структуры или подписи token.
describe('Mock JWT tokens', () => {
  it('creates a valid access token', async () => {
    const userId = '00000000-0000-4000-8000-000000000001'

    const token = await createAccessToken(userId)
    const verifiedUserId = await verifyAccessToken(token)

    expect(token.split('.')).toHaveLength(3)
    expect(verifiedUserId).toBe(userId)
  })

  it('rejects an invalid token', async () => {
    const result = await verifyAccessToken('invalid-token')

    expect(result).toBeNull()
  })

  it('rejects a modified token', async () => {
    const token = await createAccessToken('00000000-0000-4000-8000-000000000001')

    const parts = token.split('.')
    parts[1] = 'invalid-payload'

    const result = await verifyAccessToken(parts.join('.'))

    expect(result).toBeNull()
  })
})
