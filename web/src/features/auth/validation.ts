/** Правила username из auth OpenAPI: `^[A-Za-z0-9_]{3,32}$`. */
export const USERNAME_PATTERN = /^[A-Za-z0-9_]{3,32}$/

export const USERNAME_HINT =
  '3–32 символа: латинские буквы, цифры и подчёркивание'

export const PASSWORD_HINT = 'Пароль не короче 8 символов'

export interface FieldErrors {
  username?: string
  password?: string
  passwordConfirm?: string
}

/** Клиентская проверка логина/регистрации до запроса к API. */
export function validateCredentials(
  username: string,
  password: string,
  options: { requirePasswordConfirm?: boolean; passwordConfirm?: string } = {},
): FieldErrors {
  const errors: FieldErrors = {}

  if (!USERNAME_PATTERN.test(username)) {
    errors.username = USERNAME_HINT
  }

  if (password.length < 8) {
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

export function hasFieldErrors(errors: FieldErrors): boolean {
  return Object.keys(errors).length > 0
}
