import type { AccessTokenResponse } from '@/api/auth'

const LOCK_NAME = 'messenger:auth-refresh'
const CHANNEL_NAME = 'messenger:auth-refresh'
/** Если вкладка ждала lock и за это время другая уже обновила сессию — не дергаем refresh снова. */
const RECENT_SUCCESS_MS = 5_000
const DEFAULT_WAIT_MS = 15_000

export type RefreshCoordinatorMessage =
  | {
      v: 1
      type: 'refresh-success'
      generation: number
      token_type: 'Bearer'
      access_token: string
      expires_in: number
    }
  | {
      v: 1
      type: 'refresh-failure'
      generation: number
      status: number | null
      final: boolean
    }
  | {
      v: 1
      type: 'session-cancelled'
      generation: number
    }

export interface BroadcastChannelLike {
  postMessage(message: RefreshCoordinatorMessage): void
  close(): void
  onmessage: ((event: MessageEvent<RefreshCoordinatorMessage>) => void) | null
}

export type RefreshSuccessListener = (session: AccessTokenResponse, generation: number) => void

export interface RefreshCoordinatorOptions {
  refresh: () => Promise<AccessTokenResponse>
  /** Web Locks; в тестах — общая очередь на несколько «вкладок». */
  locks?: Pick<LockManager, 'request'> | null
  createChannel?: (name: string) => BroadcastChannelLike
  now?: () => number
  recentSuccessMs?: number
  waitTimeoutMs?: number
}

export class RefreshCancelledError extends Error {
  constructor(message = 'refresh_cancelled') {
    super(message)
    this.name = 'RefreshCancelledError'
  }
}

/**
 * Один POST /auth/refresh на все вкладки одного origin.
 * Refresh-cookie остаётся HttpOnly; между вкладками передаётся только access JWT.
 */
