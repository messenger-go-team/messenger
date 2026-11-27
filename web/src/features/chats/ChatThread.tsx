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
  ArrowUp,
} from 'lucide-react'
import { ApiError } from '@/api/client'
import { getMessageContext, getMessageHistory, markChatRead, type Message } from '@/api/history'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useAuth } from '@/features/auth/useAuth'
import { connectionStatusLabel } from '@/features/chats/connectionStatus'
import { formatChatListTime } from '@/features/chats/formatChatListTime'
import { resolveMarkReadSeq } from '@/features/chats/markReadSeq'
import { mergeThreadMessages, type ThreadMessage } from '@/features/chats/mergeThreadMessages'
import { dismissVirtualKeyboardAfterSend } from '@/lib/dismissVirtualKeyboard'
import { MessageLaterMenu } from '@/features/later/MessageLaterMenu'
import { useOptionalLaterReminders } from '@/features/later/useLaterReminders'
import { useWs } from '@/features/ws/useWs'
import { cn } from '@/lib/utils'

const HISTORY_PAGE_SIZE = 50
const MAX_BODY_LENGTH = 4096
/** Сколько держать подсветку после scrollIntoView; снятие анимируется CSS ~1s. */
const HIGHLIGHT_MS = 4500
const MESSAGE_UNAVAILABLE_NOTICE = 'Сообщение недоступно'

type HistoryStatus = 'loading' | 'ready' | 'error' | 'empty'

interface ChatThreadProps {
  chatId: string
  peerUsername: string | null
  onReadCommitted?: () => void
  /** Серверный id сообщения, к которому нужно перейти (Later: «Открыть» / ссылка в списке). */
  focusMessageId?: string | null
  /** Вызывается, когда ChatThread принял focusMessageId, чтобы родитель очистил одноразовый state. */
  onFocusConsumed?: () => void
}

