const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL ?? '').replace(/\/+$/, '')

/** Типизированная ошибка HTTP API с сохранением статуса и машинного кода backend. */
export class ApiError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string, message: string) {
    super(message)

    this.name = 'ApiError'
    this.status = status
    this.code = code
  }
}

/**
 * Выполняет запрос к настроенному API и преобразует контрактную ошибку в `ApiError`.
 * `credentials: include` нужен для HttpOnly refresh cookie и намеренно имеет приоритет над options.
 * Для успешного 204 возвращает `undefined`; generic `T` описывает ожидаемую схему, но не валидирует JSON runtime.
 */
export async function apiRequest<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...options,
    credentials: 'include',
    headers: new Headers(options.headers),
  })

  if (!response.ok) {
    // Ошибка может прийти без JSON (например, от proxy), поэтому сохраняем безопасный fallback.
    const errorBody: unknown = await response.json().catch(() => null)

    if (
      typeof errorBody === 'object' &&
      errorBody !== null &&
      'code' in errorBody &&
      'message' in errorBody &&
      typeof errorBody.code === 'string' &&
      typeof errorBody.message === 'string'
    ) {
      throw new ApiError(response.status, errorBody.code, errorBody.message)
    }

    throw new ApiError(response.status, 'unknown_error', `HTTP request failed: ${response.status}`)
  }

  if (response.status === 204) {
    return undefined as T
  }

  return (await response.json()) as T
}
