/** OpenAPI `GET /users/search`: prefix 1–32 символа `[A-Za-z0-9_]`. */
const PREFIX_PATTERN = /^[A-Za-z0-9_]{1,32}$/

export const USER_SEARCH_HINT = 'Логин: латинские буквы, цифры и подчёркивание, до 32 символов.'

/** Пустая строка — поиск не вызываем. */
export function normalizeUserSearchInput(raw: string): string {
  return raw.trim()
}

export function isValidUserSearchPrefix(prefix: string): boolean {
  return PREFIX_PATTERN.test(prefix)
}
