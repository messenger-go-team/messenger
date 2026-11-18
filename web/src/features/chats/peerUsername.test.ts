import { describe, expect, it } from 'vitest'
import { peerUsername } from '@/features/chats/peerUsername'

const alice = { id: 'a', username: 'alice_1' }
const bob = { id: 'b', username: 'bob_2' }

describe('peerUsername', () => {
  it('returns the other member username', () => {
    expect(peerUsername([alice, bob], 'a')).toBe('bob_2')
    expect(peerUsername([alice, bob], 'b')).toBe('alice_1')
  })

  it('falls back when the current user is missing from members', () => {
    expect(peerUsername([bob], 'a')).toBe('bob_2')
  })
})
