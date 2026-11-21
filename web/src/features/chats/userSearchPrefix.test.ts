import { describe, expect, it } from 'vitest'
import {
  isValidUserSearchPrefix,
  normalizeUserSearchInput,
} from '@/features/chats/userSearchPrefix'

describe('userSearchPrefix', () => {
  it('accepts OpenAPI username prefixes', () => {
    expect(isValidUserSearchPrefix('a')).toBe(true)
    expect(isValidUserSearchPrefix('alice_1')).toBe(true)
  })

  it('rejects empty, cyrillic and overly long values', () => {
    expect(isValidUserSearchPrefix('')).toBe(false)
    expect(isValidUserSearchPrefix('алиса')).toBe(false)
    expect(isValidUserSearchPrefix('a'.repeat(33))).toBe(false)
  })

  it('trims search input', () => {
    expect(normalizeUserSearchInput('  bob  ')).toBe('bob')
  })
})
