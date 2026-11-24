import { ApiError } from '@/api/client'
import { listLater, type LaterEntry } from '@/api/later'
import { compareLaterEntries } from '@/features/later/laterOrder'
import {
  MAX_POLL_INTERVAL_MS,
  MIN_DUE_REFETCH_MS,
  dueDelayMs,
  nextBackoffDelayMs,
  reminderKey,
} from '@/features/later/reminderTiming'

export type LaterRemindersStatus = 'loading' | 'ready' | 'error'

export const LATER_LOAD_ERROR = 'Не удалось загрузить напоминания. Повторите попытку.'

/** Неизменяемый срез состояния; новый объект создаётся только при реальном изменении. */
export interface LaterRemindersSnapshot {
  entries: LaterEntry[]
  serverTime: string | null
  /** `error` только пока не было ни одного успешного ответа; позже ошибка не очищает список. */
  status: LaterRemindersStatus
  /** Последний неудачный GET; сбрасывается успешным ответом. */
  error: string | null
  /** Просроченная запись из свежего успешного ответа, ещё не отложенная «Позже». */
  activeReminder: LaterEntry | null
}

/** Актуальные учётные данные сессии; провайдер обновляет их без пересоздания store. */
export interface LaterRemindersCredentials {
  accessToken: string | null
  /** Обычное восстановление сессии на 401 (refresh через общий coordinator). */
  recoverAuth: () => Promise<unknown>
}

const INITIAL_SNAPSHOT: LaterRemindersSnapshot = {
  entries: [],
  serverTime: null,
  status: 'loading',
  error: null,
  activeReminder: null,
}

/**
 * Единственный владелец GET /later для авторизованной вкладки.
 * Один таймер объединяет периодический опрос (≤30 с), ближайший `due_at` и backoff после ошибок;
 * запросы single-flight. Экземпляр живёт для одного пользователя: смена аккаунта = новый store.
 */
export class LaterRemindersStore {
  private credentials: LaterRemindersCredentials = {
    accessToken: null,
    recoverAuth: () => Promise.resolve(),
  }
  private readonly listeners = new Set<() => void>()
  private snapshot: LaterRemindersSnapshot = INITIAL_SNAPSHOT

  private running = false
  private generation = 0
  private inFlight: Promise<void> | null = null
  private rerunRequested = false
  private lastRequestToken: string | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private failures = 0
  private hasLoaded = false
  /** Локальное время ближайшего регулярного опроса или повтора после ошибки. */
  private pollAt = 0
  /** id запланированной записи → локальное время её срока (localNow + due_at - server_time). */
  private readonly dueAt = new Map<string, number>()
  /** id → ключ напоминания из свежего успешного ответа. */
  private readonly reminders = new Map<string, string>()
  private readonly dismissed = new Set<string>()

  /** `ownerId` фиксирует владельца: store живёт ровно для одного пользователя. */
  readonly ownerId: string | null

  constructor(ownerId: string | null) {
    this.ownerId = ownerId
  }

