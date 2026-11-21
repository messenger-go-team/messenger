import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AccessTokenResponse } from '@/api/auth'
import {
  createRefreshCoordinator,
  RefreshCancelledError,
  type BroadcastChannelLike,
  type RefreshCoordinatorMessage,
} from '@/features/auth/refreshCoordinator'

function session(token: string): AccessTokenResponse {
  return { token_type: 'Bearer', access_token: token, expires_in: 900 }
}

/** Общий exclusive lock для нескольких «вкладок» в одном процессе. */
function createSerialLockManager(): Pick<LockManager, 'request'> {
  let chain: Promise<unknown> = Promise.resolve()
  const request = (<T>(_name: string, callback: LockGrantedCallback<T>): Promise<T> => {
    const run = chain.then(() => callback({ name: _name } as Lock))
    chain = run.then(
      () => undefined,
      () => undefined,
    )
    return run as Promise<T>
  }) as LockManager['request']
  return { request }
}

function createChannelHub() {
  const subscribers = new Set<(message: RefreshCoordinatorMessage) => void>()

  return {
    createChannel(name: string): BroadcastChannelLike {
      void name
      let deliver: ((message: RefreshCoordinatorMessage) => void) | null = null
      const channel: BroadcastChannelLike = {
        onmessage: null,
        postMessage(message) {
          // Как настоящий BroadcastChannel: отправитель своё сообщение не получает.
          for (const notify of subscribers) {
            if (notify !== deliver) notify(message)
          }
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

describe('createRefreshCoordinator', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('runs a single refresh when two tabs request at once', async () => {
    const refresh = vi.fn().mockResolvedValue(session('access-1'))
    const locks = createSerialLockManager()
    const hub = createChannelHub()

    const tabA = createRefreshCoordinator({
      refresh,
      locks,
      createChannel: hub.createChannel,
    })
    const tabB = createRefreshCoordinator({
      refresh,
      locks,
      createChannel: hub.createChannel,
    })

    const [a, b] = await Promise.all([tabA.requestRefresh(), tabB.requestRefresh()])

    expect(refresh).toHaveBeenCalledTimes(1)
    expect(a.access_token).toBe('access-1')
    expect(b.access_token).toBe('access-1')

    tabA.dispose()
    tabB.dispose()
  })

  it('delivers remote success to success listeners without a second refresh', async () => {
    const refresh = vi.fn().mockResolvedValue(session('access-2'))
    const locks = createSerialLockManager()
    const hub = createChannelHub()
    const heard: string[] = []

    const leader = createRefreshCoordinator({
      refresh,
      locks,
      createChannel: hub.createChannel,
    })
    const follower = createRefreshCoordinator({
      refresh,
      locks,
      createChannel: hub.createChannel,
    })
    follower.subscribeSuccess((next) => {
      heard.push(next.access_token)
    })

    await leader.requestRefresh()
    await vi.waitFor(() => {
      expect(heard).toEqual(['access-2'])
    })
    expect(refresh).toHaveBeenCalledTimes(1)

    leader.dispose()
    follower.dispose()
  })

  it('cancel rejects in-flight refresh and ignores a late success', async () => {
    let resolveRefresh!: (value: AccessTokenResponse) => void
    const refresh = vi.fn(
      () =>
        new Promise<AccessTokenResponse>((resolve) => {
          resolveRefresh = resolve
        }),
    )
    const locks = createSerialLockManager()
    const hub = createChannelHub()
    const coordinator = createRefreshCoordinator({
      refresh,
      locks,
      createChannel: hub.createChannel,
    })

    const pending = coordinator.requestRefresh()
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(1))
    coordinator.cancel('logout')

    await expect(pending).rejects.toBeInstanceOf(RefreshCancelledError)

    const lateListener = vi.fn()
    coordinator.subscribeSuccess(lateListener)
    resolveRefresh(session('late-token'))
    await Promise.resolve()
    expect(lateListener).not.toHaveBeenCalled()

    coordinator.dispose()
  })

  it('lets the waiting tab refresh after the leader fails without a success broadcast', async () => {
    const refresh = vi
      .fn()
      .mockRejectedValueOnce(new Error('leader_tab_crashed'))
      .mockResolvedValueOnce(session('recovered'))
    const locks = createSerialLockManager()
    const hub = createChannelHub()

    const leader = createRefreshCoordinator({
      refresh,
      locks,
      createChannel: hub.createChannel,
    })
    const waiter = createRefreshCoordinator({
      refresh,
      locks,
      createChannel: hub.createChannel,
    })

    const leaderPending = leader.requestRefresh()
    const waiterPending = waiter.requestRefresh()

    await expect(leaderPending).rejects.toThrow('leader_tab_crashed')
    await expect(waiterPending).resolves.toMatchObject({ access_token: 'recovered' })
    expect(refresh).toHaveBeenCalledTimes(2)

    leader.dispose()
    waiter.dispose()
  })
})
