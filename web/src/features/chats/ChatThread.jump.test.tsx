import { useState } from 'react'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { User } from '@/api/auth'
import { login } from '@/api/auth'
import { AuthContext, type AuthContextValue } from '@/features/auth/auth-context'
import { ChatThread } from '@/features/chats/ChatThread'
import { LaterRemindersProvider } from '@/features/later/LaterRemindersProvider'
import { useLaterReminders } from '@/features/later/useLaterReminders'
import { WsProvider } from '@/features/ws/WsProvider'
import { MockWebSocketServer } from '@/ws/mock/server'
import { server } from '../../../mocks/server'
import { INITIAL_CHAT_ID, addMockHistoryMessage } from '../../../mocks/data/history'
import { seedLaterMocks } from '../../../mocks/handlers/later'

const ALICE: User = {
  id: '00000000-0000-4000-8000-000000000001',
  username: 'alice_1',
  created_at: '2026-01-01T00:00:00Z',
}
const BOB_ID = '00000000-0000-4000-8000-000000000002'
const TOTAL = 120

function messageId(seq: number) {
  return `20000000-0000-4000-8000-${String(seq).padStart(12, '0')}`
}

function bodyOf(seq: number) {
  return `Сообщение №${seq}`
}

/** Расширяет фикстуру из 6 сообщений до TOTAL, чтобы окно контекста не покрывало весь чат. */
function seedLongHistory() {
  for (let seq = 7; seq <= TOTAL; seq += 1) {
    addMockHistoryMessage({
      id: messageId(seq),
      chat_id: INITIAL_CHAT_ID,
      seq,
      sender_id: seq % 2 === 0 ? BOB_ID : ALICE.id,
      body: bodyOf(seq),
      created_at: '2026-11-02T10:00:00Z',
    })
  }
}

async function authValue(): Promise<AuthContextValue> {
  const session = await login({ username: 'alice_1', password: 'correct-horse-battery' })
  return {
    user: ALICE,
    accessToken: session.access_token,
    isReady: true,
    isAuthenticated: true,
    logoutError: null,
    login: async () => undefined,
    register: async () => undefined,
    logout: async () => undefined,
  }
}

function LaterCount() {
  const { entries } = useLaterReminders()
  return <p data-testid="later-count">{entries.length}</p>
}

function renderThread(
  auth: AuthContextValue,
  props: { focusMessageId?: string | null; onFocusConsumed?: () => void },
) {
  const mockWs = new MockWebSocketServer({ senderId: ALICE.id })
  mockWs.ensureSequenceAtLeast(INITIAL_CHAT_ID, TOTAL)
  return render(
    <AuthContext.Provider value={auth}>
      <WsProvider webSocketFactory={mockWs.webSocketFactory} disableApiMockSocket>
        <MemoryRouter>
          <LaterRemindersProvider>
            <LaterCount />
            <ChatThread chatId={INITIAL_CHAT_ID} peerUsername="bob_2" {...props} />
          </LaterRemindersProvider>
        </MemoryRouter>
      </WsProvider>
    </AuthContext.Provider>,
  )
}

function bubble(seq: number) {
  return document.querySelector(`[data-message-id="${messageId(seq)}"]`)
}

