import { http, HttpResponse } from 'msw'
import { findUserById } from '../data/auth'
import {
  createOrGetPersonalChat,
  findHistoryChat,
  getHistoryMessagePage,
  isChatMember,
  listHistoryChats,
  markHistoryChatRead,
} from '../data/history'
import { authenticateAccessToken } from '../lib/authentication'
import { normalizeUuid, parseIntegerParameter } from '../lib/validation'

const MAX_SAFE_SEQ = Number.MAX_SAFE_INTEGER

/** Формирует единый контрактный ответ для отсутствующего или недействительного JWT. */
function unauthorized() {
  return HttpResponse.json(
    { code: 'unauthorized', message: 'A valid access token is required' },
    { status: 401 },
  )
}

/** Формирует OpenAPI-совместимую ошибку 422 с настраиваемым машинным кодом. */
function validationError(message: string, code = 'validation_error') {
  return HttpResponse.json({ code, message }, { status: 422 })
}

/** Формирует ошибку отсутствующего пользователя или чата. */
function notFound(message: string) {
  return HttpResponse.json({ code: 'not_found', message }, { status: 404 })
}

/** Не раскрывает историю существующего чата пользователю без membership. */
function forbidden() {
  return HttpResponse.json(
    { code: 'chat_membership_required', message: 'Chat membership is required' },
    { status: 403 },
  )
}

/** Отклоняет неоднозначные query-параметры вместо неявного выбора первого значения. */
function hasDuplicateParameter(url: URL, name: string): boolean {
  return url.searchParams.getAll(name).length > 1
}

/**
 * History handlers связывают HTTP-валидацию и авторизацию с in-memory data layer.
 * ID владельца и membership всегда выводятся из проверенного JWT и серверного state.
 */
export const historyHandlers = [
  http.post('/chats/personal', async ({ request }) => {
    const currentUserId = await authenticateAccessToken(request)

    if (!currentUserId) {
      return unauthorized()
    }

    let body: unknown

    try {
      body = await request.json()
    } catch {
      return validationError('Invalid JSON body')
    }

    if (
      typeof body !== 'object' ||
      body === null ||
      Array.isArray(body) ||
      Object.keys(body).some((key) => key !== 'user_id') ||
      !('user_id' in body)
    ) {
      return validationError('Invalid personal chat request')
    }

    const otherUserId = normalizeUuid(body.user_id)

    if (!otherUserId) {
      return validationError('Invalid personal chat request')
    }

    if (otherUserId === currentUserId) {
      return validationError('A personal chat requires another user')
    }

    if (!findUserById(otherUserId)) {
      return notFound('User not found')
    }

    // Data layer гарантирует единственный personal chat для неупорядоченной пары пользователей.
    const result = createOrGetPersonalChat(currentUserId, otherUserId)

    return HttpResponse.json(result.chat, { status: result.created ? 201 : 200 })
  }),

  http.get('/chats', async ({ request }) => {
    const currentUserId = await authenticateAccessToken(request)

    if (!currentUserId) {
      return unauthorized()
    }

    return HttpResponse.json({ chats: listHistoryChats(currentUserId) })
  }),

  http.get('/chats/:chatId/messages', async ({ request, params }) => {
    const currentUserId = await authenticateAccessToken(request)

    if (!currentUserId) {
      return unauthorized()
    }

    const chatId = normalizeUuid(params.chatId)

    if (!chatId) {
      return validationError('Invalid chat ID')
    }

    const url = new URL(request.url)

    // Повторяющиеся значения нельзя безопасно интерпретировать как один cursor или limit.
    if (
      hasDuplicateParameter(url, 'before_seq') ||
      hasDuplicateParameter(url, 'after_seq') ||
      hasDuplicateParameter(url, 'limit')
    ) {
      return validationError('Pagination parameters must not be repeated', 'invalid_pagination')
    }

    const beforeRaw = url.searchParams.get('before_seq')
    const afterRaw = url.searchParams.get('after_seq')
    const limitRaw = url.searchParams.get('limit')

    // Cursor направления взаимоисключающие: одновременно двигаться назад и вперёд нельзя.
    if (beforeRaw !== null && afterRaw !== null) {
      return validationError(
        'Only one of before_seq and after_seq may be provided',
        'invalid_pagination',
      )
    }

    const beforeSeq =
      beforeRaw === null ? undefined : parseIntegerParameter(beforeRaw, 1, MAX_SAFE_SEQ)
    const afterSeq =
      afterRaw === null ? undefined : parseIntegerParameter(afterRaw, 0, MAX_SAFE_SEQ)
    const limit = limitRaw === null ? 50 : parseIntegerParameter(limitRaw, 1, 100)

    if (beforeSeq === null || afterSeq === null || limit === null) {
      return validationError('Invalid pagination parameters', 'invalid_pagination')
    }

    if (!findHistoryChat(chatId)) {
      return notFound('Chat not found')
    }

    // Существование проверяется раньше membership, чтобы сохранить согласованную матрицу 404/403.
    if (!isChatMember(chatId, currentUserId)) {
      return forbidden()
    }

    return HttpResponse.json(
      getHistoryMessagePage(chatId, {
        beforeSeq,
        afterSeq,
        limit,
      }),
    )
  }),

  http.post('/chats/:chatId/read', async ({ request, params }) => {
    const currentUserId = await authenticateAccessToken(request)

    if (!currentUserId) {
      return unauthorized()
    }

    const chatId = normalizeUuid(params.chatId)

    if (!chatId) {
      return validationError('Invalid chat ID')
    }

    let body: unknown

    try {
      body = await request.json()
    } catch {
      return validationError('Invalid JSON body')
    }

    if (
      typeof body !== 'object' ||
      body === null ||
      Array.isArray(body) ||
      Object.keys(body).some((key) => key !== 'seq') ||
      !('seq' in body) ||
      typeof body.seq !== 'number' ||
      !Number.isSafeInteger(body.seq) ||
      body.seq < 0 ||
      body.seq > MAX_SAFE_SEQ
    ) {
      return validationError('Invalid read sequence')
    }

    const chat = findHistoryChat(chatId)

    if (!chat) {
      return notFound('Chat not found')
    }

    if (!isChatMember(chatId, currentUserId)) {
      return forbidden()
    }

    if (body.seq > chat.last_seq) {
      return validationError('Read sequence exceeds chat last_seq')
    }

    // Data layer применяет max(current, seq), поэтому повторные и запоздавшие вызовы безопасны.
    markHistoryChatRead(chatId, currentUserId, body.seq)

    return new HttpResponse(null, { status: 204 })
  }),
]
