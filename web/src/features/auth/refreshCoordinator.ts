import type { AccessTokenResponse } from '@/api/auth'
import { ApiError } from '@/api/client'

const LOCK_NAME = 'messenger:auth-refresh'
const CHANNEL_NAME = 'messenger:auth-refresh'
const EPOCH_STORAGE_KEY = 'messenger:auth-refresh-epoch'
const OUTCOME_STORAGE_KEY = 'messenger:auth-refresh-outcome'
/** Если вкладка ждала lock и за это время другая уже обновила сессию — не дергаем refresh снова. */
const RECENT_SUCCESS_MS = 5_000
const RECENT_FINAL_FAILURE_MS = 5_000
const DEFAULT_WAIT_MS = 15_000

export type RefreshCoordinatorMessage =
  | {
      v: 1
      type: 'refresh-success'
      sessionEpoch: number
      token_type: 'Bearer'
      access_token: string
      expires_in: number
    }
  | {
      v: 1
      type: 'refresh-failure'
      sessionEpoch: number
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

export type RefreshOutcome =
  | {
      kind: 'success'
      sessionEpoch: number
      at: number
      session: AccessTokenResponse
    }
  | {
      kind: 'failure'
      sessionEpoch: number
      at: number
      status: number | null
      final: boolean
    }

/** Общий epoch/outcome между вкладками (localStorage в браузере, память в тестах). */
export interface RefreshSharedStore {
  getEpoch(): number
  setEpoch(epoch: number): void
  readOutcome(): RefreshOutcome | null
  writeOutcome(outcome: RefreshOutcome | null): void
}

export interface RefreshCoordinatorOptions {
  refresh: (signal: AbortSignal) => Promise<AccessTokenResponse>
  /** Web Locks; в тестах — общая очередь на несколько «вкладок». */
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

export function createMemoryRefreshStore(initialEpoch = 0): RefreshSharedStore {
  let epoch = initialEpoch
  let outcome: RefreshOutcome | null = null
  return {
    getEpoch: () => epoch,
    setEpoch: (next) => {
      epoch = next
    },
    readOutcome: () => outcome,
    writeOutcome: (next) => {
      outcome = next
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
        // private mode / quota — epoch останется только в BC
      }
    },
    readOutcome() {
      try {
        const raw = localStorage.getItem(OUTCOME_STORAGE_KEY)
        if (!raw) return null
        return JSON.parse(raw) as RefreshOutcome
      } catch {
        return null
      }
    },
    writeOutcome(outcome) {
      try {
        if (!outcome) {
          localStorage.removeItem(OUTCOME_STORAGE_KEY)
          return
        }
        localStorage.setItem(OUTCOME_STORAGE_KEY, JSON.stringify(outcome))
      } catch {
        // ignore
      }
    },
  }
}

/** Не передаём Error в AbortController.abort — в Node/Vitest это даёт unhandled rejection. */
const abortReasons = new WeakMap<AbortSignal, Error>()

function abortWith(controller: AbortController, error: Error) {
  abortReasons.set(controller.signal, error)
  if (!controller.signal.aborted) {
    controller.abort()
  }
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

/**
 * Один POST /auth/refresh на все вкладки одного origin.
 * Refresh-cookie остаётся HttpOnly; между вкладками передаётся только access JWT.
 * sessionEpoch общий через store (localStorage) + BroadcastChannel.
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
  let disposed = false
  let localInFlight: Promise<AccessTokenResponse> | null = null
  let localAbort: AbortController | null = null
  const successListeners = new Set<RefreshSuccessListener>()
  const invalidatedListeners = new Set<RefreshInvalidatedListener>()

  let channel: BroadcastChannelLike | null = null
  try {
    channel = createChannel(CHANNEL_NAME)
  } catch {
    channel = null
  }

  const settleFlight = async (pending: Promise<AccessTokenResponse> | null) => {
    if (!pending) return
    await pending.then(
      () => undefined,
      () => undefined,
    )
  }

  const notifySuccess = (session: AccessTokenResponse, epoch: number) => {
    for (const listener of successListeners) {
      try {
        listener(session, epoch)
      } catch {
        // слушатель не должен ронять координатор
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

  const readFreshSuccess = (epoch: number): AccessTokenResponse | null => {
    const outcome = store.readOutcome()
    if (!outcome || outcome.kind !== 'success') return null
    if (outcome.sessionEpoch !== epoch) return null
    if (now() - outcome.at > recentSuccessMs) return null
    return outcome.session
  }

  const readFreshFinalFailure = (epoch: number): RefreshFinalError | null => {
    const outcome = store.readOutcome()
    if (!outcome || outcome.kind !== 'failure' || !outcome.final) return null
    if (outcome.sessionEpoch !== epoch) return null
    if (now() - outcome.at > recentFinalFailureMs) return null
    return new RefreshFinalError(outcome.status)
  }

  const applySuccess = (session: AccessTokenResponse, epoch: number, fromRemote: boolean) => {
    if (disposed || epoch !== sessionEpoch) return
    store.writeOutcome({
      kind: 'success',
      sessionEpoch: epoch,
      at: now(),
      session,
    })
    // Локальный и remote: Auth/REST должны получить актуальный JWT (в т.ч. после WS-refresh).
    notifySuccess(session, epoch)
    if (!fromRemote && channel) {
      channel.postMessage({
        v: 1,
        type: 'refresh-success',
        sessionEpoch: epoch,
        token_type: 'Bearer',
        access_token: session.access_token,
        expires_in: session.expires_in,
      })
    }
  }

  const applyFinalFailure = (status: number | null, epoch: number, fromRemote: boolean) => {
    if (disposed || epoch !== sessionEpoch) return
    store.writeOutcome({
      kind: 'failure',
      sessionEpoch: epoch,
      at: now(),
      status,
      final: true,
    })
    if (!fromRemote && channel) {
      channel.postMessage({
        v: 1,
        type: 'refresh-failure',
        sessionEpoch: epoch,
        status,
        final: true,
      })
    }
  }

  const adoptEpoch = (nextEpoch: number, reason: 'logout' | 'account_switch', notify: boolean) => {
    if (nextEpoch < sessionEpoch) return
    sessionEpoch = nextEpoch
    store.setEpoch(nextEpoch)
    store.writeOutcome(null)
    if (localAbort) abortWith(localAbort, new RefreshCancelledError(`refresh_cancelled_${reason}`))
    localAbort = null
    localInFlight = null
    if (notify) notifyInvalidated(nextEpoch, reason)
  }

  if (channel) {
    channel.onmessage = (event) => {
      const data = event.data
      if (!data || data.v !== 1) return
      if (data.type === 'refresh-success') {
        if (data.sessionEpoch !== sessionEpoch) return
        applySuccess(
          {
            token_type: 'Bearer',
            access_token: data.access_token,
            expires_in: data.expires_in as AccessTokenResponse['expires_in'],
          },
          data.sessionEpoch,
          true,
        )
        return
      }
      if (data.type === 'refresh-failure' && data.final) {
        if (data.sessionEpoch !== sessionEpoch) return
        applyFinalFailure(data.status, data.sessionEpoch, true)
        if (localAbort) abortWith(localAbort, new RefreshFinalError(data.status))
        return
      }
      if (data.type === 'session-cancelled') {
        if (data.sessionEpoch <= sessionEpoch) return
        adoptEpoch(data.sessionEpoch, 'logout', true)
      }
    }
  }

  const runRefresh = async (epoch: number, signal: AbortSignal): Promise<AccessTokenResponse> => {
    const cached = readFreshSuccess(epoch)
    if (cached) return cached
    const finalFailure = readFreshFinalFailure(epoch)
    if (finalFailure) throw finalFailure
    if (signal.aborted || epoch !== sessionEpoch) throw abortError(signal)

    try {
      const session = await Promise.race([refresh(signal), whenAborted(signal)])
      if (signal.aborted || epoch !== sessionEpoch) throw abortError(signal)
      applySuccess(session, epoch, false)
      return session
    } catch (error) {
      if (signal.aborted || epoch !== sessionEpoch) throw abortError(signal)
      if (isFinalRefreshFailure(error)) {
        const status =
          error instanceof RefreshFinalError ? error.status : (error as ApiError).status
        applyFinalFailure(status, epoch, false)
        throw error instanceof RefreshFinalError ? error : new RefreshFinalError(status)
      }
      if (channel) {
        try {
          channel.postMessage({
            v: 1,
            type: 'refresh-failure',
            sessionEpoch: epoch,
            status: error instanceof ApiError ? error.status : null,
            final: false,
          })
        } catch {
          // ignore
        }
      }
      throw error
    }
  }

  const refreshWithLock = async (
    epoch: number,
    signal: AbortSignal,
  ): Promise<AccessTokenResponse> => {
    if (!locks) return runRefresh(epoch, signal)
    try {
      return await locks.request(LOCK_NAME, { signal }, async () => {
        if (signal.aborted || epoch !== sessionEpoch) throw abortError(signal)
        return runRefresh(epoch, signal)
      })
    } catch (error) {
      if (signal.aborted) throw abortError(signal)
      throw error
    }
  }

  const requestRefresh = (): Promise<AccessTokenResponse> => {
    if (disposed) return Promise.reject(new RefreshCancelledError('coordinator_disposed'))
    if (localInFlight) return localInFlight

    const epoch = sessionEpoch
    const abort = new AbortController()
    localAbort = abort
    const timer = setTimeout(() => {
      abortWith(abort, new RefreshTimeoutError())
    }, waitTimeoutMs)

    const slot: { promise: Promise<AccessTokenResponse> | null } = { promise: null }
    slot.promise = (async () => {
      try {
        return await refreshWithLock(epoch, abort.signal)
      } finally {
        clearTimeout(timer)
        if (localAbort === abort) localAbort = null
        if (localInFlight === slot.promise) localInFlight = null
      }
    })()

    localInFlight = slot.promise
    return slot.promise
  }

  const bumpEpoch = (reason: 'logout' | 'account_switch' | 'dispose') => {
    const next = sessionEpoch + 1
    sessionEpoch = next
    store.setEpoch(next)
    store.writeOutcome(null)
    const pending = localInFlight
    if (localAbort) abortWith(localAbort, new RefreshCancelledError(`refresh_cancelled_${reason}`))
    localAbort = null
    localInFlight = null
    if (channel && reason !== 'dispose') {
      try {
        channel.postMessage({ v: 1, type: 'session-cancelled', sessionEpoch: next })
      } catch {
        // канал мог быть закрыт
      }
    }
    if (reason === 'logout' || reason === 'account_switch') {
      notifyInvalidated(next, reason)
    }
    return { next, pending }
  }

  return {
    requestRefresh,
    /**
     * Logout / смена аккаунта: общий sessionEpoch++, abort in-flight HTTP/lock wait,
     * ждём завершения заявки перед дальнейшими cookie-операциями.
     */
    async cancel(reason: 'logout' | 'account_switch' = 'logout') {
      const { pending } = bumpEpoch(reason)
      await settleFlight(pending)
    },
    getSessionEpoch() {
      return sessionEpoch
    },
    /** @deprecated используйте getSessionEpoch */
    getGeneration() {
      return sessionEpoch
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
    dispose() {
      const { pending } = bumpEpoch('dispose')
      disposed = true
      successListeners.clear()
      invalidatedListeners.clear()
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
    },
  }
}

export type RefreshCoordinator = ReturnType<typeof createRefreshCoordinator>

/** Процессный singleton для AuthProvider и WsProvider. */
let shared: RefreshCoordinator | null = null

export function getSharedRefreshCoordinator(
  refresh: (signal: AbortSignal) => Promise<AccessTokenResponse>,
): RefreshCoordinator {
  if (!shared) {
    shared = createRefreshCoordinator({ refresh })
  }
  return shared
}

/** Только для тестов. */
export function resetSharedRefreshCoordinatorForTests() {
  shared?.dispose()
  shared = null
  try {
    localStorage.removeItem(EPOCH_STORAGE_KEY)
    localStorage.removeItem(OUTCOME_STORAGE_KEY)
  } catch {
    // jsdom / private mode
  }
}
