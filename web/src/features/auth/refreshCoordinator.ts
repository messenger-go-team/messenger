import type { AccessTokenResponse } from '@/api/auth'
import { ApiError } from '@/api/client'

const LOCK_NAME = 'messenger:auth-refresh'
const CHANNEL_NAME = 'messenger:auth-refresh'
const CHANNEL_LOCK = 'messenger:auth-refresh-channel'
const EPOCH_STORAGE_KEY = 'messenger:auth-refresh-epoch'
const META_STORAGE_KEY = 'messenger:auth-refresh-meta'
const OP_ID_STORAGE_KEY = 'messenger:auth-refresh-opid'
/** Кэш успеха в памяти вкладки; JWT в localStorage не пишем. */
const RECENT_SUCCESS_MS = 5_000
const RECENT_FINAL_FAILURE_MS = 5_000
const DEFAULT_WAIT_MS = 15_000
/** Интервал опроса памяти, пока ждём JWT по BC после meta success. */
const BC_POLL_MS = 10

export type RefreshCoordinatorMessage =
  | {
      v: 1
      type: 'refresh-success'
      sessionEpoch: number
      opId: number
      token_type: 'Bearer'
      access_token: string
      expires_in: number
    }
  | {
      v: 1
      type: 'refresh-failure'
      sessionEpoch: number
      opId: number
      status: number | null
      final: boolean
    }
  | {
      v: 1
      type: 'session-cancelled'
      sessionEpoch: number
    }

export interface BroadcastChannelLike {
  postMessage(message: RefreshCoordinatorMessage): void
  close(): void
  onmessage: ((event: MessageEvent<RefreshCoordinatorMessage>) => void) | null
}

export type RefreshSuccessListener = (session: AccessTokenResponse, sessionEpoch: number) => void
export type RefreshInvalidatedListener = (
  sessionEpoch: number,
  reason: 'logout' | 'account_switch',
) => void
export type RefreshFinalFailureListener = (status: number | null, sessionEpoch: number) => void

/** Метаданные без JWT — можно класть в localStorage. */
export type RefreshOutcomeMeta =
  | {
      kind: 'success'
      sessionEpoch: number
      opId: number
      at: number
    }
  | {
      kind: 'failure'
      sessionEpoch: number
      opId: number
      at: number
      status: number | null
      final: boolean
    }

type MemoryOutcome =
  | (Extract<RefreshOutcomeMeta, { kind: 'success' }> & { session: AccessTokenResponse })
  | Extract<RefreshOutcomeMeta, { kind: 'failure' }>

/** Epoch + meta + общий opId без секретов; JWT только в памяти координатора и BC. */
export interface RefreshSharedStore {
  getEpoch(): number
  setEpoch(epoch: number): void
  readMeta(): RefreshOutcomeMeta | null
  writeMeta(meta: RefreshOutcomeMeta | null): void
  /** Монотонный opId на весь origin (localStorage / общая память тестов). */
  allocateOpId(): number
}

export interface RefreshCoordinatorOptions {
  refresh: (signal: AbortSignal) => Promise<AccessTokenResponse>
  locks?: Pick<LockManager, 'request'> | null
  createChannel?: (name: string) => BroadcastChannelLike
  store?: RefreshSharedStore
  now?: () => number
  recentSuccessMs?: number
  recentFinalFailureMs?: number
  waitTimeoutMs?: number
}

export class RefreshCancelledError extends Error {
  constructor(message = 'refresh_cancelled') {
    super(message)
    this.name = 'RefreshCancelledError'
  }
}

export class RefreshFinalError extends Error {
  readonly status: number | null

  constructor(status: number | null, message = 'refresh_final_failure') {
    super(message)
    this.name = 'RefreshFinalError'
    this.status = status
  }
}

export class RefreshTimeoutError extends Error {
  constructor(message = 'refresh_wait_timeout') {
    super(message)
    this.name = 'RefreshTimeoutError'
  }
}

export function isFinalRefreshFailure(error: unknown): boolean {
  if (error instanceof RefreshFinalError) return true
  if (error instanceof ApiError && (error.status === 401 || error.status === 403)) return true
  return false
}

