import { describe, expect, it } from 'vitest'
import { maxConfirmedSeq, mergeThreadMessages } from './mergeThreadMessages'

const USER = '00000000-0000-4000-8000-000000000001'
const PEER = '00000000-0000-4000-8000-000000000002'
const CHAT = '10000000-0000-4000-8000-000000000001'

describe('mergeThreadMessages', () => {
  it('merges history and ws without duplicates and keeps seq order', () => {
    const merged = mergeThreadMessages({
      currentUserId: USER,
      chatId: CHAT,
      history: [
        {
          id: 'm1',
          chat_id: CHAT,
          seq: 1,
          sender_id: PEER,
          body: 'hi',
          created_at: '2026-11-01T11:01:00Z',
        },
      ],
      wsMessages: [
        {
          id: 'm1',
          chat_id: CHAT,
          seq: 1,
          sender_id: PEER,
          body: 'hi',
          created_at: '2026-11-01T11:01:00Z',
        },
        {
          id: 'm2',
          chat_id: CHAT,
          seq: 2,
          sender_id: USER,
          body: 'yo',
          created_at: '2026-11-01T11:02:00Z',
          client_msg_id: 'c2',
        },
      ],
      pending: [],
    })

    expect(merged.map((item) => item.id)).toEqual(['m1', 'm2'])
    expect(merged[0]?.status).toBe('received')
    expect(merged[1]?.status).toBe('sent')
  })

  it('keeps sending and failed pending until ack lands', () => {
    const merged = mergeThreadMessages({
      currentUserId: USER,
      chatId: CHAT,
      history: [],
      wsMessages: [],
      pending: [
        {
          chatId: CHAT,
          clientMsgId: 'c-pending',
          body: 'draft',
          status: 'pending',
          attempts: 1,
        },
        {
          chatId: CHAT,
          clientMsgId: 'c-failed',
          body: 'boom',
          status: 'failed',
          attempts: 5,
          errorCode: 'timeout',
        },
      ],
    })

    expect(merged).toHaveLength(2)
    expect(merged.map((item) => item.status).sort()).toEqual(['failed', 'sending'])
  })

  it('drops pending once confirmed by message id', () => {
    const merged = mergeThreadMessages({
      currentUserId: USER,
      chatId: CHAT,
      history: [],
      wsMessages: [
        {
          id: 'm9',
          chat_id: CHAT,
          seq: 9,
          sender_id: USER,
          body: 'ok',
          created_at: '2026-11-01T12:00:00Z',
          client_msg_id: 'c9',
        },
      ],
      pending: [
        {
          chatId: CHAT,
          clientMsgId: 'c9',
          body: 'ok',
          status: 'sent',
          attempts: 1,
          messageId: 'm9',
          seq: 9,
          createdAt: '2026-11-01T12:00:00Z',
        },
      ],
    })

    expect(merged).toHaveLength(1)
    expect(merged[0]?.key).toBe('m9')
    expect(merged[0]?.status).toBe('sent')
  })

  it('does not surface pending ACK older than the REST history window', () => {
    const merged = mergeThreadMessages({
      currentUserId: USER,
      chatId: CHAT,
      history: [
        {
          id: 'm51',
          chat_id: CHAT,
          seq: 51,
          sender_id: PEER,
          body: 'page',
          created_at: '2026-11-01T12:00:00Z',
        },
      ],
      wsMessages: [],
      pending: [
        {
          chatId: CHAT,
          clientMsgId: 'c1',
          body: 'ancient ack',
          status: 'sent',
          attempts: 1,
          messageId: 'm1',
          seq: 1,
          createdAt: '2026-11-01T10:00:00Z',
        },
      ],
    })

    expect(merged.map((item) => item.seq)).toEqual([51])
  })

  it('does not surface WS cache older than the REST history window', () => {
    const merged = mergeThreadMessages({
      currentUserId: USER,
      chatId: CHAT,
      history: [
        {
          id: 'm50',
          chat_id: CHAT,
          seq: 50,
          sender_id: PEER,
          body: 'newest page',
          created_at: '2026-11-01T12:00:00Z',
        },
        {
          id: 'm51',
          chat_id: CHAT,
          seq: 51,
          sender_id: PEER,
          body: 'also page',
          created_at: '2026-11-01T12:01:00Z',
        },
      ],
      wsMessages: [
        {
          id: 'm1',
          chat_id: CHAT,
          seq: 1,
          sender_id: PEER,
          body: 'from sync cache',
          created_at: '2026-11-01T10:00:00Z',
        },
        {
          id: 'm52',
          chat_id: CHAT,
          seq: 52,
          sender_id: USER,
          body: 'live',
          created_at: '2026-11-01T12:02:00Z',
          client_msg_id: 'c52',
        },
      ],
      pending: [],
    })

    expect(merged.map((item) => item.seq)).toEqual([50, 51, 52])
  })

  it('ignores other chats', () => {
    const merged = mergeThreadMessages({
      currentUserId: USER,
      chatId: CHAT,
      history: [
        {
          id: 'x',
          chat_id: 'other',
          seq: 1,
          sender_id: PEER,
          body: 'nope',
          created_at: '2026-11-01T11:01:00Z',
        },
      ],
      wsMessages: [],
      pending: [
        {
          chatId: 'other',
          clientMsgId: 'c',
          body: 'nope',
          status: 'pending',
          attempts: 1,
        },
      ],
    })
    expect(merged).toEqual([])
  })
})

describe('maxConfirmedSeq', () => {
  it('skips sending and failed', () => {
    expect(
      maxConfirmedSeq([
        {
          key: '1',
          chatId: CHAT,
          seq: 3,
          senderId: PEER,
          body: 'a',
          createdAt: 't',
          status: 'received',
          mine: false,
        },
        {
          key: 'p',
          chatId: CHAT,
          senderId: USER,
          body: 'b',
          createdAt: 't',
          status: 'sending',
          mine: true,
        },
      ]),
    ).toBe(3)
  })
})
