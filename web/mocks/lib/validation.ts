export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Проверяет строковое UUID-представление и одновременно сужает тип значения. */
export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value)
}

/** Валидирует UUID и возвращает каноническое lower-case представление для ключей хранилищ. */
export function normalizeUuid(value: unknown): string | null {
  return isUuid(value) ? value.toLowerCase() : null
}

/**
 * Разбирает десятичный query-параметр без знака, дробей и экспоненты.
 * Дополнительно ограничивает результат safe-integer диапазоном, важным для `seq` в JavaScript.
 */
export function parseIntegerParameter(
  value: string,
  minimum: number,
  maximum: number,
): number | null {
  if (!/^\d+$/.test(value)) {
    return null
  }

  const parsed = Number(value)

  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : null
}