/** Общий backoff для bootstrap и планового refresh. */
export function refreshBackoffMs(attempt: number, baseMs = 1_000, maxMs = 30_000): number {
  const exp = Math.min(baseMs * 2 ** Math.max(0, attempt), maxMs)
  return exp
}

export function createMemoryRefreshStore(initialEpoch = 0): RefreshSharedStore {
  let epoch = initialEpoch
  let meta: RefreshOutcomeMeta | null = null
  let opId = 0
  return {
    getEpoch: () => epoch,
    setEpoch: (next) => {
      epoch = next
    },
    readMeta: () => meta,
    writeMeta: (next) => {
      meta = next
    },
    allocateOpId: () => {
      opId += 1
      return opId
    },
  }
}

function createLocalStorageRefreshStore(): RefreshSharedStore {
  return {
    getEpoch() {
      try {
        const raw = localStorage.getItem(EPOCH_STORAGE_KEY)
        const parsed = raw == null ? 0 : Number(raw)
        return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0
      } catch {
        return 0
      }
    },
    setEpoch(epoch) {
      try {
        localStorage.setItem(EPOCH_STORAGE_KEY, String(epoch))
      } catch {
        // private mode / quota
      }
    },
    readMeta() {
      try {
        const raw = localStorage.getItem(META_STORAGE_KEY)
        if (!raw) return null
        const parsed = JSON.parse(raw) as RefreshOutcomeMeta
        if (parsed && (parsed.kind === 'success' || parsed.kind === 'failure')) return parsed
        return null
      } catch {
        return null
      }
    },
    writeMeta(meta) {
      try {
        if (!meta) {
          localStorage.removeItem(META_STORAGE_KEY)
          return
        }
        localStorage.setItem(META_STORAGE_KEY, JSON.stringify(meta))
      } catch {
        // ignore
      }
    },
    allocateOpId() {
      try {
        const raw = localStorage.getItem(OP_ID_STORAGE_KEY)
        const current = raw == null ? 0 : Number(raw)
        const next = (Number.isFinite(current) && current >= 0 ? current : 0) + 1
        localStorage.setItem(OP_ID_STORAGE_KEY, String(next))
        return next
      } catch {
        return Date.now()
      }
    },
  }
}

const abortReasons = new WeakMap<AbortSignal, Error>()

function abortWith(controller: AbortController, error: Error) {
  abortReasons.set(controller.signal, error)
  if (!controller.signal.aborted) controller.abort()
}

function abortError(signal: AbortSignal): Error {
  return abortReasons.get(signal) ?? new RefreshCancelledError('refresh_aborted')
}

function whenAborted(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) {
      reject(abortError(signal))
      return
    }
    signal.addEventListener(
      'abort',
      () => {
        reject(abortError(signal))
      },
      { once: true },
    )
  })
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError(signal))
      return
    }
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        reject(abortError(signal))
      },
      { once: true },
    )
  })
}

function isStaleOp(existing: RefreshOutcomeMeta | null, epoch: number, opId: number): boolean {
  if (!existing || existing.sessionEpoch !== epoch) return false
  return existing.opId > opId
}

/**
 * Один POST /auth/refresh на origin; cookie-операции сериализуются тем же Web Lock.
 * JWT только в памяти + BroadcastChannel; в localStorage — epoch/meta без секретов.
 */
