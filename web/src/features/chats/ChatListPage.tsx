import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
} from 'react'
import { Link, useLocation, useNavigate, useParams } from 'react-router'
import { MessageCircle, Plus, Search } from 'lucide-react'
import type { UserSummary } from '@/api/auth'
import { searchUsers } from '@/api/auth'
import { createPersonalChat, type ChatListItem } from '@/api/history'
import { AppNav } from '@/components/AppNav'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useAuth } from '@/features/auth/useAuth'
import { ChatThread } from '@/features/chats/ChatThread'
import { formatChatListTime } from '@/features/chats/formatChatListTime'
import { peerUsername } from '@/features/chats/peerUsername'
import {
  isValidUserSearchPrefix,
  normalizeUserSearchInput,
  USER_SEARCH_HINT,
} from '@/features/chats/userSearchPrefix'
import type { createChatListReader } from '@/features/ws/chatListReader'
import { useWs } from '@/features/ws/useWs'
import { cn } from '@/lib/utils'

const SEARCH_DEBOUNCE_MS = 300

type ListStatus = 'loading' | 'ready' | 'error'
type SearchStatus = 'idle' | 'loading' | 'ready' | 'error' | 'invalid'

interface ListLoad {
  reader: ReturnType<typeof createChatListReader>
  token: string
  running: boolean
  queued: boolean
  revision: number
}

/** Сохраняет только peerUsername из state навигации (без одноразового focusMessageId). */
function peerStateFrom(state: unknown): { peerUsername: string } | null {
  if (
    typeof state === 'object' &&
    state !== null &&
    'peerUsername' in state &&
    typeof state.peerUsername === 'string'
  ) {
    return { peerUsername: state.peerUsername }
  }
  return null
}

