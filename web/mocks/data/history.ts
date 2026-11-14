import { findUserById } from './auth'
import { isUuid } from '../lib/validation'

/** Публичное представление участника без Auth credentials. */
export interface HistoryUserSummary {
  id: string
  username: string
}

/** OpenAPI-представление сообщения с монотонным `seq` внутри чата. */
export interface HistoryMessage {
  id: string
  chat_id: string
  seq: number
  sender_id: string
  body: string
  created_at: string
}

/** Полная схема personal chat, возвращаемая при создании или повторном запросе пары. */
export interface HistoryChat {
  id: string
  type: 'personal'
  created_at: string
  members: HistoryUserSummary[]
  last_seq: number
}

/** Элемент списка чатов с производными last message и unread counter. */
export interface HistoryChatListItem {
  id: string
  type: 'personal'
  created_at: string
  members: HistoryUserSummary[]
  last_message: HistoryMessage | null
  unread_count: number
}

/** Cursor-страница сообщений и признаки наличия данных по обе стороны страницы. */
export interface HistoryMessagePage {
  messages: HistoryMessage[]
  next_before_seq: number | null
  next_after_seq: number | null
  has_more_before: boolean
  has_more_after: boolean
}

interface MockChat {
  id: string
  type: 'personal'
  createdAt: string
  lastSeq: number
}

interface MockChatMember {
  chatId: string
  userId: string
  lastReadSeq: number
}

interface MessagePageOptions {
  beforeSeq?: number
  afterSeq?: number
  limit: number
}

const ALICE_ID = '00000000-0000-4000-8000-000000000001'
const BOB_ID = '00000000-0000-4000-8000-000000000002'
export const INITIAL_CHAT_ID = '10000000-0000-4000-8000-000000000001'
const MAX_MESSAGE_BODY_LENGTH = 4096
const RFC3339_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/

const initialChats: MockChat[] = [
  {
    id: INITIAL_CHAT_ID,
    type: 'personal',
    createdAt: '2026-11-01T11:00:00Z',
    lastSeq: 6,
  },
]

const initialMembers: MockChatMember[] = [
  { chatId: INITIAL_CHAT_ID, userId: ALICE_ID, lastReadSeq: 4 },
  { chatId: INITIAL_CHAT_ID, userId: BOB_ID, lastReadSeq: 2 },
]

const initialMessages: HistoryMessage[] = [
  {
    id: '20000000-0000-4000-8000-000000000001',
    chat_id: INITIAL_CHAT_ID,
    seq: 1,
    sender_id: ALICE_ID,
    body: 'Привет, Боб!',
    created_at: '2026-11-01T11:01:00Z',
  },
  {
    id: '20000000-0000-4000-8000-000000000002',
    chat_id: INITIAL_CHAT_ID,
    seq: 2,
    sender_id: BOB_ID,
    body: 'Привет, Алиса!',
    created_at: '2026-11-01T11:02:00Z',
  },
  {
    id: '20000000-0000-4000-8000-000000000003',
    chat_id: INITIAL_CHAT_ID,
    seq: 3,
    sender_id: ALICE_ID,
    body: 'Как дела?',
    created_at: '2026-11-01T11:03:00Z',
  },
  {
    id: '20000000-0000-4000-8000-000000000004',
    chat_id: INITIAL_CHAT_ID,
    seq: 4,
    sender_id: BOB_ID,
    body: 'Всё хорошо.',
    created_at: '2026-11-01T11:04:00Z',
  },
  {
    id: '20000000-0000-4000-8000-000000000005',
    chat_id: INITIAL_CHAT_ID,
    seq: 5,
    sender_id: ALICE_ID,
    body: 'Увидимся вечером?',
    created_at: '2026-11-01T11:05:00Z',
  },
  {
    id: '20000000-0000-4000-8000-000000000006',
    chat_id: INITIAL_CHAT_ID,
    seq: 6,
    sender_id: BOB_ID,
    body: 'Да, договорились.',
    created_at: '2026-11-01T11:06:00Z',
  },
]

let chats = new Map<string, MockChat>()
let members = new Map<string, Map<string, MockChatMember>>()
let messages = new Map<string, HistoryMessage[]>()
let personalChatIds = new Map<string, string>()

/** Строит симметричный ключ пары, чтобы порядок участников не создавал второй personal chat. */
function personalChatKey(firstUserId: string, secondUserId: string): string {
  return [firstUserId, secondUserId].sort().join(':')
}

/** Возвращает стабильный порядок участников для детерминированных fixtures и ответов. */
function getMemberIds(chatId: string): string[] {
  return [...(members.get(chatId)?.keys() ?? [])].sort()
}

/** Преобразует Auth-запись в публичную схему и выявляет несогласованные fixtures. */
function toUserSummary(userId: string): HistoryUserSummary {
  const user = findUserById(userId)

  if (!user) {
    throw new Error(`History fixture references unknown user: ${userId}`)
  }

  return { id: user.id, username: user.username }
}

