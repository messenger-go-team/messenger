import { describe, expect, it, vi } from 'vitest'
import { addUser } from '../../mocks/data/auth'
import { INITIAL_CHAT_ID, addMockHistoryMessage, getLastReadSeq } from '../../mocks/data/history'
import { createAccessToken } from '../../mocks/lib/tokens'
import { login } from './auth'
import { createPersonalChat, getMessageHistory, listChats, markChatRead } from './history'

const ALICE_ID = '00000000-0000-4000-8000-000000000001'
const BOB_ID = '00000000-0000-4000-8000-000000000002'
const CHARLIE_ID = '00000000-0000-4000-8000-000000000003'
const UNKNOWN_ID = '00000000-0000-4000-8000-000000000099'

/** Получает JWT Alice через публичный login API, а не напрямую из token helper. */
async function aliceToken() {
  return (await login({ username: 'alice_1', password: 'correct-horse-battery' })).access_token
}

/** Получает JWT Bob для проверки независимых membership/read cursor. */
async function bobToken() {
  return (await login({ username: 'bob_2', password: 'correct-horse-battery' })).access_token
}

/** Добавляет пользователя одновременно в Auth state и создаёт для него валидный JWT. */
async function addCharlieAndCreateToken() {
  addUser({
    id: CHARLIE_ID,
    username: 'charlie_3',
    password: 'test-password',
    created_at: '2026-11-01T10:10:00Z',
  })

  return createAccessToken(CHARLIE_ID)
}

/** Выполняет raw-запрос, когда тесту важны различия статусов 200/201 или shape ошибки. */
async function rawCreatePersonalChat(userId: string, accessToken?: string, extraBody = {}) {
  return fetch('/chats/personal', {
    method: 'POST',
    headers: {
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ user_id: userId, ...extraBody }),
  })
}

