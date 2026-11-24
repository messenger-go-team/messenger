/**
 * Basename React Router / Vite asset base без завершающего `/`.
 * Staging: `/app` (экраны под /app/*, REST остаётся на корне домена).
 * Локальный MSW и Vitest: `` (корень).
 */
export function appBasename(baseUrl: string = import.meta.env.BASE_URL): string {
  const trimmed = baseUrl.replace(/\/+$/, '')
  return trimmed === '' || trimmed === '/' ? '' : trimmed
}
