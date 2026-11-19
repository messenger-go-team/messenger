import type { UserSummary } from '@/api/auth'

/** Username собеседника в личном чате; для текущего пользователя не подходит. */
export function peerUsername(members: UserSummary[], currentUserId: string): string {
  const peer = members.find((member) => member.id !== currentUserId)
  return peer?.username ?? members[0]?.username ?? 'Чат'
}
