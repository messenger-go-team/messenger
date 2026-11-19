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
  const mountedRef = useRef(true)

  const [chats, setChats] = useState<ChatListItem[]>([])
  const [listStatus, setListStatus] = useState<ListStatus>('loading')
  const [listError, setListError] = useState<string | null>(null)
  const [listReloadKey, setListReloadKey] = useState(0)

  const [query, setQuery] = useState('')
  const [searchResults, setSearchResults] = useState<UserSummary[]>([])
  const [searchResultsPrefix, setSearchResultsPrefix] = useState<string | null>(null)
  const [searchFetchStatus, setSearchFetchStatus] = useState<'loading' | 'ready' | 'error'>(
    'loading',
  )
  const [searchError, setSearchError] = useState<string | null>(null)
  const [creatingUserId, setCreatingUserId] = useState<string | null>(null)
  const [openError, setOpenError] = useState<{ target: UserSummary; message: string } | null>(null)
  const searchRequestRef = useRef(0)
  const openRequestRef = useRef(0)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      openRequestRef.current += 1
      searchRequestRef.current += 1
    }
  }, [])

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
    if (!searching || searchInvalid) {
      searchRequestRef.current += 1
      return
    }
    if (!accessToken || !user) return

    const requestId = ++searchRequestRef.current
    const prefixForRequest = searchPrefix
    const timer = window.setTimeout(() => {
      void (async () => {
        setSearchFetchStatus('loading')
        setSearchError(null)
        try {
          const response = await searchUsers(prefixForRequest, accessToken)
          if (requestId !== searchRequestRef.current) return
          setSearchResults(response.users.filter((item) => item.id !== user.id))
          setSearchResultsPrefix(prefixForRequest)
          setSearchFetchStatus('ready')
        } catch {
          if (requestId !== searchRequestRef.current) return
          setSearchResults([])
          setSearchResultsPrefix(prefixForRequest)
          setSearchFetchStatus('error')
          setSearchError('Не удалось найти пользователей. Повторите попытку.')
        }
      })()
    }, SEARCH_DEBOUNCE_MS)

    return () => {
      window.clearTimeout(timer)
    }
  }, [accessToken, searchInvalid, searchPrefix, searching, user])

  const resultsMatchCurrentPrefix = searchResultsPrefix === searchPrefix
  const searchStatus: SearchStatus = !searching
    ? 'idle'
    : searchInvalid
      ? 'invalid'
      : !resultsMatchCurrentPrefix
        ? 'loading'
        : searchFetchStatus
  const visibleSearchResults = resultsMatchCurrentPrefix ? searchResults : []

  const refreshChatsInBackground = useCallback(async (token: string) => {
    try {
      const response = await listChats(token)
      if (!mountedRef.current) return
      setChats(response.chats)
      setListStatus('ready')
      setListError(null)
    } catch {
      // Открытие чата уже произошло по id из POST; список подтянется при следующем заходе.
    }
  }, [])

  async function openChatWithUser(target: UserSummary) {
    if (!accessToken || creatingUserId !== null) return
    const requestId = ++openRequestRef.current
    setCreatingUserId(target.id)
    setOpenError(null)
    setSearchError(null)
    try {
      const chat = await createPersonalChat(target.id, accessToken)
      if (requestId !== openRequestRef.current || !mountedRef.current) return
      const listItem: ChatListItem = {
        id: chat.id,
        type: chat.type,
        created_at: chat.created_at,
        members: chat.members,
        last_message: null,
        unread_count: 0,
      }
      setChats((previous) => [listItem, ...previous.filter((item) => item.id !== chat.id)])
      setListStatus('ready')
      setQuery('')
      navigate(`/chats/${chat.id}`, { state: { peerUsername: target.username } })
      void refreshChatsInBackground(accessToken)
    } catch {
      if (requestId !== openRequestRef.current || !mountedRef.current) return
      setOpenError({
        target,
        message: 'Не удалось открыть чат. Повторите попытку.',
      })
    } finally {
      if (requestId === openRequestRef.current) {
        setCreatingUserId(null)
      }
    }
  }

  function focusSearch(event?: FormEvent) {
    event?.preventDefault()
    document.getElementById(searchId)?.focus()
  }

  function retrySearch() {
    if (!searching || searchInvalid) return
    searchRequestRef.current += 1
    setSearchResultsPrefix(null)
    setSearchFetchStatus('loading')
    setSearchError(null)
    // Триггерим эффект повторным «сдвигом» через смену nonce в prefix-зависимом ключе:
    setQuery((value) => value)
    void (async () => {
      if (!accessToken || !user) return
      const requestId = ++searchRequestRef.current
      const prefixForRequest = searchPrefix
      try {
        const response = await searchUsers(prefixForRequest, accessToken)
        if (requestId !== searchRequestRef.current) return
        setSearchResults(response.users.filter((item) => item.id !== user.id))
        setSearchResultsPrefix(prefixForRequest)
        setSearchFetchStatus('ready')
      } catch {
        if (requestId !== searchRequestRef.current) return
        setSearchResults([])
        setSearchResultsPrefix(prefixForRequest)
        setSearchFetchStatus('error')
        setSearchError('Не удалось найти пользователей. Повторите попытку.')
      }
    })()
  }

  const peerFromState =
    typeof location.state === 'object' &&
    location.state !== null &&
    'peerUsername' in location.state &&
    typeof location.state.peerUsername === 'string'
      ? location.state.peerUsername
      : null
  const selectedChat = chatId ? chats.find((chat) => chat.id === chatId) : undefined
  const selectedPeer = chatId
    ? (selectedChat && user ? peerUsername(selectedChat.members, user.id) : null) || peerFromState
    : null

  return (
    <div className="flex h-svh min-h-0 overflow-hidden bg-background text-foreground">
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

      <aside className="flex min-w-0 flex-1 max-w-[344px] flex-col border-r border-border bg-card">
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
            Поиск по логину
          </label>
          <div className="relative">
            <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              id={searchId}
              role="searchbox"
              aria-label="Поиск по логину"
              placeholder="Поиск по логину"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value)
                setOpenError(null)
              }}
              className="h-10 rounded-full border-transparent bg-muted pl-9"
              autoComplete="off"
            />
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {searching ? (
            <SearchPanel
              status={searchStatus}
              results={visibleSearchResults}
              error={openError?.message ?? searchError}
              creatingUserId={creatingUserId}
              onRetry={() => {
                if (openError) {
                  void openChatWithUser(openError.target)
                  return
                }
                retrySearch()
              }}
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

  const opening = creatingUserId !== null

  return (
    <div className="flex flex-col">
      {error ? (
        <div
          className="flex flex-col items-start gap-3 border-b border-border px-4 py-4"
          role="alert"
        >
          <p className="text-sm text-destructive">{error}</p>
          <Button type="button" variant="outline" onClick={onRetry}>
            Повторить
          </Button>
        </div>
      ) : null}
      <ul className="flex flex-col">
        {results.map((item) => (
          <li key={item.id} className="border-b border-border">
            <div className="flex items-center gap-3 px-4 py-3">
              <InitialAvatar username={item.username} />
              <span className="min-w-0 flex-1 truncate font-semibold">{item.username}</span>
              <Button
                type="button"
                size="sm"
                disabled={opening}
                aria-label={`Написать ${item.username}`}
                onClick={() => void onWrite(item)}
              >
                {creatingUserId === item.id ? 'Открываем…' : 'Написать'}
              </Button>
            </div>
          </li>
        ))}
      </ul>
    </div>
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
