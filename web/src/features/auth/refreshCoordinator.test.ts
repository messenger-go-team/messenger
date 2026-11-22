import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AccessTokenResponse } from '@/api/auth'
import { ApiError } from '@/api/client'
import {
  createMemoryRefreshStore,
  createRefreshCoordinator,
  RefreshCancelledError,
  RefreshFinalError,
  RefreshTimeoutError,
  type BroadcastChannelLike,
  type RefreshCoordinatorMessage,
  type RefreshSharedStore,
} from '@/features/auth/refreshCoordinator'

function session(token: string): AccessTokenResponse {
  return { token_type: 'Bearer', access_token: token, expires_in: 900 }
}

/** Общий exclusive lock с поддержкой AbortSignal (очередь + отмена ожидания). */
function createSerialLockManager(): Pick<LockManager, 'request'> {
  let tail: Promise<void> = Promise.resolve()
  const abortedError = () => new DOMException('Aborted', 'AbortError')

  const request = ((
    name: string,
    optionsOrCallback: LockOptions | LockGrantedCallback<unknown>,
    maybeCallback?: LockGrantedCallback<unknown>,
  ) => {
    const callback = typeof optionsOrCallback === 'function' ? optionsOrCallback : maybeCallback!
    const options = typeof optionsOrCallback === 'function' ? undefined : optionsOrCallback
    const signal = options?.signal

    if (signal?.aborted) {
      return Promise.reject(abortedError())
    }

    return new Promise<unknown>((resolve, reject) => {
      let cancelled = false
      const onAbort = () => {
        cancelled = true
        reject(abortedError())
      }
      signal?.addEventListener('abort', onAbort)

      const run = async () => {
        if (cancelled || signal?.aborted) return
        try {
          resolve(await callback({ name } as Lock))
        } catch (error) {
          reject(error)
        } finally {
          signal?.removeEventListener('abort', onAbort)
        }
      }

      tail = tail.then(run, run).then(
        () => undefined,
        () => undefined,
      )
    })
  }) as LockManager['request']
  return { request }
}

function createChannelHub(options?: { asyncDelivery?: boolean; delayMs?: number }) {
  const subscribers = new Set<(message: RefreshCoordinatorMessage) => void>()
  const asyncDelivery = options?.asyncDelivery ?? false
  const delayMs = options?.delayMs ?? 0

  return {
    createChannel(name: string): BroadcastChannelLike {
      void name
      let deliver: ((message: RefreshCoordinatorMessage) => void) | null = null
      const channel: BroadcastChannelLike = {
        onmessage: null,
        postMessage(message) {
          const send = () => {
            for (const notify of subscribers) {
              if (notify !== deliver) notify(message)
            }
          }
          // Как в спецификации: доставка другим контекстам не синхронна с postMessage.
          if (delayMs > 0) window.setTimeout(send, delayMs)
          else if (asyncDelivery) queueMicrotask(send)
          else send()
        },
        close() {
          if (deliver) subscribers.delete(deliver)
        },
      }
      deliver = (message: RefreshCoordinatorMessage) => {
        channel.onmessage?.({ data: message } as MessageEvent<RefreshCoordinatorMessage>)
      }
      subscribers.add(deliver)
      return channel
    },
  }
}

function createTab(
  refresh: (signal: AbortSignal) => Promise<AccessTokenResponse>,
  locks: Pick<LockManager, 'request'>,
  hub: ReturnType<typeof createChannelHub>,
  store: RefreshSharedStore,
  extras?: { waitTimeoutMs?: number },
) {
  return createRefreshCoordinator({
    refresh,
    locks,
    createChannel: hub.createChannel,
    store,
    waitTimeoutMs: extras?.waitTimeoutMs,
  })
}

