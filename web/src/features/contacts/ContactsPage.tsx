import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { ArrowLeft, LogOut, MessageCircle, Search, User, UserPlus, Users } from 'lucide-react'
import { addContact, getContacts, removeContact, searchUsers, type UserSummary } from '@/api/auth'
import { createPersonalChat } from '@/api/history'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useAuth } from '@/features/auth/useAuth'
import {
  isValidUserSearchPrefix,
  normalizeUserSearchInput,
  USER_SEARCH_HINT,
} from '@/features/chats/userSearchPrefix'

const SEARCH_DEBOUNCE_MS = 300

type ListStatus = 'loading' | 'ready' | 'error'

/** Экран контактов (#70): список, empty, локальный фильтр + глобальный поиск. */
export function ContactsPage() {
  const { user, accessToken, logout } = useAuth()
  const navigate = useNavigate()
  const searchId = useId()
  const mountedRef = useRef(true)
  const searchRequestRef = useRef(0)

  const [contacts, setContacts] = useState<UserSummary[]>([])
  const [listStatus, setListStatus] = useState<ListStatus>('loading')
  const [listError, setListError] = useState<string | null>(null)
  const [reloadKey, setReloadKey] = useState(0)

  const [query, setQuery] = useState('')
  const [globalResults, setGlobalResults] = useState<UserSummary[]>([])
  const [globalPrefix, setGlobalPrefix] = useState<string | null>(null)
  const [globalStatus, setGlobalStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle')
  const [busyId, setBusyId] = useState<string | null>(null)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      searchRequestRef.current += 1
    }
  }, [])

  useEffect(() => {
    if (!accessToken) return
    const timer = window.setTimeout(() => {
      void (async () => {
        setListStatus('loading')
        setListError(null)
        try {
          const response = await getContacts(accessToken)
          if (!mountedRef.current) return
          setContacts(response.contacts)
          setListStatus('ready')
        } catch {
          if (!mountedRef.current) return
          setListStatus((status) => (status === 'ready' ? 'ready' : 'error'))
          setListError('Не удалось загрузить контакты. Повторите попытку.')
        }
      })()
    }, 0)
    return () => window.clearTimeout(timer)
  }, [accessToken, reloadKey])

  const prefix = normalizeUserSearchInput(query)
  const searching = prefix.length > 0
  const searchInvalid = searching && !isValidUserSearchPrefix(prefix)

  useEffect(() => {
    if (!searching || searchInvalid || !accessToken || !user) {
      searchRequestRef.current += 1
      const clearTimer = window.setTimeout(() => {
        setGlobalResults([])
        setGlobalPrefix(null)
        setGlobalStatus('idle')
      }, 0)
      return () => window.clearTimeout(clearTimer)
    }
    const requestId = ++searchRequestRef.current
    const prefixForRequest = prefix
    const timer = window.setTimeout(() => {
      void (async () => {
        setGlobalStatus('loading')
        try {
          const response = await searchUsers(prefixForRequest, accessToken)
          if (requestId !== searchRequestRef.current) return
          setGlobalResults(response.users.filter((item) => item.id !== user.id))
          setGlobalPrefix(prefixForRequest)
          setGlobalStatus('ready')
        } catch {
          if (requestId !== searchRequestRef.current) return
          setGlobalResults([])
          setGlobalPrefix(prefixForRequest)
          setGlobalStatus('error')
        }
      })()
    }, SEARCH_DEBOUNCE_MS)
    return () => window.clearTimeout(timer)
  }, [accessToken, prefix, searchInvalid, searching, user])

  const contactIds = new Set(contacts.map((item) => item.id))
  const filteredContacts = searching
    ? contacts.filter((item) => item.username.toLowerCase().includes(prefix.toLowerCase()))
    : contacts
  const globalVisible =
    globalPrefix === prefix && globalStatus === 'ready'
      ? globalResults.filter((item) => !contactIds.has(item.id))
      : []

  const openChat = useCallback(
    async (target: UserSummary) => {
      if (!accessToken || busyId) return
      setBusyId(target.id)
      try {
        const chat = await createPersonalChat(target.id, accessToken)
        if (!mountedRef.current) return
        navigate(`/chats/${chat.id}`, { state: { peerUsername: target.username } })
      } finally {
        if (mountedRef.current) setBusyId(null)
      }
    },
    [accessToken, busyId, navigate],
  )

  const toggleContact = useCallback(
    async (target: UserSummary, isContact: boolean) => {
      if (!accessToken || busyId) return
      setBusyId(target.id)
      try {
        if (isContact) await removeContact(target.id, accessToken)
        else await addContact(target.id, accessToken)
        if (!mountedRef.current) return
        setReloadKey((value) => value + 1)
      } finally {
        if (mountedRef.current) setBusyId(null)
      }
    },
    [accessToken, busyId],
  )

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
            title="Чаты"
          >
            <MessageCircle className="size-5" />
          </Link>
          <span
            className="inline-flex size-10 items-center justify-center rounded-lg bg-accent text-foreground"
            aria-label="Контакты"
            title="Контакты"
            aria-current="page"
          >
            <Users className="size-5" />
          </span>
        </div>
        <div className="flex flex-col items-center gap-2">
          <Link
            to="/change-password"
            className="inline-flex size-10 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent"
            aria-label="Профиль"
          >
            <User className="size-5" />
          </Link>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Выйти"
            onClick={() => void logout()}
          >
            <LogOut className="size-4" />
          </Button>
        </div>
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
          <h1 className="text-xl font-semibold tracking-tight">Контакты</h1>
        </header>

        <div className="px-4 pb-3">
          <label htmlFor={searchId} className="sr-only">
            Поиск контактов и людей
          </label>
          <div className="relative">
            <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              id={searchId}
              role="searchbox"
              aria-label="Поиск контактов и людей"
              placeholder="Поиск по логину"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              className="h-10 rounded-full border-transparent bg-muted pl-9"
              autoComplete="off"
            />
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {searchInvalid ? (
            <p className="px-4 py-6 text-sm text-muted-foreground">{USER_SEARCH_HINT}</p>
          ) : null}

          {listStatus === 'loading' ? (
            <p className="px-4 py-6 text-sm text-muted-foreground" role="status">
              Загрузка контактов…
            </p>
          ) : null}

          {listStatus === 'error' && contacts.length === 0 ? (
            <div className="flex flex-col items-start gap-3 px-4 py-6" role="alert">
              <p className="text-sm text-destructive">{listError}</p>
              <Button type="button" variant="outline" onClick={() => setReloadKey((v) => v + 1)}>
                Повторить
              </Button>
            </div>
          ) : null}

          {listStatus === 'ready' && !searching && contacts.length === 0 ? (
            <div className="flex flex-col items-center gap-4 px-6 py-12 text-center">
              <span
                aria-hidden
                className="inline-flex size-14 items-center justify-center rounded-full bg-muted text-muted-foreground"
              >
                <Users className="size-7" />
              </span>
              <div className="space-y-1">
                <p className="text-base font-semibold">Пока нет контактов</p>
                <p className="text-sm text-muted-foreground">
                  Найдите человека по логину и добавьте в контакты или сразу напишите.
                </p>
              </div>
            </div>
          ) : null}

          {filteredContacts.length > 0 ? (
            <div>
              <p className="px-4 pt-2 pb-1 text-xs font-medium tracking-wide text-muted-foreground uppercase">
                Контакты
              </p>
              <ul>
                {filteredContacts.map((item) => (
                  <ContactRow
                    key={item.id}
                    user={item}
                    isContact
                    busy={busyId === item.id}
                    disabled={busyId !== null}
                    onWrite={() => void openChat(item)}
                    onToggle={() => void toggleContact(item, true)}
                  />
                ))}
              </ul>
            </div>
          ) : null}

          {searching && !searchInvalid ? (
            <div>
              <p className="px-4 pt-3 pb-1 text-xs font-medium tracking-wide text-muted-foreground uppercase">
                Найдено
              </p>
              {globalStatus === 'loading' ? (
                <p className="px-4 py-4 text-sm text-muted-foreground">Ищем пользователей…</p>
              ) : null}
              {globalStatus === 'error' ? (
                <p className="px-4 py-4 text-sm text-destructive" role="alert">
                  Не удалось найти пользователей
                </p>
              ) : null}
              {globalStatus === 'ready' &&
              globalVisible.length === 0 &&
              filteredContacts.length === 0 ? (
                <p className="px-4 py-6 text-sm text-muted-foreground">Никого не нашли</p>
              ) : null}
              <ul>
                {globalVisible.map((item) => (
                  <ContactRow
                    key={item.id}
                    user={item}
                    isContact={false}
                    busy={busyId === item.id}
                    disabled={busyId !== null}
                    onWrite={() => void openChat(item)}
                    onToggle={() => void toggleContact(item, false)}
                  />
                ))}
              </ul>
            </div>
          ) : null}

          {listError && listStatus === 'ready' ? (
            <div className="border-t border-border px-4 py-3" role="alert">
              <p className="text-sm text-destructive">{listError}</p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="mt-2"
                onClick={() => setReloadKey((v) => v + 1)}
              >
                Повторить
              </Button>
            </div>
          ) : null}
        </div>
      </section>

      <main className="hidden min-w-0 flex-1 items-center justify-center bg-muted/20 md:flex">
        <p className="max-w-sm px-6 text-center text-sm text-muted-foreground">
          Выберите контакт или найдите человека, чтобы начать переписку
        </p>
      </main>
    </div>
  )
}

