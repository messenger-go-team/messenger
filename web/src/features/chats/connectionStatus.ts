import type { TransportState } from '@/ws'

/** Человекочитаемый статус соединения для баннера в окне чата. */
export function connectionStatusLabel(transport: TransportState): string | null {
  switch (transport) {
    case 'connected':
      return null
    case 'connecting':
      return 'Подключение…'
    case 'reconnecting':
      return 'Нет соединения. Переподключение…'
    case 'disconnected':
      return 'Соединение потеряно. Переподключение…'
    case 'auth_failed':
      return 'Сессия истекла. Войдите снова.'
    case 'stopped':
      return 'Соединение остановлено'
    case 'idle':
    default:
      return 'Подключение…'
  }
}