describe('History API', () => {
  // Создание personal chat проверяет уникальность пары и строгую OpenAPI-валидацию body.
  describe('POST /chats/personal', () => {
    it('returns 200 and the same chat for an existing pair in either direction', async () => {
      const aliceResponse = await rawCreatePersonalChat(BOB_ID, await aliceToken())
      const bobResponse = await rawCreatePersonalChat(ALICE_ID, await bobToken())

      expect(aliceResponse.status).toBe(200)
      expect(bobResponse.status).toBe(200)
      expect((await aliceResponse.json()).id).toBe(INITIAL_CHAT_ID)
      expect((await bobResponse.json()).id).toBe(INITIAL_CHAT_ID)
    })

    it('returns 201 for a new pair and the client exposes the OpenAPI Chat', async () => {
      await addCharlieAndCreateToken()
      const accessToken = await aliceToken()
      const response = await rawCreatePersonalChat(CHARLIE_ID, accessToken)
      const chat = await response.json()

      expect(response.status).toBe(201)
      expect(chat).toMatchObject({
        id: expect.any(String),
        type: 'personal',
        created_at: expect.any(String),
        last_seq: 0,
      })
      expect(chat.members.map((member: { id: string }) => member.id)).toEqual([
        ALICE_ID,
        CHARLIE_ID,
      ])
      expect(Object.keys(chat).sort()).toEqual(['created_at', 'id', 'last_seq', 'members', 'type'])
      expect(
        chat.members.every((member: object) => Object.keys(member).sort().join() === 'id,username'),
      ).toBe(true)

      await expect(createPersonalChat(CHARLIE_ID, accessToken)).resolves.toEqual(chat)
    })

    it('returns 401 without a valid access token', async () => {
      expect((await rawCreatePersonalChat(BOB_ID)).status).toBe(401)
      await expect(createPersonalChat(BOB_ID, 'invalid-token')).rejects.toMatchObject({
        status: 401,
        code: 'unauthorized',
      })
    })

    it.each([
      ['invalid UUID', 'invalid', {}],
      ['current user', ALICE_ID, {}],
      ['additional property', BOB_ID, { unexpected: true }],
    ])('returns 422 for %s', async (_name, userId, extraBody) => {
      const response = await rawCreatePersonalChat(userId, await aliceToken(), extraBody)
      expect(response.status).toBe(422)
    })

    it('returns 422 for malformed JSON', async () => {
      const response = await fetch('/chats/personal', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${await aliceToken()}`,
          'Content-Type': 'application/json',
        },
        body: '{',
      })

      expect(response.status).toBe(422)
    })

    it('returns 422 when user_id is missing', async () => {
      const response = await fetch('/chats/personal', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${await aliceToken()}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({}),
      })

      expect(response.status).toBe(422)
    })

    it('returns 404 for an unknown user', async () => {
      await expect(createPersonalChat(UNKNOWN_ID, await aliceToken())).rejects.toMatchObject({
        status: 404,
        code: 'not_found',
      })
    })
  })

  // Список обязан скрывать чужие чаты и возвращать только публичные поля участников.
  describe('GET /chats', () => {
    it('lists only member chats with last message and unread count', async () => {
      const result = await listChats(await aliceToken())

      expect(result.chats).toHaveLength(1)
      expect(result.chats[0]).toMatchObject({
        id: INITIAL_CHAT_ID,
        type: 'personal',
        last_message: { seq: 6, sender_id: BOB_ID },
        unread_count: 1,
      })
      expect(result.chats[0]).not.toHaveProperty('last_seq')
      expect(Object.keys(result.chats[0]).sort()).toEqual([
        'created_at',
        'id',
        'last_message',
        'members',
        'type',
        'unread_count',
      ])
      expect(
        result.chats[0].members.every(
          (member) => Object.keys(member).sort().join() === 'id,username',
        ),
      ).toBe(true)
      expect(Object.keys(result.chats[0].last_message ?? {}).sort()).toEqual([
        'body',
        'chat_id',
        'created_at',
        'id',
        'sender_id',
        'seq',
      ])
    })

    it('returns an empty list to a user without chats', async () => {
      const charlieToken = await addCharlieAndCreateToken()
      await expect(listChats(charlieToken)).resolves.toEqual({ chats: [] })
    })

    it('returns 401 for an invalid token', async () => {
      await expect(listChats('invalid-token')).rejects.toMatchObject({
        status: 401,
        code: 'unauthorized',
      })
    })

    // Fake time позволяет проверить `exp` реального JWT без ожидания 15 минут.
    it('returns 401 for an expired token', async () => {
      vi.useFakeTimers()

      try {
        vi.setSystemTime(new Date('2026-11-01T12:00:00Z'))
        const accessToken = await createAccessToken(ALICE_ID)
        vi.setSystemTime(new Date('2026-11-01T12:16:00Z'))

        await expect(listChats(accessToken)).rejects.toMatchObject({
          status: 401,
          code: 'unauthorized',
        })
      } finally {
        vi.useRealTimers()
      }
    })

    it('returns 401 for a valid token whose subject is unknown', async () => {
      await expect(listChats(await createAccessToken(UNKNOWN_ID))).rejects.toMatchObject({
        status: 401,
        code: 'unauthorized',
      })
    })
  })

  // История фиксирует cursor-направления, границы safe integer и отсутствие read side effect.
  describe('GET /chats/{chat_id}/messages', () => {
    it('returns the latest page in ascending order without changing read state', async () => {
      const result = await getMessageHistory(INITIAL_CHAT_ID, await aliceToken(), { limit: 2 })

      expect(result.messages.map((message) => message.seq)).toEqual([5, 6])
      expect(result).toMatchObject({
        next_before_seq: 5,
        next_after_seq: 6,
        has_more_before: true,
        has_more_after: false,
      })
      expect(Object.keys(result).sort()).toEqual([
        'has_more_after',
        'has_more_before',
        'messages',
        'next_after_seq',
        'next_before_seq',
      ])
      expect(Object.keys(result.messages[0]).sort()).toEqual([
        'body',
        'chat_id',
        'created_at',
        'id',
        'sender_id',
        'seq',
      ])
      expect(getLastReadSeq(INITIAL_CHAT_ID, ALICE_ID)).toBe(4)
    })

    it('serializes before_seq and returns the closest older page', async () => {
      const result = await getMessageHistory(INITIAL_CHAT_ID, await aliceToken(), {
        beforeSeq: 5,
        limit: 2,
      })

      expect(result.messages.map((message) => message.seq)).toEqual([3, 4])
      expect(result.has_more_before).toBe(true)
      expect(result.has_more_after).toBe(true)
    })

    it('serializes after_seq and returns the earliest newer page', async () => {
      const result = await getMessageHistory(INITIAL_CHAT_ID, await aliceToken(), {
        afterSeq: 2,
        limit: 2,
      })

      expect(result.messages.map((message) => message.seq)).toEqual([3, 4])
    })

    it('accepts after_seq zero', async () => {
      const result = await getMessageHistory(INITIAL_CHAT_ID, await aliceToken(), {
        afterSeq: 0,
      })

      expect(result.messages.map((message) => message.seq)).toEqual([1, 2, 3, 4, 5, 6])
    })

    it('accepts before_seq one', async () => {
      const result = await getMessageHistory(INITIAL_CHAT_ID, await aliceToken(), {
        beforeSeq: 1,
      })

      expect(result).toEqual({
        messages: [],
        next_before_seq: null,
        next_after_seq: null,
        has_more_before: false,
        has_more_after: false,
      })
    })

    it.each([
      ['after_seq at last_seq', 6],
      ['after_seq above last_seq', 7],
    ])('returns an empty page for %s', async (_name, afterSeq) => {
      await expect(
        getMessageHistory(INITIAL_CHAT_ID, await aliceToken(), { afterSeq }),
      ).resolves.toEqual({
        messages: [],
        next_before_seq: null,
        next_after_seq: null,
        has_more_before: false,
        has_more_after: false,
      })
    })

    it('applies limit one', async () => {
      const result = await getMessageHistory(INITIAL_CHAT_ID, await aliceToken(), { limit: 1 })

      expect(result.messages.map((message) => message.seq)).toEqual([6])
    })

    // 55 сообщений отличают default limit 50 от случайного возврата всей истории.
    it('uses a default limit of 50', async () => {
      const accessToken = await addCharlieAndCreateToken()
      const chat = await createPersonalChat(ALICE_ID, accessToken)

      for (let seq = 1; seq <= 55; seq++) {
        addMockHistoryMessage({
          id: `30000000-0000-4000-8000-${String(seq).padStart(12, '0')}`,
          chat_id: chat.id,
          seq,
          sender_id: seq % 2 === 0 ? ALICE_ID : CHARLIE_ID,
          body: `Message ${seq}`,
          created_at: new Date(Date.UTC(2026, 10, 2) + seq * 1000).toISOString(),
        })
      }

      const page = await getMessageHistory(chat.id, accessToken)

      expect(page.messages).toHaveLength(50)
      expect(page.messages[0].seq).toBe(6)
      expect(page.messages[49].seq).toBe(55)
      expect(page.has_more_before).toBe(true)
    })

    it('returns an empty page for an empty chat', async () => {
      const charlieToken = await addCharlieAndCreateToken()
      const chat = await createPersonalChat(ALICE_ID, charlieToken)

      await expect(getMessageHistory(chat.id, charlieToken)).resolves.toEqual({
        messages: [],
        next_before_seq: null,
        next_after_seq: null,
        has_more_before: false,
        has_more_after: false,
      })
    })

    it('accepts cursor and limit upper boundaries', async () => {
      const accessToken = await aliceToken()
      const beforePage = await getMessageHistory(INITIAL_CHAT_ID, accessToken, {
        beforeSeq: Number.MAX_SAFE_INTEGER,
        limit: 100,
      })
      const afterPage = await getMessageHistory(INITIAL_CHAT_ID, accessToken, {
        afterSeq: Number.MAX_SAFE_INTEGER,
        limit: 100,
      })

      expect(beforePage.messages.map((message) => message.seq)).toEqual([1, 2, 3, 4, 5, 6])
      expect(afterPage.messages).toEqual([])
    })

    it('returns 401 for an invalid token', async () => {
      await expect(getMessageHistory(INITIAL_CHAT_ID, 'invalid-token')).rejects.toMatchObject({
        status: 401,
        code: 'unauthorized',
      })
    })

    it('returns 403 to a user who is not a chat member', async () => {
      const charlieToken = await addCharlieAndCreateToken()
      await expect(getMessageHistory(INITIAL_CHAT_ID, charlieToken)).rejects.toMatchObject({
        status: 403,
        code: 'chat_membership_required',
      })
    })

    it('returns 404 for an unknown chat', async () => {
      await expect(getMessageHistory(UNKNOWN_ID, await aliceToken())).rejects.toMatchObject({
        status: 404,
        code: 'not_found',
      })
    })

    it('returns 422 for an invalid chat UUID', async () => {
      await expect(getMessageHistory('invalid', await aliceToken())).rejects.toMatchObject({
        status: 422,
        code: 'validation_error',
      })
    })

    it('returns history for an existing chat addressed by uppercase UUID', async () => {
      const chatId = 'abcdefab-cdef-4abc-8def-abcdefabcdef'
      const charlieToken = await addCharlieAndCreateToken()
      const uuidSpy = vi.spyOn(crypto, 'randomUUID').mockReturnValue(chatId)

      try {
        const chat = await createPersonalChat(ALICE_ID, charlieToken)
        expect(chat.id).toBe(chatId)

        await expect(getMessageHistory(chatId.toUpperCase(), charlieToken)).resolves.toEqual({
          messages: [],
          next_before_seq: null,
          next_after_seq: null,
          has_more_before: false,
          has_more_after: false,
        })
      } finally {
        uuidSpy.mockRestore()
      }
    })

    // Raw query нужен для комбинаций, которые типизированный client намеренно не позволяет собрать.
    it.each([
      'before_seq=1&after_seq=0',
      'before_seq=0',
      'after_seq=-1',
      'after_seq=1.5',
      'after_seq=9007199254740992',
      'limit=0',
      'limit=101',
      'limit=1.5',
      'before_seq=3&before_seq=4',
      'after_seq=3&after_seq=4',
      'limit=10&limit=20',
    ])('returns 422 for invalid pagination: %s', async (query) => {
      const response = await fetch(`/chats/${INITIAL_CHAT_ID}/messages?${query}`, {
        headers: { Authorization: `Bearer ${await aliceToken()}` },
      })

      expect(response.status).toBe(422)
      expect(await response.json()).toMatchObject({ code: 'invalid_pagination' })
    })
  })

  // Read endpoint проверяет monotonic cursor, membership и влияние cursor на unread_count.
  describe('POST /chats/{chat_id}/read', () => {
    it('advances only the current member cursor and returns an empty 204', async () => {
      const response = await fetch(`/chats/${INITIAL_CHAT_ID}/read`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${await aliceToken()}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ seq: 6 }),
      })

      expect(response.status).toBe(204)
      expect(await response.text()).toBe('')
      expect(getLastReadSeq(INITIAL_CHAT_ID, ALICE_ID)).toBe(6)
      expect(getLastReadSeq(INITIAL_CHAT_ID, BOB_ID)).toBe(2)
      expect((await listChats(await aliceToken())).chats[0].unread_count).toBe(0)
    })

    it('is idempotent and never moves the cursor backwards', async () => {
      const accessToken = await aliceToken()

      await expect(markChatRead(INITIAL_CHAT_ID, 6, accessToken)).resolves.toBeUndefined()
      await expect(markChatRead(INITIAL_CHAT_ID, 6, accessToken)).resolves.toBeUndefined()
      await expect(markChatRead(INITIAL_CHAT_ID, 3, accessToken)).resolves.toBeUndefined()
      expect(getLastReadSeq(INITIAL_CHAT_ID, ALICE_ID)).toBe(6)
    })

    it('partially advances the cursor and leaves remaining messages unread', async () => {
      const accessToken = await bobToken()

      expect((await listChats(accessToken)).chats[0].unread_count).toBe(2)
      await markChatRead(INITIAL_CHAT_ID, 3, accessToken)

      expect(getLastReadSeq(INITIAL_CHAT_ID, BOB_ID)).toBe(3)
      expect((await listChats(accessToken)).chats[0].unread_count).toBe(1)
    })

    it('accepts seq zero for an empty chat', async () => {
      const charlieToken = await addCharlieAndCreateToken()
      const chat = await createPersonalChat(ALICE_ID, charlieToken)
      await expect(markChatRead(chat.id, 0, charlieToken)).resolves.toBeUndefined()
    })

    it('accepts Number.MAX_SAFE_INTEGER when it equals chat last_seq', async () => {
      const charlieToken = await addCharlieAndCreateToken()
      const chat = await createPersonalChat(ALICE_ID, charlieToken)
      addMockHistoryMessage({
        id: '30000000-0000-4000-8000-999999999999',
        chat_id: chat.id,
        seq: Number.MAX_SAFE_INTEGER,
        sender_id: ALICE_ID,
        body: 'Maximum safe sequence',
        created_at: '2026-11-02T12:00:00Z',
      })

      await expect(
        markChatRead(chat.id, Number.MAX_SAFE_INTEGER, charlieToken),
      ).resolves.toBeUndefined()
      expect(getLastReadSeq(chat.id, CHARLIE_ID)).toBe(Number.MAX_SAFE_INTEGER)
    })

    it('returns 401 for an invalid token', async () => {
      await expect(markChatRead(INITIAL_CHAT_ID, 1, 'invalid-token')).rejects.toMatchObject({
        status: 401,
        code: 'unauthorized',
      })
    })

    it('returns 403 to a user who is not a chat member', async () => {
      const charlieToken = await addCharlieAndCreateToken()
      await expect(markChatRead(INITIAL_CHAT_ID, 1, charlieToken)).rejects.toMatchObject({
        status: 403,
        code: 'chat_membership_required',
      })
    })

    it('returns 404 for an unknown chat', async () => {
      await expect(markChatRead(UNKNOWN_ID, 0, await aliceToken())).rejects.toMatchObject({
        status: 404,
        code: 'not_found',
      })
    })

    it.each([
      ['invalid chat UUID', 'invalid', { seq: 0 }],
      ['negative seq', INITIAL_CHAT_ID, { seq: -1 }],
      ['fractional seq', INITIAL_CHAT_ID, { seq: 1.5 }],
      ['seq above last_seq', INITIAL_CHAT_ID, { seq: 7 }],
      ['missing seq', INITIAL_CHAT_ID, {}],
      ['additional property', INITIAL_CHAT_ID, { seq: 1, unexpected: true }],
    ])('returns 422 for %s', async (_name, chatId, body) => {
      const response = await fetch(`/chats/${chatId}/read`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${await aliceToken()}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      })

      expect(response.status).toBe(422)
    })

    it('returns 422 for malformed JSON', async () => {
      const response = await fetch(`/chats/${INITIAL_CHAT_ID}/read`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${await aliceToken()}`,
          'Content-Type': 'application/json',
        },
        body: '{',
      })

      expect(response.status).toBe(422)
      const error = await response.json()
      expect(error).toMatchObject({ code: 'validation_error' })
    })
  })
})
