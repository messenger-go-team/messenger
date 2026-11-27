function parseValidDate(iso: string): Date | null {
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? null : date
}

function isSameCalendarDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  )
}

function formatClock(date: Date): string {
  return new Intl.DateTimeFormat('ru-RU', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date)
}

/** Время последнего сообщения для строки списка: сегодня HH:mm, иначе краткая дата. */
export function formatChatListTime(iso: string, now = new Date()): string {
  const date = parseValidDate(iso)
  if (!date) return ''

  if (isSameCalendarDay(date, now)) {
    return formatClock(date)
  }

  return new Intl.DateTimeFormat('ru-RU', {
    day: '2-digit',
    month: '2-digit',
  }).format(date)
}

/**
 * Подпись срока в toast «Напоминание» (Figma 426:22631): «Сегодня в 14:00»,
 * иначе «dd.mm в HH:mm».
 */
export function formatReminderDueLabel(iso: string, now = new Date()): string {
  const date = parseValidDate(iso)
  if (!date) return ''

  const time = formatClock(date)
  if (isSameCalendarDay(date, now)) {
    return `Сегодня в ${time}`
  }

  const day = new Intl.DateTimeFormat('ru-RU', {
    day: '2-digit',
    month: '2-digit',
  }).format(date)
  return `${day} в ${time}`
}
