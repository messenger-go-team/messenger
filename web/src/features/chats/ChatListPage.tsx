import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react'
import { Link, useLocation, useNavigate, useParams } from 'react-router'
import { Bell, LogOut, MessageCircle, Plus, Search, User, Users } from 'lucide-react'
import type { UserSummary } from '@/api/auth'
import { searchUsers } from '@/api/auth'
import { createPersonalChat, listChats, type ChatListItem } from '@/api/history'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useAuth } from '@/features/auth/useAuth'
import { formatChatListTime } from '@/features/chats/formatChatListTime'
import { peerUsername } from '@/features/chats/peerUsername'
import {
  isValidUserSearchPrefix,
  normalizeUserSearchInput,
  USER_SEARCH_HINT,
} from '@/features/chats/userSearchPrefix'
import { cn } from '@/lib/utils'

const SEARCH_DEBOUNCE_MS = 300

type ListStatus = 'loading' | 'ready' | 'error'
type SearchStatus = 'idle' | 'loading' | 'ready' | 'error' | 'invalid'

/** Главный экран списка чатов и поиска пользователей (#43). */
export function ChatListPage() {
  const { user, accessToken, logout } = useAuth()
  const { chatId } = useParams()
  const location = useLocation()
  const navigate = useNavigate()
  const searchId = useId()
  const chatsNavActive = location.pathname === '/' || location.pathname.startsWith('/chats/')

  const [chats, setChats] = useState<ChatListItem[]>([])
  const [listStatus, setListStatus] = useState<ListStatus>('loading')
  const [listError, setListError] = useState<string | null>(null)
  const [listReloadKey, setListReloadKey] = useState(0)

  const [query, setQuery] = useState('')
  const [searchNonce, setSearchNonce] = useState(0)
  const [searchResults, setSearchResults] = useState<UserSummary[]>([])
  const [searchFetchStatus, setSearchFetchStatus] = useState<'loading' | 'ready' | 'error'>(
    'loading',
  )
  const [searchError, setSearchError] = useState<string | null>(null)
  const [creatingUserId, setCreatingUserId] = useState<string | null>(null)
  const searchRequestRef = useRef(0)

  const reloadChats = useCallback(() => {
    setListReloadKey((value) => value + 1)
  }, [])

  useEffect(() => {
    if (!accessToken) return

    let cancelled = false
    const timer = window.setTimeout(() => {
      void (async () => {
        setListStatus('loading')
        setListError(null)
        try {
          const response = await listChats(accessToken)
          if (cancelled) return
          setChats(response.chats)
          setListStatus('ready')
        } catch {
          if (cancelled) return
          setListStatus('error')
          setListError('Не удалось загрузить чаты. Повторите попытку.')
        }
      })()
    }, 0)

    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [accessToken, listReloadKey])

  const searchPrefix = normalizeUserSearchInput(query)
  const searching = searchPrefix.length > 0
  const searchInvalid = searching && !isValidUserSearchPrefix(searchPrefix)

  useEffect(() => {
    if (!searching || searchInvalid || !accessToken || !user) return

    const requestId = ++searchRequestRef.current
    const timer = window.setTimeout(() => {
      void (async () => {
        setSearchFetchStatus('loading')
        setSearchError(null)
        try {
          const response = await searchUsers(searchPrefix, accessToken)
          if (requestId !== searchRequestRef.current) return
          setSearchResults(response.users.filter((item) => item.id !== user.id))
          setSearchFetchStatus('ready')
        } catch {
          if (requestId !== searchRequestRef.current) return
          setSearchFetchStatus('error')
          setSearchError('Не удалось найти пользователей. Повторите попытку.')
          setSearchResults([])
        }
      })()
    }, SEARCH_DEBOUNCE_MS)

    return () => {
      window.clearTimeout(timer)
    }
  }, [accessToken, searchInvalid, searchNonce, searchPrefix, searching, user])

  const searchStatus: SearchStatus = !searching
    ? 'idle'
    : searchInvalid
      ? 'invalid'
      : searchFetchStatus

  async function openChatWithUser(target: UserSummary) {
    if (!accessToken) return
    setCreatingUserId(target.id)
    try {
      const chat = await createPersonalChat(target.id, accessToken)
      const response = await listChats(accessToken)
      setChats(response.chats)
      setListStatus('ready')
      setQuery('')
      navigate(`/chats/${chat.id}`)
    } catch {
      setSearchError('Не удалось открыть чат. Повторите попытку.')
      setSearchFetchStatus('error')
    } finally {
      setCreatingUserId(null)
    }
  }

  function focusSearch(event?: FormEvent) {
    event?.preventDefault()
    document.getElementById(searchId)?.focus()
  }

  const selectedPeer =
    chatId && user
      ? peerUsername(chats.find((chat) => chat.id === chatId)?.members ?? [], user.id)
      : null

  return (
    <div className="flex h-svh min-h-0 bg-background text-foreground">
      <nav
        aria-label="Основная навигация"
        className="flex w-12 shrink-0 flex-col items-center justify-between border-r border-border bg-muted/40 py-3"
      >
        <div className="flex flex-col items-center gap-3">
          <NavIcon label="Уведомления" disabled>
            <Bell className="size-5" />
          </NavIcon>
          <NavIcon label="Чаты" active={chatsNavActive} to="/">
            <MessageCircle className="size-5" />
          </NavIcon>
          <NavIcon label="Контакты" to="/contacts">
            <Users className="size-5" />
          </NavIcon>
        </div>
        <div className="flex flex-col items-center gap-2">
          <NavIcon label="Профиль" to="/change-password">
            <User className="size-5" />
          </NavIcon>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Выйти"
            title="Выйти"
            onClick={() => void logout()}
          >
            <LogOut className="size-4" />
          </Button>
        </div>
      </nav>

      <aside className="flex w-full max-w-[344px] shrink-0 flex-col border-r border-border bg-card">
        <header className="flex items-center justify-between gap-3 px-4 pt-5 pb-3">
          <h1 className="text-xl font-semibold tracking-tight">Чаты</h1>
          <Button
            type="button"
            size="icon"
            className="rounded-full"
            aria-label="Новый чат"
            onClick={() => focusSearch()}
          >
            <Plus className="size-5" />
          </Button>
        </header>

        <div className="px-4 pb-3">
          <label htmlFor={searchId} className="sr-only">
            найти
          </label>
          <div className="relative">
            <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              id={searchId}
              role="searchbox"
              aria-label="найти"
              placeholder="найти"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              className="h-10 rounded-full border-transparent bg-muted pl-9"
              autoComplete="off"
            />
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {searching ? (
            <SearchPanel
              status={searchStatus}
              results={searchResults}
              error={searchError}
              creatingUserId={creatingUserId}
              onRetry={() => setSearchNonce((value) => value + 1)}
              onWrite={openChatWithUser}
            />
          ) : (
            <ChatsPanel
              status={listStatus}
              chats={chats}
              error={listError}
              currentUserId={user?.id ?? ''}
              selectedChatId={chatId}
              onRetry={reloadChats}
              onFindPerson={() => focusSearch()}
            />
          )}
        </div>
      </aside>

      <main className="hidden min-w-0 flex-1 items-center justify-center bg-background md:flex">
        {chatId ? (
          <p className="max-w-sm px-6 text-center text-muted-foreground">
            Чат с {selectedPeer ?? 'пользователем'}. Окно переписки — в задаче #44.
          </p>
        ) : (
          <p className="max-w-sm px-6 text-center text-muted-foreground">
            Выберите чат, чтобы начать обмен сообщениями
          </p>
        )}
      </main>
    </div>
  )
}

function ChatsPanel({
  status,
  chats,
  error,
  currentUserId,
  selectedChatId,
  onRetry,
  onFindPerson,
}: {
  status: ListStatus
  chats: ChatListItem[]
  error: string | null
  currentUserId: string
  selectedChatId?: string
  onRetry: () => void
  onFindPerson: () => void
}) {
  if (status === 'loading') {
    return <p className="px-4 py-6 text-sm text-muted-foreground">Загрузка чатов…</p>
  }

  if (status === 'error') {
    return (
      <div className="flex flex-col items-start gap-3 px-4 py-6" role="alert">
        <p className="text-sm text-destructive">{error}</p>
        <Button type="button" variant="outline" onClick={onRetry}>
          Повторить
        </Button>
      </div>
    )
  }

  if (chats.length === 0) {
    return (
      <div className="flex flex-col items-center gap-3 px-4 py-8 text-center">
        <p className="text-sm text-muted-foreground">У вас нет чатов</p>
        <Button type="button" onClick={onFindPerson}>
          Найти человека
        </Button>
      </div>
    )
  }

  return (
    <ul className="flex flex-col">
      {chats.map((chat) => {
        const name = peerUsername(chat.members, currentUserId)
        const preview = chat.last_message?.body ?? 'Нет сообщений'
        const time = chat.last_message ? formatChatListTime(chat.last_message.created_at) : ''
        const selected = chat.id === selectedChatId

        return (
          <li key={chat.id} className="border-b border-border">
            <Link
              to={`/chats/${chat.id}`}
              className={cn(
                'flex items-center gap-3 px-4 py-3 transition-colors hover:bg-accent/60',
                selected && 'bg-accent',
              )}
            >
              <InitialAvatar username={name} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate font-semibold">{name}</span>
                  {time ? (
                    <span className="shrink-0 text-xs text-muted-foreground">{time}</span>
                  ) : null}
                </div>
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-sm text-muted-foreground">{preview}</span>
                  {chat.unread_count > 0 ? (
                    <span className="inline-flex min-w-5 shrink-0 items-center justify-center rounded-full bg-primary px-1.5 text-xs font-medium text-primary-foreground">
                      {chat.unread_count}
                    </span>
                  ) : null}
                </div>
              </div>
            </Link>
          </li>
        )
      })}
    </ul>
  )
}

function SearchPanel({
  status,
  results,
  error,
  creatingUserId,
  onRetry,
  onWrite,
}: {
  status: SearchStatus
  results: UserSummary[]
  error: string | null
  creatingUserId: string | null
  onRetry: () => void
  onWrite: (user: UserSummary) => void
}) {
  if (status === 'invalid') {
    return <p className="px-4 py-6 text-sm text-muted-foreground">{USER_SEARCH_HINT}</p>
  }

  if (status === 'loading' || status === 'idle') {
    return <p className="px-4 py-6 text-sm text-muted-foreground">Ищем пользователей…</p>
  }

  if (status === 'error') {
    return (
      <div className="flex flex-col items-start gap-3 px-4 py-6" role="alert">
        <p className="text-sm text-destructive">{error}</p>
        <Button type="button" variant="outline" onClick={onRetry}>
          Повторить
        </Button>
      </div>
    )
  }

  if (results.length === 0) {
    return <p className="px-4 py-6 text-sm text-muted-foreground">Никого не нашли</p>
  }

  return (
    <ul className="flex flex-col">
      {results.map((item) => (
        <li key={item.id} className="border-b border-border">
          <div className="flex items-center gap-3 px-4 py-3">
            <InitialAvatar username={item.username} />
            <span className="min-w-0 flex-1 truncate font-semibold">{item.username}</span>
            <Button
              type="button"
              size="sm"
              disabled={creatingUserId === item.id}
              aria-label={`Написать ${item.username}`}
              onClick={() => void onWrite(item)}
            >
              {creatingUserId === item.id ? 'Открываем…' : 'Написать'}
            </Button>
          </div>
        </li>
      ))}
    </ul>
  )
}

function InitialAvatar({ username }: { username: string }) {
  const letter = username.trim().charAt(0).toUpperCase() || '?'
  return (
    <span
      aria-hidden
      className="inline-flex size-10 shrink-0 items-center justify-center rounded-full bg-[color-mix(in_oklab,var(--brand-button-to)_35%,white)] text-sm font-semibold text-foreground"
    >
      {letter}
    </span>
  )
}

function NavIcon({
  children,
  label,
  to,
  active = false,
  disabled = false,
}: {
  children: ReactNode
  label: string
  to?: string
  active?: boolean
  disabled?: boolean
}) {
  const className = cn(
    'inline-flex size-10 items-center justify-center rounded-lg text-muted-foreground transition-colors',
    active && 'bg-accent text-foreground',
    disabled && 'opacity-40',
  )

  if (disabled || !to) {
    return (
      <span className={className} aria-label={label} title={label}>
        {children}
      </span>
    )
  }

  return (
    <Link
      to={to}
      className={className}
      aria-label={label}
      title={label}
      aria-current={active ? 'page' : undefined}
    >
      {children}
    </Link>
  )
}
