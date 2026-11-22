/** Режим MSW: только точное значение `true` (строка из Vite env). */
export function isApiMockEnabled(
  env: ImportMetaEnv | Record<string, string | undefined> = import.meta.env,
): boolean {
  return env.VITE_API_MOCK === 'true'
}

/** Base URL REST API без завершающего `/`. Пустая строка = origin страницы. */
export function apiBaseUrl(
  env: ImportMetaEnv | Record<string, string | undefined> = import.meta.env,
): string {
  return (env.VITE_API_BASE_URL ?? '').replace(/\/+$/, '')
}

/**
 * Origin WebSocket без завершающего `/`.
 * Если `VITE_WS_ORIGIN` не задан — схема и host текущей страницы (`wss` на HTTPS).
 */
export function wsOrigin(
  env: ImportMetaEnv | Record<string, string | undefined> = import.meta.env,
  location: Pick<Location, 'protocol' | 'host'> = window.location,
): string {
  const configured = env.VITE_WS_ORIGIN
  if (configured) return configured.replace(/\/+$/, '')
  const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${scheme}//${location.host}`
}
