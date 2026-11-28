import { describe, expect, it } from 'vitest'
import { formatChatListTime, formatReminderDueLabel } from '@/features/chats/formatChatListTime'

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

describe('formatReminderDueLabel', () => {
  it('formats same-day due as «Сегодня в HH:mm»', () => {
    const now = new Date('2026-11-24T12:00:00')
    expect(formatReminderDueLabel('2026-11-24T14:00:00', now)).toBe('Сегодня в 14:00')
  })

  it('formats other days as «dd.mm в HH:mm»', () => {
    const now = new Date('2026-11-24T12:00:00')
    expect(formatReminderDueLabel('2026-11-07T09:30:00', now)).toBe('07.11 в 09:30')
  })
})
