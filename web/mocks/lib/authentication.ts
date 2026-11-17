import { verifyAccessToken } from './tokens'

/**
 * Извлекает Bearer JWT и проверяет подпись, claims и срок по общим правилам History.
 * Существование пользователя в Auth проверяет только операция, которой нужен lookup.
 * Возвращает ID аутентифицированного пользователя; handler преобразует `null` в HTTP 401.
 */
export async function authenticateAccessToken(request: Request): Promise<string | null> {
  const authorization = request.headers.get('authorization')

  if (!authorization?.startsWith('Bearer ')) {
    return null
  }

  return verifyAccessToken(authorization.slice('Bearer '.length))
}
