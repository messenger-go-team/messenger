import type { ThreadMessage } from '@/features/chats/mergeThreadMessages'
import { maxConfirmedSeq } from '@/features/chats/mergeThreadMessages'
import type { HistorySyncState } from '@/ws'

/**
 * Seq для POST /read:
 * - только не выше реально показанного (visibleMaxSeq);
 * - при successful backfill (`ready`) — до max подтверждённых в ленте, дыры seq допустимы;
 * - при `error` — только до max REST-истории (не прыгаем по WS-буферу после сбоя догрузки);
 * - во время sync / not_started — 0.
 */
export function resolveMarkReadSeq({
  visibleMaxSeq,
  messages,
  historySyncState,
  restHistoryMaxSeq,
}: {
  visibleMaxSeq: number
  messages: readonly ThreadMessage[]
  historySyncState: HistorySyncState
  restHistoryMaxSeq: number
}): number {
  if (historySyncState === 'syncing' || historySyncState === 'not_started') return 0
  if (visibleMaxSeq <= 0) return 0

  if (historySyncState === 'ready') {
    const trustedMax = maxConfirmedSeq(messages)
    if (trustedMax <= 0) return 0
    return Math.min(visibleMaxSeq, trustedMax)
  }

  // history === 'error'
  if (restHistoryMaxSeq <= 0) return 0
  return Math.min(visibleMaxSeq, restHistoryMaxSeq)
}