export function createRefreshCoordinator(options: RefreshCoordinatorOptions) {
  const refresh = options.refresh
  const locks = options.locks === undefined ? navigator.locks : options.locks
  const now = options.now ?? Date.now
  const recentSuccessMs = options.recentSuccessMs ?? RECENT_SUCCESS_MS
  const waitTimeoutMs = options.waitTimeoutMs ?? DEFAULT_WAIT_MS
  const createChannel =
    options.createChannel ??
    ((name: string) => new BroadcastChannel(name) as unknown as BroadcastChannelLike)

  let generation = 0
  let disposed = false
  let localInFlight: Promise<AccessTokenResponse> | null = null
  let cancelInFlight: ((error: Error) => void) | null = null
  let lastSuccess: AccessTokenResponse | null = null
  let lastSuccessAt = 0
  let lastSuccessGeneration = -1
  const successListeners = new Set<RefreshSuccessListener>()

  let channel: BroadcastChannelLike | null = null
  try {
    channel = createChannel(CHANNEL_NAME)
  } catch {
    channel = null
  }

  const notifySuccess = (session: AccessTokenResponse, gen: number) => {
    for (const listener of successListeners) {
      try {
        listener(session, gen)
      } catch {
        // слушатель не должен ронять координатор
      }
    }
  }

  const applySuccess = (session: AccessTokenResponse, gen: number, fromRemote: boolean) => {
    if (disposed || gen !== generation) return
    lastSuccess = session
    lastSuccessAt = now()
    lastSuccessGeneration = gen
    // Локальный caller получает session из requestRefresh; слушатели — только remote (другие вкладки).
    if (fromRemote) {
      notifySuccess(session, gen)
      return
    }
    if (channel) {
      channel.postMessage({
        v: 1,
        type: 'refresh-success',
        generation: gen,
        token_type: 'Bearer',
        access_token: session.access_token,
        expires_in: session.expires_in,
      })
    }
  }

  if (channel) {
    channel.onmessage = (event) => {
      const data = event.data
      if (!data || data.v !== 1) return
      if (data.type === 'refresh-success') {
        if (data.generation !== generation) return
        applySuccess(
          {
            token_type: 'Bearer',
            access_token: data.access_token,
            expires_in: data.expires_in as AccessTokenResponse['expires_in'],
          },
          data.generation,
          true,
        )
        return
      }
      if (data.type === 'session-cancelled' && data.generation >= generation) {
        // чужая/общая отмена уже отражена bumpGeneration у отправителя
      }
    }
  }

  const recentSuccess = (gen: number): AccessTokenResponse | null => {
    if (!lastSuccess) return null
    if (lastSuccessGeneration !== gen) return null
    if (now() - lastSuccessAt > recentSuccessMs) return null
    return lastSuccess
  }

  const runRefresh = async (gen: number): Promise<AccessTokenResponse> => {
    const cached = recentSuccess(gen)
    if (cached) return cached
    if (gen !== generation) throw new RefreshCancelledError()
    const session = await refresh()
    if (gen !== generation) throw new RefreshCancelledError()
    applySuccess(session, gen, false)
    return session
  }

  const refreshWithLock = async (gen: number): Promise<AccessTokenResponse> => {
    if (!locks) return runRefresh(gen)
    return locks.request(LOCK_NAME, async () => {
      if (gen !== generation) throw new RefreshCancelledError()
      return runRefresh(gen)
    })
  }

  const requestRefresh = (): Promise<AccessTokenResponse> => {
    if (disposed) return Promise.reject(new RefreshCancelledError('coordinator_disposed'))
    const gen = generation
    if (localInFlight) return localInFlight

    const slot: { promise: Promise<AccessTokenResponse> | null } = { promise: null }
    slot.promise = (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        return await Promise.race([
          refreshWithLock(gen),
          new Promise<AccessTokenResponse>((_, reject) => {
            cancelInFlight = reject
            timer = setTimeout(() => {
              reject(new Error('refresh_wait_timeout'))
            }, waitTimeoutMs)
          }),
        ])
      } finally {
        if (timer !== undefined) clearTimeout(timer)
        if (cancelInFlight) cancelInFlight = null
        if (localInFlight === slot.promise) localInFlight = null
      }
    })()

    localInFlight = slot.promise
    return slot.promise
  }

  const bumpGeneration = (reason: 'logout' | 'account_switch' | 'dispose') => {
    generation += 1
    lastSuccess = null
    lastSuccessAt = 0
    lastSuccessGeneration = -1
    const rejectInFlight = cancelInFlight
    cancelInFlight = null
    localInFlight = null
    if (rejectInFlight) {
      rejectInFlight(new RefreshCancelledError(`refresh_cancelled_${reason}`))
    }
    if (channel && reason !== 'dispose') {
      try {
        channel.postMessage({ v: 1, type: 'session-cancelled', generation })
      } catch {
        // канал мог быть закрыт
      }
    }
    return generation
  }

  return {
    requestRefresh,
    /** Logout / смена аккаунта: отменяет ожидания прежней сессии. */
    cancel(reason: 'logout' | 'account_switch' = 'logout') {
      bumpGeneration(reason)
    },
    getGeneration() {
      return generation
    },
    subscribeSuccess(listener: RefreshSuccessListener) {
      successListeners.add(listener)
      return () => {
        successListeners.delete(listener)
      }
    },
    dispose() {
      bumpGeneration('dispose')
      disposed = true
      successListeners.clear()
      if (channel) {
        channel.onmessage = null
        try {
          channel.close()
        } catch {
          // ignore
        }
        channel = null
      }
    },
  }
}

export type RefreshCoordinator = ReturnType<typeof createRefreshCoordinator>

/** Процессный singleton для AuthProvider и WsProvider. */
let shared: RefreshCoordinator | null = null

export function getSharedRefreshCoordinator(
  refresh: () => Promise<AccessTokenResponse>,
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
}