/** Главный экран списка чатов и поиска пользователей (#43). */
export function ChatListPage() {
  const { user, accessToken, logout } = useAuth()
  const { client, snapshot, chatList } = useWs()
  const { liveMessageVersion, recoveryVersion } = snapshot
  const { chatId } = useParams()
  const location = useLocation()
  const navigate = useNavigate()
  const searchId = useId()
  const mountedRef = useRef(true)

  const [chats, setChats] = useState<ChatListItem[]>([])
  const [listStatus, setListStatus] = useState<ListStatus>('loading')
  const [listError, setListError] = useState<string | null>(null)

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
  const listLoadRef = useRef<ListLoad | null>(null)
  const signalsRef = useRef({ client, liveMessageVersion: 0, recoveryVersion: 0 })
  const locationKeyRef = useRef(location.key)

  useLayoutEffect(() => {
    locationKeyRef.current = location.key
  }, [location.key])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      openRequestRef.current += 1
      searchRequestRef.current += 1
    }
  }, [])

  const refreshChats = useCallback(
    async (reuse = false, afterMutation = false) => {
      const load = listLoadRef.current
      if (!load || load.reader !== chatList) return
      if (afterMutation) {
        // An earlier GET may contain data from before POST /read or chat creation.
        load.revision += 1
        chatList.invalidate()
      }
      if (load.running) {
        load.queued = true
        return
      }

      load.running = true
      let reuseResponse = reuse
      do {
        load.queued = false
        const revision = load.revision
        try {
          const response = await chatList.load(load.token, reuseResponse)
          if (listLoadRef.current !== load) return
          // Live events queue a refresh while this successful result is still useful.
          if (load.revision === revision) {
            setChats(response.chats)
            setListStatus('ready')
            setListError(null)
          }
        } catch {
          if (listLoadRef.current !== load) return
          if (load.revision === revision) {
            setListError('Не удалось загрузить чаты. Повторите попытку.')
            setListStatus((status) => (status === 'ready' ? 'ready' : 'error'))
          }
        }
        reuseResponse = false
      } while (load.queued)
      load.running = false
    },
    [chatList],
  )

  const reloadChats = useCallback(() => void refreshChats(), [refreshChats])
  const reloadAfterMutation = useCallback(() => void refreshChats(false, true), [refreshChats])

  useEffect(() => {
    if (!accessToken) return
    listLoadRef.current = {
      reader: chatList,
      token: accessToken,
      running: false,
      queued: false,
      revision: 0,
    }
    const timer = window.setTimeout(() => void refreshChats(), 0)
    return () => {
      window.clearTimeout(timer)
      listLoadRef.current = null
    }
  }, [accessToken, chatList, refreshChats])

  useEffect(() => {
    const previous = signalsRef.current
    signalsRef.current = { client, liveMessageVersion, recoveryVersion }
    if (!client) return
    const sameClient = previous.client === client
    const receivedLive = liveMessageVersion > (sameClient ? previous.liveMessageVersion : 0)
    const recovered = recoveryVersion > (sameClient ? previous.recoveryVersion : 0)
    if (receivedLive || recovered) {
      // Reuse the list fetched by successful History catch-up, even if its message page was empty.
      void refreshChats(!receivedLive)
    }
  }, [client, liveMessageVersion, recoveryVersion, refreshChats])

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

  async function openChatWithUser(target: UserSummary) {
    if (!accessToken || creatingUserId !== null) return
    const requestId = ++openRequestRef.current
    const startedAtLocationKey = locationKeyRef.current
    setCreatingUserId(target.id)
    setOpenError(null)
    setSearchError(null)
    try {
      const chat = await createPersonalChat(target.id, accessToken)
      if (requestId !== openRequestRef.current || !mountedRef.current) return
      reloadAfterMutation()
      if (locationKeyRef.current !== startedAtLocationKey) return
      setQuery('')
      navigate(`/chats/${chat.id}`, { state: { peerUsername: target.username } })
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

  /** focusMessageId одноразовый: после приёма ChatThread убираем его из history state. */
  const consumeFocusMessage = useCallback(() => {
    navigate(location.pathname, {
      replace: true,
      state: peerStateFrom(location.state),
    })
  }, [location.pathname, location.state, navigate])

  const peerFromState =
    typeof location.state === 'object' &&
    location.state !== null &&
    'peerUsername' in location.state &&
    typeof location.state.peerUsername === 'string'
      ? location.state.peerUsername
      : null
  const focusMessageId =
    typeof location.state === 'object' &&
    location.state !== null &&
    'focusMessageId' in location.state &&
    typeof location.state.focusMessageId === 'string'
      ? location.state.focusMessageId
      : null
  const selectedChat = chatId ? chats.find((chat) => chat.id === chatId) : undefined
  const selectedPeer = chatId
    ? (selectedChat && user ? peerUsername(selectedChat.members, user.id) : null) || peerFromState
    : null

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-background text-foreground md:flex-row">
      {/* Mobile/tablet: hide nav in thread (Figma full-bleed chat). Desktop keeps rail. */}
      <AppNav
        active="chats"
        onLogout={() => void logout()}
        className={cn('order-last md:order-first', chatId && 'max-lg:hidden')}
      />

      <aside
        className={cn(
          'min-h-0 min-w-0 flex-1 flex-col bg-card',
          // Tablet: full width after rail. Desktop: narrow list + split.
          'lg:max-w-[380px] lg:border-r lg:border-border',
          chatId ? 'hidden lg:flex' : 'flex',
        )}
      >
        <header className="flex items-center justify-between gap-3 px-4 pt-5 pb-3">
          <h1 className="text-xl font-semibold tracking-tight">Чаты</h1>
          <Button
            type="button"
            size="icon"
            // Figma 415:8511 — solid primary circle, white +
            className="size-10 rounded-full bg-primary bg-none from-transparent to-transparent text-white hover:opacity-90"
            aria-label="Новый чат"
            onClick={() => focusSearch()}
          >
            <Plus className="size-5" strokeWidth={2.5} />
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
              placeholder="найти"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value)
                setOpenError(null)
              }}
              className="h-10 rounded-full border-transparent bg-muted pl-9 focus-visible:border-border focus-visible:bg-card"
              autoComplete="off"
            />
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto overscroll-y-contain">
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

      <main
        className={cn(
          'min-h-0 min-w-0 flex-1 bg-background',
          // Empty «Выберите чат» only on desktop split (Figma tablet = list OR thread).
          chatId ? 'flex' : 'hidden items-center justify-center lg:flex',
        )}
      >
        {chatId ? (
          <ChatThread
            key={chatId}
            chatId={chatId}
            peerUsername={selectedPeer}
            onReadCommitted={reloadAfterMutation}
            focusMessageId={focusMessageId}
            onFocusConsumed={consumeFocusMessage}
          />
        ) : (
          <ChatNotSelectedPanel onFindPerson={() => focusSearch()} />
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

  const refreshErrorBanner = error ? (
    <div className="flex flex-col items-start gap-2 border-b border-border px-4 py-3" role="alert">
      <p className="text-sm text-destructive">{error}</p>
      <Button type="button" variant="outline" size="sm" onClick={onRetry}>
        Повторить
      </Button>
    </div>
  ) : null

  if (chats.length === 0) {
    return (
      <div className="flex flex-col">
        {refreshErrorBanner}
        <div className="flex flex-col items-center gap-4 px-6 py-12 text-center">
          <span
            aria-hidden
            className="inline-flex size-14 items-center justify-center rounded-full bg-muted text-muted-foreground"
          >
            <MessageCircle className="size-7" />
          </span>
          <div className="space-y-1">
            <p className="text-base font-semibold text-foreground">Начните переписку</p>
            <p className="text-sm text-muted-foreground">
              У вас пока нет чатов. Найдите человека по логину и напишите первое сообщение.
            </p>
          </div>
          <Button type="button" onClick={onFindPerson}>
            Найти человека
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-col">
      {refreshErrorBanner}
      <ul className="flex flex-col">
        {chats.map((chat) => {
          const name = peerUsername(chat.members, currentUserId)
          const preview = chat.last_message?.body ?? 'Нет сообщений'
          const time = chat.last_message ? formatChatListTime(chat.last_message.created_at) : ''
          const selected = chat.id === selectedChatId

          return (
            <li key={chat.id}>
              <Link
                to={`/chats/${chat.id}`}
                className={cn(
                  // Figma 415:8501 — мягкий muted-фон выбранной строки (не solid primary)
                  'mx-2 flex items-center gap-3 rounded-xl px-3 py-3 transition-colors hover:bg-muted/80',
                  selected && 'bg-muted',
                )}
              >
                <InitialAvatar username={name} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate font-semibold">{name}</span>
                    {time ? (
                      <span className="shrink-0 text-[11px] text-muted-foreground">{time}</span>
                    ) : null}
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-sm text-muted-foreground">{preview}</span>
                    {chat.unread_count > 0 ? (
                      <span className="inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-primary px-1 text-[11px] font-medium text-white">
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
    </div>
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
    return (
      <div className="flex flex-col items-center gap-3 px-6 py-12 text-center">
        <span
          aria-hidden
          className="inline-flex size-12 items-center justify-center rounded-full bg-muted text-muted-foreground"
        >
          <Search className="size-5" />
        </span>
        <div className="space-y-1">
          <p className="text-base font-semibold text-foreground">Никого не нашли</p>
          <p className="text-sm text-muted-foreground">
            Проверьте логин: только латиница, цифры и _ , от 3 символов.
          </p>
        </div>
      </div>
    )
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
      <p className="px-4 pt-2 pb-1 text-xs font-medium tracking-wide text-muted-foreground uppercase">
        Люди
      </p>
      <ul className="flex flex-col">
        {results.map((item) => (
          <li key={item.id} className="border-b border-border">
            <div className="flex items-center gap-3 px-4 py-3">
              <InitialAvatar username={item.username} />
              <div className="min-w-0 flex-1">
                <p className="truncate font-semibold">{item.username}</p>
                <p className="truncate text-xs text-muted-foreground">@{item.username}</p>
              </div>
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

function ChatNotSelectedPanel({ onFindPerson }: { onFindPerson: () => void }) {
  return (
    <div className="flex max-w-md flex-col items-center gap-4 px-8 text-center">
      <span
        aria-hidden
        className="inline-flex size-16 items-center justify-center rounded-full bg-muted text-muted-foreground"
      >
        <MessageCircle className="size-8" />
      </span>
      <div className="space-y-2">
        <h2 className="text-lg font-semibold tracking-tight">Выберите чат</h2>
        <p className="text-sm text-muted-foreground">
          Откройте диалог слева или найдите человека по логину, чтобы начать переписку.
        </p>
      </div>
      <Button type="button" variant="outline" onClick={onFindPerson}>
        Найти человека
      </Button>
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
