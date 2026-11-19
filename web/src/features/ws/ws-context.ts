import { createContext } from 'react'
import type { MessengerWebSocketClient, WebSocketClientSnapshot } from '@/ws'

export interface WsContextValue {
  client: MessengerWebSocketClient | null
  snapshot: WebSocketClientSnapshot
}

export const idleSnapshot: WebSocketClientSnapshot = {
  transport: 'idle',
  history: 'not_started',
  pending: [],
  messages: [],
}

export const WsContext = createContext<WsContextValue | null>(null)
