import { http, HttpResponse } from 'msw'
import {
  addUser,
  findUserByUsername,
  findUserById,
  createRefreshSession,
  consumeRefreshSession,
  revokeRefreshSession,
  searchUsersByPrefix,
  listContacts,
  addContact,
  removeContact,
} from '../data/auth'
import { resolveRefreshToken } from '../lib/cookies'
import { createAccessToken, verifyAccessToken } from '../lib/tokens'

const MIN_PASSWORD_LENGTH = 8

/** Проверяет OpenAPI `minLength` в Unicode code points, а не в UTF-16 code units. */
function isValidPassword(password: unknown): password is string {
  return typeof password === 'string' && Array.from(password).length >= MIN_PASSWORD_LENGTH
}

/**
 * MSW handlers для Auth, поиска пользователей и контактов.
 * Они повторяют HTTP-контракт, а mutable state и операции над ним находятся в `mocks/data/auth`.
 */
export const authHandlers = [
  // Регистрация валидирует exact object, чтобы дополнительные поля не расходились с OpenAPI.
  http.post('/auth/register', async ({ request }) => {
    let body: unknown

    try {
      body = await request.json()
    } catch {
      return HttpResponse.json(
        { code: 'validation_error', message: 'Invalid JSON body' },
        { status: 422 },
      )
    }

    if (
      typeof body !== 'object' ||
      body === null ||
      Array.isArray(body) ||
      Object.keys(body).some((key) => key !== 'username' && key !== 'password') ||
      !('username' in body) ||
      typeof body.username !== 'string' ||
      !/^[A-Za-z0-9_]{3,32}$/.test(body.username) ||
      !('password' in body) ||
      !isValidPassword(body.password)
    ) {
      return HttpResponse.json(
        { code: 'validation_error', message: 'Invalid registration data' },
        { status: 422 },
      )
    }

    if (findUserByUsername(body.username)) {
      return HttpResponse.json(
        { code: 'conflict', message: 'Username already exists' },
        { status: 409 },
      )
    }

    const user = {
      id: crypto.randomUUID(),
      username: body.username,
      password: body.password,
      created_at: new Date().toISOString(),
    }

    addUser(user)

    return HttpResponse.json(
      {
        id: user.id,
        username: user.username,
        created_at: user.created_at,
      },
      { status: 201 },
    )
  }),

  // Login выдаёт короткоживущий JWT, а refresh token оставляет в защищённой cookie.
  http.post('/auth/login', async ({ request }) => {
    let body: unknown

    try {
      body = await request.json()
    } catch {
      return HttpResponse.json(
        {
          code: 'validation_error',
          message: 'Invalid JSON body',
        },
        { status: 422 },
      )
    }

    if (
      typeof body !== 'object' ||
      body === null ||
      Array.isArray(body) ||
      Object.keys(body).some((key) => key !== 'username' && key !== 'password') ||
      !('username' in body) ||
      typeof body.username !== 'string' ||
      !/^[A-Za-z0-9_]{3,32}$/.test(body.username) ||
      !('password' in body) ||
      !isValidPassword(body.password)
    ) {
      return HttpResponse.json(
        {
          code: 'validation_error',
          message: 'Invalid username or password format',
        },
        { status: 422 },
      )
    }

    const user = findUserByUsername(body.username)

    if (!user || user.password !== body.password) {
      return HttpResponse.json(
        {
          code: 'unauthorized',
          message: 'Invalid credentials',
        },
        { status: 401 },
      )
    }

    const accessToken = await createAccessToken(user.id)
    const refreshToken = createRefreshSession(user.id)

    return HttpResponse.json(
      {
        token_type: 'Bearer',
        access_token: accessToken,
        expires_in: 900,
      },
      {
        status: 200,
        headers: {
          'Set-Cookie': `refresh_token=${refreshToken}; Max-Age=2592000; Path=/auth; HttpOnly; Secure; SameSite=Lax`,
        },
      },
    )
  }),

  // Refresh-сессия одноразовая: consume удаляет старую запись до выпуска новой пары token.
  http.post('/auth/refresh', async ({ request, cookies }) => {
    const refreshToken = resolveRefreshToken(cookies, request.headers.get('cookie'))

    if (!refreshToken) {
      return HttpResponse.json(
        {
          code: 'unauthorized',
          message: 'Refresh token is required',
        },
        { status: 401 },
      )
    }

    const userId = consumeRefreshSession(refreshToken)

    if (!userId) {
      return HttpResponse.json(
        {
          code: 'unauthorized',
          message: 'Invalid or expired refresh token',
        },
        { status: 401 },
      )
    }

    const user = findUserById(userId)

    if (!user) {
      return HttpResponse.json(
        {
          code: 'unauthorized',
          message: 'User not found',
        },
        { status: 401 },
      )
    }

    const accessToken = await createAccessToken(user.id)
    const newRefreshToken = createRefreshSession(user.id)

    return HttpResponse.json(
      {
        token_type: 'Bearer',
        access_token: accessToken,
        expires_in: 900,
      },
      {
        status: 200,
        headers: {
          'Set-Cookie': `refresh_token=${newRefreshToken}; Max-Age=2592000; Path=/auth; HttpOnly; Secure; SameSite=Lax`,
        },
      },
    )
  }),

  http.post('/auth/logout', ({ request, cookies }) => {
    const refreshToken = resolveRefreshToken(cookies, request.headers.get('cookie'))

    if (!refreshToken || !revokeRefreshSession(refreshToken)) {
      return HttpResponse.json(
        {
          code: 'unauthorized',
          message: 'Invalid or missing refresh token',
        },
        { status: 401 },
      )
    }

    return new HttpResponse(null, {
      status: 204,
      headers: {
        'Set-Cookie': 'refresh_token=; Max-Age=0; Path=/auth; HttpOnly; Secure; SameSite=Lax',
      },
    })
  }),

  // `/me` дополнительно проверяет, что `sub` JWT всё ещё существует в mock user store.
  http.get('/me', async ({ request }) => {
    const authorization = request.headers.get('Authorization')

    if (!authorization?.startsWith('Bearer ')) {
      return HttpResponse.json(
        {
          code: 'unauthorized',
          message: 'Authorization token is required',
        },
        { status: 401 },
      )
    }

    const token = authorization.slice('Bearer '.length)
    const userId = await verifyAccessToken(token)

    if (!userId) {
      return HttpResponse.json(
        {
          code: 'unauthorized',
          message: 'Invalid or expired access token',
        },
        { status: 401 },
      )
    }

    const user = findUserById(userId)

    if (!user) {
      return HttpResponse.json(
        {
          code: 'unauthorized',
          message: 'User not found',
        },
        { status: 401 },
      )
    }

    return HttpResponse.json(
      {
        id: user.id,
        username: user.username,
        created_at: user.created_at,
      },
      { status: 200 },
    )
  }),

  http.get('/users/search', async ({ request }) => {
    const authorization = request.headers.get('authorization')

    if (!authorization?.startsWith('Bearer ')) {
      return HttpResponse.json(
        {
          code: 'unauthorized',
          message: 'Missing or invalid access token',
        },
        { status: 401 },
      )
    }

    const token = authorization.slice('Bearer '.length)
    const userId = await verifyAccessToken(token)

    if (!userId || !findUserById(userId)) {
      return HttpResponse.json(
        {
          code: 'unauthorized',
          message: 'Missing or invalid access token',
        },
        { status: 401 },
      )
    }

    const url = new URL(request.url)
    const prefix = url.searchParams.get('prefix')

    if (!prefix || !/^[A-Za-z0-9_]{1,32}$/.test(prefix)) {
      return HttpResponse.json(
        {
          code: 'validation_error',
          message: 'Invalid search prefix',
        },
        { status: 422 },
      )
    }

    return HttpResponse.json({
      users: searchUsersByPrefix(prefix),
    })
  }),

  http.get('/contacts', async ({ request }) => {
    const authorization = request.headers.get('authorization')

    if (!authorization?.startsWith('Bearer ')) {
      return HttpResponse.json(
        {
          code: 'unauthorized',
          message: 'Missing or invalid access token',
        },
        { status: 401 },
      )
    }

    const token = authorization.slice('Bearer '.length)
    const userId = await verifyAccessToken(token)

    if (!userId || !findUserById(userId)) {
      return HttpResponse.json(
        {
          code: 'unauthorized',
          message: 'Missing or invalid access token',
        },
        { status: 401 },
      )
    }

    return HttpResponse.json({
      contacts: listContacts(userId),
    })
  }),

  http.put('/contacts/:contactId', async ({ request, params }) => {
    const authorization = request.headers.get('authorization')

    if (!authorization?.startsWith('Bearer ')) {
      return HttpResponse.json(
        {
          code: 'unauthorized',
          message: 'Missing or invalid access token',
        },
        { status: 401 },
      )
    }

    const token = authorization.slice('Bearer '.length)
    const userId = await verifyAccessToken(token)

    if (!userId || !findUserById(userId)) {
      return HttpResponse.json(
        {
          code: 'unauthorized',
          message: 'Missing or invalid access token',
        },
        { status: 401 },
      )
    }

    const contactId = params.contactId

    if (
      typeof contactId !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(contactId)
    ) {
      return HttpResponse.json(
        {
          code: 'validation_error',
          message: 'Invalid contact ID',
        },
        { status: 422 },
      )
    }

    if (!findUserById(contactId)) {
      return HttpResponse.json(
        {
          code: 'not_found',
          message: 'Contact user not found',
        },
        { status: 404 },
      )
    }

    // Владельцем набора всегда является пользователь из JWT, а не параметр запроса.
    addContact(userId, contactId)

    return new HttpResponse(null, { status: 204 })
  }),
  http.delete('/contacts/:contactId', async ({ request, params }) => {
    const authorization = request.headers.get('authorization')

    if (!authorization?.startsWith('Bearer ')) {
      return HttpResponse.json(
        {
          code: 'unauthorized',
          message: 'Missing or invalid access token',
        },
        { status: 401 },
      )
    }

    const token = authorization.slice('Bearer '.length)
    const userId = await verifyAccessToken(token)

    if (!userId || !findUserById(userId)) {
      return HttpResponse.json(
        {
          code: 'unauthorized',
          message: 'Missing or invalid access token',
        },
        { status: 401 },
      )
    }

    const contactId = params.contactId

    if (
      typeof contactId !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(contactId)
    ) {
      return HttpResponse.json(
        {
          code: 'validation_error',
          message: 'Invalid contact ID',
        },
        { status: 422 },
      )
    }

    // Удаление отсутствующей записи остаётся идемпотентным и возвращает тот же 204.
    removeContact(userId, contactId)

    return new HttpResponse(null, { status: 204 })
  }),
]