/** Собирает публичный Chat без внутренних полей membership state. */
function toHistoryChat(chat: MockChat): HistoryChat {
  return {
    id: chat.id,
    type: chat.type,
    created_at: chat.createdAt,
    members: getMemberIds(chat.id).map(toUserSummary),
    last_seq: chat.lastSeq,
  }
}

/** Не позволяет вызывающему изменить сообщение, хранящееся в общем in-memory state. */
function cloneMessage(message: HistoryMessage): HistoryMessage {
  return { ...message }
}

/** Возвращает копию сообщений в гарантированном порядке `seq ASC`. */
function getSortedMessages(chatId: string): HistoryMessage[] {
  return [...(messages.get(chatId) ?? [])].sort((first, second) => first.seq - second.seq)
}

/** Проверяет обязательную timezone часть RFC 3339 и возможность разобрать абсолютное время. */
function isRfc3339DateTime(value: string): boolean {
  return RFC3339_PATTERN.test(value) && Number.isFinite(Date.parse(value))
}

/**
 * Полностью пересоздаёт History state из детерминированных fixtures.
 * Новые Map и копии объектов исключают протекание ссылок и данных между тестами.
 */
export function resetHistoryData(): void {
  chats = new Map(initialChats.map((chat) => [chat.id, { ...chat }]))
  members = new Map()
  messages = new Map()
  personalChatIds = new Map()

  for (const member of initialMembers) {
    let chatMembers = members.get(member.chatId)

    if (!chatMembers) {
      chatMembers = new Map()
      members.set(member.chatId, chatMembers)
    }

    chatMembers.set(member.userId, { ...member })
  }

  for (const message of initialMessages) {
    const chatMessages = messages.get(message.chat_id) ?? []
    chatMessages.push(cloneMessage(message))
    messages.set(message.chat_id, chatMessages)
  }

  for (const chat of initialChats) {
    const memberIds = getMemberIds(chat.id)

    // Индекс пары восстанавливается из membership, поэтому остаётся согласованным с основным state.
    if (memberIds.length === 2) {
      personalChatIds.set(personalChatKey(memberIds[0], memberIds[1]), chat.id)
    }
  }
}

/** Возвращает публичное представление чата без выдачи mutable внутреннего объекта. */
export function findHistoryChat(chatId: string): HistoryChat | undefined {
  const chat = chats.get(chatId)
  return chat ? toHistoryChat(chat) : undefined
}

/** Проверяет membership по серверному state, а не по данным из HTTP-запроса. */
export function isChatMember(chatId: string, userId: string): boolean {
  return members.get(chatId)?.has(userId) ?? false
}

/**
 * Возвращает единственный personal chat пары или атомарно создаёт пустой чат.
 * Флаг `created` позволяет handler выбрать контрактный статус 201 или 200.
 */
export function createOrGetPersonalChat(
  currentUserId: string,
  otherUserId: string,
): { chat: HistoryChat; created: boolean } {
  const key = personalChatKey(currentUserId, otherUserId)
  const existingChatId = personalChatIds.get(key)

  if (existingChatId) {
    const existingChat = chats.get(existingChatId)

    if (existingChat) {
      return { chat: toHistoryChat(existingChat), created: false }
    }
  }

  const chat: MockChat = {
    id: crypto.randomUUID(),
    type: 'personal',
    createdAt: new Date().toISOString(),
    lastSeq: 0,
  }

  chats.set(chat.id, chat)
  members.set(
    chat.id,
    new Map([
      [currentUserId, { chatId: chat.id, userId: currentUserId, lastReadSeq: 0 }],
      [otherUserId, { chatId: chat.id, userId: otherUserId, lastReadSeq: 0 }],
    ]),
  )
  messages.set(chat.id, [])
  personalChatIds.set(key, chat.id)

  return { chat: toHistoryChat(chat), created: true }
}

/**
 * Формирует список чатов пользователя с последним сообщением и `unread_count`.
 * Непрочитанными считаются только чужие сообщения после собственного `last_read_seq`.
 */
