export interface MockUser {
  id: string
  username: string
  password: string
  created_at: string
}

interface MockRefreshSession {
  userId: string
  expiresAt: number
}

const initialUsers: MockUser[] = [
  {
    id: '00000000-0000-4000-8000-000000000001',
    username: 'alice_1',
    password: 'correct-horse-battery',
    created_at: '2026-11-01T10:00:00Z',
  },
]

let users: MockUser[] = structuredClone(initialUsers)

export function findUserByUsername(username: string): MockUser | undefined {
  return users.find((user) => user.username.toLowerCase() === username.toLowerCase())
}

export function findUserById(id: string): MockUser | undefined {
  return users.find((user) => user.id === id)
}

export function addUser(user: MockUser): void {
  users.push(user)
}

export function resetAuthData(): void {
  users = structuredClone(initialUsers)
  refreshSessions.clear()
  contacts.clear()
}

const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000

const refreshSessions = new Map<string, MockRefreshSession>()

export function createRefreshSession(userId: string): string {
  const refreshToken = crypto.randomUUID()

  refreshSessions.set(refreshToken, {
    userId,
    expiresAt: Date.now() + REFRESH_TOKEN_TTL_MS,
  })

  return refreshToken
}

export function consumeRefreshSession(refreshToken: string): string | null {
  const session = refreshSessions.get(refreshToken)

  if (!session) {
    return null
  }

  refreshSessions.delete(refreshToken)

  if (session.expiresAt <= Date.now()) {
    return null
  }

  return session.userId
}

export function revokeRefreshSession(refreshToken: string): boolean {
  return refreshSessions.delete(refreshToken)
}

export function searchUsersByPrefix(prefix: string) {
  const normalizedPrefix = prefix.toLowerCase()

  return users
    .filter((user) => user.username.toLowerCase().startsWith(normalizedPrefix))
    .slice(0, 20)
    .map((user) => ({
      id: user.id,
      username: user.username,
    }))
}

const contacts = new Map<string, Set<string>>()

export function listContacts(userId: string) {
  const contactIds = contacts.get(userId) ?? new Set<string>()

  return [...contactIds]
    .map((contactId) => findUserById(contactId))
    .filter((user) => user !== undefined)
    .map((user) => ({
      id: user.id,
      username: user.username,
    }))
}

export function addContact(userId: string, contactId: string) {
  let userContacts = contacts.get(userId)

  if (!userContacts) {
    userContacts = new Set<string>()
    contacts.set(userId, userContacts)
  }

  userContacts.add(contactId)
}

export function removeContact(userId: string, contactId: string) {
  contacts.get(userId)?.delete(contactId)
}
