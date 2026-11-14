import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createRefreshSession,
  consumeRefreshSession,
  revokeRefreshSession,
  resetAuthData,
  searchUsersByPrefix,
  addContact,
  listContacts,
  removeContact,
  addUser,
} from './auth'

const USER_ID = '00000000-0000-4000-8000-000000000001'

// Refresh tests фиксируют одноразовость token и обязательную очистку session state.
describe('Mock refresh sessions', () => {
  afterEach(() => {
    resetAuthData()
  })

  it('creates a refresh session for a user', () => {
    const token = createRefreshSession(USER_ID)

    expect(token).toEqual(expect.any(String))
    expect(token.length).toBeGreaterThan(0)
    expect(consumeRefreshSession(token)).toBe(USER_ID)
  })

  it('prevents reusing a consumed refresh token', () => {
    const token = createRefreshSession(USER_ID)

    expect(consumeRefreshSession(token)).toBe(USER_ID)
    expect(consumeRefreshSession(token)).toBeNull()
  })

  it('revokes a refresh token', () => {
    const token = createRefreshSession(USER_ID)

    expect(revokeRefreshSession(token)).toBe(true)
    expect(consumeRefreshSession(token)).toBeNull()
  })

  it('rejects and removes an expired refresh token during revocation', () => {
    vi.useFakeTimers()

    try {
      vi.setSystemTime(new Date('2026-11-01T12:00:00Z'))
      const token = createRefreshSession(USER_ID)
      vi.setSystemTime(new Date('2026-12-02T12:00:00Z'))

      expect(revokeRefreshSession(token)).toBe(false)
      expect(consumeRefreshSession(token)).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('rejects an unknown refresh token', () => {
    expect(consumeRefreshSession('unknown-token')).toBeNull()
    expect(revokeRefreshSession('unknown-token')).toBe(false)
  })

  it('clears refresh sessions when mock data is reset', () => {
    const token = createRefreshSession(USER_ID)

    resetAuthData()

    expect(consumeRefreshSession(token)).toBeNull()
  })

  it('finds users by prefix regardless of case', () => {
    const result = searchUsersByPrefix('ALI')

    expect(result).toEqual([
      {
        id: '00000000-0000-4000-8000-000000000001',
        username: 'alice_1',
      },
    ])
  })
})

// Contact store должен быть идемпотентным и изолировать наборы разных владельцев.
describe('Contacts storage', () => {
  const aliceId = '00000000-0000-4000-8000-000000000001'

  const bob = {
    id: '00000000-0000-4000-8000-000000000010',
    username: 'bob_1',
    password: 'test-password',
    created_at: '2026-11-01T10:00:00Z',
  }

  it('adds a contact and returns public user fields', () => {
    addUser(bob)
    addContact(aliceId, bob.id)

    expect(listContacts(aliceId)).toEqual([
      {
        id: bob.id,
        username: bob.username,
      },
    ])
  })

  it('does not duplicate contacts when added twice', () => {
    addUser(bob)

    addContact(aliceId, bob.id)
    addContact(aliceId, bob.id)

    expect(listContacts(aliceId)).toHaveLength(1)
  })

  it('sorts contacts by ASCII lower-case username while preserving original case', () => {
    const zed = {
      id: '00000000-0000-4000-8000-000000000011',
      username: 'Zed_1',
      password: 'test-password',
      created_at: '2026-11-01T10:10:00Z',
    }
    const initialBobId = '00000000-0000-4000-8000-000000000002'

    addUser(zed)
    addContact(aliceId, zed.id)
    addContact(aliceId, initialBobId)

    expect(listContacts(aliceId)).toEqual([
      { id: initialBobId, username: 'bob_2' },
      { id: zed.id, username: 'Zed_1' },
    ])
  })

  it('removes an existing contact', () => {
    addUser(bob)
    addContact(aliceId, bob.id)

    removeContact(aliceId, bob.id)

    expect(listContacts(aliceId)).toEqual([])
  })

  it('allows removing a contact that does not exist', () => {
    expect(() => removeContact(aliceId, bob.id)).not.toThrow()
    expect(listContacts(aliceId)).toEqual([])
  })

  it('keeps contacts isolated between users', () => {
    addUser(bob)
    addContact(aliceId, bob.id)

    expect(listContacts(bob.id)).toEqual([])
    expect(listContacts(aliceId)).toHaveLength(1)
  })
})
