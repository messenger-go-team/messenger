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

const MOCK_PASSWORD = 'correct-horse-battery'
const ALICE_ID = '00000000-0000-4000-8000-000000000001'
const BOB_ID = '00000000-0000-4000-8000-000000000002'

/** Именованные логины для удобного поиска в UI; остальное добиваем contact_NN до 50 контактов. */
const NAMED_DIRECTORY: Array<{ hex: string; username: string }> = [
  { hex: '101', username: 'carol_3' },
  { hex: '102', username: 'dave_4' },
  { hex: '103', username: 'erin_5' },
  { hex: '104', username: 'frank_6' },
  { hex: '105', username: 'grace_7' },
  { hex: '106', username: 'hank_8' },
  { hex: '107', username: 'ivy_9' },
  { hex: '108', username: 'jake_10' },
  { hex: '109', username: 'kate_11' },
  { hex: '10a', username: 'leo_12' },
  { hex: '10b', username: 'mia_13' },
  { hex: '10c', username: 'nina_14' },
  { hex: '10d', username: 'demo_alpha' },
  { hex: '10e', username: 'demo_beta' },
  { hex: '10f', username: 'demo_gamma' },
  { hex: '110', username: 'demo_delta' },
  { hex: '111', username: 'demo_echo' },
]

function directoryUserId(hexSuffix: string): string {
  return `00000000-0000-4000-8000-${hexSuffix.padStart(12, '0')}`
}

/**
 * 49 пользователей каталога + bob в контактах alice = 50.
 * UUID с 101+, чтобы не пересекаться с id в unit-тестах (003/004/010/…).
 */
function buildDirectoryUsers(): Omit<MockUser, 'password'>[] {
  const named = new Map(NAMED_DIRECTORY.map((entry) => [entry.hex, entry.username]))
  const users: Omit<MockUser, 'password'>[] = []

  for (let index = 0; index < 49; index += 1) {
    const hex = (0x101 + index).toString(16)
    const username = named.get(hex) ?? `contact_${String(index + 1).padStart(2, '0')}`
    const minute = 10 + index
    const created_at = `2026-11-01T${String(Math.floor(minute / 60) + 10).padStart(2, '0')}:${String(
      minute % 60,
    ).padStart(2, '0')}:00Z`

    users.push({
      id: directoryUserId(hex),
      username,
      created_at,
    })
  }

  return users
}

const directoryUsers = buildDirectoryUsers()

const initialUsers: MockUser[] = [
  {
    id: ALICE_ID,
    username: 'alice_1',
    password: MOCK_PASSWORD,
    created_at: '2026-11-01T10:00:00Z',
  },
  {
    id: BOB_ID,
    username: 'bob_2',
    password: MOCK_PASSWORD,
    created_at: '2026-11-01T10:05:00Z',
  },
  ...directoryUsers.map((user) => ({ ...user, password: MOCK_PASSWORD })),
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

/**
 * Засевает alice ~50 контактами для локальной/телефонной приёмки.
 * Только browser MSW: в Vitest не вызывается, чтобы контрактные тесты ждали пустой список.
 */
export function seedAliceDemoContacts(): void {
  addContact(ALICE_ID, BOB_ID)
  for (const user of directoryUsers) {
    addContact(ALICE_ID, user.id)
  }
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
