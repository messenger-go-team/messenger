import { ApiError } from '@/api/client'

/** Понятный русский текст для UI по контрактным кодам Auth API. */
export function messageFromAuthError(error: unknown): string {
  if (error instanceof ApiError) {
    switch (error.code) {
      case 'invalid_credentials':
        return 'Неверный username или пароль.'
      case 'username_taken':
        return 'Username уже занят.'
      case 'validation_error':
        return error.message.trim() || 'Проверьте поля формы.'
      default:
        return error.message.trim() || 'Не удалось выполнить запрос. Попробуйте ещё раз.'
    }
  }

  return 'Не удалось выполнить запрос. Попробуйте ещё раз.'
}