describe('ChatThread jump to message', () => {
  const scrollIntoView = vi.fn()

  beforeEach(() => {
    scrollIntoView.mockReset()
    Element.prototype.scrollIntoView = scrollIntoView
    seedLongHistory()
  })

  afterEach(() => {
    server.events.removeAllListeners()
    // @ts-expect-error jsdom не определяет scrollIntoView — возвращаем исходное состояние.
    delete Element.prototype.scrollIntoView
  })

  it('loads the context window, scrolls to the target and highlights it', async () => {
    renderThread(await authValue(), { focusMessageId: messageId(20) })

    expect(await screen.findByText(bodyOf(20))).toBeInTheDocument()
    // limit 50 → 24 older + target + 25 newer: seq 1..45; the latest page is not loaded.
    expect(screen.getByText(bodyOf(45))).toBeInTheDocument()
    expect(screen.queryByText(bodyOf(TOTAL))).not.toBeInTheDocument()

    await waitFor(() => expect(bubble(20)).toHaveAttribute('data-highlighted', 'true'))
    expect(bubble(21)).not.toHaveAttribute('data-highlighted')
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'center' })
    expect(scrollIntoView.mock.contexts[0]).toBe(bubble(20))
  })

  it('does not stick to the bottom nor merge newer WS messages into the window', async () => {
    renderThread(await authValue(), { focusMessageId: messageId(20) })
    await screen.findByText(bodyOf(20))

    expect(screen.queryByText(bodyOf(60))).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'К последним сообщениям' })).toBeInTheDocument()
  })

  it('removes the highlight after a short delay', async () => {
    renderThread(await authValue(), { focusMessageId: messageId(20) })
    await waitFor(() => expect(bubble(20)).toHaveAttribute('data-highlighted', 'true'))

    await waitFor(() => expect(bubble(20)).not.toHaveAttribute('data-highlighted'), {
      timeout: 4000,
    })
  })

  it('tells the parent the one-shot focus was consumed', async () => {
    const onFocusConsumed = vi.fn()
    renderThread(await authValue(), { focusMessageId: messageId(20), onFocusConsumed })

    await screen.findByText(bodyOf(20))
    expect(onFocusConsumed).toHaveBeenCalledTimes(1)
  })

  it('continues normal after_seq pagination from the bottom of the window', async () => {
    const afterRequests: string[] = []
    server.events.on('request:start', ({ request }) => {
      const url = new URL(request.url)
      if (url.pathname === `/chats/${INITIAL_CHAT_ID}/messages`) {
        afterRequests.push(url.search)
      }
    })

    renderThread(await authValue(), { focusMessageId: messageId(20) })
    await screen.findByText(bodyOf(20))

    const scroller = screen.getByTestId('chat-thread-scroll')
    Object.defineProperty(scroller, 'scrollHeight', { configurable: true, value: 2000 })
    Object.defineProperty(scroller, 'clientHeight', { configurable: true, value: 400 })
    await act(async () => {
      scroller.scrollTop = 1590
      scroller.dispatchEvent(new Event('scroll', { bubbles: true }))
    })

    expect(await screen.findByText(bodyOf(46))).toBeInTheDocument()
    expect(screen.getByText(bodyOf(95))).toBeInTheDocument()
    expect(afterRequests).toContain('?after_seq=45&limit=50')
    // The window is unchanged on the older side and still has more after seq 95.
    expect(screen.getByText('Привет, Боб!')).toBeInTheDocument()
    expect(screen.queryByText(bodyOf(TOTAL))).not.toBeInTheDocument()
  })

  it('continues before_seq pagination upwards from the window', async () => {
    renderThread(await authValue(), { focusMessageId: messageId(60) })
    await screen.findByText(bodyOf(60))
    // limit 50 → seq 36..85, older side still has seq 1..35.
    expect(screen.queryByText(bodyOf(35))).not.toBeInTheDocument()

    const scroller = screen.getByTestId('chat-thread-scroll')
    Object.defineProperty(scroller, 'scrollHeight', { configurable: true, value: 2000 })
    Object.defineProperty(scroller, 'clientHeight', { configurable: true, value: 400 })
    await act(async () => {
      scroller.scrollTop = 0
      scroller.dispatchEvent(new Event('scroll', { bubbles: true }))
    })

    expect(await screen.findByText(bodyOf(35))).toBeInTheDocument()
    expect(screen.getByText('Привет, Боб!')).toBeInTheDocument()
  })

  it('returns to the latest messages from the window', async () => {
    renderThread(await authValue(), { focusMessageId: messageId(20) })
    await screen.findByText(bodyOf(20))

    fireEvent.click(screen.getByRole('button', { name: 'К последним сообщениям' }))

    expect(await screen.findByText(bodyOf(TOTAL))).toBeInTheDocument()
    expect(screen.queryByText(bodyOf(20))).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'К последним сообщениям' })).not.toBeInTheDocument()
  })

  it('on 404 drops the Later entry, says the message is unavailable and shows the chat', async () => {
    const missingId = '20000000-0000-4000-8000-0000000000ff'
    seedLaterMocks([
      {
        id: '98fcaed4-d453-4cba-b561-4100fe7aa314',
        message: {
          id: missingId,
          chat_id: INITIAL_CHAT_ID,
          seq: 3,
          sender_id: BOB_ID,
          body: 'Исчезнувшее',
          created_at: '2026-11-14T15:00:00Z',
        },
        due_at: null,
        created_at: '2026-11-14T15:00:00Z',
        updated_at: '2026-11-14T15:00:00Z',
      },
    ])
    renderThread(await authValue(), { focusMessageId: missingId })
    await waitFor(() => expect(screen.getByTestId('later-count')).toHaveTextContent('1'))

    expect(await screen.findByText('Сообщение недоступно')).toBeInTheDocument()
    expect(screen.getByTestId('chat-thread-scroll')).not.toHaveTextContent('Сообщение недоступно')
    expect(await screen.findByText(bodyOf(TOTAL))).toBeInTheDocument()
    await waitFor(() => expect(screen.getByTestId('later-count')).toHaveTextContent('0'))
  })

  it('does not merge the previous page into a context window that is still loading', async () => {
    let release: () => void = () => undefined
    const contextReady = new Promise<void>((resolve) => {
      release = resolve
    })
    server.use(
      http.get(`/chats/${INITIAL_CHAT_ID}/messages/${messageId(20)}/context`, async () => {
        await contextReady
        return HttpResponse.json({
          target_message_id: messageId(20),
          messages: Array.from({ length: 45 }, (_, index) => {
            const seq = index + 1
            return {
              id: messageId(seq),
              chat_id: INITIAL_CHAT_ID,
              seq,
              sender_id: BOB_ID,
              body: bodyOf(seq),
              created_at: '2026-11-02T10:00:00Z',
            }
          }),
          next_before_seq: 1,
          next_after_seq: 45,
          has_more_before: false,
          has_more_after: true,
        })
      }),
    )
    const beforeRequests: string[] = []
    server.events.on('request:start', ({ request }) => {
      const url = new URL(request.url)
      if (url.pathname.endsWith('/messages') && url.searchParams.has('before_seq')) {
        beforeRequests.push(url.searchParams.get('before_seq') ?? '')
      }
    })

    const auth = await authValue()
    const mockWs = new MockWebSocketServer({ senderId: ALICE.id })
    mockWs.ensureSequenceAtLeast(INITIAL_CHAT_ID, TOTAL)

    function Harness() {
      const [focus, setFocus] = useState<string | null>(null)
      return (
        <>
          <button type="button" onClick={() => setFocus(messageId(20))}>
            jump
          </button>
          <ChatThread chatId={INITIAL_CHAT_ID} peerUsername="bob_2" focusMessageId={focus} />
        </>
      )
    }

    render(
      <AuthContext.Provider value={auth}>
        <WsProvider webSocketFactory={mockWs.webSocketFactory} disableApiMockSocket>
          <MemoryRouter>
            <LaterRemindersProvider>
              <Harness />
            </LaterRemindersProvider>
          </MemoryRouter>
        </WsProvider>
      </AuthContext.Provider>,
    )
    expect(await screen.findByText(bodyOf(TOTAL))).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'jump' }))

    const scroller = screen.getByTestId('chat-thread-scroll')
    Object.defineProperty(scroller, 'scrollHeight', { configurable: true, value: 2000 })
    Object.defineProperty(scroller, 'clientHeight', { configurable: true, value: 400 })
    await act(async () => {
      scroller.scrollTop = 0
      scroller.dispatchEvent(new Event('scroll', { bubbles: true }))
    })
    release()

    expect(await screen.findByText(bodyOf(20))).toBeInTheDocument()
    expect(screen.queryByText(bodyOf(70))).not.toBeInTheDocument()
    expect(beforeRequests).toEqual([])
  })

  it('keeps the target on a temporary error and retries the context', async () => {
    let calls = 0
    server.use(
      http.get(`/chats/${INITIAL_CHAT_ID}/messages/${messageId(20)}/context`, () => {
        calls += 1
        if (calls === 1) {
          return HttpResponse.json(
            { code: 'service_unavailable', message: 'down' },
            { status: 503 },
          )
        }
        return HttpResponse.json({
          target_message_id: messageId(20),
          messages: [
            {
              id: messageId(20),
              chat_id: INITIAL_CHAT_ID,
              seq: 20,
              sender_id: BOB_ID,
              body: bodyOf(20),
              created_at: '2026-11-02T10:00:00Z',
            },
          ],
          next_before_seq: 20,
          next_after_seq: 20,
          has_more_before: true,
          has_more_after: true,
        })
      }),
    )
    renderThread(await authValue(), { focusMessageId: messageId(20) })

    expect(await screen.findByText(/Не удалось открыть сообщение/)).toBeInTheDocument()
    expect(screen.queryByText('Сообщение недоступно')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Повторить' }))

    expect(await screen.findByText(bodyOf(20))).toBeInTheDocument()
    await waitFor(() => expect(bubble(20)).toHaveAttribute('data-highlighted', 'true'))
    expect(calls).toBe(2)
  })
})