function ContactRow({
  user,
  isContact,
  busy,
  disabled,
  onWrite,
  onToggle,
}: {
  user: UserSummary
  isContact: boolean
  busy: boolean
  disabled: boolean
  onWrite: () => void
  onToggle: () => void
}) {
  const letter = user.username.trim().charAt(0).toUpperCase() || '?'
  return (
    <li className="border-b border-border">
      <div className="flex items-center gap-3 px-4 py-3">
        <span
          aria-hidden
          className="inline-flex size-10 shrink-0 items-center justify-center rounded-full bg-[color-mix(in_oklab,var(--brand-button-to)_35%,white)] text-sm font-semibold"
        >
          {letter}
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate font-semibold">{user.username}</p>
          <p className="truncate text-xs text-muted-foreground">@{user.username}</p>
        </div>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={disabled}
          aria-label={isContact ? `Удалить ${user.username}` : `Добавить ${user.username}`}
          onClick={onToggle}
        >
          {busy ? '…' : isContact ? 'Удалить' : <UserPlus className="size-4" />}
        </Button>
        <Button
          type="button"
          size="sm"
          disabled={disabled}
          aria-label={`Написать ${user.username}`}
          onClick={onWrite}
        >
          {busy ? '…' : 'Написать'}
        </Button>
      </div>
    </li>
  )
}
