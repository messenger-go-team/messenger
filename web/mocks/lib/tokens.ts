import { SignJWT, jwtVerify } from 'jose'

const MOCK_JWT_SECRET = 'messenger-mock-jwt-secret-for-development-only'
const ACCESS_TOKEN_TTL = '15m'

async function getMockJwtKey(): Promise<CryptoKey> {
  const secret = new TextEncoder().encode(MOCK_JWT_SECRET)

  return crypto.subtle.importKey('raw', secret, { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
    'verify',
  ])
}

export async function createAccessToken(userId: string): Promise<string> {
  const key = await getMockJwtKey()

  return new SignJWT({})
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime(ACCESS_TOKEN_TTL)
    .sign(key)
}

export async function verifyAccessToken(token: string): Promise<string | null> {
  try {
    const key = await getMockJwtKey()

    const { payload } = await jwtVerify(token, key, {
      algorithms: ['HS256'],
    })

    return typeof payload.sub === 'string' ? payload.sub : null
  } catch {
    return null
  }
}
