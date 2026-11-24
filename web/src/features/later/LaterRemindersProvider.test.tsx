import { act, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { User } from '@/api/auth'
import { ApiError } from '@/api/client'
import { listLater, type LaterEntry, type LaterList } from '@/api/later'
import { AuthContext, type AuthContextValue } from '@/features/auth/auth-context'
import { LaterRemindersProvider } from '@/features/later/LaterRemindersProvider'
import { useLaterReminders } from '@/features/later/useLaterReminders'

vi.mock('@/api/later', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/later')>()),
  listLater: vi.fn(),
}))

const listLaterMock = vi.mocked(listLater)

const ALICE: User = { id: 'u-alice', username: 'alice_1', created_at: '2026-01-01T00:00:00Z' }
const BOB: User = { id: 'u-bob', username: 'bob_2', created_at: '2026-01-01T00:00:00Z' }
const SERVER_TIME = '2026-11-24T12:00:00.000Z'
const CHAT_ID = '10000000-0000-4000-8000-000000000001'

function entry(id: string, overrides: Partial<LaterEntry> = {}): LaterEntry {
  return {
    id,
    status: 'unscheduled',
    message: {
      id: `m-${id}`,
      chat_id: CHAT_ID,
      seq: 1,
      sender_id: 'peer',
      body: `Текст ${id}`,
      created_at: '2026-11-24T10:00:00Z',
    },
    due_at: null,
    created_at: '2026-11-24T10:00:00Z',
    updated_at: '2026-11-24T10:00:00Z',
    ...overrides,
  }
}

function dueEntry(id: string): LaterEntry {
  return entry(id, { status: 'due', due_at: '2026-11-24T11:00:00.000Z' })
}

function scheduledEntry(id: string, inMs: number): LaterEntry {
  return entry(id, {
    status: 'scheduled',
    due_at: new Date(Date.parse(SERVER_TIME) + inMs).toISOString(),
  })
}

function list(entries: LaterEntry[]): LaterList {
  return { server_time: SERVER_TIME, entries }
}

function auth(user: User | null, token = 'token-1'): AuthContextValue {
  return {
    user,
    accessToken: user ? token : null,
    isReady: true,
    isAuthenticated: Boolean(user),
    logoutError: null,
    login: async () => undefined,
    register: async () => undefined,
    logout: async () => undefined,
  }
}

let api: ReturnType<typeof useLaterReminders> | null = null

function Probe() {
  api = useLaterReminders()
  const location = useLocation()
  return (
    <div>
      <p data-testid="status">{api.status}</p>
      <p data-testid="error">{api.error ?? ''}</p>
      <p data-testid="ids">{api.entries.map((item) => item.id).join(',')}</p>
      <p data-testid="location">
        {location.pathname}|{JSON.stringify(location.state)}
      </p>
    </div>
  )
}

function tree(value: AuthContextValue, recoverAuth = vi.fn().mockResolvedValue(undefined)) {
  return (
    <AuthContext.Provider value={value}>
      <MemoryRouter initialEntries={['/']}>
        <LaterRemindersProvider recoverAuth={recoverAuth}>
          <Routes>
            <Route path="*" element={<Probe />} />
          </Routes>
        </LaterRemindersProvider>
      </MemoryRouter>
    </AuthContext.Provider>
  )
}

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}

async function flush() {
  await advance(0)
}

function setHidden(hidden: boolean) {
  Object.defineProperty(document, 'hidden', { configurable: true, value: hidden })
  document.dispatchEvent(new Event('visibilitychange'))
}

