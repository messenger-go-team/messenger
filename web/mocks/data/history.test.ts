import { beforeEach, describe, expect, it } from 'vitest'
import { addUser } from './auth'
import {
  INITIAL_CHAT_ID,
  type HistoryMessage,
  addMockHistoryMessage,
  createOrGetPersonalChat,
  findHistoryChat,
  getHistoryMessagePage,
  getLastReadSeq,
  listHistoryChats,
  markHistoryChatRead,
  resetHistoryData,
} from './history'

const ALICE_ID = '00000000-0000-4000-8000-000000000001'
const BOB_ID = '00000000-0000-4000-8000-000000000002'
const CHARLIE_ID = '00000000-0000-4000-8000-000000000003'
const DARIA_ID = '00000000-0000-4000-8000-000000000004'

/** Добавляет дополнительного пользователя, необходимого для создания нового personal chat. */
function addCharlie() {
  addUser({
    id: CHARLIE_ID,
    username: 'charlie_3',
    password: 'test-password',
    created_at: '2026-11-01T10:10:00Z',
  })
}

/** Добавляет второго дополнительного пользователя для сценариев сортировки нескольких чатов. */
function addDaria() {
  addUser({
    id: DARIA_ID,
    username: 'daria_4',
    password: 'test-password',
    created_at: '2026-11-01T10:15:00Z',
  })
}

/** Создаёт валидное сообщение по умолчанию, позволяя тесту менять только проверяемое поле. */
function validMockMessage(overrides: Partial<HistoryMessage> = {}): HistoryMessage {
  return {
    id: '20000000-0000-4000-8000-000000000007',
    chat_id: INITIAL_CHAT_ID,
    seq: 7,
    sender_id: ALICE_ID,
    body: 'Новое сообщение',
    created_at: '2026-11-01T11:07:00Z',
    ...overrides,
  }
}

