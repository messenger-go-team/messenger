import { Navigate, Outlet } from 'react-router'
import { useAuth } from '@/features/auth/useAuth'

/** Закрывает маршруты без сессии; до готовности Auth показывает заглушку. */
export function RequireAuth() {
  const { isAuthenticated, isReady } = useAuth()

  if (!isReady) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-background p-6">
        <p className="text-muted-foreground">Загрузка сессии…</p>
      </main>
    )
  }

  if (!isAuthenticated) {
    return <Navigate to="/login" replace />
  }

  return <Outlet />
}
