import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router'
import { AlertDialog } from '@base-ui/react/alert-dialog'
import { ArrowLeft, Bell, MessageCircle, User, Users } from 'lucide-react'
import { completeLater, listLater, type LaterEntry, type LaterStatus } from '@/api/later'
import { Button, buttonVariants } from '@/components/ui/button'
import { useAuth } from '@/features/auth/useAuth'
import { formatChatListTime } from '@/features/chats/formatChatListTime'
import { cn } from '@/lib/utils'

type Status = 'loading' | 'ready' | 'error'

const GROUP_ORDER: LaterStatus[] = ['due', 'scheduled', 'unscheduled']

const GROUP_TITLE: Record<LaterStatus, string> = {
  due: 'Сейчас',
  scheduled: 'Запланировано',
  unscheduled: 'Без срока',
}

/** Список «Важно» / Later: три группы, Готово, loading/empty/error. */
export function LaterPage() {
  const { accessToken, isAuthenticated } = useAuth()
  const [status, setStatus] = useState<Status>('loading')
  const [error, setError] = useState<string | null>(null)
  const [entries, setEntries] = useState<LaterEntry[]>([])
  const [reloadKey, setReloadKey] = useState(0)
  const [completingId, setCompletingId] = useState<string | null>(null)
  const sessionActive = Boolean(accessToken && isAuthenticated)

  useEffect(() => {
    if (!sessionActive || !accessToken) return
    let cancelled = false
    const timer = window.setTimeout(() => {
      void (async () => {
        setStatus('loading')
        setError(null)
        try {
          const response = await listLater(accessToken)
          if (cancelled) return
          setEntries(response.entries)
          setStatus('ready')
        } catch {
          if (cancelled) return
          setStatus('error')
          setError('Не удалось загрузить напоминания. Повторите попытку.')
        }
      })()
    }, 0)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [accessToken, sessionActive, reloadKey])

  const visibleEntries = useMemo(() => (sessionActive ? entries : []), [sessionActive, entries])
  const visibleStatus: Status = sessionActive ? status : 'ready'
  const visibleError = sessionActive ? error : null

  const groups = useMemo(() => {
    const map: Record<LaterStatus, LaterEntry[]> = {
      due: [],
      scheduled: [],
      unscheduled: [],
    }
    for (const entry of visibleEntries) {
      map[entry.status].push(entry)
    }
    return GROUP_ORDER.map((key) => ({ key, title: GROUP_TITLE[key], items: map[key] })).filter(
      (group) => group.items.length > 0,
    )
  }, [visibleEntries])

  async function onComplete(entryId: string) {
    if (!accessToken) return
    setCompletingId(entryId)
    try {
      await completeLater(accessToken, entryId)
      setEntries((current) => current.filter((entry) => entry.id !== entryId))
    } catch {
      setError('Не удалось отметить готовым. Повторите попытку.')
    } finally {
      setCompletingId(null)
    }
  }

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

      <section className="flex min-w-0 flex-1 flex-col bg-card md:max-w-[420px] md:border-r md:border-border lg:max-w-[480px]">
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
          {visibleStatus === 'loading' ? (
            <p className="px-4 py-6 text-sm text-muted-foreground" role="status">
              Загрузка…
            </p>
          ) : null}

          {visibleStatus === 'error' ? (
            <div className="flex flex-col items-start gap-3 px-4 py-6" role="alert">
              <p className="text-sm text-destructive">
                {visibleError ?? 'Не удалось загрузить напоминания. Повторите попытку.'}
              </p>
              <Button type="button" variant="outline" onClick={() => setReloadKey((v) => v + 1)}>
                Повторить
              </Button>
            </div>
          ) : null}

          {visibleStatus === 'ready' && visibleError ? (
            <p className="px-4 pt-3 text-sm text-destructive" role="alert">
              {visibleError}
            </p>
          ) : null}

          {visibleStatus === 'ready' && visibleEntries.length === 0 ? (
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

          {visibleStatus === 'ready' && groups.length > 0 ? (
            <div className="flex flex-col gap-4 pb-6">
              {groups.map((group) => (
                <section key={group.key} aria-labelledby={`later-group-${group.key}`}>
                  <h2
                    id={`later-group-${group.key}`}
                    className="px-4 pb-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase"
                  >
                    {group.title}
                  </h2>
                  <ul className="flex flex-col">
                    {group.items.map((entry) => (
                      <li
                        key={entry.id}
                        className="flex items-start gap-2 border-b border-border px-4 py-3"
                      >
                        <Link
                          to={`/chats/${entry.message.chat_id}`}
                          className="min-w-0 flex-1 space-y-1 hover:opacity-90"
                        >
                          {entry.due_at ? (
                            <time className="text-xs text-muted-foreground" dateTime={entry.due_at}>
                              {formatChatListTime(entry.due_at)}
                            </time>
                          ) : null}
                          <p className="line-clamp-2 text-sm text-foreground">
                            {entry.message.body}
                          </p>
                        </Link>
                        <AlertDialog.Root>
                          <AlertDialog.Trigger
                            className={cn(
                              buttonVariants({ variant: 'outline', size: 'sm' }),
                              'shrink-0',
                            )}
                            disabled={completingId === entry.id}
                          >
                            Готово
                          </AlertDialog.Trigger>
                          <AlertDialog.Portal>
                            <AlertDialog.Backdrop className="fixed inset-0 z-50 bg-black/40" />
                            <AlertDialog.Popup className="fixed top-1/2 left-1/2 z-50 w-[calc(100%-2rem)] max-w-sm -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-card p-5 shadow-lg outline-none">
                              <AlertDialog.Title className="text-lg font-semibold">
                                Убрать из «Важно»?
                              </AlertDialog.Title>
                              <AlertDialog.Description className="mt-2 text-sm text-muted-foreground">
                                Запись исчезнет из списка. Сообщение в чате останется.
                              </AlertDialog.Description>
                              <div className="mt-4 flex justify-end gap-2">
                                <AlertDialog.Close
                                  className={cn(buttonVariants({ variant: 'outline' }))}
                                >
                                  Отмена
                                </AlertDialog.Close>
                                <AlertDialog.Close
                                  className={cn(buttonVariants())}
                                  onClick={() => void onComplete(entry.id)}
                                >
                                  Готово
                                </AlertDialog.Close>
                              </div>
                            </AlertDialog.Popup>
                          </AlertDialog.Portal>
                        </AlertDialog.Root>
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
            </div>
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
