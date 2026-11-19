import { describe, expect, it } from 'vitest'
import type { ThreadMessage } from '@/features/chats/mergeThreadMessages'
import { maxContiguousConfirmedSeq, resolveMarkReadSeq } from '@/features/chats/markReadSeq'

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

describe('maxContiguousConfirmedSeq', () => {
  it('stops before a gap', () => {
    expect(maxContiguousConfirmedSeq([msg(1), msg(2), msg(5)])).toBe(2)
  })

  it('returns the top of a dense window', () => {
    expect(maxContiguousConfirmedSeq([msg(51), msg(52), msg(53)])).toBe(53)
  })

  it('ignores sending and failed', () => {
    expect(maxContiguousConfirmedSeq([msg(1), msg(2, 'sending'), msg(3)])).toBe(1)
  })
})

describe('resolveMarkReadSeq', () => {
  it('returns 0 while history is syncing', () => {
    expect(
      resolveMarkReadSeq({
        visibleMaxSeq: 9,
        messages: [msg(1), msg(2), msg(3)],
        historySyncing: true,
      }),
    ).toBe(0)
  })

  it('does not mark past an unseen seq or a gap', () => {
    expect(
      resolveMarkReadSeq({
        visibleMaxSeq: 2,
        messages: [msg(1), msg(2), msg(5)],
        historySyncing: false,
      }),
    ).toBe(2)
    expect(
      resolveMarkReadSeq({
        visibleMaxSeq: 5,
        messages: [msg(1), msg(2), msg(5)],
        historySyncing: false,
      }),
    ).toBe(2)
  })
})
