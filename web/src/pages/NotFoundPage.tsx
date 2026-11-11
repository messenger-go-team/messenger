/** Fallback-страница для маршрутов, отсутствующих в `AppRouter`. */
export function NotFoundPage() {
  return (
    <main className="flex min-h-screen items-center justify-center">
      <h1 className="text-2xl font-bold">404 — Страница не найдена</h1>
    </main>
  )
}
