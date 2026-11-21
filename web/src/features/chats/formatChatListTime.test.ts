import { describe, expect, it } from 'vitest'
import { formatChatListTime } from '@/features/chats/formatChatListTime'

describe('formatChatListTime', () => {
  it('formats same-day timestamps as HH:mm', () => {
    const now = new Date('2026-11-19T15:00:00')
    expect(formatChatListTime('2026-11-19T10:48:00', now)).toBe('10:48')
  })

  it('formats older days as dd.mm', () => {
    const now = new Date('2026-11-19T15:00:00')
    expect(formatChatListTime('2026-11-07T12:00:00', now)).toBe('07.11')
  })
})
