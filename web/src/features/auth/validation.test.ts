import { describe, expect, it } from 'vitest'
import { hasFieldErrors, validateCredentials, validateEmail } from './validation'

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

  it('counts password length in Unicode code points', () => {
    expect(validateCredentials('alice_1', '😀😀😀😀').password).toBeTruthy()
    expect(validateCredentials('alice_1', '😀😀😀😀😀😀😀😀')).toEqual({})
  })

  it('does not trim or normalize the password before measuring it', () => {
    expect(validateCredentials('alice_1', '1234567 ')).toEqual({})
    expect(validateCredentials('alice_1', '  123456')).toEqual({})
    expect(validateCredentials('alice_1', 'ééééééé')).toEqual({
      password: 'Пароль не короче 8 символов',
    })
  })

  it('checks password confirmation when required', () => {
    const errors = validateCredentials('alice_1', 'correct-horse-battery', {
      requirePasswordConfirm: true,
      passwordConfirm: 'other-password',
    })

    expect(errors.passwordConfirm).toBeTruthy()
    expect(hasFieldErrors(errors)).toBe(true)
  })

  it('validates email when required by the registration mockup', () => {
    expect(
      validateCredentials('alice_1', 'correct-horse-battery', {
        requireEmail: true,
        email: 'bad',
      }).email,
    ).toBeTruthy()
    expect(
      validateCredentials('alice_1', 'correct-horse-battery', {
        requireEmail: true,
        email: 'alice@example.com',
      }),
    ).toEqual({})
  })
})

describe('validateEmail', () => {
  it('accepts a simple email and rejects an empty value', () => {
    expect(validateEmail('alice@example.com')).toEqual({})
    expect(validateEmail('')).toMatchObject({ email: expect.any(String) })
  })
})