/** Окно переписки: REST-история вверх, WS send/ack/new, mark-read, индикатор связи. */
export function ChatThread({
  chatId,
  peerUsername,
  onReadCommitted,
  focusMessageId,
  onFocusConsumed,
}: ChatThreadProps) {
  const { user, accessToken } = useAuth()
  const { client, snapshot } = useWs()
  const laterReminders = useOptionalLaterReminders()
  const composerId = useId()
  const listRef = useRef<HTMLDivElement>(null)
  const stickToBottomRef = useRef(true)
  const markedSeqRef = useRef(0)
  const markInFlightRef = useRef(false)
  const pendingMarkSeqRef = useRef(0)
  const visibleSeqsRef = useRef(new Set<number>())
  const historyRequestRef = useRef(0)
  const messageNodeRefs = useRef(new Map<number, Element>())
  const messageElByIdRef = useRef(new Map<string, HTMLElement>())
  /** Сообщение, к которому ещё нужно перейти; сохраняется при временной ошибке для retry. */
  const jumpTargetRef = useRef<string | null>(null)
  /** id, который нужно прокрутить и подсветить, когда строка появится в DOM. */
  const pendingScrollRef = useRef<string | null>(null)
  const initialLoadStartedRef = useRef(false)
  /** Пока грузится новое окно, before/after-пагинация старого окна запрещена. */
  const historyLoadingRef = useRef(false)
  const onFocusConsumedRef = useRef(onFocusConsumed)
  const accessTokenRef = useRef(accessToken)
  const laterRemindersRef = useRef(laterReminders)

  const [history, setHistory] = useState<Message[]>([])
  const [historyStatus, setHistoryStatus] = useState<HistoryStatus>('loading')
  const [historyError, setHistoryError] = useState<string | null>(null)
  const [hasMoreBefore, setHasMoreBefore] = useState(false)
  /** true, пока окно контекста не дошло до последнего сообщения чата. */
  const [hasMoreAfter, setHasMoreAfter] = useState(false)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const [loadingNewer, setLoadingNewer] = useState(false)
  const [highlightedId, setHighlightedId] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [sendError, setSendError] = useState<string | null>(null)
  const [visibilityTick, setVisibilityTick] = useState(0)
  const [visibleSeqs, setVisibleSeqs] = useState<readonly number[]>([])
  const [showNewMessagesChip, setShowNewMessagesChip] = useState(false)
  /** Тик после restore scroll (before_seq) — пересчитать chip по геометрии. */
  const [layoutTick, setLayoutTick] = useState(0)
  /**
   * Серверные message id, уже учтённые для chip.
   * Chip — только на первое появление входящего ниже/на нижней границе окна ленты.
   * before_seq помечает id без chip; seq только для порядка ленты.
   */
  const knownMessageIdsRef = useRef(new Set<string>())

  const loadInitial = useCallback(async () => {
    // Токен ротируется каждые ~14 мин: читаем актуальный, но не перезагружаем ленту (и окно прыжка).
    const accessToken = accessTokenRef.current
    if (!accessToken) return
    initialLoadStartedRef.current = true
    historyLoadingRef.current = true
    const requestId = ++historyRequestRef.current
    setHistoryStatus('loading')
    setHistoryError(null)
    knownMessageIdsRef.current = new Set()
    setShowNewMessagesChip(false)
    setHasMoreAfter(false)
    pendingScrollRef.current = null

    try {
      const applyPage = (
        messages: Message[],
        hasBefore: boolean,
        hasAfter: boolean,
        stickToBottom: boolean,
      ) => {
        setHistory(messages)
        setHasMoreBefore(hasBefore)
        setHasMoreAfter(hasAfter)
        setHistoryStatus(messages.length === 0 ? 'empty' : 'ready')
        stickToBottomRef.current = stickToBottom
        for (const item of messages) knownMessageIdsRef.current.add(item.id)
      }

      const target = jumpTargetRef.current
      if (target) {
        try {
          const context = await getMessageContext(chatId, target, accessToken, {
            limit: HISTORY_PAGE_SIZE,
          })
          if (requestId !== historyRequestRef.current) return
          jumpTargetRef.current = null
          pendingScrollRef.current = context.target_message_id
          applyPage(context.messages, context.has_more_before, context.has_more_after, false)
          return
        } catch (error) {
          if (requestId !== historyRequestRef.current) return
          if (!(error instanceof ApiError && error.status === 404)) {
            // Временная ошибка: цель сохраняем, «Повторить» снова запросит контекст.
            setHistoryStatus('error')
            setHistoryError('Не удалось открыть сообщение. Повторите попытку.')
            return
          }
          // 404: сообщение недоступно — убираем запись Later и показываем обычную ленту.
          jumpTargetRef.current = null
          const reminders = laterRemindersRef.current
          const stale = reminders?.entries.find((entry) => entry.message.id === target)
          if (stale) reminders?.removeEntry(stale.id)
          setNotice(MESSAGE_UNAVAILABLE_NOTICE)
        }
      }

      try {
        const page = await getMessageHistory(chatId, accessToken, { limit: HISTORY_PAGE_SIZE })
        if (requestId !== historyRequestRef.current) return
        applyPage(page.messages, page.has_more_before, false, true)
      } catch {
        if (requestId !== historyRequestRef.current) return
        setHistoryStatus('error')
        setHistoryError('Не удалось загрузить сообщения. Повторите попытку.')
      }
    } finally {
      if (requestId === historyRequestRef.current) historyLoadingRef.current = false
    }
  }, [chatId])

  useEffect(() => {
    accessTokenRef.current = accessToken
    laterRemindersRef.current = laterReminders
    onFocusConsumedRef.current = onFocusConsumed
  })

  // До mount-загрузки: запоминаем цель. Для уже открытого чата — сразу грузим её контекст.
  useEffect(() => {
    if (!focusMessageId) return
    jumpTargetRef.current = focusMessageId
    onFocusConsumedRef.current?.()
    if (initialLoadStartedRef.current) void loadInitial()
  }, [focusMessageId, loadInitial])

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
    if (historyLoadingRef.current) return
    // Только готовое окно: после 503 перехода loadOlder иначе снимет «Повторить».
    if (historyStatus !== 'ready') return
    if (!accessToken || loadingOlder || !hasMoreBefore || history.length === 0) return
    const oldest = history[0]
    if (!oldest) return
    const list = listRef.current
    const previousHeight = list?.scrollHeight ?? 0
    const requestId = historyRequestRef.current
    setLoadingOlder(true)
    try {
      const page = await getMessageHistory(chatId, accessToken, {
        beforeSeq: oldest.seq,
        limit: HISTORY_PAGE_SIZE,
      })
      // Окно могло смениться (прыжок к сообщению) — устаревшую страницу не подмешиваем.
      if (requestId !== historyRequestRef.current) return
      setHistory((prev) => {
        const seen = new Set(prev.map((item) => item.id))
        const older = page.messages.filter((item) => !seen.has(item.id))
        for (const item of older) knownMessageIdsRef.current.add(item.id)
        return [...older, ...prev]
      })
      setHasMoreBefore(page.has_more_before)
      setHistoryStatus('ready')
      requestAnimationFrame(() => {
        if (!list) return
        list.scrollTop = list.scrollHeight - previousHeight
        // После восстановления прокрутки — измерить новые входящие (WS во время before_seq).
        requestAnimationFrame(() => setLayoutTick((value) => value + 1))
      })
    } catch {
      setHistoryError('Не удалось подгрузить историю.')
    } finally {
      setLoadingOlder(false)
    }
  }, [accessToken, chatId, hasMoreBefore, history, historyStatus, loadingOlder])

  /** Продолжает обычную after_seq-пагинацию вниз от окна контекста до последнего сообщения. */
  const loadNewer = useCallback(async () => {
    if (historyLoadingRef.current) return
    if (historyStatus !== 'ready') return
    if (!accessToken || loadingNewer || !hasMoreAfter || history.length === 0) return
    const newest = history[history.length - 1]
    if (!newest) return
    const requestId = historyRequestRef.current
    setLoadingNewer(true)
    try {
      const page = await getMessageHistory(chatId, accessToken, {
        afterSeq: newest.seq,
        limit: HISTORY_PAGE_SIZE,
      })
      if (requestId !== historyRequestRef.current) return
      setHistory((prev) => {
        const seen = new Set(prev.map((item) => item.id))
        const newer = page.messages.filter((item) => !seen.has(item.id))
        // Догруженные вниз сообщения не должны показывать chip «Новые сообщения».
        for (const item of newer) knownMessageIdsRef.current.add(item.id)
        return [...prev, ...newer]
      })
      setHasMoreAfter(page.has_more_after)
      setHistoryError(null)
    } catch {
      setHistoryError('Не удалось подгрузить новые сообщения.')
    } finally {
      setLoadingNewer(false)
    }
  }, [accessToken, chatId, hasMoreAfter, history, historyStatus, loadingNewer])

  /** Выход из окна контекста к последним сообщениям чата. */
  const jumpToLatest = useCallback(() => {
    jumpTargetRef.current = null
    void loadInitial()
  }, [loadInitial])

  const messages = useMemo(() => {
    if (!user) return []
    return mergeThreadMessages({
      currentUserId: user.id,
      chatId,
      history,
      // Пока окно не дошло до конца чата, WS-сообщения новее окна не вставляем (дыра в ленте).
      windowMaxSeq: hasMoreAfter ? (history[history.length - 1]?.seq ?? null) : null,
      wsMessages: snapshot.messages,
      pending: snapshot.pending,
    })
  }, [chatId, hasMoreAfter, history, snapshot.messages, snapshot.pending, user])

  useEffect(() => {
    if (!stickToBottomRef.current) return
    const list = listRef.current
    if (!list) return
    list.scrollTop = list.scrollHeight
  }, [messages])

  useEffect(() => {
    if (stickToBottomRef.current) {
      for (const item of messages) {
        if (item.id) knownMessageIdsRef.current.add(item.id)
      }
      setShowNewMessagesChip(false)
      return
    }

    let cancelled = false
    const measure = () => {
      if (cancelled || stickToBottomRef.current) return
      const list = listRef.current
      if (!list) return
      const listBottom = list.getBoundingClientRect().bottom
      let showChip = false
      for (const item of messages) {
        if (!item.id) continue
        if (item.mine) {
          knownMessageIdsRef.current.add(item.id)
          continue
        }
        if (knownMessageIdsRef.current.has(item.id)) continue
        const row = messageElByIdRef.current.get(item.id)
        if (!row) continue
        const rowRect = row.getBoundingClientRect()
        // jsdom/нулевой layout: не фиксируем id, пока нет реальной геометрии (иначе chip теряется).
        if (rowRect.width === 0 && rowRect.height === 0) continue
        knownMessageIdsRef.current.add(item.id)
        // Верх строки на нижней границе окна или ниже → chip. Частично видимое / выше — нет.
        // Уже показанный chip не гасим видимым входящим.
        if (rowRect.top >= listBottom) showChip = true
      }
      if (showChip) setShowNewMessagesChip(true)
    }

    // Два кадра: после отрисовки строки и после возможного restore scroll.
    const frame = window.requestAnimationFrame(() => {
      window.requestAnimationFrame(measure)
    })
    return () => {
      cancelled = true
      window.cancelAnimationFrame(frame)
    }
  }, [layoutTick, messages])

  useEffect(() => {
    if (!highlightedId) return
    const timer = window.setTimeout(() => setHighlightedId(null), HIGHLIGHT_MS)
    return () => window.clearTimeout(timer)
  }, [highlightedId])

  useEffect(() => {
    if (!notice) return
    const timer = window.setTimeout(() => setNotice(null), 6000)
    return () => window.clearTimeout(timer)
  }, [notice])

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
    // В окне контекста низ ленты — не конец чата: к нему не «прилипаем».
    stickToBottomRef.current = atBottom && !hasMoreAfter
    if (atBottom) setShowNewMessagesChip(false)
    if (target.scrollTop < 48) void loadOlder()
    if (hasMoreAfter && distanceFromBottom < 48) void loadNewer()
  }

  const bindMessageNode = (message: ThreadMessage, node: HTMLElement | null) => {
    if (message.seq != null) {
      if (node) messageNodeRefs.current.set(message.seq, node)
      else messageNodeRefs.current.delete(message.seq)
    }
    if (message.id) {
      if (node) messageElByIdRef.current.set(message.id, node)
      else messageElByIdRef.current.delete(message.id)
      if (node && pendingScrollRef.current === message.id) {
        // Строка цели уже в DOM: прокрутить к центру и подсветить.
        pendingScrollRef.current = null
        node.scrollIntoView?.({ block: 'center' })
        setHighlightedId(message.id)
      }
    }
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
      // Отправка из окна контекста возвращает ленту к последним сообщениям.
      if (hasMoreAfter) jumpToLatest()
      if (historyStatus === 'empty') setHistoryStatus('ready')
      // Touch: свернуть virtual keyboard. Desktop: фокус в композере сохраняем (Enter → снова печатать).
      dismissVirtualKeyboardAfterSend()
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
      <header className="flex items-center gap-3 border-b border-border px-3 py-3 md:px-5 lg:px-6">
        <Link
          to="/"
          className="inline-flex size-9 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent lg:hidden"
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

      {notice ? (
        <p
          className="border-b border-border bg-muted px-4 py-2 text-center text-sm text-muted-foreground"
          role="status"
        >
          {notice}
        </p>
      ) : null}

      <div
        ref={listRef}
        className="relative min-h-0 flex-1 overflow-y-auto overscroll-y-contain px-3 py-4 md:px-5 lg:px-6"
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
              ref={(node) => bindMessageNode(message, node)}
              data-seq={message.seq}
              data-message-id={message.id}
              data-highlighted={message.id && message.id === highlightedId ? 'true' : undefined}
              className={cn(
                'group/bubble flex items-end gap-1',
                message.mine ? 'justify-end' : 'justify-start',
                message.mine &&
                  message.status === 'sending' &&
                  'animate-in fade-in slide-in-from-bottom-1 duration-200',
              )}
            >
              {!message.mine && message.id && accessToken ? (
                <MessageLaterMenu
                  accessToken={accessToken}
                  chatId={chatId}
                  messageId={message.id}
                  align="start"
                />
              ) : null}
              <div
                className={cn(
                  // Figma 426:22954 in / 426:22952 out — ~18px corners, tail ~4px
                  'max-w-[min(100%,30rem)] rounded-[18px] px-3 py-2 text-sm',
                  'transition-[box-shadow] duration-1000 ease-out',
                  message.mine
                    ? 'rounded-br-[4px] bg-accent text-foreground'
                    : 'rounded-bl-[4px] border border-border bg-card text-foreground',
                  message.status === 'failed' && 'ring-2 ring-destructive/60',
                  message.status === 'sending' && 'opacity-80',
                  message.id && message.id === highlightedId && 'ring-2 ring-primary',
                )}
              >
                <p className="whitespace-pre-wrap break-words">{message.body}</p>
                <div className="mt-1 flex items-center justify-end gap-1.5 text-[11px] text-muted-foreground">
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
              {message.mine && message.id && accessToken ? (
                <MessageLaterMenu
                  accessToken={accessToken}
                  chatId={chatId}
                  messageId={message.id}
                  align="end"
                />
              ) : null}
            </li>
          ))}
        </ul>

        {loadingNewer ? (
          <p className="pt-3 text-center text-xs text-muted-foreground" role="status">
            Загрузка новых сообщений…
          </p>
        ) : null}

        {hasMoreAfter && historyStatus === 'ready' ? (
          <div className="flex justify-center pt-3">
            <Button type="button" variant="outline" size="sm" onClick={jumpToLatest}>
              К последним сообщениям
            </Button>
          </div>
        ) : null}
      </div>

      <form
        onSubmit={send}
        className="flex items-end gap-2 border-t border-border bg-card px-3 py-3 md:px-5 lg:px-6"
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
          placeholder="Сообщение"
          maxLength={MAX_BODY_LENGTH}
          autoComplete="off"
          // Idle 415:8451 muted; typed/focus 415:8545 card + border
          className={cn(
            'min-h-11 flex-1 rounded-full px-4',
            draft.trim()
              ? 'border-border bg-card'
              : 'border-transparent bg-muted focus-visible:border-border focus-visible:bg-card',
          )}
          aria-invalid={Boolean(sendError)}
        />
        <Button
          type="submit"
          size="icon"
          // Active: brand cyan + glow; idle: pale circle + muted arrow (Figma composer)
          className={cn(
            'size-11 rounded-full border-0 bg-none from-transparent to-transparent shadow-none disabled:opacity-100',
            draft.trim() && client
              ? 'bg-[var(--brand-button-to)] text-white shadow-[0_4px_16px_color-mix(in_oklab,var(--brand-button-to)_55%,transparent)] hover:opacity-95'
              : 'bg-[#e8eef2] text-[#8fa0b0]',
          )}
          disabled={!draft.trim() || !client}
          aria-label="Отправить"
        >
          <ArrowUp
            className="size-5"
            strokeWidth={draft.trim() && client ? 2.5 : 2}
          />
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
