import { describe, expect, it } from 'vitest'
import { connectionStatusLabel } from './connectionStatus'

describe('connectionStatusLabel', () => {
  it('hides banner when connected', () => {
    expect(connectionStatusLabel('connected')).toBeNull()
  })

  it('explains reconnect and auth failure', () => {
    expect(connectionStatusLabel('reconnecting')).toMatch(/Переподключение/)
    expect(connectionStatusLabel('auth_failed')).toMatch(/Сессия/)
  })
})
