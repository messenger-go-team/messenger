import { useContext } from 'react'
import { WsContext, type WsContextValue } from '@/features/ws/ws-context'

/** Доступ к живому WS-клиенту и его snapshot. */
export function useWs(): WsContextValue {
  const value = useContext(WsContext)
  if (!value) {
    throw new Error('useWs must be used within WsProvider')
  }
  return value
}
