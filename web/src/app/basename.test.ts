import { describe, expect, it } from 'vitest'
import { appBasename, resolveAppBase } from '@/app/basename'

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
