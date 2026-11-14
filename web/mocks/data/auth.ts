/** Внутренняя Auth-запись; `password` никогда не должен попадать в публичный API-ответ. */
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
  {
    id: '00000000-0000-4000-8000-000000000002',
    username: 'bob_2',
    password: 'correct-horse-battery',
    created_at: '2026-11-01T10:05:00Z',
  },
]

let users: MockUser[] = structuredClone(initialUsers)

/** Ищет пользователя без учёта регистра username, как это делает mock Auth API. */
export function findUserByUsername(username: string): MockUser | undefined {
  return users.find((user) => user.username.toLowerCase() === username.toLowerCase())
}

/** Возвращает внутреннюю запись пользователя по UUID или `undefined`, если её нет. */
export function findUserById(id: string): MockUser | undefined {
  return users.find((user) => user.id === id)
}

/** Добавляет пользователя в in-memory store; уникальность должна быть проверена handler заранее. */
export function addUser(user: MockUser): void {
  users.push(user)
}

/**
 * Восстанавливает начальные fixtures и очищает сессии и контакты.
 * Вызывается после каждого теста, чтобы mutable state не протекал между сценариями.
 */
export function resetAuthData(): void {
  users = structuredClone(initialUsers)
  refreshSessions.clear()
  contacts.clear()
}

const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000

const refreshSessions = new Map<string, MockRefreshSession>()

/** Создаёт одноразовую refresh-сессию с серверным сроком действия и возвращает opaque token. */
export function createRefreshSession(userId: string): string {
  const refreshToken = crypto.randomUUID()

  refreshSessions.set(refreshToken, {
    userId,
    expiresAt: Date.now() + REFRESH_TOKEN_TTL_MS,
  })

  return refreshToken
}

/**
 * Атомарно извлекает и удаляет refresh-сессию.
 * Удаление до проверки срока запрещает повторное использование как валидного, так и истёкшего token.
 */
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

/** Отзывает только действующую refresh-сессию; истёкшая также удаляется и возвращает `false`. */
export function revokeRefreshSession(refreshToken: string): boolean {
  const session = refreshSessions.get(refreshToken)

  if (!session) {
    return false
  }

  refreshSessions.delete(refreshToken)

  return session.expiresAt > Date.now()
}

/** Возвращает не более 20 публичных профилей с case-insensitive prefix. */
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

/** Возвращает публичные данные контактов конкретного владельца, исключая исчезнувших пользователей. */
export function listContacts(userId: string) {
  const contactIds = contacts.get(userId) ?? new Set<string>()

  return [...contactIds]
    .map((contactId) => findUserById(contactId))
    .filter((user) => user !== undefined)
    .sort((first, second) => {
      const firstUsername = first.username.toLowerCase()
      const secondUsername = second.username.toLowerCase()

      if (firstUsername < secondUsername) return -1
      if (firstUsername > secondUsername) return 1
      return 0
    })
    .map((user) => ({
      id: user.id,
      username: user.username,
    }))
}

/** Идемпотентно добавляет contact ID в независимый набор владельца. */
export function addContact(userId: string, contactId: string) {
  let userContacts = contacts.get(userId)

  if (!userContacts) {
    userContacts = new Set<string>()
    contacts.set(userId, userContacts)
  }

  userContacts.add(contactId)
}

/** Идемпотентно удаляет contact ID только из набора указанного владельца. */
export function removeContact(userId: string, contactId: string) {
  contacts.get(userId)?.delete(contactId)
}
