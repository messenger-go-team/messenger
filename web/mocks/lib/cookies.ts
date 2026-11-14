/** Извлекает именованную cookie из сырого Cookie header, сохраняя `=` внутри значения. */
function getCookieFromHeader(cookieHeader: string | null, cookieName: string): string | null {
  if (!cookieHeader) {
    return null
  }

  for (const cookie of cookieHeader.split(';')) {
    const [name, ...value] = cookie.trim().split('=')

    if (name === cookieName) {
      return value.join('=') || null
    }
  }

  return null
}

/**
 * Возвращает refresh token из resolver context MSW с fallback на сырой Cookie header.
 * Browser MSW хранит HttpOnly cookie во внутреннем store и передаёт её только через `cookies`;
 * fallback сохраняет совместимость с Node-тестами, где cookie store отсутствует.
 */
export function resolveRefreshToken(
  cookies: Record<string, string>,
  cookieHeader: string | null,
): string | null {
  return cookies.refresh_token || getCookieFromHeader(cookieHeader, 'refresh_token')
}
