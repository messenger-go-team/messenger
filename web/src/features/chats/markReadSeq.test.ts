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
  it('does not mark synced seq that was never visible when a jumped seq is shown', () => {
    // Synced to 2; only 5 is in viewport; 1–2 never intersected → no /read yet.
    expect(
      resolveMarkReadSeq({
        visibleSeqs: [5],
        messages: [msg(1), msg(2), msg(5)],
        historySyncState: 'syncing',
        syncedCursor: 2,
      }),
    ).toBe(0)
    expect(
      resolveMarkReadSeq({
        visibleSeqs: [5],
        messages: [msg(1), msg(2), msg(5)],
        historySyncState: 'ready',
        syncedCursor: 2,
      }),
    ).toBe(0)
  })

  it('marks synced seq when it was actually shown alongside a jumped newer seq', () => {
    expect(
      resolveMarkReadSeq({
        visibleSeqs: [2, 5],
        messages: [msg(1), msg(2), msg(5)],
        historySyncState: 'ready',
        syncedCursor: 2,
      }),
    ).toBe(2)
  })

  it('marks 5 after History confirms the range even if 3–4 are absent', () => {
    // Backfill finished: synced cursor advanced to 5; 3–4 missing is OK.
    expect(
      resolveMarkReadSeq({
        visibleSeqs: [5],
        messages: [msg(1), msg(2), msg(5)],
        historySyncState: 'ready',
        syncedCursor: 5,
      }),
    ).toBe(5)
  })

  it('advances to the normal next visible seq without waiting for periodic sync', () => {
    // Synced to 2; ordinary visible 3 → /read to 3 immediately.
    expect(
      resolveMarkReadSeq({
        visibleSeqs: [3],
        messages: [msg(1), msg(2), msg(3)],
        historySyncState: 'ready',
        syncedCursor: 2,
      }),
    ).toBe(3)
  })

  it('does not mark above what was shown', () => {
    expect(
      resolveMarkReadSeq({
        visibleSeqs: [2],
        messages: [msg(1), msg(2), msg(3)],
        historySyncState: 'ready',
        syncedCursor: 3,
      }),
    ).toBe(2)
  })

  it('returns 0 before history sync has started', () => {
    expect(
      resolveMarkReadSeq({
        visibleSeqs: [1],
        messages: [msg(1)],
        historySyncState: 'not_started',
        syncedCursor: 0,
      }),
    ).toBe(0)
  })

  it('on recovery error with empty synced cursor does not jump via WS-only buffer', () => {
    expect(
      resolveMarkReadSeq({
        visibleSeqs: [5],
        messages: [msg(5)],
        historySyncState: 'error',
        syncedCursor: 0,
      }),
    ).toBe(0)
  })
})
