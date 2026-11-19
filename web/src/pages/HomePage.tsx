import { Link } from 'react-router'
import { Button, buttonVariants } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { useAuth } from '@/features/auth/useAuth'

/** Временная домашняя страница после входа до экранов чатов. */
export function HomePage() {
  const { user, logout } = useAuth()

  return (
    <main className="flex min-h-screen items-center justify-center bg-background p-6">
      <section className="flex w-full max-w-md flex-col items-center gap-4 rounded-xl border bg-card p-8 text-card-foreground shadow-sm">
        <h1 className="text-2xl font-bold">Tiding</h1>
        <p className="text-center text-muted-foreground">
          Вы вошли как <span className="font-medium text-foreground">{user?.username}</span>
        </p>
        <div className="flex w-full flex-col gap-2">
          <Link
            to="/change-password"
            className={cn(buttonVariants({ variant: 'outline' }), 'w-full')}
          >
            Сменить пароль
          </Link>
          <Button type="button" variant="outline" onClick={() => void logout()}>
            Выйти
          </Button>
        </div>
      </section>
    </main>
  )
}
