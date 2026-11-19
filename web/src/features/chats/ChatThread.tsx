import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type UIEvent,
} from 'react'
import { Link } from 'react-router'
import {
  ArrowLeft,
  Check,
  CircleAlert,
  LoaderCircle,
  MessageCircle,
  RotateCcw,
  SendHorizontal,
} from 'lucide-react'
import { getMessageHistory, markChatRead, type Message } from '@/api/history'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useAuth } from '@/features/auth/useAuth'
import { connectionStatusLabel } from '@/features/chats/connectionStatus'
import { formatChatListTime } from '@/features/chats/formatChatListTime'
import { resolveMarkReadSeq } from '@/features/chats/markReadSeq'
import { mergeThreadMessages, type ThreadMessage } from '@/features/chats/mergeThreadMessages'
import { useWs } from '@/features/ws/useWs'
import { cn } from '@/lib/utils'

const HISTORY_PAGE_SIZE = 50
const MAX_BODY_LENGTH = 4096

type HistoryStatus = 'loading' | 'ready' | 'error' | 'empty'

interface ChatThreadProps {
  chatId: string
  peerUsername: string | null
  onReadCommitted?: () => void
}

/** Окно переписки: REST-история вверх, WS send/ack/new, mark-read, индикатор связи. */
export function ChatThread({ chatId, peerUsername, onReadCommitted }: ChatThreadProps) {
  const { user, accessToken } = useAuth()
  const { client, snapshot } = useWs()
  const composerId = useId()
  const listRef = useRef<HTMLDivElement>(null)
  const stickToBottomRef = useRef(true)
  const markedSeqRef = useRef(0)
  const markInFlightRef = useRef(false)
  const pendingMarkSeqRef = useRef(0)
  const visibleSeqsRef = useRef(new Set<number>())
  const historyRequestRef = useRef(0)
  const messageNodeRefs = useRef(new Map<number, Element>())

  const [history, setHistory] = useState<Message[]>([])
  const [historyStatus, setHistoryStatus] = useState<HistoryStatus>('loading')
  const [historyError, setHistoryError] = useState<string | null>(null)
  const [hasMoreBefore, setHasMoreBefore] = useState(false)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const [draft, setDraft] = useState('')
  const [sendError, setSendError] = useState<string | null>(null)
  const [visibilityTick, setVisibilityTick] = useState(0)
  const [visibleSeqs, setVisibleSeqs] = useState<readonly number[]>([])
  const [showNewMessagesChip, setShowNewMessagesChip] = useState(false)
  const lastIncomingKeyRef = useRef<string | null>(null)

  const loadInitial = useCallback(async () => {
    if (!accessToken) return
    const requestId = ++historyRequestRef.current
    setHistoryStatus('loading')
    setHistoryError(null)
    try {
      const page = await getMessageHistory(chatId, accessToken, { limit: HISTORY_PAGE_SIZE })
      if (requestId !== historyRequestRef.current) return
      setHistory(page.messages)
      setHasMoreBefore(page.has_more_before)
      setHistoryStatus(page.messages.length === 0 ? 'empty' : 'ready')
      stickToBottomRef.current = true
    } catch {
      if (requestId !== historyRequestRef.current) return
      setHistoryStatus('error')
      setHistoryError('Не удалось загрузить сообщения. Повторите попытку.')
    }
  }, [accessToken, chatId])

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadInitial()
    }, 0)
    return () => {
      window.clearTimeout(timer)
      historyRequestRef.current += 1
    }
  }, [loadInitial])

  const loadOlder = useCallback(async () => {
    if (!accessToken || loadingOlder || !hasMoreBefore || history.length === 0) return
    const oldest = history[0]
    if (!oldest) return
    const list = listRef.current
    const previousHeight = list?.scrollHeight ?? 0
    setLoadingOlder(true)
    try {
      const page = await getMessageHistory(chatId, accessToken, {
        beforeSeq: oldest.seq,
        limit: HISTORY_PAGE_SIZE,
      })
      setHistory((prev) => {
        const seen = new Set(prev.map((item) => item.id))
        const older = page.messages.filter((item) => !seen.has(item.id))
        return [...older, ...prev]
      })
      setHasMoreBefore(page.has_more_before)
      setHistoryStatus('ready')
      requestAnimationFrame(() => {
        if (!list) return
        list.scrollTop = list.scrollHeight - previousHeight
      })
    } catch {
      setHistoryError('Не удалось подгрузить историю.')
    } finally {
      setLoadingOlder(false)
    }
  }, [accessToken, chatId, hasMoreBefore, history, loadingOlder])

  const messages = useMemo(() => {
    if (!user) return []
    return mergeThreadMessages({
      currentUserId: user.id,
      chatId,
      history,
      wsMessages: snapshot.messages,
      pending: snapshot.pending,
    })
  }, [chatId, history, snapshot.messages, snapshot.pending, user])

  useEffect(() => {
    if (!stickToBottomRef.current) return
    const list = listRef.current
    if (!list) return
    list.scrollTop = list.scrollHeight
  }, [messages])

  useEffect(() => {
    const latestIncomingKey =
      [...messages].reverse().find((item) => !item.mine)?.key ?? null

    if (stickToBottomRef.current) {
      lastIncomingKeyRef.current = latestIncomingKey
      setShowNewMessagesChip(false)
      return
    }

    if (latestIncomingKey != null && latestIncomingKey !== lastIncomingKeyRef.current) {
      if (lastIncomingKeyRef.current != null) {
        setShowNewMessagesChip(true)
      }
      lastIncomingKeyRef.current = latestIncomingKey
    }
  }, [messages])

  const connectionLabel = connectionStatusLabel(snapshot.transport)
  const syncedCursor = client?.getSyncedCursor(chatId) ?? 0

  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') return
    const root = listRef.current
    if (!root) return

    // Только фактическое пересечение с viewport — порог 80 px для stick-to-bottom сюда не переносим.
    const observer = new IntersectionObserver(
      (entries) => {
        let changed = false
        for (const entry of entries) {
          if (!entry.isIntersecting) continue
          const seqAttr = (entry.target as HTMLElement).dataset.seq
          const seq = seqAttr ? Number(seqAttr) : NaN
          if (!Number.isFinite(seq) || seq <= 0 || visibleSeqsRef.current.has(seq)) continue
          visibleSeqsRef.current.add(seq)
          changed = true
        }
        if (changed) {
          setVisibleSeqs(Array.from(visibleSeqsRef.current).sort((a, b) => a - b))
        }
      },
      { root, threshold: 0.6 },
    )

    for (const node of messageNodeRefs.current.values()) {
      observer.observe(node)
    }

    return () => observer.disconnect()
  }, [messages])

  useEffect(() => {
    if (!accessToken || !user || document.hidden) return
    if (historyStatus !== 'ready' && historyStatus !== 'empty') return

    const seqToMark = resolveMarkReadSeq({
      visibleSeqs,
      messages,
      historySyncState: snapshot.history,
      syncedCursor,
    })
    if (seqToMark <= markedSeqRef.current) return

    if (markInFlightRef.current) {
      pendingMarkSeqRef.current = Math.max(pendingMarkSeqRef.current, seqToMark)
      return
    }

    markInFlightRef.current = true
    const requested = seqToMark
    void markChatRead(chatId, requested, accessToken)
      .then(() => {
        if (requested > markedSeqRef.current) markedSeqRef.current = requested
        onReadCommitted?.()
      })
      .catch(() => {
        // Временная ошибка: повторим, когда снова изменится лента / видимость.
      })
      .finally(() => {
        markInFlightRef.current = false
        const pending = pendingMarkSeqRef.current
        pendingMarkSeqRef.current = 0
        if (pending > markedSeqRef.current) {
          setVisibilityTick((value) => value + 1)
        }
      })
  }, [
    accessToken,
    chatId,
    historyStatus,
    messages,
    onReadCommitted,
    snapshot.history,
    syncedCursor,
    user,
    visibilityTick,
    visibleSeqs,
  ])

  useEffect(() => {
    const onVisibility = () => {
      if (!document.hidden) setVisibilityTick((value) => value + 1)
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => document.removeEventListener('visibilitychange', onVisibility)
  }, [])

  const onScroll = (event: UIEvent<HTMLDivElement>) => {
    const target = event.currentTarget
    const distanceFromBottom = target.scrollHeight - target.scrollTop - target.clientHeight
    const atBottom = distanceFromBottom < 80
    stickToBottomRef.current = atBottom
    if (atBottom) setShowNewMessagesChip(false)
    if (target.scrollTop < 48) void loadOlder()
  }

  const bindMessageNode = (seq: number | undefined, node: HTMLElement | null) => {
    if (seq == null) return
    if (node) messageNodeRefs.current.set(seq, node)
    else messageNodeRefs.current.delete(seq)
  }

  const send = (event: FormEvent) => {
    event.preventDefault()
    const body = draft.trim()
    if (!body || !client || !user) return
    if (body.length > MAX_BODY_LENGTH) {
      setSendError(`Сообщение не длиннее ${MAX_BODY_LENGTH} символов`)
      return
    }
    if (snapshot.transport === 'auth_failed' || snapshot.transport === 'stopped') {
      setSendError('Нет соединения для отправки')
      return
    }
    try {
      client.sendMessage(chatId, body)
      setDraft('')
      setSendError(null)
      stickToBottomRef.current = true
      if (historyStatus === 'empty') setHistoryStatus('ready')
    } catch {
      setSendError('Не удалось отправить сообщение')
    }
  }

  const retry = (message: ThreadMessage) => {
    if (!client || !message.clientMsgId) return
    client.retryMessage(message.clientMsgId)
  }

  const title = peerUsername?.trim() || 'Чат'
  const letter = title.charAt(0).toUpperCase() || '?'

  return (
    <section
      className="flex h-full min-h-0 w-full flex-col bg-background"
      aria-label={`Чат с ${title}`}
    >
      <header className="flex items-center gap-3 border-b border-border px-3 py-3 md:px-5">
        <Link
          to="/"
          className="inline-flex size-9 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent md:hidden"
          aria-label="К списку чатов"
        >
          <ArrowLeft className="size-5" />
        </Link>
        <span
          aria-hidden
          className="inline-flex size-10 shrink-0 items-center justify-center rounded-full bg-[color-mix(in_oklab,var(--brand-button-to)_35%,white)] text-sm font-semibold"
        >
          {letter}
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-base font-semibold">{title}</h2>
          {connectionLabel ? (
            <p className="truncate text-xs text-amber-700 dark:text-amber-400" role="status">
              {connectionLabel}
            </p>
          ) : null}
        </div>
      </header>

      {connectionLabel ? (
        <div
          className="border-b border-amber-200 bg-amber-50 px-4 py-2 text-center text-sm text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/40 dark:text-amber-100"
          role="status"
        >
          {connectionLabel}
        </div>
      ) : null}

      <div
        ref={listRef}
        className="min-h-0 flex-1 overflow-y-auto px-3 py-4 md:px-6"
        onScroll={onScroll}
        data-testid="chat-thread-scroll"
      >
        {historyStatus === 'loading' ? (
          <p className="py-10 text-center text-sm text-muted-foreground" role="status">
            Загрузка сообщений…
          </p>
        ) : null}

        {historyStatus === 'error' ? (
          <div className="flex flex-col items-center gap-3 py-10" role="alert">
            <p className="text-sm text-destructive">{historyError}</p>
            <Button type="button" variant="outline" onClick={() => void loadInitial()}>
              Повторить
            </Button>
          </div>
        ) : null}

        {historyStatus === 'empty' && messages.length === 0 ? (
          <div className="flex flex-col items-center gap-3 py-16 text-center">
            <span
              aria-hidden
              className="inline-flex size-14 items-center justify-center rounded-full bg-muted text-muted-foreground"
            >
              <MessageCircle className="size-7" />
            </span>
            <div className="space-y-1">
              <p className="text-base font-semibold">Напишите первое сообщение</p>
              <p className="text-sm text-muted-foreground">Сообщения появятся в этом окне</p>
            </div>
          </div>
        ) : null}

        {loadingOlder ? (
          <p className="pb-3 text-center text-xs text-muted-foreground" role="status">
            Загрузка истории…
          </p>
        ) : null}

        {historyError && historyStatus === 'ready' ? (
          <p className="pb-3 text-center text-xs text-destructive" role="status">
            {historyError}
          </p>
        ) : null}

        {showNewMessagesChip ? (
          <div className="sticky top-0 z-10 mb-3 flex justify-center">
            <button
              type="button"
              className="rounded-full border border-border bg-card px-3 py-1 text-xs font-medium shadow-sm"
              onClick={() => {
                stickToBottomRef.current = true
                setShowNewMessagesChip(false)
                const list = listRef.current
                if (list) list.scrollTop = list.scrollHeight
              }}
            >
              Новые сообщения
            </button>
          </div>
        ) : null}

        <ul className="flex flex-col gap-2">
          {messages.map((message) => (
            <li
              key={message.key}
              ref={(node) => bindMessageNode(message.seq, node)}
              data-seq={message.seq}
              className={cn(
                'group/bubble flex',
                message.mine ? 'justify-end' : 'justify-start',
                message.mine &&
                  message.status === 'sending' &&
                  'animate-in fade-in slide-in-from-bottom-1 duration-200',
              )}
            >
              <div
                className={cn(
                  'max-w-[min(100%,28rem)] rounded-2xl px-3 py-2 text-sm shadow-sm transition-shadow',
                  message.mine
                    ? 'rounded-br-md bg-primary text-primary-foreground'
                    : 'rounded-bl-md bg-muted text-foreground',
                  message.status === 'failed' && 'ring-2 ring-destructive/60',
                  message.status === 'sending' && 'opacity-80',
                  'group-hover/bubble:shadow-md',
                )}
              >
                <p className="whitespace-pre-wrap break-words">{message.body}</p>
                <div
                  className={cn(
                    'mt-1 flex items-center justify-end gap-1.5 text-[11px]',
                    message.mine ? 'text-primary-foreground/80' : 'text-muted-foreground',
                  )}
                >
                  {message.createdAt && message.status !== 'sending' ? (
                    <time dateTime={message.createdAt}>
                      {formatChatListTime(message.createdAt)}
                    </time>
                  ) : null}
                  {message.mine ? <StatusLabel status={message.status} /> : null}
                  {message.status === 'failed' ? (
                    <button
                      type="button"
                      className="inline-flex items-center gap-1 underline-offset-2 hover:underline"
                      onClick={() => retry(message)}
                      aria-label="Повторить отправку"
                    >
                      <RotateCcw className="size-3" />
                      Повторить
                    </button>
                  ) : null}
                </div>
              </div>
            </li>
          ))}
        </ul>
      </div>

      <form
        onSubmit={send}
        className="flex items-end gap-2 border-t border-border bg-card px-3 py-3 md:px-5"
      >
        <label htmlFor={composerId} className="sr-only">
          Сообщение
        </label>
        <Input
          id={composerId}
          value={draft}
          onChange={(event) => {
            setDraft(event.target.value)
            setSendError(null)
          }}
          placeholder="Написать сообщение"
          maxLength={MAX_BODY_LENGTH}
          autoComplete="off"
          className="min-h-11 flex-1 rounded-full border-transparent bg-muted px-4"
          aria-invalid={Boolean(sendError)}
        />
        <Button
          type="submit"
          size="icon"
          className="size-11 rounded-full"
          disabled={!draft.trim() || !client}
          aria-label="Отправить"
        >
          <SendHorizontal className="size-4" />
        </Button>
      </form>
      {sendError ? (
        <p className="px-4 pb-2 text-xs text-destructive" role="alert">
          {sendError}
        </p>
      ) : null}
    </section>
  )
}

function StatusLabel({ status }: { status: ThreadMessage['status'] }) {
  if (status === 'sending') {
    return (
      <span className="inline-flex items-center gap-1" title="Отправляется">
        <LoaderCircle className="size-3 animate-spin" aria-hidden />
        <span className="sr-only">отправляется</span>
      </span>
    )
  }
  if (status === 'failed') {
    return (
      <span className="inline-flex items-center gap-1" title="Ошибка">
        <CircleAlert className="size-3" aria-hidden />
        <span className="sr-only">ошибка</span>
      </span>
    )
  }
  if (status === 'sent') {
    return (
      <span className="inline-flex items-center gap-1" title="Отправлено">
        <Check className="size-3" aria-hidden />
        <span className="sr-only">отправлено</span>
      </span>
    )
  }
  return null
}
