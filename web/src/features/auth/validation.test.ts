import { describe, expect, it } from 'vitest'
import { hasFieldErrors, validateCredentials } from './validation'

describe('validateCredentials', () => {
  it('accepts OpenAPI-compliant username and password', () => {
    expect(validateCredentials('alice_1', 'correct-horse-battery')).toEqual({})
  })

  it('rejects short or invalid username', () => {
    expect(validateCredentials('ab', 'correct-horse-battery').username).toBeTruthy()
    expect(validateCredentials('alice@1', 'correct-horse-battery').username).toBeTruthy()
  })

  it('rejects short password', () => {
    expect(validateCredentials('alice_1', 'short').password).toBeTruthy()
  })

  it('checks password confirmation when required', () => {
    const errors = validateCredentials('alice_1', 'correct-horse-battery', {
      requirePasswordConfirm: true,
      passwordConfirm: 'other-password',
    })

    expect(errors.passwordConfirm).toBeTruthy()
    expect(hasFieldErrors(errors)).toBe(true)
  })
})
