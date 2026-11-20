import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { refresh as refreshRequest } from '@/api/auth'
import { ApiError } from '@/api/client'
import { getMessageHistory, listChats } from '@/api/history'
import { useAuth } from '@/features/auth/useAuth'
import { idleSnapshot, WsContext } from '@/features/ws/ws-context'
import {
  MessengerWebSocketClient,
  type AuthAdapter,
  type HistoryAdapter,
  type WebSocketClientSnapshot,
  type WebSocketFactory,
} from '@/ws'
import { MockWebSocketServer } from '@/ws/mock/server'

interface WsProviderProps {
  children: ReactNode
  /** Подмена фабрики сокетов (Vitest / MockWebSocketServer). */
  webSocketFactory?: WebSocketFactory
  /** Не поднимать in-memory mock при VITE_API_MOCK (например, в unit-тестах с явной фабрикой). */
  disableApiMockSocket?: boolean
}

/**
 * Держит один MessengerWebSocketClient на сессию: start при login, stop при logout.
 * HistoryAdapter кормит after_seq recovery; AuthAdapter — refresh cookie.
 */
export function WsProvider({
  children,
  webSocketFactory,
  disableApiMockSocket = false,
}: WsProviderProps) {
  const { user, accessToken, isAuthenticated } = useAuth()
  const [snapshot, setSnapshot] = useState<WebSocketClientSnapshot>(idleSnapshot)
  const clientRef = useRef<MessengerWebSocketClient | null>(null)
  const mockServerRef = useRef<MockWebSocketServer | null>(null)
  const [client, setClient] = useState<MessengerWebSocketClient | null>(null)

  const authAdapter = useMemo<AuthAdapter>(
    () => ({
      async refreshAccessToken() {
        try {
          const session = await refreshRequest()
          return { kind: 'success', accessToken: session.access_token }
        } catch (error) {
          if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
            return { kind: 'unauthorized' }
          }
          return { kind: 'temporary_failure' }
        }
      },
    }),
    [],
  )

  const historyAdapter = useMemo<HistoryAdapter>(
    () => ({
      async listChats(token) {
        const response = await listChats(token)
        return response.chats.map((chat) => ({ id: chat.id }))
      },
      async getMessages(chatId, token, options) {
        const page = await getMessageHistory(chatId, token, {
          afterSeq: options.afterSeq,
          limit: options.limit,
        })
        const last = page.messages.at(-1)
        if (last && mockServerRef.current) {
          mockServerRef.current.ensureSequenceAtLeast(chatId, last.seq)
        }
        return {
          messages: page.messages,
          next_after_seq: page.next_after_seq,
          has_more_after: page.has_more_after,
        }
      },
    }),
    [],
  )

  useEffect(() => {
    let cancelled = false
    let unsubscribe: (() => void) | undefined
    const timer = window.setTimeout(() => {
      if (cancelled) return

      if (!isAuthenticated || !user || !accessToken) {
        clientRef.current?.stop()
        clientRef.current = null
        mockServerRef.current = null
        setClient(null)
        setSnapshot(idleSnapshot)
        return
      }

      // Клиент живёт на user.id: refresh JWT идёт через AuthAdapter, без reconnect.
      let factory = webSocketFactory
      if (!factory && !disableApiMockSocket && import.meta.env.VITE_API_MOCK === 'true') {
        const mock = new MockWebSocketServer({ senderId: user.id })
        mockServerRef.current = mock
        factory = mock.webSocketFactory
      }

      const next = new MessengerWebSocketClient({
        accessToken,
        currentUserId: user.id,
        auth: authAdapter,
        history: historyAdapter,
        webSocketFactory: factory,
      })
      clientRef.current = next
      setClient(next)
      unsubscribe = next.subscribe(setSnapshot)
      next.start()
    }, 0)

    return () => {
      cancelled = true
      window.clearTimeout(timer)
      unsubscribe?.()
      const current = clientRef.current
      if (current) {
        current.stop()
        clientRef.current = null
        mockServerRef.current = null
      }
      setClient(null)
      setSnapshot(idleSnapshot)
    }
    // accessToken намеренно только на старте сессии пользователя
    // eslint-disable-next-line react-hooks/exhaustive-deps -- recreate on identity, not refresh
  }, [
    authAdapter,
    disableApiMockSocket,
    historyAdapter,
    isAuthenticated,
    user?.id,
    webSocketFactory,
  ])

  const value = useMemo(() => ({ client, snapshot }), [client, snapshot])

  return <WsContext.Provider value={value}>{children}</WsContext.Provider>
}
