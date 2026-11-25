import { describe, expect, it } from 'vitest'
import { appBasename, assertBuildProfile, resolveAppBase } from '@/app/basename'

describe('appBasename', () => {
  it('maps Vite /app/ base to React Router basename /app', () => {
    expect(appBasename('/app/')).toBe('/app')
    expect(appBasename('/app')).toBe('/app')
  })

  it('maps root base to empty basename for local MSW', () => {
    expect(appBasename('/')).toBe('')
    expect(appBasename('')).toBe('')
  })
})

describe('resolveAppBase', () => {
  it('uses /app/ for a production build without an explicit base', () => {
    expect(resolveAppBase('production', { VITE_API_MOCK: 'false' })).toBe('/app/')
  })

  it('uses / for local mocks when base is not set', () => {
    expect(resolveAppBase('development', { VITE_API_MOCK: 'true' })).toBe('/')
  })

  it('keeps an explicit base for a real-API build', () => {
    expect(resolveAppBase('production', { VITE_API_MOCK: 'false', VITE_APP_BASE: '/trial/' })).toBe(
      '/trial/',
    )
  })

  it('rejects mocks together with a non-root base', () => {
    expect(() =>
      resolveAppBase('development', { VITE_API_MOCK: 'true', VITE_APP_BASE: '/app/' }),
    ).toThrow(/mockServiceWorker\.js/)
  })
})

describe('assertBuildProfile', () => {
  it('accepts staging with same-origin REST and WebSocket and mocks disabled', () => {
    expect(() =>
      assertBuildProfile('staging', '/app/', {
        VITE_API_MOCK: 'false',
        VITE_API_BASE_URL: '',
        VITE_WS_ORIGIN: '',
      }),
    ).not.toThrow()
  })

  it('rejects an alternate staging base path', () => {
    expect(() => assertBuildProfile('staging', '/trial/', { VITE_API_MOCK: 'false' })).toThrow(
      /VITE_APP_BASE/,
    )
  })

  it.each([
    ['VITE_API_MOCK', 'true'],
    ['VITE_API_MOCK', ''],
    ['VITE_API_BASE_URL', 'http://localhost:8080'],
    ['VITE_WS_ORIGIN', 'ws://localhost:8080'],
  ])('rejects an incompatible staging value for %s', (key, value) => {
    expect(() =>
      assertBuildProfile('staging', '/app/', { VITE_API_MOCK: 'false', [key]: value }),
    ).toThrow(key)
  })

  it('rejects MSW even with a root base in a regular production build', () => {
    expect(() => assertBuildProfile('production', '/', { VITE_API_MOCK: 'true' })).toThrow(
      /VITE_API_MOCK/,
    )
  })

  it('allows a real-API production build with a custom base and origins', () => {
    expect(() =>
      assertBuildProfile('production', '/trial/', {
        VITE_API_MOCK: 'false',
        VITE_API_BASE_URL: 'http://localhost:8080',
        VITE_WS_ORIGIN: 'ws://localhost:8080',
      }),
    ).not.toThrow()
  })
})
