import type { Message } from '@/api/history'
import type { PendingMessage, StoredMessage } from '@/ws'

/** Статус пузыря в ленте (MVP: delivered/read собеседнику — этап 2). */
export type ThreadMessageStatus = 'sending' | 'sent' | 'failed' | 'received'

/** Унифицированное сообщение для окна чата. */
export interface ThreadMessage {
  key: string
  id?: string
  clientMsgId?: string
  chatId: string
  seq?: number
  senderId: string
  body: string
  createdAt: string
  status: ThreadMessageStatus
  mine: boolean
}

/**
 * Склеивает REST-историю, WS-store и pending в одну ленту без дублей.
 * Pending без seq идут после подтверждённых; sent с message_id схлопывается в confirmed.
 */
export function mergeThreadMessages({
  currentUserId,
  chatId,
  history,
  windowMaxSeq = null,
  wsMessages,
  pending,
}: {
  currentUserId: string
  chatId: string
  history: readonly Message[]
  /**
   * Верхняя граница окна контекста, не доходящего до конца чата: WS/ack новее неё скрыты,
   * иначе в ленте появится дыра. null — окно у последних сообщений (обычный режим).
   */
  windowMaxSeq?: number | null
  wsMessages: readonly StoredMessage[]
  pending: readonly PendingMessage[]
}): ThreadMessage[] {
  const byId = new Map<string, ThreadMessage>()
  const byClientMsgId = new Map<string, string>()

  const upsertConfirmed = (message: Message | StoredMessage) => {
    if (message.chat_id !== chatId) return
    const clientMsgId =
      'client_msg_id' in message && typeof message.client_msg_id === 'string'
        ? message.client_msg_id
        : undefined
    const mine = message.sender_id === currentUserId
    const item: ThreadMessage = {
      key: message.id,
      id: message.id,
      clientMsgId,
      chatId: message.chat_id,
      seq: message.seq,
      senderId: message.sender_id,
      body: message.body,
      createdAt: message.created_at,
      status: mine ? 'sent' : 'received',
      mine,
    }
    byId.set(message.id, item)
    if (clientMsgId) byClientMsgId.set(clientMsgId, message.id)
  }

  for (const message of history) upsertConfirmed(message)

  // Окно ленты задаёт REST (history). WS-кэш: только seq внутри окна или новее max —
  // старые seq из sync не всплывают без before_seq / loadOlder.
  let historyMinSeq: number | null = null
  for (const message of history) {
    if (message.chat_id !== chatId) continue
    if (historyMinSeq == null || message.seq < historyMinSeq) historyMinSeq = message.seq
  }

  for (const message of wsMessages) {
    if (message.chat_id !== chatId) continue
    if (historyMinSeq != null && message.seq < historyMinSeq) continue
    if (windowMaxSeq != null && message.seq > windowMaxSeq) continue
    upsertConfirmed(message)
  }

  for (const item of pending) {
    if (item.chatId !== chatId) continue
    if (item.status === 'sent' && item.messageId && byId.has(item.messageId)) continue
    if (item.status === 'sent' && item.messageId) {
      // Та же нижняя граница окна, что и для WS-кэша (ACK не обходит before_seq).
      if (historyMinSeq != null && item.seq != null && item.seq < historyMinSeq) continue
      if (windowMaxSeq != null && item.seq != null && item.seq > windowMaxSeq) continue
      const confirmed: ThreadMessage = {
        key: item.messageId,
        id: item.messageId,
        clientMsgId: item.clientMsgId,
        chatId: item.chatId,
        seq: item.seq,
        senderId: currentUserId,
        body: item.body,
        createdAt: item.createdAt ?? new Date(0).toISOString(),
        status: 'sent',
        mine: true,
      }
      byId.set(item.messageId, confirmed)
      byClientMsgId.set(item.clientMsgId, item.messageId)
      continue
    }

    const existingId = byClientMsgId.get(item.clientMsgId)
    if (existingId && byId.has(existingId)) continue

    byId.set(`pending:${item.clientMsgId}`, {
      key: `pending:${item.clientMsgId}`,
      clientMsgId: item.clientMsgId,
      chatId: item.chatId,
      seq: item.seq,
      senderId: currentUserId,
      body: item.body,
      createdAt: item.createdAt ?? new Date(0).toISOString(),
      status: item.status === 'failed' ? 'failed' : 'sending',
      mine: true,
    })
  }

  return Array.from(byId.values()).sort((left, right) => {
    if (left.seq != null && right.seq != null && left.seq !== right.seq) {
      return left.seq - right.seq
    }
    if (left.seq != null && right.seq == null) return -1
    if (left.seq == null && right.seq != null) return 1
    return left.createdAt.localeCompare(right.createdAt) || left.key.localeCompare(right.key)
  })
}

/** Максимальный подтверждённый seq в ленте — для mark-read и курсора. */
export function maxConfirmedSeq(messages: readonly ThreadMessage[]): number {
  let max = 0
  for (const message of messages) {
    if (
      message.seq != null &&
      message.seq > max &&
      message.status !== 'sending' &&
      message.status !== 'failed'
    ) {
      max = message.seq
    }
  }
  return max
}
