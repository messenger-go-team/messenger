import { AlertDialog } from '@base-ui/react/alert-dialog'
import { Link } from 'react-router'
import { LogOut } from 'lucide-react'
import { AppNav } from '@/components/AppNav'
import { buttonVariants } from '@/components/ui/button'
import { useAuth } from '@/features/auth/useAuth'
import { cn } from '@/lib/utils'

/** Профиль текущего пользователя (Figma `366:24927` / alert `24947`). */
export function ProfilePage() {
  const { user, logout } = useAuth()
  const letter = user?.username.trim().charAt(0).toUpperCase() || '?'

  return (
    <div className="flex h-svh min-h-0 flex-col overflow-hidden bg-background text-foreground md:flex-row">
      <AppNav active="profile" className="order-last md:order-first" />

      <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto">
        <header className="flex shrink-0 items-center gap-3 border-b border-border px-4 py-4">
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
            <AlertDialog.Root>
              <AlertDialog.Trigger
                className={cn(buttonVariants({ variant: 'outline' }), 'w-full text-destructive')}
              >
                <LogOut className="size-4" />
                Выйти
              </AlertDialog.Trigger>
              <AlertDialog.Portal>
                <AlertDialog.Backdrop className="fixed inset-0 z-50 bg-black/40" />
                <AlertDialog.Popup className="fixed top-1/2 left-1/2 z-50 w-[calc(100%-2rem)] max-w-sm -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-card p-5 shadow-lg outline-none">
                  <AlertDialog.Title className="text-lg font-semibold">
                    Выйти из аккаунта?
                  </AlertDialog.Title>
                  <AlertDialog.Description className="mt-2 text-sm text-muted-foreground">
                    Сессия на этом устройстве будет завершена.
                  </AlertDialog.Description>
                  <div className="mt-5 flex justify-end gap-2">
                    <AlertDialog.Close className={cn(buttonVariants({ variant: 'outline' }))}>
                      Отмена
                    </AlertDialog.Close>
                    <AlertDialog.Close
                      className={cn(buttonVariants())}
                      onClick={() => {
                        void logout()
                      }}
                    >
                      Выйти из аккаунта
                    </AlertDialog.Close>
                  </div>
                </AlertDialog.Popup>
              </AlertDialog.Portal>
            </AlertDialog.Root>
          </div>
        </div>
      </main>
    </div>
  )
}
