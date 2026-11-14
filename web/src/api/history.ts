import type { UserSummary } from './auth'
import { apiRequest } from './client'

/** Сообщение History API; `seq` задаёт порядок независимо от времени клиента. */
export interface Message {
  id: string
  chat_id: string
  seq: number
  sender_id: string
  body: string
  created_at: string
}

/** Personal chat с участниками и последним выделенным sequence number. */
export interface Chat {
  id: string
  type: 'personal'
  created_at: string
  members: UserSummary[]
  last_seq: number
}

/** Элемент списка чатов с последним сообщением и пользовательским unread counter. */
export interface ChatListItem {
  id: string
  type: 'personal'
  created_at: string
  members: UserSummary[]
  last_message: Message | null
  unread_count: number
}

/** Контейнер списка чатов текущего пользователя. */
export interface ChatsResponse {
  chats: ChatListItem[]
}

/** Cursor-страница истории; сообщения всегда ожидаются в порядке `seq ASC`. */
export interface MessagePage {
  messages: Message[]
  next_before_seq: number | null
  next_after_seq: number | null
  has_more_before: boolean
  has_more_after: boolean
}

/**
 * Допустимые варианты cursor pagination.
 * Union запрещает одновременную передачу `beforeSeq` и `afterSeq` на уровне TypeScript.
 */
export type MessageHistoryOptions =
  | { beforeSeq: number; afterSeq?: never; limit?: number }
  | { afterSeq: number; beforeSeq?: never; limit?: number }
  | { beforeSeq?: never; afterSeq?: never; limit?: number }

/** Создаёт personal chat или возвращает уже существующий чат этой пары пользователей. */
export function createPersonalChat(userId: string, accessToken: string): Promise<Chat> {
  return apiRequest<Chat>('/chats/personal', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ user_id: userId }),
  })
}

/** Загружает чаты текущего пользователя вместе с последним сообщением и unread counter. */
export function listChats(accessToken: string): Promise<ChatsResponse> {
  return apiRequest<ChatsResponse>('/chats', {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  })
}

/**
 * Загружает страницу истории в выбранном cursor-направлении.
 * GET не изменяет read cursor; это выполняется отдельным `markChatRead`.
 */
export function getMessageHistory(
  chatId: string,
  accessToken: string,
  options: MessageHistoryOptions = {},
): Promise<MessagePage> {
  const params = new URLSearchParams()

  if (options.beforeSeq !== undefined) {
    params.set('before_seq', String(options.beforeSeq))
  }

  if (options.afterSeq !== undefined) {
    params.set('after_seq', String(options.afterSeq))
  }

  if (options.limit !== undefined) {
    params.set('limit', String(options.limit))
  }

  const query = params.size > 0 ? `?${params.toString()}` : ''

  return apiRequest<MessagePage>(`/chats/${encodeURIComponent(chatId)}/messages${query}`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  })
}

/** Монотонно отмечает сообщения до `seq` прочитанными; успешный ответ не содержит body. */
export function markChatRead(chatId: string, seq: number, accessToken: string): Promise<void> {
  return apiRequest<void>(`/chats/${encodeURIComponent(chatId)}/read`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ seq }),
  })
}
