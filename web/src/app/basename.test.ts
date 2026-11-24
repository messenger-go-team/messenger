import { describe, expect, it } from 'vitest'
import { appBasename } from '@/app/basename'

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