beforeEach(() => {
  vi.useFakeTimers()
  listLaterMock.mockReset()
  api = null
  Object.defineProperty(document, 'hidden', { configurable: true, value: false })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('LaterRemindersProvider polling', () => {
  it('loads on open and keeps polling every 30 s even when the list is empty', async () => {
    listLaterMock.mockResolvedValue(list([]))
    render(tree(auth(ALICE)))
    await flush()

    expect(listLaterMock).toHaveBeenCalledTimes(1)
    expect(listLaterMock).toHaveBeenLastCalledWith('token-1')
    expect(screen.getByTestId('status')).toHaveTextContent('ready')

    await advance(29_000)
    expect(listLaterMock).toHaveBeenCalledTimes(1)
    await advance(1_000)
    expect(listLaterMock).toHaveBeenCalledTimes(2)
    await advance(30_000)
    expect(listLaterMock).toHaveBeenCalledTimes(3)
  })

  it('polls when only unscheduled entries exist', async () => {
    listLaterMock.mockResolvedValue(list([entry('a')]))
    render(tree(auth(ALICE)))
    await flush()
    await advance(30_000)

    expect(listLaterMock).toHaveBeenCalledTimes(2)
  })

  it('wakes at the nearest due_at measured on the server clock, before the 30 s poll', async () => {
    listLaterMock.mockResolvedValueOnce(list([scheduledEntry('a', 10_000)]))
    listLaterMock.mockResolvedValue(list([dueEntry('a')]))
    render(tree(auth(ALICE)))
    await flush()

    await advance(9_000)
    expect(listLaterMock).toHaveBeenCalledTimes(1)
    await advance(1_000)
    expect(listLaterMock).toHaveBeenCalledTimes(2)
    expect(screen.getByRole('region', { name: 'Напоминание' })).toBeInTheDocument()
  })

  it('does not request while the tab is hidden and refreshes when it becomes visible', async () => {
    listLaterMock.mockResolvedValue(list([]))
    render(tree(auth(ALICE)))
    await flush()

    act(() => setHidden(true))
    await advance(120_000)
    expect(listLaterMock).toHaveBeenCalledTimes(1)

    act(() => setHidden(false))
    await flush()
    expect(listLaterMock).toHaveBeenCalledTimes(2)
  })

  it('refreshes when the window regains focus', async () => {
    listLaterMock.mockResolvedValue(list([]))
    render(tree(auth(ALICE)))
    await flush()

    act(() => {
      window.dispatchEvent(new Event('focus'))
    })
    await flush()
    expect(listLaterMock).toHaveBeenCalledTimes(2)
  })

  it('coalesces concurrent refreshes into a single GET', async () => {
    let resolve: (value: LaterList) => void = () => undefined
    listLaterMock.mockReturnValue(new Promise<LaterList>((done) => (resolve = done)))
    render(tree(auth(ALICE)))
    await flush()

    act(() => {
      void api?.refresh()
      void api?.refresh()
      window.dispatchEvent(new Event('focus'))
    })
    expect(listLaterMock).toHaveBeenCalledTimes(1)

    await act(async () => resolve(list([])))
    expect(screen.getByTestId('status')).toHaveTextContent('ready')
    await advance(30_000)
    expect(listLaterMock).toHaveBeenCalledTimes(2)
  })

  it('retries 5 → 10 → 20 → 30 → 30 s after 503 and shows the toast after recovery', async () => {
    listLaterMock.mockRejectedValue(new ApiError(503, 'service_unavailable', 'down'))
    render(tree(auth(ALICE)))
    await flush()
    expect(screen.getByTestId('status')).toHaveTextContent('error')
    expect(screen.queryByRole('region', { name: 'Напоминание' })).not.toBeInTheDocument()

    for (const [delay, calls] of [
      [5_000, 2],
      [10_000, 3],
      [20_000, 4],
      [30_000, 5],
      [30_000, 6],
    ] as const) {
      await advance(delay - 1)
      expect(listLaterMock).toHaveBeenCalledTimes(calls - 1)
      await advance(1)
      expect(listLaterMock).toHaveBeenCalledTimes(calls)
    }

    listLaterMock.mockResolvedValue(list([dueEntry('a')]))
    await advance(30_000)
    expect(screen.getByTestId('status')).toHaveTextContent('ready')
    expect(screen.getByRole('region', { name: 'Напоминание' })).toBeInTheDocument()

    // Backoff resets: the next regular poll is 30 s away, not 5 s.
    await advance(5_000)
    expect(listLaterMock).toHaveBeenCalledTimes(7)
  })

  it('treats a network failure like 5xx and never turns an error into an empty list', async () => {
    listLaterMock.mockResolvedValueOnce(list([entry('a')]))
    listLaterMock.mockRejectedValue(new TypeError('Failed to fetch'))
    render(tree(auth(ALICE)))
    await flush()
    await advance(30_000)

    expect(screen.getByTestId('status')).toHaveTextContent('ready')
    expect(screen.getByTestId('error')).not.toBeEmptyDOMElement()
    expect(screen.getByTestId('ids')).toHaveTextContent('a')

    await advance(5_000)
    expect(listLaterMock).toHaveBeenCalledTimes(3)
  })

  it('requests normal auth recovery on 401 without temporary backoff', async () => {
    const recoverAuth = vi.fn().mockResolvedValue(undefined)
    listLaterMock.mockRejectedValue(new ApiError(401, 'unauthorized', 'expired'))
    render(tree(auth(ALICE), recoverAuth))
    await flush()

    expect(recoverAuth).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('status')).not.toHaveTextContent('error')

    await advance(5_000)
    await advance(10_000)
    expect(listLaterMock).toHaveBeenCalledTimes(1)
  })

  it('repeats GET with the rotated access token', async () => {
    listLaterMock.mockResolvedValue(list([]))
    const view = render(tree(auth(ALICE, 'token-1')))
    await flush()

    view.rerender(tree(auth(ALICE, 'token-2')))
    await flush()

    expect(listLaterMock).toHaveBeenCalledTimes(2)
    expect(listLaterMock).toHaveBeenLastCalledWith('token-2')
  })
})

describe('LaterRemindersProvider reminders', () => {
  it('shows the toast with preview, due label and actions for a fresh due entry', async () => {
    listLaterMock.mockResolvedValue(list([dueEntry('a')]))
    render(tree(auth(ALICE)))
    await flush()

    const toast = screen.getByRole('region', { name: 'Напоминание' })
    expect(toast).toHaveTextContent('Текст a')
    expect(toast).toHaveTextContent('Срок:')
    expect(screen.getByRole('button', { name: 'Позже' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Открыть' })).toBeInTheDocument()
  })

  it('«Позже» only dismisses; later polls with the same due entry stay quiet', async () => {
    listLaterMock.mockResolvedValue(list([dueEntry('a')]))
    render(tree(auth(ALICE)))
    await flush()

    fireEvent.click(screen.getByRole('button', { name: 'Позже' }))
    expect(screen.queryByRole('region', { name: 'Напоминание' })).not.toBeInTheDocument()
    expect(screen.getByTestId('ids')).toHaveTextContent('a')

    await advance(30_000)
    expect(listLaterMock).toHaveBeenCalledTimes(2)
    expect(screen.queryByRole('region', { name: 'Напоминание' })).not.toBeInTheDocument()
  })

  it('«Открыть» navigates to the chat with focusMessageId', async () => {
    listLaterMock.mockResolvedValue(list([dueEntry('a')]))
    render(tree(auth(ALICE)))
    await flush()

    fireEvent.click(screen.getByRole('button', { name: 'Открыть' }))

    expect(screen.getByTestId('location')).toHaveTextContent(
      `/chats/${CHAT_ID}|{"focusMessageId":"m-a"}`,
    )
    expect(screen.queryByRole('region', { name: 'Напоминание' })).not.toBeInTheDocument()
  })

  it('removes the toast when the entry is completed', async () => {
    listLaterMock.mockResolvedValue(list([dueEntry('a')]))
    render(tree(auth(ALICE)))
    await flush()

    act(() => api?.removeEntry('a'))

    expect(screen.queryByRole('region', { name: 'Напоминание' })).not.toBeInTheDocument()
    expect(screen.getByTestId('ids')).toBeEmptyDOMElement()
  })

  it('removes the toast when the entry is rescheduled into the future', async () => {
    listLaterMock.mockResolvedValue(list([dueEntry('a')]))
    render(tree(auth(ALICE)))
    await flush()

    act(() => api?.replaceEntry(scheduledEntry('a', 3_600_000), SERVER_TIME))

    expect(screen.queryByRole('region', { name: 'Напоминание' })).not.toBeInTheDocument()
    expect(screen.getByTestId('ids')).toHaveTextContent('a')
  })

  it('shows a rescheduled entry again once a fresh response reports it due', async () => {
    listLaterMock.mockResolvedValueOnce(list([dueEntry('a')]))
    render(tree(auth(ALICE)))
    await flush()
    fireEvent.click(screen.getByRole('button', { name: 'Позже' }))

    const later = { ...dueEntry('a'), due_at: '2026-11-24T11:30:00.000Z' }
    listLaterMock.mockResolvedValue(list([later]))
    await advance(30_000)

    expect(screen.getByRole('region', { name: 'Напоминание' })).toBeInTheDocument()
  })

  it('shows no toast for scheduled or unscheduled entries', async () => {
    listLaterMock.mockResolvedValue(list([entry('a'), scheduledEntry('b', 3_600_000)]))
    render(tree(auth(ALICE)))
    await flush()

    expect(screen.queryByRole('region', { name: 'Напоминание' })).not.toBeInTheDocument()
  })
})

describe('LaterRemindersProvider account changes', () => {
  it('clears timers, entries and the toast on logout', async () => {
    listLaterMock.mockResolvedValue(list([dueEntry('a')]))
    const view = render(tree(auth(ALICE)))
    await flush()
    expect(screen.getByRole('region', { name: 'Напоминание' })).toBeInTheDocument()

    view.rerender(tree(auth(null)))
    await flush()

    expect(screen.queryByRole('region', { name: 'Напоминание' })).not.toBeInTheDocument()
    expect(screen.getByTestId('ids')).toBeEmptyDOMElement()
    await advance(120_000)
    expect(listLaterMock).toHaveBeenCalledTimes(1)
  })

  it('drops the previous account state and ignores its late response', async () => {
    let resolveAlice: (value: LaterList) => void = () => undefined
    listLaterMock.mockReturnValueOnce(new Promise<LaterList>((done) => (resolveAlice = done)))
    const view = render(tree(auth(ALICE)))
    await flush()

    listLaterMock.mockResolvedValueOnce(list([entry('bob-entry')]))
    view.rerender(tree(auth(BOB, 'token-bob')))
    await flush()
    await act(async () => resolveAlice(list([dueEntry('alice-entry')])))

    expect(screen.getByTestId('ids')).toHaveTextContent('bob-entry')
    expect(screen.getByTestId('ids')).not.toHaveTextContent('alice-entry')
    expect(screen.queryByRole('region', { name: 'Напоминание' })).not.toBeInTheDocument()
    expect(listLaterMock).toHaveBeenLastCalledWith('token-bob')
  })

  it('does not carry dismissed reminders over to another account', async () => {
    listLaterMock.mockResolvedValue(list([dueEntry('a')]))
    const view = render(tree(auth(ALICE)))
    await flush()
    fireEvent.click(screen.getByRole('button', { name: 'Позже' }))

    view.rerender(tree(auth(BOB, 'token-bob')))
    await flush()

    expect(screen.getByRole('region', { name: 'Напоминание' })).toBeInTheDocument()
  })
})