export function listHistoryChats(userId: string): HistoryChatListItem[] {
  const result: HistoryChatListItem[] = []

  for (const chat of chats.values()) {
    const currentMember = members.get(chat.id)?.get(userId)

    if (!currentMember) {
      continue
    }

    const chatMessages = getSortedMessages(chat.id)
    const lastMessage = chatMessages.at(-1) ?? null
    // Собственные сообщения не увеличивают badge, даже если их seq выше read cursor.
    const unreadCount = chatMessages.filter(
      (message) => message.seq > currentMember.lastReadSeq && message.sender_id !== userId,
    ).length

    result.push({
      id: chat.id,
      type: chat.type,
      created_at: chat.createdAt,
      members: getMemberIds(chat.id).map(toUserSummary),
      last_message: lastMessage ? cloneMessage(lastMessage) : null,
      unread_count: unreadCount,
    })
  }

  // Активные чаты идут по абсолютному времени последнего сообщения; пустые — после них.
  // UUID обеспечивает стабильный порядок при равном времени и для нескольких пустых чатов.
  return result.sort((first, second) => {
    if (first.last_message && second.last_message) {
      const timeComparison =
        Date.parse(second.last_message.created_at) - Date.parse(first.last_message.created_at)
      return timeComparison || first.id.localeCompare(second.id)
    }

    if (first.last_message) return -1
    if (second.last_message) return 1
    return first.id.localeCompare(second.id)
  })
}

/**
 * Строит cursor-страницу сообщений, всегда отсортированную по `seq ASC`.
 * `beforeSeq` выбирает ближайшие старые сообщения с конца диапазона, `afterSeq` — ближайшие новые
 * с начала; без cursor возвращается последняя страница. Функция не изменяет read state.
 */
export function getHistoryMessagePage(
  chatId: string,
  options: MessagePageOptions,
): HistoryMessagePage {
  const allMessages = getSortedMessages(chatId)
  let candidates = allMessages
  const { beforeSeq, afterSeq } = options

  if (beforeSeq !== undefined) {
    candidates = allMessages.filter((message) => message.seq < beforeSeq)
  } else if (afterSeq !== undefined) {
    candidates = allMessages.filter((message) => message.seq > afterSeq)
  }

  // Направление cursor определяет сторону, с которой применяется limit.
  const selected =
    afterSeq !== undefined ? candidates.slice(0, options.limit) : candidates.slice(-options.limit)

  if (selected.length === 0) {
    return {
      messages: [],
      next_before_seq: null,
      next_after_seq: null,
      has_more_before: false,
      has_more_after: false,
    }
  }

  const firstSeq = selected[0].seq
  const lastSeq = selected[selected.length - 1].seq

  return {
    messages: selected.map(cloneMessage),
    next_before_seq: firstSeq,
    next_after_seq: lastSeq,
    has_more_before: allMessages.some((message) => message.seq < firstSeq),
    has_more_after: allMessages.some((message) => message.seq > lastSeq),
  }
}

/**
 * Монотонно продвигает `last_read_seq` участника и никогда не уменьшает его.
 * Проверки membership и верхней границы `last_seq` выполняет HTTP handler.
 */
export function markHistoryChatRead(chatId: string, userId: string, seq: number): void {
  const member = members.get(chatId)?.get(userId)

  if (member && seq > member.lastReadSeq) {
    member.lastReadSeq = seq
  }
}

/** Возвращает внутренний read cursor участника; используется для проверки state в тестах. */
export function getLastReadSeq(chatId: string, userId: string): number | undefined {
  return members.get(chatId)?.get(userId)?.lastReadSeq
}

/**
 * Добавляет валидное fixture-сообщение и синхронизирует `lastSeq` чата.
 * Бросает ошибку при нарушении OpenAPI-инвариантов, membership или уникальности ID/seq.
 */
export function addMockHistoryMessage(message: HistoryMessage): void {
  if (!isUuid(message.id) || !isUuid(message.chat_id) || !isUuid(message.sender_id)) {
    throw new Error('Mock message IDs must be valid UUIDs')
  }

  if (!Number.isSafeInteger(message.seq) || message.seq < 1) {
    throw new Error('Mock message seq must be a positive safe integer')
  }

  const bodyLength = [...message.body].length

  if (bodyLength < 1 || bodyLength > MAX_MESSAGE_BODY_LENGTH) {
    throw new Error(`Mock message body must contain 1 to ${MAX_MESSAGE_BODY_LENGTH} characters`)
  }

  if (!isRfc3339DateTime(message.created_at)) {
    throw new Error('Mock message created_at must be an RFC 3339 date-time')
  }

  const chat = chats.get(message.chat_id)

  if (!chat || !isChatMember(message.chat_id, message.sender_id)) {
    throw new Error('Mock message must belong to an existing chat member')
  }

  const chatMessages = messages.get(message.chat_id) ?? []

  for (const existingMessages of messages.values()) {
    if (existingMessages.some((existing) => existing.id === message.id)) {
      throw new Error(`Duplicate mock message ID: ${message.id}`)
    }
  }

  if (chatMessages.some((existing) => existing.seq === message.seq)) {
    throw new Error(`Duplicate mock message seq: ${message.seq}`)
  }

  chatMessages.push(cloneMessage(message))
  chatMessages.sort((first, second) => first.seq - second.seq)
  messages.set(message.chat_id, chatMessages)
  chat.lastSeq = Math.max(chat.lastSeq, message.seq)
}

resetHistoryData()