describe('createRefreshCoordinator', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('runs a single refresh when two tabs request at once', async () => {
    const refresh = vi.fn(async () => session('access-1'))
    const locks = createSerialLockManager()
    const hub = createChannelHub()
    const store = createMemoryRefreshStore()

    const tabA = createTab(refresh, locks, hub, store)
    const tabB = createTab(refresh, locks, hub, store)

    const [a, b] = await Promise.all([tabA.requestRefresh(), tabB.requestRefresh()])

    expect(refresh).toHaveBeenCalledTimes(1)
    expect(a.access_token).toBe('access-1')
    expect(b.access_token).toBe('access-1')

    tabA.dispose()
    tabB.dispose()
  })

  it('still runs a single refresh when BroadcastChannel delivery is async', async () => {
    let releaseRefresh!: (value: AccessTokenResponse) => void
    const refresh = vi.fn(
      () =>
        new Promise<AccessTokenResponse>((resolve) => {
          releaseRefresh = resolve
        }),
    )
    const locks = createSerialLockManager()
    const hub = createChannelHub({ asyncDelivery: true })
    const store = createMemoryRefreshStore()

    const tabA = createTab(refresh, locks, hub, store)
    const tabB = createTab(refresh, locks, hub, store)

    const pendingA = tabA.requestRefresh()
    const pendingB = tabB.requestRefresh()
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(1))

    releaseRefresh(session('access-async'))
    const [a, b] = await Promise.all([pendingA, pendingB])

    expect(refresh).toHaveBeenCalledTimes(1)
    expect(a.access_token).toBe('access-async')
    expect(b.access_token).toBe('access-async')

    tabA.dispose()
    tabB.dispose()
  })

  it('keeps one POST after account_switch when tabs share sessionEpoch', async () => {
    const refresh = vi.fn(async () => session('after-switch'))
    const locks = createSerialLockManager()
    const hub = createChannelHub({ asyncDelivery: true })
    const store = createMemoryRefreshStore(0)

    const tabA = createTab(refresh, locks, hub, store)
    await tabA.cancel('account_switch')
    expect(tabA.getSessionEpoch()).toBe(1)
    expect(store.getEpoch()).toBe(1)

    // Новая вкладка читает общий epoch, а не локальный 0.
    const tabB = createTab(refresh, locks, hub, store)
    expect(tabB.getSessionEpoch()).toBe(1)

    const [a, b] = await Promise.all([tabA.requestRefresh(), tabB.requestRefresh()])
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(a.access_token).toBe('after-switch')
    expect(b.access_token).toBe('after-switch')

    tabA.dispose()
    tabB.dispose()
  })

  it('delivers success to listeners for local and remote refresh', async () => {
    const refresh = vi.fn(async () => session('access-2'))
    const locks = createSerialLockManager()
    const hub = createChannelHub()
    const store = createMemoryRefreshStore()
    const localHeard: string[] = []
    const remoteHeard: string[] = []

    const leader = createTab(refresh, locks, hub, store)
    const follower = createTab(refresh, locks, hub, store)
    leader.subscribeSuccess((next) => {
      localHeard.push(next.access_token)
    })
    follower.subscribeSuccess((next) => {
      remoteHeard.push(next.access_token)
    })

    await leader.requestRefresh()
    await vi.waitFor(() => {
      expect(localHeard).toEqual(['access-2'])
      expect(remoteHeard).toEqual(['access-2'])
    })
    expect(refresh).toHaveBeenCalledTimes(1)

    leader.dispose()
    follower.dispose()
  })

  it('cancel aborts the in-flight refresh signal and remote tab adopts epoch', async () => {
    const signals: AbortSignal[] = []
    let resolveRefresh!: (value: AccessTokenResponse) => void
    const refresh = vi.fn(
      (signal: AbortSignal) =>
        new Promise<AccessTokenResponse>((resolve) => {
          signals.push(signal)
          resolveRefresh = resolve
        }),
    )
    const locks = createSerialLockManager()
    const hub = createChannelHub()
    const store = createMemoryRefreshStore()
    const leader = createTab(refresh, locks, hub, store)
    const follower = createTab(refresh, locks, hub, store)
    const invalidated = vi.fn()
    follower.subscribeInvalidated(invalidated)

    const pending = leader.requestRefresh()
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(1))

    await leader.cancel('logout')
    await expect(pending).rejects.toBeInstanceOf(RefreshCancelledError)
    expect(signals[0]?.aborted).toBe(true)

    await vi.waitFor(() => expect(invalidated).toHaveBeenCalled())
    expect(follower.getSessionEpoch()).toBe(leader.getSessionEpoch())

    resolveRefresh(session('late-token'))
    await Promise.resolve()
    expect(store.readMeta()).toBeNull()

    leader.dispose()
    follower.dispose()
  })

  it('ignores a late session-cancelled that would wipe a newer success', async () => {
    const refresh = vi.fn(async () => session('fresh'))
    const locks = createSerialLockManager()
    const hub = createChannelHub({ asyncDelivery: true })
    const store = createMemoryRefreshStore()
    const tab = createTab(refresh, locks, hub, store)

    await tab.cancel('logout')
    await tab.requestRefresh()
    expect(store.readMeta()?.kind).toBe('success')

    // Запоздалый cancel той же эпохи не должен сбросить свежий outcome.
    const channel = hub.createChannel('probe')
    channel.postMessage({ v: 1, type: 'session-cancelled', sessionEpoch: tab.getSessionEpoch() })
    await Promise.resolve()
    expect(store.readMeta()?.kind).toBe('success')

    tab.dispose()
    channel.close()
  })

  it('ignores a late refresh-success with an older opId', async () => {
    let nowMs = 1_000
    const refresh = vi
      .fn<(signal: AbortSignal) => Promise<AccessTokenResponse>>()
      .mockResolvedValueOnce(session('first'))
      .mockResolvedValueOnce(session('second'))
    const locks = createSerialLockManager()
    const hub = createChannelHub()
    const store = createMemoryRefreshStore()
    const tab = createRefreshCoordinator({
      refresh,
      locks,
      createChannel: hub.createChannel,
      store,
      now: () => nowMs,
      recentSuccessMs: 5_000,
    })
    const heard: string[] = []
    tab.subscribeSuccess((s) => heard.push(s.access_token))

    await tab.requestRefresh()
    nowMs += 6_000
    await tab.requestRefresh()
    expect(heard.at(-1)).toBe('second')

    const channel = hub.createChannel('probe')
    channel.postMessage({
      v: 1,
      type: 'refresh-success',
      sessionEpoch: tab.getSessionEpoch(),
      opId: 1,
      token_type: 'Bearer',
      access_token: 'stale-late',
      expires_in: 900,
    })
    await Promise.resolve()
    expect(heard.at(-1)).toBe('second')
    expect(heard).not.toContain('stale-late')

    tab.dispose()
    channel.close()
  })

  it('withSessionChange waits for the lock and only then publishes a new epoch', async () => {
    let releaseRefresh!: (value: AccessTokenResponse) => void
    const refresh = vi.fn(
      () =>
        new Promise<AccessTokenResponse>((resolve) => {
          releaseRefresh = resolve
        }),
    )
    const locks = createSerialLockManager()
    const hub = createChannelHub({ asyncDelivery: true })
    const store = createMemoryRefreshStore()
    const tabA = createTab(refresh, locks, hub, store)
    const tabB = createTab(refresh, locks, hub, store)

    const pendingRefresh = tabB.requestRefresh()
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(1))

    let epochInsideLock = -1
    const logoutPending = tabA.withSessionChange('logout', async () => {
      epochInsideLock = store.getEpoch()
    })

    await Promise.resolve()
    expect(store.getEpoch()).toBe(0)
    expect(epochInsideLock).toBe(-1)

    releaseRefresh(session('from-b'))
    await expect(pendingRefresh).resolves.toMatchObject({ access_token: 'from-b' })
    await logoutPending
    expect(epochInsideLock).toBe(1)
    expect(store.getEpoch()).toBe(1)

    tabA.dispose()
    tabB.dispose()
  })

  it('notifies final-failure listeners for local and remote tabs', async () => {
    const refresh = vi.fn(async () => {
      throw new ApiError(401, 'unauthorized', 'refresh rejected')
    })
    const locks = createSerialLockManager()
    const hub = createChannelHub()
    const store = createMemoryRefreshStore()
    const leader = createTab(refresh, locks, hub, store)
    const follower = createTab(refresh, locks, hub, store)
    const localFinal = vi.fn()
    const remoteFinal = vi.fn()
    leader.subscribeFinalFailure(localFinal)
    follower.subscribeFinalFailure(remoteFinal)

    await expect(leader.requestRefresh()).rejects.toBeInstanceOf(RefreshFinalError)
    await vi.waitFor(() => {
      expect(localFinal).toHaveBeenCalled()
      expect(remoteFinal).toHaveBeenCalled()
    })

    leader.dispose()
    follower.dispose()
  })

  it('does not persist access JWT in the shared store meta', async () => {
    const refresh = vi.fn(async () => session('secret-jwt'))
    const locks = createSerialLockManager()
    const hub = createChannelHub()
    const store = createMemoryRefreshStore()
    const tab = createTab(refresh, locks, hub, store)

    await tab.requestRefresh()
    expect(JSON.stringify(store.readMeta())).not.toContain('secret-jwt')

    tab.dispose()
  })

  it('uses a shared opId so a new tab does not drop a fresh success', async () => {
    let nowMs = 1_000
    const refresh = vi
      .fn<(signal: AbortSignal) => Promise<AccessTokenResponse>>()
      .mockResolvedValueOnce(session('a1'))
      .mockResolvedValueOnce(session('a2'))
      .mockResolvedValueOnce(session('b1'))
    const locks = createSerialLockManager()
    const hub = createChannelHub()
    const store = createMemoryRefreshStore()
    const opts = {
      refresh,
      locks,
      createChannel: hub.createChannel,
      store,
      now: () => nowMs,
      recentSuccessMs: 5_000,
    }
    const tabA = createRefreshCoordinator(opts)
    const heardB: string[] = []

    await tabA.requestRefresh()
    nowMs += 6_000
    await tabA.requestRefresh()
    expect(store.readMeta()?.opId).toBe(2)

    nowMs += 6_000
    const tabB = createRefreshCoordinator(opts)
    tabB.subscribeSuccess((s) => heardB.push(s.access_token))
    const result = await tabB.requestRefresh()
    expect(result.access_token).toBe('b1')
    expect(heardB).toEqual(['b1'])
    expect(store.readMeta()?.opId).toBe(3)

    tabA.dispose()
    tabB.dispose()
  })

  it('waits for a BroadcastChannel success delayed beyond 50ms without a second POST', async () => {
    let releaseRefresh!: (value: AccessTokenResponse) => void
    const refresh = vi.fn(
      () =>
        new Promise<AccessTokenResponse>((resolve) => {
          releaseRefresh = resolve
        }),
    )
    const locks = createSerialLockManager()
    const hub = createChannelHub({ delayMs: 80 })
    const store = createMemoryRefreshStore()
    const tabA = createTab(refresh, locks, hub, store)
    const tabB = createTab(refresh, locks, hub, store)

    const pendingA = tabA.requestRefresh()
    const pendingB = tabB.requestRefresh()
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(1))
    releaseRefresh(session('shared-late-bc'))

    const [a, b] = await Promise.all([pendingA, pendingB])
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(a.access_token).toBe('shared-late-bc')
    expect(b.access_token).toBe('shared-late-bc')

    tabA.dispose()
    tabB.dispose()
  })

  it('timeout aborts a queued lock wait so a late grant does not POST', async () => {
    let releaseLeader!: (value: AccessTokenResponse) => void
    const refresh = vi.fn(
      () =>
        new Promise<AccessTokenResponse>((resolve) => {
          releaseLeader = resolve
        }),
    )
    const locks = createSerialLockManager()
    const hub = createChannelHub()
    const store = createMemoryRefreshStore()

    const leader = createTab(refresh, locks, hub, store, { waitTimeoutMs: 5_000 })
    const waiter = createTab(refresh, locks, hub, store, { waitTimeoutMs: 30 })

    const leaderPending = leader.requestRefresh()
    const waiterPending = waiter.requestRefresh()
    // Подписываемся до таймаута, иначе Vitest видит unhandled rejection.
    const waiterRejected = expect(waiterPending).rejects.toBeInstanceOf(RefreshTimeoutError)
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(1))
    await waiterRejected

    releaseLeader(session('leader-done'))
    await expect(leaderPending).resolves.toMatchObject({ access_token: 'leader-done' })
    // После таймаута waiter не должен стартовать свой POST, когда lock освободится.
    await Promise.resolve()
    await Promise.resolve()
    expect(refresh).toHaveBeenCalledTimes(1)

    leader.dispose()
    waiter.dispose()
  })

  it('final 401 is shared: one POST, both tabs fail without a second refresh', async () => {
    const refresh = vi.fn(async () => {
      throw new ApiError(401, 'unauthorized', 'refresh rejected')
    })
    const locks = createSerialLockManager()
    const hub = createChannelHub({ asyncDelivery: true })
    const store = createMemoryRefreshStore()

    const tabA = createTab(refresh, locks, hub, store)
    const tabB = createTab(refresh, locks, hub, store)

    const [a, b] = await Promise.allSettled([tabA.requestRefresh(), tabB.requestRefresh()])

    expect(refresh).toHaveBeenCalledTimes(1)
    expect(a.status).toBe('rejected')
    expect(b.status).toBe('rejected')
    if (a.status === 'rejected') expect(a.reason).toBeInstanceOf(RefreshFinalError)
    if (b.status === 'rejected') expect(b.reason).toBeInstanceOf(RefreshFinalError)

    tabA.dispose()
    tabB.dispose()
  })

  it('lets the waiting tab refresh after a temporary leader failure', async () => {
    const refresh = vi
      .fn<(signal: AbortSignal) => Promise<AccessTokenResponse>>()
      .mockRejectedValueOnce(new Error('leader_tab_crashed'))
      .mockResolvedValueOnce(session('recovered'))
    const locks = createSerialLockManager()
    const hub = createChannelHub()
    const store = createMemoryRefreshStore()

    const leader = createTab(refresh, locks, hub, store)
    const waiter = createTab(refresh, locks, hub, store)

    const leaderPending = leader.requestRefresh()
    const waiterPending = waiter.requestRefresh()

    await expect(leaderPending).rejects.toThrow('leader_tab_crashed')
    await expect(waiterPending).resolves.toMatchObject({ access_token: 'recovered' })
    expect(refresh).toHaveBeenCalledTimes(2)

    leader.dispose()
    waiter.dispose()
  })
})