  setCredentials(credentials: LaterRemindersCredentials): void {
    this.credentials = credentials
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  readonly getSnapshot = (): LaterRemindersSnapshot => this.snapshot

  /** Запускает опрос (повторный вызов безопасен); при видимой вкладке сразу делает GET. */
  start(): void {
    if (this.running) return
    this.running = true
    this.generation += 1
    document.addEventListener('visibilitychange', this.onVisibilityChange)
    window.addEventListener('focus', this.onFocus)
    if (this.isVisible()) void this.refresh()
  }

  /** Останавливает таймеры и отбрасывает ответы запросов, начатых до остановки. */
  stop(): void {
    this.running = false
    this.generation += 1
    this.inFlight = null
    this.rerunRequested = false
    this.clearTimer()
    document.removeEventListener('visibilitychange', this.onVisibilityChange)
    window.removeEventListener('focus', this.onFocus)
  }

  /** Single-flight GET /later: параллельные вызовы получают один и тот же promise. */
  refresh = (): Promise<void> => {
    if (!this.running) return Promise.resolve()
    if (this.inFlight) return this.inFlight
    const token = this.credentials.accessToken
    if (!token) return Promise.resolve()

    this.clearTimer()
    this.lastRequestToken = token
    if (this.snapshot.status === 'error') this.setSnapshot({ status: 'loading' })

    const generation = this.generation
    const run = this.load(token, generation).finally(() => {
      if (this.generation !== generation) return
      this.inFlight = null
      if (this.rerunRequested) {
        this.rerunRequested = false
        if (this.isVisible()) void this.refresh()
        return
      }
      this.arm()
    })
    this.inFlight = run
    return run
  }

  /** Access token ротировался: повторить GET уже с новым токеном (после текущего запроса). */
  tokenChanged(): void {
    if (!this.running) return
    const token = this.credentials.accessToken
    if (!token || token === this.lastRequestToken) return
    if (this.inFlight) {
      this.rerunRequested = true
      return
    }
    if (this.isVisible()) void this.refresh()
  }

  /** Убирает запись (complete, 404 контекста) и её напоминание. */
  removeEntry(entryId: string): void {
    this.reminders.delete(entryId)
    this.dueAt.delete(entryId)
    this.setSnapshot({ entries: this.snapshot.entries.filter((entry) => entry.id !== entryId) })
    this.arm()
  }

  /**
   * Заменяет или добавляет запись после PATCH/POST. Прежнее напоминание снимается, если срок
   * изменился; новое показывается только из следующего свежего GET.
   */
  replaceEntry(entry: LaterEntry, serverTime?: string): void {
    const entries = this.snapshot.entries.some((item) => item.id === entry.id)
      ? this.snapshot.entries.map((item) => (item.id === entry.id ? entry : item))
      : [...this.snapshot.entries, entry]

    if (this.reminders.get(entry.id) !== reminderKey(entry)) this.reminders.delete(entry.id)
    this.trackDue(entry, serverTime ?? this.snapshot.serverTime, Date.now())
    this.setSnapshot({ entries })
    this.arm()
  }

  /** «Позже» на toast: скрывает напоминание в этой сессии, запись остаётся в списке. */
  dismissReminder(entryId: string): void {
    const entry = this.snapshot.entries.find((item) => item.id === entryId)
    if (entry) this.dismissed.add(reminderKey(entry))
    this.reminders.delete(entryId)
    this.setSnapshot({})
  }

  private async load(token: string, generation: number): Promise<void> {
    try {
      const response = await listLater(token)
      if (generation !== this.generation) return
      this.applySuccess(response.entries, response.server_time)
    } catch (error) {
      if (generation !== this.generation) return
      if (error instanceof ApiError && error.status === 401) {
        await this.recoverFromUnauthorized(generation)
        return
      }
      this.applyFailure()
    }
  }

  private applySuccess(entries: LaterEntry[], serverTime: string): void {
    const receivedAt = Date.now()
    this.failures = 0
    this.hasLoaded = true
    this.pollAt = receivedAt + MAX_POLL_INTERVAL_MS

    this.dueAt.clear()
    this.reminders.clear()
    for (const entry of entries) {
      this.trackDue(entry, serverTime, receivedAt)
      const key = reminderKey(entry)
      if (entry.status === 'due' && !this.dismissed.has(key)) this.reminders.set(entry.id, key)
    }

    this.setSnapshot({ entries, serverTime, status: 'ready', error: null })
  }

  private applyFailure(): void {
    this.pollAt = Date.now() + nextBackoffDelayMs(this.failures)
    this.failures += 1
    // Ошибка не превращается в пустой список: прежние записи остаются как были.
    this.setSnapshot({
      status: this.hasLoaded ? 'ready' : 'error',
      error: LATER_LOAD_ERROR,
    })
  }

  /** 401 — не временный сбой: без backoff просим обычное восстановление сессии. */
  private async recoverFromUnauthorized(generation: number): Promise<void> {
    try {
      await this.credentials.recoverAuth()
    } catch {
      // Финальный отказ AuthProvider сам снимет сессию; временный — подберёт опрос ниже.
    }
    if (generation !== this.generation) return
    this.pollAt = Date.now() + MAX_POLL_INTERVAL_MS
  }

  private trackDue(entry: LaterEntry, serverTime: string | null, receivedAt: number): void {
    if (entry.status !== 'scheduled' || entry.due_at === null || serverTime === null) {
      this.dueAt.delete(entry.id)
      return
    }
    const delay = dueDelayMs(entry.due_at, serverTime)
    if (delay === null) {
      this.dueAt.delete(entry.id)
      return
    }
    this.dueAt.set(entry.id, receivedAt + Math.max(delay, MIN_DUE_REFETCH_MS))
  }

  /** Ставит ровно один таймер на ближайшее из: опрос, повтор, due_at. */
  private arm(): void {
    this.clearTimer()
    if (!this.running || this.inFlight || !this.hasLoadedOrFailed() || !this.isVisible()) return

    let target = this.pollAt
    for (const due of this.dueAt.values()) {
      if (due < target) target = due
    }
    const delay = Math.min(Math.max(0, target - Date.now()), MAX_POLL_INTERVAL_MS)
    this.timer = setTimeout(() => {
      this.timer = null
      void this.refresh()
    }, delay)
  }

  private hasLoadedOrFailed(): boolean {
    return this.pollAt > 0
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  private isVisible(): boolean {
    return !document.hidden
  }

  private readonly onVisibilityChange = (): void => {
    if (this.isVisible()) void this.refresh()
    else this.clearTimer()
  }

  private readonly onFocus = (): void => {
    if (this.isVisible()) void this.refresh()
  }

  private setSnapshot(patch: Partial<LaterRemindersSnapshot>): void {
    const next = { ...this.snapshot, ...patch }
    next.activeReminder = this.pickActiveReminder(next.entries)
    this.snapshot = next
    for (const listener of this.listeners) listener()
  }

  private pickActiveReminder(entries: readonly LaterEntry[]): LaterEntry | null {
    const candidates = entries
      .filter((entry) => this.reminders.get(entry.id) === reminderKey(entry))
      .sort(compareLaterEntries)
    return candidates[0] ?? null
  }
}
