import type { ThreadMessage } from '@/features/chats/mergeThreadMessages'
import type { HistorySyncState } from '@/ws'

/**
 * Seq для POST /read (api/ws/events.md §8):
 * - не выше реально показанного (visibleMaxSeq);
 * - потолок = history-synced cursor, либо непрерывное продление synced+1, synced+2… по seq в ленте;
 * - скачок (есть 5, нет 3 при synced=2) не двигает границу, пока History не подтвердит диапазон;
 * - после успешной догрузки syncedCursor сам становится 5 (дыры 3–4 допустимы) → /read до 5.
 */
export function resolveMarkReadSeq({
  visibleMaxSeq,
  messages,
  historySyncState,
  syncedCursor,
}: {
  visibleMaxSeq: number
  messages: readonly ThreadMessage[]
  historySyncState: HistorySyncState
  syncedCursor: number
}): number {
  if (visibleMaxSeq <= 0) return 0
  if (historySyncState === 'not_started') return 0

  const confirmedSeqs = new Set<number>()
  for (const message of messages) {
    if (message.seq != null && message.status !== 'sending' && message.status !== 'failed') {
      confirmedSeqs.add(message.seq)
    }
  }

  // Непрерывное продление от синхронизированного курсора обычными следующими seq.
  let edge = syncedCursor
  while (confirmedSeqs.has(edge + 1)) {
    edge += 1
  }

  const trustedMax = Math.max(syncedCursor, edge)
  if (trustedMax <= 0) return 0
  return Math.min(visibleMaxSeq, trustedMax)
}
