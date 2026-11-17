/** Правила username из auth OpenAPI: `^[A-Za-z0-9_]{3,32}$`. */
export const USERNAME_PATTERN = /^[A-Za-z0-9_]{3,32}$/

export const USERNAME_HINT = '3–32 символа: латинские буквы, цифры и подчёркивание'

export const PASSWORD_HINT = 'Пароль не короче 8 символов'

export const EMAIL_HINT = 'Укажите корректный email'

/** Простая проверка формата email для UI макета (API email не принимает). */
export const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export interface FieldErrors {
  email?: string
  username?: string
  password?: string
  passwordConfirm?: string
}

/** Клиентская проверка логина/регистрации до запроса к API. */
export function validateCredentials(
  username: string,
  password: string,
  options: {
    requirePasswordConfirm?: boolean
    passwordConfirm?: string
    requireEmail?: boolean
    email?: string
  } = {},
): FieldErrors {
  const errors: FieldErrors = {}

  if (options.requireEmail) {
    const email = options.email?.trim() ?? ''
    if (!EMAIL_PATTERN.test(email)) {
      errors.email = EMAIL_HINT
    }
  }

  if (!USERNAME_PATTERN.test(username)) {
    errors.username = USERNAME_HINT
  }

  // OpenAPI minLength считает Unicode code points, не единицы UTF-16.
  // Пароль не обрезаем и не нормализуем: пробелы и составные символы входят в длину как есть.
  if (Array.from(password).length < 8) {
    errors.password = PASSWORD_HINT
  }

  if (options.requirePasswordConfirm) {
    if (!options.passwordConfirm) {
      errors.passwordConfirm = 'Повторите пароль'
    } else if (options.passwordConfirm !== password) {
      errors.passwordConfirm = 'Пароли не совпадают'
    }
  }

  return errors
}

export function validateEmail(email: string): FieldErrors {
  const trimmed = email.trim()
  if (!EMAIL_PATTERN.test(trimmed)) {
    return { email: EMAIL_HINT }
  }
  return {}
}

export function hasFieldErrors(errors: FieldErrors): boolean {
  return Object.keys(errors).length > 0
}
