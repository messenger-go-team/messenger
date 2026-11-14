import { findUserById } from '../data/auth'
import { verifyAccessToken } from './tokens'

/**
 * Извлекает Bearer JWT, проверяет подпись/срок и существование `sub` в mock Auth store.
 * Возвращает ID аутентифицированного пользователя; handler преобразует `null` в HTTP 401.
 */
export async function authenticateAccessToken(request: Request): Promise<string | null> {
  const authorization = request.headers.get('authorization')

  if (!authorization?.startsWith('Bearer ')) {
    return null
  }

  const userId = await verifyAccessToken(authorization.slice('Bearer '.length))

  return userId && findUserById(userId) ? userId : null
}
