import { useEffect, useState } from 'react'
import { Link } from 'react-router'
import { ArrowLeft, Bell, MessageCircle, User, Users } from 'lucide-react'
import { listLater, type LaterEntry } from '@/api/later'
import { Button } from '@/components/ui/button'
import { useAuth } from '@/features/auth/useAuth'
import { formatChatListTime } from '@/features/chats/formatChatListTime'

type Status = 'loading' | 'ready' | 'error'

/** Список «Важно» / Later (Figma Important empty / ready). MSW до #87. */
export function LaterPage() {
  const { accessToken } = useAuth()
  const [status, setStatus] = useState<Status>('loading')
  const [error, setError] = useState<string | null>(null)
  const [entries, setEntries] = useState<LaterEntry[]>([])
  const [reloadKey, setReloadKey] = useState(0)

  useEffect(() => {
    if (!accessToken) return
    const timer = window.setTimeout(() => {
      void (async () => {
        setStatus('loading')
        setError(null)
        try {
          const response = await listLater(accessToken)
          setEntries(response.entries)
          setStatus('ready')
        } catch {
          setStatus('error')
          setError('Не удалось загрузить напоминания. Повторите попытку.')
        }
      })()
    }, 0)
    return () => window.clearTimeout(timer)
  }, [accessToken, reloadKey])

  return (
    <div className="flex h-svh min-h-0 overflow-hidden bg-background text-foreground">
      <nav
        aria-label="Основная навигация"
        className="flex w-12 shrink-0 flex-col items-center justify-between border-r border-border bg-muted/40 py-3"
      >
        <div className="flex flex-col items-center gap-3">
          <span
            className="inline-flex size-10 items-center justify-center rounded-lg bg-accent text-foreground"
            aria-current="page"
            aria-label="Важно"
          >
            <Bell className="size-5" />
          </span>
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
        <Link
          to="/profile"
          className="inline-flex size-10 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent"
          aria-label="Профиль"
        >
          <User className="size-5" />
        </Link>
      </nav>

      <section className="flex min-w-0 flex-1 flex-col bg-card md:max-w-[420px] md:border-r md:border-border">
        <header className="flex items-center gap-3 px-4 pt-5 pb-3">
          <Link
            to="/"
            className="inline-flex size-9 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent md:hidden"
            aria-label="К чатам"
          >
            <ArrowLeft className="size-5" />
          </Link>
          <h1 className="text-xl font-semibold tracking-tight">Важно</h1>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {status === 'loading' ? (
            <p className="px-4 py-6 text-sm text-muted-foreground" role="status">
              Загрузка…
            </p>
          ) : null}

          {status === 'error' ? (
            <div className="flex flex-col items-start gap-3 px-4 py-6" role="alert">
              <p className="text-sm text-destructive">{error}</p>
              <Button type="button" variant="outline" onClick={() => setReloadKey((v) => v + 1)}>
                Повторить
              </Button>
            </div>
          ) : null}

          {status === 'ready' && entries.length === 0 ? (
            <div className="flex flex-col items-center gap-4 px-6 py-16 text-center">
              <span
                aria-hidden
                className="inline-flex size-14 items-center justify-center rounded-full bg-muted text-muted-foreground"
              >
                <Bell className="size-7" />
              </span>
              <div className="space-y-1">
                <p className="text-base font-semibold">Пока пусто</p>
                <p className="text-sm text-muted-foreground">
                  Отметьте сообщение «Вернуться позже» в чате — оно появится здесь.
                </p>
              </div>
            </div>
          ) : null}

          {status === 'ready' && entries.length > 0 ? (
            <ul className="flex flex-col">
              {entries.map((entry) => (
                <li key={entry.id} className="border-b border-border px-4 py-3">
                  <Link
                    to={`/chats/${entry.message.chat_id}`}
                    className="block space-y-1 hover:opacity-90"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
                        {statusLabel(entry.status)}
                      </span>
                      {entry.due_at ? (
                        <time className="text-xs text-muted-foreground" dateTime={entry.due_at}>
                          {formatChatListTime(entry.due_at)}
                        </time>
                      ) : null}
                    </div>
                    <p className="line-clamp-2 text-sm text-foreground">{entry.message.body}</p>
                  </Link>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      </section>

      <main className="hidden min-w-0 flex-1 items-center justify-center bg-muted/20 md:flex">
        <p className="max-w-sm px-6 text-center text-sm text-muted-foreground">
          Выберите напоминание, чтобы открыть сообщение в чате
        </p>
      </main>
    </div>
  )
}

function statusLabel(status: LaterEntry['status']): string {
  if (status === 'due') return 'Сейчас'
  if (status === 'scheduled') return 'Запланировано'
  return 'Без срока'
}