describe('History data', () => {
  beforeEach(() => {
    resetHistoryData()
  })

  // Пара пользователей идентифицирует один chat независимо от порядка аргументов.
  it('returns the existing personal chat regardless of user order', () => {
    const direct = createOrGetPersonalChat(ALICE_ID, BOB_ID)
    const reverse = createOrGetPersonalChat(BOB_ID, ALICE_ID)

    expect(direct.created).toBe(false)
    expect(reverse.created).toBe(false)
    expect(reverse.chat.id).toBe(direct.chat.id)
    expect(direct.chat.members.map((member) => member.id)).toEqual([ALICE_ID, BOB_ID])
  })

  it('creates one new empty personal chat for a user pair', () => {
    addCharlie()

    const created = createOrGetPersonalChat(ALICE_ID, CHARLIE_ID)
    const repeated = createOrGetPersonalChat(CHARLIE_ID, ALICE_ID)

    expect(created.created).toBe(true)
    expect(created.chat.last_seq).toBe(0)
    expect(repeated).toEqual({ chat: created.chat, created: false })
    expect(getHistoryMessagePage(created.chat.id, { limit: 50 })).toEqual({
      messages: [],
      next_before_seq: null,
      next_after_seq: null,
      has_more_before: false,
      has_more_after: false,
    })
  })

  // Unread counter исключает собственные сообщения и всё до last_read_seq включительно.
  it('counts only messages from other members after the read cursor', () => {
    expect(listHistoryChats(ALICE_ID)[0].unread_count).toBe(1)
    expect(listHistoryChats(BOB_ID)[0].unread_count).toBe(2)
  })

  it('advances the read cursor monotonically and updates unread count', () => {
    markHistoryChatRead(INITIAL_CHAT_ID, ALICE_ID, 6)
    markHistoryChatRead(INITIAL_CHAT_ID, ALICE_ID, 3)

    expect(getLastReadSeq(INITIAL_CHAT_ID, ALICE_ID)).toBe(6)
    expect(getLastReadSeq(INITIAL_CHAT_ID, BOB_ID)).toBe(2)
    expect(listHistoryChats(ALICE_ID)[0].unread_count).toBe(0)
  })

  // Следующие три сценария фиксируют выбор ближайшей страницы в каждом cursor-направлении.
  it('returns the latest page by default in ascending seq order', () => {
    const page = getHistoryMessagePage(INITIAL_CHAT_ID, { limit: 2 })

    expect(page.messages.map((message) => message.seq)).toEqual([5, 6])
    expect(page).toMatchObject({
      next_before_seq: 5,
      next_after_seq: 6,
      has_more_before: true,
      has_more_after: false,
    })
  })

  it('returns the closest older page for before_seq', () => {
    const page = getHistoryMessagePage(INITIAL_CHAT_ID, { beforeSeq: 5, limit: 2 })

    expect(page.messages.map((message) => message.seq)).toEqual([3, 4])
    expect(page).toMatchObject({
      next_before_seq: 3,
      next_after_seq: 4,
      has_more_before: true,
      has_more_after: true,
    })
  })

  it('returns the earliest newer page for after_seq', () => {
    const page = getHistoryMessagePage(INITIAL_CHAT_ID, { afterSeq: 2, limit: 2 })

    expect(page.messages.map((message) => message.seq)).toEqual([3, 4])
    expect(page).toMatchObject({
      next_before_seq: 3,
      next_after_seq: 4,
      has_more_before: true,
      has_more_after: true,
    })
  })

  // Сортировка учитывает пустые чаты, равные timestamps и timezone offsets.
  it('places empty chats after chats with messages', () => {
    addCharlie()
    const emptyChat = createOrGetPersonalChat(ALICE_ID, CHARLIE_ID).chat

    expect(listHistoryChats(ALICE_ID).map((chat) => chat.id)).toEqual([
      INITIAL_CHAT_ID,
      emptyChat.id,
    ])
  })

  it('sorts equal last-message timestamps by chat UUID', () => {
    addCharlie()
    addDaria()
    const charlieChat = createOrGetPersonalChat(ALICE_ID, CHARLIE_ID).chat
    const dariaChat = createOrGetPersonalChat(ALICE_ID, DARIA_ID).chat

    for (const [chatId, senderId, suffix] of [
      [charlieChat.id, CHARLIE_ID, '008'],
      [dariaChat.id, DARIA_ID, '009'],
    ]) {
      addMockHistoryMessage({
        id: `20000000-0000-4000-8000-000000000${suffix}`,
        chat_id: chatId,
        seq: 1,
        sender_id: senderId,
        body: 'Одинаковое время',
        created_at: '2026-11-02T12:00:00Z',
      })
    }

    const expectedTiedOrder = [charlieChat.id, dariaChat.id].sort()
    expect(
      listHistoryChats(ALICE_ID)
        .slice(0, 2)
        .map((chat) => chat.id),
    ).toEqual(expectedTiedOrder)
  })

  it('sorts RFC 3339 timestamps by their absolute time across timezone offsets', () => {
    addCharlie()
    addDaria()
    const earlierChat = createOrGetPersonalChat(ALICE_ID, CHARLIE_ID).chat
    const laterChat = createOrGetPersonalChat(ALICE_ID, DARIA_ID).chat

    addMockHistoryMessage({
      id: '20000000-0000-4000-8000-000000000010',
      chat_id: earlierChat.id,
      seq: 1,
      sender_id: CHARLIE_ID,
      body: '09:00 UTC',
      created_at: '2026-11-02T12:00:00+03:00',
    })
    addMockHistoryMessage({
      id: '20000000-0000-4000-8000-000000000011',
      chat_id: laterChat.id,
      seq: 1,
      sender_id: DARIA_ID,
      body: '10:00 UTC',
      created_at: '2026-11-02T10:00:00Z',
    })

    expect(
      listHistoryChats(ALICE_ID)
        .slice(0, 2)
        .map((chat) => chat.id),
    ).toEqual([laterChat.id, earlierChat.id])
  })

  // Fixture helper обязан синхронизировать chat metadata и защищать OpenAPI-инварианты.
  it('updates last_seq and last_message when a mock message is added', () => {
    addMockHistoryMessage(validMockMessage())

    expect(findHistoryChat(INITIAL_CHAT_ID)?.last_seq).toBe(7)
    expect(listHistoryChats(ALICE_ID)[0].last_message?.seq).toBe(7)
  })

  it.each([
    ['zero seq', validMockMessage({ seq: 0 })],
    ['unsafe seq', validMockMessage({ seq: Number.MAX_SAFE_INTEGER + 1 })],
    ['invalid message UUID', validMockMessage({ id: 'invalid' })],
    ['invalid chat UUID', validMockMessage({ chat_id: 'invalid' })],
    ['invalid sender UUID', validMockMessage({ sender_id: 'invalid' })],
    ['empty body', validMockMessage({ body: '' })],
    ['body above 4096 characters', validMockMessage({ body: 'a'.repeat(4097) })],
    ['invalid created_at', validMockMessage({ created_at: '2026-11-02' })],
  ])('rejects a mock message with %s', (_name, message) => {
    expect(() => addMockHistoryMessage(message)).toThrow()
  })

  it('rejects a duplicate mock message ID', () => {
    expect(() =>
      addMockHistoryMessage(
        validMockMessage({
          id: '20000000-0000-4000-8000-000000000001',
        }),
      ),
    ).toThrow('Duplicate mock message ID')
  })

  // Reset удаляет динамические сущности и возвращает исходные cursor/messages.
  it('restores deterministic fixtures on reset', () => {
    addCharlie()
    const dynamicChatId = createOrGetPersonalChat(ALICE_ID, CHARLIE_ID).chat.id
    markHistoryChatRead(INITIAL_CHAT_ID, ALICE_ID, 6)

    resetHistoryData()

    expect(findHistoryChat(dynamicChatId)).toBeUndefined()
    expect(getLastReadSeq(INITIAL_CHAT_ID, ALICE_ID)).toBe(4)
    expect(getHistoryMessagePage(INITIAL_CHAT_ID, { limit: 100 }).messages).toHaveLength(6)
  })
})
