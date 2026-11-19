import { describe, expect, it } from 'vitest'
import type { ThreadMessage } from '@/features/chats/mergeThreadMessages'
import { resolveMarkReadSeq } from '@/features/chats/markReadSeq'

const CHAT = 'c1'

function msg(seq: number, status: ThreadMessage['status'] = 'received'): ThreadMessage {
  return {
    key: String(seq),
    chatId: CHAT,
    seq,
    senderId: 'u',
    body: 'x',
    createdAt: 't',
    status,
    mine: false,
  }
}

describe('resolveMarkReadSeq', () => {
  it('returns 0 while history is syncing or not started', () => {
    expect(
      resolveMarkReadSeq({
        visibleMaxSeq: 9,
        messages: [msg(1), msg(2), msg(3)],
        historySyncState: 'syncing',
        restHistoryMaxSeq: 3,
      }),
    ).toBe(0)
    expect(
      resolveMarkReadSeq({
        visibleMaxSeq: 9,
        messages: [msg(1)],
        historySyncState: 'not_started',
        restHistoryMaxSeq: 0,
      }),
    ).toBe(0)
  })

  it('after ready backfill allows seq gaps in the delivered set', () => {
    expect(
      resolveMarkReadSeq({
        visibleMaxSeq: 5,
        messages: [msg(1), msg(2), msg(5)],
        historySyncState: 'ready',
        restHistoryMaxSeq: 5,
      }),
    ).toBe(5)
  })

  it('does not mark above what was actually shown', () => {
    expect(
      resolveMarkReadSeq({
        visibleMaxSeq: 2,
        messages: [msg(1), msg(2), msg(5)],
        historySyncState: 'ready',
        restHistoryMaxSeq: 5,
      }),
    ).toBe(2)
  })

  it('on recovery error does not jump via WS-only buffer when REST is empty', () => {
    expect(
      resolveMarkReadSeq({
        visibleMaxSeq: 5,
        messages: [msg(5)],
        historySyncState: 'error',
        restHistoryMaxSeq: 0,
      }),
    ).toBe(0)
  })

  it('on recovery error caps at REST watermark', () => {
    expect(
      resolveMarkReadSeq({
        visibleMaxSeq: 15,
        messages: [msg(1), msg(2), msg(15)],
        historySyncState: 'error',
        restHistoryMaxSeq: 2,
      }),
    ).toBe(2)
  })
})