export function createRefreshCoordinator(options: RefreshCoordinatorOptions) {
  const refresh = options.refresh
  const locks = options.locks === undefined ? navigator.locks : options.locks
  const store = options.store ?? createLocalStorageRefreshStore()
  const now = options.now ?? Date.now
  const recentSuccessMs = options.recentSuccessMs ?? RECENT_SUCCESS_MS
  const recentFinalFailureMs = options.recentFinalFailureMs ?? RECENT_FINAL_FAILURE_MS
  const waitTimeoutMs = options.waitTimeoutMs ?? DEFAULT_WAIT_MS
  const createChannel =
    options.createChannel ??
    ((name: string) => new BroadcastChannel(name) as unknown as BroadcastChannelLike)

  let sessionEpoch = store.getEpoch()
  /** Последняя эпоха, по которой уже вызвали invalidate (в т.ч. при sync до BC). */
  let lastInvalidatedEpoch = sessionEpoch
  let disposed = false
  let localInFlight: Promise<AccessTokenResponse> | null = null
  /**
   * opId реально начатой HTTP-ротации (POST). Заявка в очереди lock ещё не считается —
   * иначе чужой 401 с меньшим opId отбрасывается до notifyFinalFailure.
   */
  let localStartedOpId: number | null = null
  let localAbort: AbortController | null = null
  /** JWT и свежий outcome только здесь (и через BC), не в localStorage. */
  let memoryOutcome: MemoryOutcome | null = null

  const successListeners = new Set<RefreshSuccessListener>()
  const invalidatedListeners = new Set<RefreshInvalidatedListener>()
  const finalFailureListeners = new Set<RefreshFinalFailureListener>()

  let channel: BroadcastChannelLike | null = null
  let outcomeAtChannelOpen: RefreshOutcomeMeta | null = null

  const settleFlight = async (pending: Promise<AccessTokenResponse> | null) => {
    if (!pending) return
    await pending.then(
      () => undefined,
      () => undefined,
    )
  }

  const syncEpochFromStore = () => {
    const stored = store.getEpoch()
    if (stored > sessionEpoch) sessionEpoch = stored
  }

  const notifySuccess = (session: AccessTokenResponse, epoch: number) => {
    for (const listener of successListeners) {
      try {
        listener(session, epoch)
      } catch {
        // ignore
      }
    }
  }

  const notifyInvalidated = (epoch: number, reason: 'logout' | 'account_switch') => {
    for (const listener of invalidatedListeners) {
      try {
        listener(epoch, reason)
      } catch {
        // ignore
      }
    }
  }

  const notifyFinalFailure = (status: number | null, epoch: number) => {
    for (const listener of finalFailureListeners) {
      try {
        listener(status, epoch)
      } catch {
        // ignore
      }
    }
  }

  const readFreshSuccess = (epoch: number): AccessTokenResponse | null => {
    if (!memoryOutcome || memoryOutcome.kind !== 'success') return null
    if (memoryOutcome.sessionEpoch !== epoch) return null
    if (now() - memoryOutcome.at > recentSuccessMs) return null
    return memoryOutcome.session
  }

  const isUsableOutcomeAt = (at: number, ttlMs: number, queuedAt?: number) => {
    if (now() - at <= ttlMs) return true
    // Отказ/успех лидера, завершённый пока мы стояли в очереди lock.
    return queuedAt != null && at >= queuedAt
  }

  const readFreshFinalFailure = (epoch: number, queuedAt?: number): RefreshFinalError | null => {
    const fromMemory =
      memoryOutcome?.kind === 'failure' &&
      memoryOutcome.final &&
      memoryOutcome.sessionEpoch === epoch &&
      isUsableOutcomeAt(memoryOutcome.at, recentFinalFailureMs, queuedAt)
        ? memoryOutcome
        : null
    if (fromMemory) return new RefreshFinalError(fromMemory.status)

    const meta = store.readMeta()
    if (!meta || meta.kind !== 'failure' || !meta.final) return null
    if (meta.sessionEpoch !== epoch) return null
    if (!isUsableOutcomeAt(meta.at, recentFinalFailureMs, queuedAt)) return null
    return new RefreshFinalError(meta.status)
  }

  const applySuccess = (
    session: AccessTokenResponse,
    epoch: number,
    opId: number,
    publish: boolean,
  ) => {
    syncEpochFromStore()
    if (disposed || epoch !== sessionEpoch) return
    const existingMeta = store.readMeta()
    if (isStaleOp(existingMeta, epoch, opId)) return
    if (
      memoryOutcome?.kind === 'success' &&
      memoryOutcome.sessionEpoch === epoch &&
      memoryOutcome.opId > opId
    ) {
      return
    }

    const meta: RefreshOutcomeMeta = { kind: 'success', sessionEpoch: epoch, opId, at: now() }
    memoryOutcome = { ...meta, session }
    notifySuccess(session, epoch)
    if (!publish || !channel) return
    try {
      channel.postMessage({
        v: 1,
        type: 'refresh-success',
        sessionEpoch: epoch,
        opId,
        token_type: 'Bearer',
        access_token: session.access_token,
        expires_in: session.expires_in,
      })
    } catch {
      return
    }
    // Другие вкладки ждут JWT только после успешной отправки.
    store.writeMeta(meta)
  }

  const applyFinalFailure = (
    status: number | null,
    epoch: number,
    opId: number,
    fromRemote: boolean,
  ): boolean => {
    syncEpochFromStore()
    if (disposed || epoch !== sessionEpoch) return false
    // Только реально начатый POST делает меньший opId «устаревшим»; очередь lock — нет.
    if (localStartedOpId != null && opId < localStartedOpId) return false
    const existingMeta = store.readMeta()
    if (isStaleOp(existingMeta, epoch, opId)) return false
    // Успех той же/более новой попытки уже зафиксирован — запоздалый 401 не откатываем.
    if (
      existingMeta?.kind === 'success' &&
      existingMeta.sessionEpoch === epoch &&
      existingMeta.opId >= opId
    ) {
      return false
    }
    // Уже применили этот отказ локально — не дублируем notify.
    if (
      memoryOutcome?.kind === 'failure' &&
      memoryOutcome.final &&
      memoryOutcome.sessionEpoch === epoch &&
      memoryOutcome.opId === opId
    ) {
      return true
    }

    const meta: RefreshOutcomeMeta = {
      kind: 'failure',
      sessionEpoch: epoch,
      opId,
      at: now(),
      status,
      final: true,
    }
    memoryOutcome = meta
    store.writeMeta(meta)
    notifyFinalFailure(status, epoch)
    if (!fromRemote && channel) {
      channel.postMessage({
        v: 1,
        type: 'refresh-failure',
        sessionEpoch: epoch,
        opId,
        status,
        final: true,
      })
    }
    return true
  }

  /** Если отказ узнали из store/meta — всё равно уведомить Auth (один раз). */
  const adoptStoreFinalFailure = (epoch: number, queuedAt?: number): RefreshFinalError | null => {
    const failed = readFreshFinalFailure(epoch, queuedAt)
    if (!failed) return null
    const meta = store.readMeta()
    if (meta?.kind === 'failure' && meta.final && meta.sessionEpoch === epoch) {
      applyFinalFailure(meta.status, epoch, meta.opId, true)
    }
    return failed
  }

  const adoptEpoch = (nextEpoch: number, reason: 'logout' | 'account_switch', notify: boolean) => {
    // Не syncFromStore до сравнения: иначе local 0 + store 1 глотает notify.
    if (nextEpoch < sessionEpoch) return
    const localBefore = sessionEpoch
    const advancing = nextEpoch > localBefore
    sessionEpoch = Math.max(sessionEpoch, nextEpoch)
    store.setEpoch(Math.max(store.getEpoch(), sessionEpoch))
    const meta = store.readMeta()
    // Не затираем outcome более новой эпохи (запоздалый cancel).
    if (!meta || meta.sessionEpoch < sessionEpoch) {
      store.writeMeta(null)
      if (!memoryOutcome || memoryOutcome.sessionEpoch < sessionEpoch) {
        memoryOutcome = null
      }
    }
    // Отмена только при реальном продвижении эпохи; запоздалый cancel той же эпохи
    // не рвёт refresh, уже стартовавший после sync из store.
    if (advancing) {
      if (localAbort)
        abortWith(localAbort, new RefreshCancelledError(`refresh_cancelled_${reason}`))
      localAbort = null
      localInFlight = null
      localStartedOpId = null
    }
    if (notify && nextEpoch > lastInvalidatedEpoch) {
      lastInvalidatedEpoch = nextEpoch
      notifyInvalidated(sessionEpoch, reason)
    }
  }

  const withLock = async <T>(
    name: string,
    signal: AbortSignal | undefined,
    fn: () => T | Promise<T>,
  ): Promise<T> => {
    if (!locks) return fn()
    if (signal) {
      try {
        return await locks.request(name, { signal }, fn)
      } catch (error) {
        if (signal.aborted) throw abortError(signal)
        throw error
      }
    }
    return locks.request(name, fn)
  }

  const tryChannelLock = async (signal: AbortSignal | undefined, fn: () => void) => {
    let acquired = false
    try {
      await withLock(CHANNEL_LOCK, signal, () => {
        acquired = true
        fn()
      })
    } catch (error) {
      // Отказ дополнительного lock отключает обмен JWT, сохраняя основной lock.
      if (acquired || signal?.aborted) throw error
    }
    return acquired
  }

  // Публикация success не может вклиниться между открытием канала и чтением meta.
  const channelReady = tryChannelLock(undefined, () => {
    if (disposed) return
    try {
      channel = createChannel(CHANNEL_NAME)
    } catch {
      channel = null
    }
    outcomeAtChannelOpen = store.readMeta()
    if (!channel) return

    channel.onmessage = (event) => {
      const data = event.data
      if (!data || data.v !== 1) return
      if (data.type === 'refresh-success') {
        syncEpochFromStore()
        if (data.sessionEpoch !== sessionEpoch) return
        applySuccess(
          {
            token_type: 'Bearer',
            access_token: data.access_token,
            expires_in: data.expires_in as AccessTokenResponse['expires_in'],
          },
          data.sessionEpoch,
          data.opId,
          false,
        )
        return
      }
      if (data.type === 'refresh-failure' && data.final) {
        syncEpochFromStore()
        if (data.sessionEpoch !== sessionEpoch) return
        const applied = applyFinalFailure(data.status, data.sessionEpoch, data.opId, true)
        // Побочный abort только если 401 актуален для текущего полёта.
        if (applied && localAbort) abortWith(localAbort, new RefreshFinalError(data.status))
        return
      }
      if (data.type === 'session-cancelled') {
        adoptEpoch(data.sessionEpoch, 'logout', true)
      }
    }
  })
  void channelReady.catch(() => undefined)

  const leaderSuccessMeta = (epoch: number) => {
    if (!channel) return null
    const meta = store.readMeta()
    if (!meta || meta.kind !== 'success' || meta.sessionEpoch !== epoch) return null
    if (outcomeAtChannelOpen?.sessionEpoch === epoch && outcomeAtChannelOpen.opId === meta.opId) {
      return null
    }
    return meta
  }

  const readSuccessForOp = (epoch: number, opId: number): AccessTokenResponse | null => {
    if (!memoryOutcome || memoryOutcome.kind !== 'success') return null
    if (memoryOutcome.sessionEpoch !== epoch || memoryOutcome.opId !== opId) return null
    return memoryOutcome.session
  }

  /**
   * Если лидер уже записал meta success — ждём JWT по BC для sessionEpoch+opId.
   * Свежее окно ИЛИ success, завершённый после постановки нашей заявки в очередь
   * (даже если к старту lock-callback TTL уже истёк).
   */
  const waitForLeaderBroadcast = async (epoch: number, signal: AbortSignal, queuedAt: number) => {
    const cached = readFreshSuccess(epoch)
    if (cached) return cached
    const finalFailure = adoptStoreFinalFailure(epoch, queuedAt)
    if (finalFailure) throw finalFailure

    const bound = leaderSuccessMeta(epoch)
    if (!bound) return null
    const fresh = now() - bound.at <= recentSuccessMs
    const completedWhileQueued = bound.at >= queuedAt
    if (!fresh && !completedWhileQueued) return null
    let boundOpId = bound.opId

    while (true) {
      if (signal.aborted || epoch !== sessionEpoch) throw abortError(signal)

      const fromMemory = readSuccessForOp(epoch, boundOpId)
      if (fromMemory) return fromMemory

      const failed = adoptStoreFinalFailure(epoch, queuedAt)
      if (failed) throw failed

      const current = store.readMeta()
      if (!current || current.sessionEpoch !== epoch) return null
      if (current.kind === 'failure' && current.final) {
        applyFinalFailure(current.status, epoch, current.opId, true)
        throw new RefreshFinalError(current.status)
      }
      if (current.kind === 'success' && current.opId > boundOpId) {
        boundOpId = current.opId
        continue
      }
      if (current.kind !== 'success' || current.opId !== boundOpId) return null

      await sleep(BC_POLL_MS, signal)
    }
  }

  const runRefresh = async (
    epoch: number,
    opId: number,
    signal: AbortSignal,
    queuedAt: number,
  ): Promise<AccessTokenResponse> => {
    syncEpochFromStore()
    if (signal.aborted || epoch !== sessionEpoch) throw abortError(signal)

    const cached = readFreshSuccess(epoch)
    if (cached) return cached
    const finalFailure = adoptStoreFinalFailure(epoch, queuedAt)
    if (finalFailure) throw finalFailure

    const fromLeader = await waitForLeaderBroadcast(epoch, signal, queuedAt)
    syncEpochFromStore()
    if (signal.aborted || epoch !== sessionEpoch) throw abortError(signal)
    if (fromLeader) return fromLeader

    // Success лидера (свежий или пока мы стояли в очереди) без JWT — без второго POST.
    const leaderMeta = leaderSuccessMeta(epoch)
    const joinLeader = leaderMeta && isUsableOutcomeAt(leaderMeta.at, recentSuccessMs, queuedAt)
    if (joinLeader && leaderMeta) {
      const late = readSuccessForOp(epoch, leaderMeta.opId) ?? readFreshSuccess(epoch)
      if (late) return late
      throw new RefreshTimeoutError('refresh_leader_jwt_timeout')
    }

    // Final 401 лидера после TTL, но завершённый пока мы в очереди — без второго POST.
    const leaderFailure = adoptStoreFinalFailure(epoch, queuedAt)
    if (leaderFailure) throw leaderFailure

    localStartedOpId = opId
    const refreshPromise = refresh(signal)
    // Второй handler: если abort выиграл race, запоздалый reject refresh не станет unhandled.
    void refreshPromise.catch(() => undefined)
    try {
      const session = await Promise.race([refreshPromise, whenAborted(signal)])
      const acceptSuccess = (publish: boolean) => {
        syncEpochFromStore()
        if (signal.aborted || epoch !== sessionEpoch) throw abortError(signal)
        applySuccess(session, epoch, opId, publish)
      }
      // После HTTP отказ блокировки публикации оставляет JWT доступным в этой вкладке.
      if (!channel || !(await tryChannelLock(signal, () => acceptSuccess(true)))) {
        acceptSuccess(false)
      }
      syncEpochFromStore()
      if (signal.aborted || epoch !== sessionEpoch) throw abortError(signal)
      return session
    } catch (error) {
      if (signal.aborted || epoch !== sessionEpoch) throw abortError(signal)
      if (isFinalRefreshFailure(error)) {
        const status =
          error instanceof RefreshFinalError ? error.status : (error as ApiError).status
        applyFinalFailure(status, epoch, opId, false)
        throw error instanceof RefreshFinalError ? error : new RefreshFinalError(status)
      }
      if (channel) {
        try {
          channel.postMessage({
            v: 1,
            type: 'refresh-failure',
            sessionEpoch: epoch,
            opId,
            status: error instanceof ApiError ? error.status : null,
            final: false,
          })
        } catch {
          // ignore
        }
      }
      throw error
    } finally {
      if (localStartedOpId === opId) localStartedOpId = null
    }
  }

  const refreshWithLock = async (
    epoch: number,
    opId: number,
    signal: AbortSignal,
    queuedAt: number,
  ): Promise<AccessTokenResponse> => {
    return withLock(LOCK_NAME, signal, async () => {
      await Promise.race([channelReady, whenAborted(signal)])
      syncEpochFromStore()
      if (signal.aborted || epoch !== sessionEpoch) throw abortError(signal)
      return runRefresh(epoch, opId, signal, queuedAt)
    })
  }

  const requestRefresh = (): Promise<AccessTokenResponse> => {
    if (disposed) return Promise.reject(new RefreshCancelledError('coordinator_disposed'))
    if (localInFlight) return localInFlight

    syncEpochFromStore()
    const epoch = sessionEpoch
    const opId = store.allocateOpId()
    const queuedAt = now()
    const abort = new AbortController()
    localAbort = abort
    const timer = setTimeout(() => {
      abortWith(abort, new RefreshTimeoutError())
    }, waitTimeoutMs)

    const slot: { promise: Promise<AccessTokenResponse> | null } = { promise: null }
    slot.promise = (async () => {
      try {
        return await refreshWithLock(epoch, opId, abort.signal, queuedAt)
      } finally {
        clearTimeout(timer)
        if (localAbort === abort) localAbort = null
        if (localStartedOpId === opId) localStartedOpId = null
        if (localInFlight === slot.promise) localInFlight = null
      }
    })()

    localInFlight = slot.promise
    return slot.promise
  }

  /** Только под Web Lock (или после abort локального flight). */
  const bumpEpochLocked = (reason: 'logout' | 'account_switch' | 'dispose') => {
    syncEpochFromStore()
    const next = sessionEpoch + 1
    sessionEpoch = next
    store.setEpoch(next)
    const meta = store.readMeta()
    if (!meta || meta.sessionEpoch < next) {
      store.writeMeta(null)
      memoryOutcome = null
    }
    if (channel && reason !== 'dispose') {
      try {
        channel.postMessage({ v: 1, type: 'session-cancelled', sessionEpoch: next })
      } catch {
        // ignore
      }
    }
    return next
  }

  const abortLocalFlight = (reason: 'logout' | 'account_switch' | 'dispose') => {
    const pending = localInFlight
    if (localAbort) abortWith(localAbort, new RefreshCancelledError(`refresh_cancelled_${reason}`))
    localAbort = null
    localInFlight = null
    localStartedOpId = null
    return pending
  }

  return {
    requestRefresh,
    /**
     * Logout / login: abort локального refresh, под Web Lock — bump epoch + cookie-операция.
     * Эпоха не публикуется до захвата lock, чтобы сосед не обновился по старой cookie.
     */
    async withSessionChange<T>(
      reason: 'logout' | 'account_switch',
      fn: () => Promise<T>,
    ): Promise<T> {
      const pending = abortLocalFlight(reason)
      await settleFlight(pending)
      return withLock(LOCK_NAME, undefined, async () => {
        await channelReady
        bumpEpochLocked(reason)
        return fn()
      })
    },
    /** @deprecated предпочтите withSessionChange для cookie-операций */
    async cancel(reason: 'logout' | 'account_switch' = 'logout') {
      const pending = abortLocalFlight(reason)
      await settleFlight(pending)
      await withLock(LOCK_NAME, undefined, async () => {
        await channelReady
        bumpEpochLocked(reason)
      })
    },
    getSessionEpoch() {
      syncEpochFromStore()
      return sessionEpoch
    },
    getGeneration() {
      return this.getSessionEpoch()
    },
    subscribeSuccess(listener: RefreshSuccessListener) {
      successListeners.add(listener)
      return () => {
        successListeners.delete(listener)
      }
    },
    subscribeInvalidated(listener: RefreshInvalidatedListener) {
      invalidatedListeners.add(listener)
      return () => {
        invalidatedListeners.delete(listener)
      }
    },
    subscribeFinalFailure(listener: RefreshFinalFailureListener) {
      finalFailureListeners.add(listener)
      return () => {
        finalFailureListeners.delete(listener)
      }
    },
    dispose() {
      const pending = abortLocalFlight('dispose')
      disposed = true
      successListeners.clear()
      invalidatedListeners.clear()
      finalFailureListeners.clear()
      if (channel) {
        channel.onmessage = null
        try {
          channel.close()
        } catch {
          // ignore
        }
        channel = null
      }
      void settleFlight(pending)
      try {
        bumpEpochLocked('dispose')
      } catch {
        // ignore
      }
    },
  }
}

export type RefreshCoordinator = ReturnType<typeof createRefreshCoordinator>

let shared: RefreshCoordinator | null = null

export function getSharedRefreshCoordinator(
  refresh: (signal: AbortSignal) => Promise<AccessTokenResponse>,
): RefreshCoordinator {
  if (!shared) {
    shared = createRefreshCoordinator({ refresh })
  }
  return shared
}

export function resetSharedRefreshCoordinatorForTests() {
  shared?.dispose()
  shared = null
  try {
    localStorage.removeItem(EPOCH_STORAGE_KEY)
    localStorage.removeItem(META_STORAGE_KEY)
    localStorage.removeItem(OP_ID_STORAGE_KEY)
    localStorage.removeItem('messenger:auth-refresh-outcome')
  } catch {
    // jsdom / private mode
  }
}
