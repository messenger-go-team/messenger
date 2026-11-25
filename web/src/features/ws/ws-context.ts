import { createContext } from 'react'
import type { MessengerWebSocketClient, WebSocketClientSnapshot } from '@/ws'
import type { createChatListReader } from '@/features/ws/chatListReader'

export interface WsContextValue {
  client: MessengerWebSocketClient | null
  snapshot: WebSocketClientSnapshot
  chatList: ReturnType<typeof createChatListReader>
}

export const idleSnapshot: WebSocketClientSnapshot = {
  transport: 'idle',
  history: 'not_started',
  pending: [],
  messages: [],
  liveMessageVersion: 0,
  recoveryVersion: 0,
}

export const WsContext = createContext<WsContextValue | null>(null)
