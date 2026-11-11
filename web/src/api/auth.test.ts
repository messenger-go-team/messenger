import { describe, expect, it } from 'vitest'
import { SignJWT } from 'jose'
import { ApiError, apiRequest } from './client'
import {
  login,
  register,
  getMe,
  refresh,
  logout,
  searchUsers,
  getContacts,
  addContact,
} from './auth'
import { verifyAccessToken } from '../../mocks/lib/tokens'
import { createRefreshSession } from '../../mocks/data/auth'
import { http, HttpResponse } from 'msw'
import { server } from '../../mocks/server'

const ALICE_ID = '00000000-0000-4000-8000-000000000001'
const MOCK_JWT_SECRET = 'messenger-mock-jwt-secret-for-development-only'

interface TestAccessTokenOptions {
  includeIssuedAt?: boolean
  expiresAt?: number | null
}

/** Подписывает JWT тестовым mock key, позволяя удалить обязательные claims для regression tests. */
async function createTestAccessToken({
  includeIssuedAt = true,
  expiresAt = Math.floor(Date.now() / 1000) + 900,
}: TestAccessTokenOptions = {}): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(MOCK_JWT_SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  let token = new SignJWT({}).setProtectedHeader({ alg: 'HS256', typ: 'JWT' }).setSubject(ALICE_ID)

  if (includeIssuedAt) {
    token = token.setIssuedAt()
  }

  if (expiresAt !== null) {
    token = token.setExpirationTime(expiresAt)
  }

  return token.sign(key)
}

/** Извлекает opaque token из Set-Cookie для Node-тестов, не эмулирующих browser cookie store. */
function getRefreshTokenFromResponse(response: Response): string {
  const refreshToken = response.headers.get('set-cookie')?.match(/refresh_token=([^;]+)/)?.[1]

  if (!refreshToken) {
    throw new Error('Expected refresh_token in Set-Cookie')
  }

  return refreshToken
}

