import { describe, expect, it } from 'vitest'
import { apiBaseUrl, isApiMockEnabled, wsOrigin } from '@/config/runtimeEnv'

describe('runtimeEnv', () => {
  it('enables MSW only for the exact string true', () => {
    expect(isApiMockEnabled({ VITE_API_MOCK: 'true' })).toBe(true)
    expect(isApiMockEnabled({ VITE_API_MOCK: 'false' })).toBe(false)
    expect(isApiMockEnabled({ VITE_API_MOCK: '' })).toBe(false)
    expect(isApiMockEnabled({})).toBe(false)
  })

  it('strips trailing slashes from API base URL', () => {
    expect(apiBaseUrl({ VITE_API_BASE_URL: 'https://staging.tidingm.ru/' })).toBe(
      'https://staging.tidingm.ru',
    )
    expect(apiBaseUrl({ VITE_API_BASE_URL: '' })).toBe('')
    expect(apiBaseUrl({})).toBe('')
  })

  it('uses VITE_WS_ORIGIN when set, otherwise page host', () => {
    expect(
      wsOrigin(
        { VITE_WS_ORIGIN: 'wss://staging.tidingm.ru/' },
        { protocol: 'http:', host: 'localhost:5173' },
      ),
    ).toBe('wss://staging.tidingm.ru')
    expect(wsOrigin({}, { protocol: 'https:', host: 'staging.tidingm.ru' })).toBe(
      'wss://staging.tidingm.ru',
    )
    expect(wsOrigin({}, { protocol: 'http:', host: 'localhost:5173' })).toBe('ws://localhost:5173')
  })
})
