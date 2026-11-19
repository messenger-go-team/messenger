import { useState } from 'react'
import { Link } from 'react-router'
import { ArrowLeft, LogOut, MessageCircle, User, Users } from 'lucide-react'
import { Button, buttonVariants } from '@/components/ui/button'
import { useAuth } from '@/features/auth/useAuth'
import { cn } from '@/lib/utils'

/** Профиль текущего пользователя (Figma `366:24927` / alert `24947`). */
export function ProfilePage() {
  const { user, logout } = useAuth()
  const [confirmLogout, setConfirmLogout] = useState(false)
  const letter = user?.username.trim().charAt(0).toUpperCase() || '?'

  return (
    <div className="flex h-svh min-h-0 overflow-hidden bg-background text-foreground">
      <nav
        aria-label="Основная навигация"
        className="flex w-12 shrink-0 flex-col items-center justify-between border-r border-border bg-muted/40 py-3"
      >
        <div className="flex flex-col items-center gap-3">
          <Link
            to="/"
            className="inline-flex size-10 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent"
            aria-label="Чаты"
          >
            <MessageCircle className="size-5" />
          </Link>
          <Link
            to="/contacts"
            className="inline-flex size-10 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent"
            aria-label="Контакты"
          >
            <Users className="size-5" />
          </Link>
        </div>
        <span
          className="inline-flex size-10 items-center justify-center rounded-lg bg-accent text-foreground"
          aria-current="page"
          aria-label="Профиль"
        >
          <User className="size-5" />
        </span>
      </nav>

      <main className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-3 border-b border-border px-4 py-4">
          <Link
            to="/"
            className="inline-flex size-9 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent md:hidden"
            aria-label="Назад"
          >
            <ArrowLeft className="size-5" />
          </Link>
          <h1 className="text-xl font-semibold tracking-tight">Профиль</h1>
        </header>

        <div className="mx-auto flex w-full max-w-md flex-col items-center gap-6 px-6 py-10">
          <span
            aria-hidden
            className="inline-flex size-20 items-center justify-center rounded-full bg-[color-mix(in_oklab,var(--brand-button-to)_35%,white)] text-2xl font-semibold"
          >
            {letter}
          </span>
          <div className="space-y-1 text-center">
            <p className="text-lg font-semibold">{user?.username ?? '—'}</p>
            <p className="text-sm text-muted-foreground">@{user?.username}</p>
            {user?.created_at ? (
              <p className="text-xs text-muted-foreground">
                С {new Date(user.created_at).toLocaleDateString('ru-RU')}
              </p>
            ) : null}
          </div>

          <div className="flex w-full flex-col gap-2">
            <Link
              to="/change-password"
              className={cn(buttonVariants({ variant: 'outline', size: 'lg' }), 'w-full')}
            >
              Сменить пароль
            </Link>
            <Button
              type="button"
              variant="outline"
              className="text-destructive"
              onClick={() => setConfirmLogout(true)}
            >
              <LogOut className="size-4" />
              Выйти
            </Button>
          </div>
        </div>
      </main>

      {confirmLogout ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          role="presentation"
          onClick={() => setConfirmLogout(false)}
        >
          <div
            role="alertdialog"
            aria-labelledby="logout-title"
            aria-describedby="logout-desc"
            className="w-full max-w-sm rounded-xl border border-border bg-card p-5 shadow-lg"
            onClick={(event) => event.stopPropagation()}
          >
            <h2 id="logout-title" className="text-lg font-semibold">
              Выйти из аккаунта?
            </h2>
            <p id="logout-desc" className="mt-2 text-sm text-muted-foreground">
              Сессия на этом устройстве будет завершена.
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={() => setConfirmLogout(false)}>
                Отмена
              </Button>
              <Button
                type="button"
                onClick={() => {
                  setConfirmLogout(false)
                  void logout()
                }}
              >
                Выйти из аккаунта
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}
