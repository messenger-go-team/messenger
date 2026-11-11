import { SignJWT, jwtVerify } from 'jose'

const MOCK_JWT_SECRET = 'messenger-mock-jwt-secret-for-development-only'
const ACCESS_TOKEN_TTL = '15m'

/** Импортирует публичный mock secret как Web Crypto key для HS256. */
async function getMockJwtKey(): Promise<CryptoKey> {
  const secret = new TextEncoder().encode(MOCK_JWT_SECRET)

  return crypto.subtle.importKey('raw', secret, { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
    'verify',
  ])
}

/** Создаёт подписанный access JWT с `sub` пользователя и сроком действия 15 минут. */
export async function createAccessToken(userId: string): Promise<string> {
  const key = await getMockJwtKey()

  return new SignJWT({})
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime(ACCESS_TOKEN_TTL)
    .sign(key)
}

/**
 * Проверяет подпись, алгоритм и стандартные временные claims JWT.
 * Любая ошибка верификации скрывается за `null`, чтобы handlers формировали единый ответ 401.
 */
export async function verifyAccessToken(token: string): Promise<string | null> {
  try {
    const key = await getMockJwtKey()

    const { payload } = await jwtVerify(token, key, {
      algorithms: ['HS256'],
      requiredClaims: ['sub', 'iat', 'exp'],
      maxTokenAge: ACCESS_TOKEN_TTL,
    })

    return typeof payload.sub === 'string' ? payload.sub : null
  } catch {
    return null
  }
}
