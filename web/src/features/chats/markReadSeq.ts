import type { ThreadMessage } from '@/features/chats/mergeThreadMessages'
import type { HistorySyncState } from '@/ws'

/**
 * Seq для POST /read (api/ws/events.md §8):
 * - только среди реально показанных seq (IntersectionObserver);
 * - потолок = history-synced cursor, либо непрерывное продление synced+1, synced+2… по seq в ленте;
 * - скачок (видно 5, нет 3 при synced=2) не даёт отмечать 2, пока 2 сам не был в viewport;
 * - после успешной догрузки syncedCursor → 5: /read до 5, даже если 3–4 отсутствуют.
 */
export function resolveMarkReadSeq({
  visibleSeqs,
  messages,
  historySyncState,
  syncedCursor,
}: {
  visibleSeqs: readonly number[]
  messages: readonly ThreadMessage[]
  historySyncState: HistorySyncState
  syncedCursor: number
}): number {
  if (visibleSeqs.length === 0) return 0
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

  let best = 0
  for (const seq of visibleSeqs) {
    if (seq > 0 && seq <= trustedMax && seq > best) best = seq
  }
  return best
}
