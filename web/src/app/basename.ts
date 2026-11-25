/**
 * Basename React Router / Vite asset base без завершающего `/`.
 * Staging: `/app` (экраны под /app/*, REST остаётся на корне домена).
 * Локальный MSW и Vitest: `` (корень).
 */
export function appBasename(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '')
  return trimmed === '' || trimmed === '/' ? '' : trimmed
}

/** Нормализует Vite `base`: всегда с завершающим `/`, корень — `/`. */
export function normalizeViteBase(base: string): string {
  const trimmed = base.trim()
  if (trimmed === '' || trimmed === '/') return '/'
  return trimmed.endsWith('/') ? trimmed : `${trimmed}/`
}

/**
 * Базовый путь SPA.
 * Production без явного `VITE_APP_BASE` — `/app/`.
 * Тесты и `VITE_API_MOCK=true` без явного base — `/`.
 * Моки и base не `/` несовместимы: worker ищется на `/mockServiceWorker.js`,
 * а Vite отдаёт его под base, и перехват `/contacts` не работает.
 */
export function resolveAppBase(mode: string, env: Record<string, string>): string {
  const explicit = env.VITE_APP_BASE?.trim() ?? ''
  const mock = mode === 'test' || env.VITE_API_MOCK === 'true'
  let base = '/app/'
  if (explicit) {
    base = normalizeViteBase(explicit)
  } else if (mock) {
    base = '/'
  }
  if (env.VITE_API_MOCK === 'true' && base !== '/') {
    throw new Error(
      `VITE_API_MOCK=true требует Vite base /. Сейчас base ${base}: MSW запрашивает /mockServiceWorker.js, а Vite отдаёт ${base}mockServiceWorker.js и не перехватывает REST на корне (/contacts). Уберите VITE_APP_BASE или выключите моки.`,
    )
  }
  return base
}

/** Validates the effective Vite environment before packaging static assets. */
export function assertBuildProfile(mode: string, base: string, env: Record<string, string>): void {
  if (env.VITE_API_MOCK === 'true') {
    throw new Error('Сборка с VITE_API_MOCK=true запрещена. Для MSW используйте npm run dev.')
  }

  if (mode !== 'staging') return

  if (base !== '/app/') {
    throw new Error('Staging требует VITE_APP_BASE=/app/.')
  }
  if (env.VITE_API_MOCK !== 'false') {
    throw new Error('Staging требует VITE_API_MOCK=false.')
  }
  for (const name of ['VITE_API_BASE_URL', 'VITE_WS_ORIGIN']) {
    if (env[name]) {
      throw new Error('Staging требует пустую переменную ' + name + ' для работы на том же origin.')
    }
  }
}
