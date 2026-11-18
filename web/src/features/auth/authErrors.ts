import { ApiError } from '@/api/client'

/** Вход или регистрация устарели, потому что следом начался logout или другой вход. */
export class AuthFlowCancelledError extends Error {
  constructor() {
    super('Auth flow cancelled')
    this.name = 'AuthFlowCancelledError'
  }
}

export function isAuthFlowCancelled(error: unknown): boolean {
  return error instanceof AuthFlowCancelledError
}

/** Понятный русский текст для UI по контрактным кодам Auth API. */
export function messageFromAuthError(error: unknown): string {
  if (error instanceof ApiError) {
    switch (error.code) {
      case 'invalid_credentials':
        return 'Неверный логин или пароль.'
      case 'username_taken':
        return 'Логин уже занят.'
      case 'validation_error':
        return error.message.trim() || 'Проверьте поля формы.'
      default:
        return error.message.trim() || 'Не удалось выполнить запрос. Попробуйте ещё раз.'
    }
  }

  return 'Не удалось выполнить запрос. Попробуйте ещё раз.'
}