describe('Auth API', () => {
  // Login проверяется как публичный client-контракт и как источник криптографически валидного JWT.
  it('returns an access token for valid credentials', async () => {
    const response = await login({
      username: 'alice_1',
      password: 'correct-horse-battery',
    })

    expect(response).toMatchObject({
      token_type: 'Bearer',
      expires_in: 900,
    })

    expect(response.access_token).toEqual(expect.any(String))
    expect(response.access_token.split('.')).toHaveLength(3)

    const userId = await verifyAccessToken(response.access_token)

    expect(userId).toBe('00000000-0000-4000-8000-000000000001')
  })

  it('returns 401 for invalid credentials', async () => {
    await expect(
      login({
        username: 'alice_1',
        password: 'wrong-password',
      }),
    ).rejects.toMatchObject({
      status: 401,
      code: 'unauthorized',
    })
  })

  it('returns 422 for invalid request data', async () => {
    await expect(
      login({
        username: 'ab',
        password: '123',
      }),
    ).rejects.toMatchObject({
      status: 422,
      code: 'validation_error',
    })
  })

  it.each([
    ['four emoji', 'short_emoji', '😀😀😀😀'],
    ['seven Unicode code points', 'short_unicode', 'абвгдеж'],
  ])(
    'rejects %s as a short password during registration and login',
    async (_name, username, password) => {
      await expect(register({ username, password })).rejects.toMatchObject({
        status: 422,
        code: 'validation_error',
      })
      await expect(login({ username, password })).rejects.toMatchObject({
        status: 422,
        code: 'validation_error',
      })
    },
  )

  it.each([
    ['eight Unicode code points', 'unicode_8', '😀😀😀😀😀😀😀😀'],
    ['eight ASCII characters', 'ascii_8', '12345678'],
  ])('accepts %s as the password length boundary', async (_name, username, password) => {
    await expect(register({ username, password })).resolves.toMatchObject({ username })
    await expect(login({ username, password })).resolves.toMatchObject({ token_type: 'Bearer' })
  })

  it('throws an ApiError for failed requests', async () => {
    await expect(
      login({
        username: 'unknown_user',
        password: 'wrong-password',
      }),
    ).rejects.toBeInstanceOf(ApiError)
  })

  // Registration не должна возвращать password или автоматически создавать login session.
  it('registers a new user without exposing the password', async () => {
    const user = await register({
      username: 'Dima_26',
      password: '12345678',
    })

    expect(user).toEqual({
      id: expect.any(String),
      username: 'Dima_26',
      created_at: expect.any(String),
    })

    expect(user).not.toHaveProperty('password')
    expect(user).not.toHaveProperty('access_token')
  })

  it('returns 409 when username already exists regardless of case', async () => {
    await expect(
      register({
        username: 'ALICE_1',
        password: '12345678',
      }),
    ).rejects.toMatchObject({
      status: 409,
      code: 'conflict',
    })
  })

  it('returns 422 for invalid registration data', async () => {
    await expect(
      register({
        username: 'ab',
        password: '123',
      }),
    ).rejects.toMatchObject({
      status: 422,
      code: 'validation_error',
    })
  })

  it('allows login after successful registration', async () => {
    await register({
      username: 'Dima_26',
      password: '12345678',
    })

    const response = await login({
      username: 'dima_26',
      password: '12345678',
    })

    expect(response).toMatchObject({
      token_type: 'Bearer',
      expires_in: 900,
    })

    expect(response.access_token).toEqual(expect.any(String))
  })

  // `/me` связывает `sub` JWT с актуальной записью пользователя и выдаёт только public profile.
  it('returns the current user for a valid access token', async () => {
    const { access_token } = await login({
      username: 'alice_1',
      password: 'correct-horse-battery',
    })

    const user = await getMe(access_token)

    expect(user).toMatchObject({
      id: '00000000-0000-4000-8000-000000000001',
      username: 'alice_1',
    })

    expect(user).not.toHaveProperty('password')
  })

  it('returns 401 for an invalid access token', async () => {
    await expect(getMe('invalid-token')).rejects.toMatchObject({
      status: 401,
      code: 'unauthorized',
    })
  })

  it.each([
    ['exp', { expiresAt: null }],
    ['iat', { includeIssuedAt: false }],
    ['exp and iat', { includeIssuedAt: false, expiresAt: null }],
  ])('returns 401 for a signed JWT without %s claims', async (_name, options) => {
    await expect(getMe(await createTestAccessToken(options))).rejects.toMatchObject({
      status: 401,
      code: 'unauthorized',
    })
  })

  it('returns 401 for an expired signed JWT', async () => {
    const expiresAt = Math.floor(Date.now() / 1000) - 1

    await expect(getMe(await createTestAccessToken({ expiresAt }))).rejects.toMatchObject({
      status: 401,
      code: 'unauthorized',
    })
  })

  it('returns 401 when Authorization header is missing', async () => {
    await expect(apiRequest('/me')).rejects.toMatchObject({
      status: 401,
      code: 'unauthorized',
    })
  })

  // Refresh rotation одноразово потребляет старый token и выпускает новую session cookie.
  it('rejects a reused refresh token', async () => {
    const refreshToken = createRefreshSession('00000000-0000-4000-8000-000000000001')

    const options: RequestInit = {
      method: 'POST',
      headers: {
        Cookie: `refresh_token=${refreshToken}`,
      },
    }

    const firstResponse = await fetch('/auth/refresh', options)

    expect(firstResponse.status).toBe(200)

    const secondResponse = await fetch('/auth/refresh', options)

    expect(secondResponse.status).toBe(401)

    const error = await secondResponse.json()

    expect(error).toEqual({
      code: 'unauthorized',
      message: 'Invalid or expired refresh token',
    })
  })

  it('refreshes an access token and rotates the refresh token', async () => {
    const refreshToken = createRefreshSession('00000000-0000-4000-8000-000000000001')

    const response = await fetch('/auth/refresh', {
      method: 'POST',
      headers: {
        Cookie: `refresh_token=${refreshToken}`,
      },
    })

    expect(response.status).toBe(200)

    const body = await response.json()

    expect(body.token_type).toBe('Bearer')
    expect(body.expires_in).toBe(900)
    expect(body.access_token).toEqual(expect.any(String))

    const newCookie = response.headers.get('set-cookie')

    expect(newCookie).toContain('refresh_token=')
    expect(newCookie).toContain('HttpOnly')
    expect(newCookie).toContain('Secure')
    expect(newCookie).toContain('SameSite=Lax')
  })

  it('issues a new usable refresh token after rotation', async () => {
    const oldToken = createRefreshSession('00000000-0000-4000-8000-000000000001')

    const firstResponse = await fetch('/auth/refresh', {
      method: 'POST',
      headers: {
        Cookie: `refresh_token=${oldToken}`,
      },
    })

    expect(firstResponse.status).toBe(200)

    const setCookie = firstResponse.headers.get('set-cookie')

    expect(setCookie).not.toBeNull()

    const newToken = setCookie?.match(/refresh_token=([^;]+)/)?.[1]

    expect(newToken).toEqual(expect.any(String))
    expect(newToken).not.toBe(oldToken)

    const secondResponse = await fetch('/auth/refresh', {
      method: 'POST',
      headers: {
        Cookie: `refresh_token=${newToken}`,
      },
    })

    expect(secondResponse.status).toBe(200)
  })

  it('returns 401 when refresh cookie is missing', async () => {
    const response = await fetch('/auth/refresh', {
      method: 'POST',
    })

    expect(response.status).toBe(401)

    const error = await response.json()

    expect(error).toEqual({
      code: 'unauthorized',
      message: 'Refresh token is required',
    })
  })

  // Logout одновременно отзывает серверную session и очищает HttpOnly cookie в ответе.
  it('logs out and clears the refresh cookie', async () => {
    const refreshToken = createRefreshSession('00000000-0000-4000-8000-000000000001')

    const response = await fetch('/auth/logout', {
      method: 'POST',
      headers: {
        Cookie: `refresh_token=${refreshToken}`,
      },
    })

    expect(response.status).toBe(204)

    const body = await response.text()
    expect(body).toBe('')

    const setCookie = response.headers.get('set-cookie')

    expect(setCookie).toContain('refresh_token=')
    expect(setCookie).toContain('Max-Age=0')
    expect(setCookie).toContain('HttpOnly')
    expect(setCookie).toContain('Secure')
    expect(setCookie).toContain('SameSite=Lax')
  })

  it('revokes the refresh session after logout', async () => {
    const refreshToken = createRefreshSession('00000000-0000-4000-8000-000000000001')

    const options: RequestInit = {
      method: 'POST',
      headers: {
        Cookie: `refresh_token=${refreshToken}`,
      },
    }

    const logoutResponse = await fetch('/auth/logout', options)

    expect(logoutResponse.status).toBe(204)

    const refreshResponse = await fetch('/auth/refresh', options)

    expect(refreshResponse.status).toBe(401)

    const error = await refreshResponse.json()

    expect(error).toEqual({
      code: 'unauthorized',
      message: 'Invalid or expired refresh token',
    })
  })

  it('returns 401 when logout cookie is missing', async () => {
    const response = await fetch('/auth/logout', {
      method: 'POST',
    })

    expect(response.status).toBe(401)

    const error = await response.json()

    expect(error).toEqual({
      code: 'unauthorized',
      message: 'Invalid or missing refresh token',
    })
  })

  it('keeps login, refresh rotation, and logout in one valid session chain', async () => {
    const loginResponse = await fetch('/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'alice_1',
        password: 'correct-horse-battery',
      }),
    })
    const initialRefreshToken = getRefreshTokenFromResponse(loginResponse)

    const refreshResponse = await fetch('/auth/refresh', {
      method: 'POST',
      headers: { Cookie: `refresh_token=${initialRefreshToken}` },
    })
    const rotatedRefreshToken = getRefreshTokenFromResponse(refreshResponse)

    expect(loginResponse.status).toBe(200)
    expect(refreshResponse.status).toBe(200)
    expect(rotatedRefreshToken).not.toBe(initialRefreshToken)

    const logoutResponse = await fetch('/auth/logout', {
      method: 'POST',
      headers: { Cookie: `refresh_token=${rotatedRefreshToken}` },
    })

    expect(logoutResponse.status).toBe(204)
    expect(await logoutResponse.text()).toBe('')

    const revokedResponse = await fetch('/auth/refresh', {
      method: 'POST',
      headers: { Cookie: `refresh_token=${rotatedRefreshToken}` },
    })

    expect(revokedResponse.status).toBe(401)
  })

  // Временные MSW handlers изолированно проверяют thin client для ответов без cookie-эмуляции jsdom.
  it('requests a new access token using the refresh endpoint', async () => {
    server.use(
      http.post('/auth/refresh', () => {
        return HttpResponse.json({
          token_type: 'Bearer',
          access_token: 'mock-new-access-token',
          expires_in: 900,
        })
      }),
    )

    const result = await refresh()

    expect(result).toEqual({
      token_type: 'Bearer',
      access_token: 'mock-new-access-token',
      expires_in: 900,
    })
  })

  it('handles a successful logout without response body', async () => {
    server.use(
      http.post('/auth/logout', () => {
        return new HttpResponse(null, { status: 204 })
      }),
    )

    const result = await logout()

    expect(result).toBeUndefined()
  })

  // User search проверяет case-insensitive prefix, ограничения формата и максимум 20 результатов.
  it('searches users by prefix regardless of case', async () => {
    const { access_token } = await login({
      username: 'alice_1',
      password: 'correct-horse-battery',
    })

    const result = await searchUsers('ALI', access_token)

    expect(result).toEqual({
      users: [
        {
          id: '00000000-0000-4000-8000-000000000001',
          username: 'alice_1',
        },
      ],
    })
  })

  it('returns 401 when searching without a valid access token', async () => {
    await expect(searchUsers('ali', 'invalid-token')).rejects.toMatchObject({
      status: 401,
      code: 'unauthorized',
    })
  })

  it('returns 422 for an invalid search prefix', async () => {
    const { access_token } = await login({
      username: 'alice_1',
      password: 'correct-horse-battery',
    })

    await expect(searchUsers('invalid prefix!', access_token)).rejects.toMatchObject({
      status: 422,
      code: 'validation_error',
    })
  })

  it('returns an empty array when no users match the prefix', async () => {
    const { access_token } = await login({
      username: 'alice_1',
      password: 'correct-horse-battery',
    })

    const result = await searchUsers('nonexistent', access_token)

    expect(result).toEqual({
      users: [],
    })
  })

  it('returns no more than 20 matching users', async () => {
    for (let index = 0; index < 25; index++) {
      await register({
        username: `testuser_${index}`,
        password: '12345678',
      })
    }

    const { access_token } = await login({
      username: 'alice_1',
      password: 'correct-horse-battery',
    })

    const result = await searchUsers('testuser_', access_token)

    expect(result.users).toHaveLength(20)

    expect(result.users.every((user) => user.username.startsWith('testuser_'))).toBe(true)
  })

  // Contact API проверяет изолированный список владельца и идемпотентное добавление.
  it('returns an empty contacts list for a new user', async () => {
    const { access_token } = await login({
      username: 'alice_1',
      password: 'correct-horse-battery',
    })

    const result = await getContacts(access_token)

    expect(result).toEqual({
      contacts: [],
    })
  })

  it('returns 401 when requesting contacts with an invalid token', async () => {
    await expect(getContacts('invalid-token')).rejects.toMatchObject({
      status: 401,
      code: 'unauthorized',
    })
  })

  it('adds a user to contacts', async () => {
    const bob = await register({
      username: 'bob_1',
      password: 'test-password',
    })

    const { access_token } = await login({
      username: 'alice_1',
      password: 'correct-horse-battery',
    })

    await addContact(bob.id, access_token)

    const result = await getContacts(access_token)

    expect(result.contacts).toEqual([
      {
        id: bob.id,
        username: bob.username,
      },
    ])
  })

  it('does not duplicate a contact when added twice', async () => {
    const bob = await register({
      username: 'bob_1',
      password: 'test-password',
    })

    const { access_token } = await login({
      username: 'alice_1',
      password: 'correct-horse-battery',
    })

    await addContact(bob.id, access_token)
    await addContact(bob.id, access_token)

    const result = await getContacts(access_token)

    expect(result.contacts).toHaveLength(1)
  })

  it('returns 404 when adding a nonexistent user', async () => {
    const { access_token } = await login({
      username: 'alice_1',
      password: 'correct-horse-battery',
    })

    await expect(
      addContact('00000000-0000-4000-8000-000000000099', access_token),
    ).rejects.toMatchObject({
      status: 404,
      code: 'not_found',
    })
  })

  it('returns 422 when adding a contact with an invalid UUID', async () => {
    const { access_token } = await login({
      username: 'alice_1',
      password: 'correct-horse-battery',
    })

    await expect(addContact('invalid-id', access_token)).rejects.toMatchObject({
      status: 422,
      code: 'validation_error',
    })
  })
})

// Дополнительные свойства отклоняются из-за `additionalProperties: false` в OpenAPI.
it('rejects additional login properties per OpenAPI', async () => {
  const response = await fetch('/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'alice_1', password: 'correct-horse-battery', extra: true }),
  })
  expect(response.status).toBe(422)
})
