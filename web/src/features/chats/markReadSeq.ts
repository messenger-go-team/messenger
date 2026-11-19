import type { ThreadMessage } from '@/features/chats/mergeThreadMessages'

/** Макс. seq без дыр от минимума подтверждённой ленты (1,2,5 → 2). */
export function maxContiguousConfirmedSeq(messages: readonly ThreadMessage[]): number {
  const seqs = Array.from(
    new Set(
      messages
        .filter(
          (message) =>
            message.seq != null && message.status !== 'sending' && message.status !== 'failed',
        )
        .map((message) => message.seq as number),
    ),
  ).sort((left, right) => left - right)

  if (seqs.length === 0) return 0

  let cursor = seqs[0]!
  for (let index = 1; index < seqs.length; index += 1) {
    const next = seqs[index]!
    if (next !== cursor + 1) break
    cursor = next
  }
  return cursor
}

/**
 * Seq для POST /read: не выше показанного и не через дыру;
 * во время history sync / error без contiguous — 0 (ждём).
 */
export function resolveMarkReadSeq({
  visibleMaxSeq,
  messages,
  historySyncing,
}: {
  visibleMaxSeq: number
  messages: readonly ThreadMessage[]
  historySyncing: boolean
}): number {
  if (historySyncing) return 0
  if (visibleMaxSeq <= 0) return 0
  const contiguous = maxContiguousConfirmedSeq(messages)
  if (contiguous <= 0) return 0
  return Math.min(visibleMaxSeq, contiguous)
}
