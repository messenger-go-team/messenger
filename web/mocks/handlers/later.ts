import { http, HttpResponse } from 'msw'
import { findHistoryMessage, isChatMember } from '../data/history'
import { authenticateAccessToken } from '../lib/authentication'
import { normalizeUuid } from '../lib/validation'

type LaterStatus = 'due' | 'scheduled' | 'unscheduled'

interface StoredLater {
  id: string
  ownerId: string
  message: {
    id: string
    chat_id: string
    seq: number
    sender_id: string
    body: string
    created_at: string
  }
  due_at: string | null
  created_at: string
  updated_at: string
  done: boolean
}

const RFC3339_Z = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/

let laterEntries: StoredLater[] = []

export function resetLaterMocks() {
  laterEntries = []
}

export function seedLaterMocks(
  entries: Array<Omit<StoredLater, 'ownerId' | 'done'> & { ownerId?: string; done?: boolean }>,
): void {
  laterEntries = entries.map((entry) => ({
    ...entry,
    ownerId: entry.ownerId ?? '00000000-0000-4000-8000-000000000001',
    done: entry.done ?? false,
  }))
}

function unauthorized() {
  return HttpResponse.json(
    { code: 'unauthorized', message: 'A valid access token is required' },
    { status: 401 },
  )
}

function notFound() {
  return HttpResponse.json(
    { code: 'not_found', message: 'Later entry or message was not found' },
    { status: 404 },
  )
}

function validationError(message: string) {
  return HttpResponse.json({ code: 'validation_error', message }, { status: 422 })
}

function isDueAtValue(value: unknown): value is string | null {
  if (value === null) return true
  return typeof value === 'string' && RFC3339_Z.test(value) && Number.isFinite(Date.parse(value))
}

function statusFor(dueAt: string | null, serverTime: string): LaterStatus {
  if (dueAt === null) return 'unscheduled'
  return Date.parse(dueAt) <= Date.parse(serverTime) ? 'due' : 'scheduled'
}

function toPublic(entry: StoredLater, serverTime: string) {
  return {
    id: entry.id,
    message: entry.message,
    due_at: entry.due_at,
    status: statusFor(entry.due_at, serverTime),
    created_at: entry.created_at,
    updated_at: entry.updated_at,
  }
}

function sortEntries(entries: ReturnType<typeof toPublic>[]) {
  const rank = { due: 0, scheduled: 1, unscheduled: 2 } as const
  return [...entries].sort((a, b) => {
    if (rank[a.status] !== rank[b.status]) return rank[a.status] - rank[b.status]
    if (a.status !== 'unscheduled') {
      const dueCmp = (a.due_at ?? '').localeCompare(b.due_at ?? '')
      if (dueCmp !== 0) return dueCmp
    }
    const createdCmp = a.created_at.localeCompare(b.created_at)
    if (createdCmp !== 0) return createdCmp
    return a.id.localeCompare(b.id)
  })
}

function newId() {
  return crypto.randomUUID()
}

/** In-memory Later handlers until wired to real History (#87). */
export const laterHandlers = [
  http.get('/later', async ({ request }) => {
    const userId = await authenticateAccessToken(request)
    if (!userId) return unauthorized()

    const serverTime = new Date().toISOString()
    const entries = laterEntries
      .filter((entry) => entry.ownerId === userId && !entry.done)
      .filter((entry) => isChatMember(entry.message.chat_id, userId))
      .map((entry) => toPublic(entry, serverTime))

    return HttpResponse.json({
      server_time: serverTime,
      entries: sortEntries(entries),
    })
  }),

  http.post('/later', async ({ request }) => {
    const userId = await authenticateAccessToken(request)
    if (!userId) return unauthorized()

    let body: unknown
    try {
      body = await request.json()
    } catch {
      return validationError('Invalid JSON body')
    }

    if (
      typeof body !== 'object' ||
      body === null ||
      Array.isArray(body) ||
      !('chat_id' in body) ||
      !('message_id' in body) ||
      !('due_at' in body)
    ) {
      return validationError('Invalid save-for-later request')
    }

    const chatId = normalizeUuid(body.chat_id)
    const messageId = normalizeUuid(body.message_id)
    if (!chatId || !messageId || !isDueAtValue(body.due_at)) {
      return validationError('Invalid save-for-later fields')
    }

    const message = findHistoryMessage(messageId)
    if (!message || message.chat_id !== chatId || !isChatMember(chatId, userId)) {
      return notFound()
    }

    const serverTime = new Date().toISOString()
    const existing = laterEntries.find(
      (entry) => entry.ownerId === userId && !entry.done && entry.message.id === messageId,
    )

    if (existing) {
      existing.due_at = body.due_at
      existing.updated_at = serverTime
      existing.message = message
      return HttpResponse.json(
        { server_time: serverTime, entry: toPublic(existing, serverTime) },
        { status: 200 },
      )
    }

    const created: StoredLater = {
      id: newId(),
      ownerId: userId,
      message,
      due_at: body.due_at,
      created_at: serverTime,
      updated_at: serverTime,
      done: false,
    }
    laterEntries.push(created)
    return HttpResponse.json(
      { server_time: serverTime, entry: toPublic(created, serverTime) },
      { status: 201 },
    )
  }),

  http.patch('/later/:laterId', async ({ request, params }) => {
    const userId = await authenticateAccessToken(request)
    if (!userId) return unauthorized()

    const laterId = normalizeUuid(params.laterId)
    if (!laterId) return validationError('Invalid later id')

    let body: unknown
    try {
      body = await request.json()
    } catch {
      return validationError('Invalid JSON body')
    }

    if (
      typeof body !== 'object' ||
      body === null ||
      Array.isArray(body) ||
      !('due_at' in body) ||
      !isDueAtValue(body.due_at)
    ) {
      return validationError('Invalid reschedule request')
    }

    const entry = laterEntries.find((item) => item.id === laterId)
    if (!entry || entry.ownerId !== userId || entry.done) return notFound()
    if (!isChatMember(entry.message.chat_id, userId)) return notFound()

    const serverTime = new Date().toISOString()
    entry.due_at = body.due_at
    entry.updated_at = serverTime
    return HttpResponse.json({
      server_time: serverTime,
      entry: toPublic(entry, serverTime),
    })
  }),

  http.post('/later/:laterId/done', async ({ request, params }) => {
    const userId = await authenticateAccessToken(request)
    if (!userId) return unauthorized()

    const laterId = normalizeUuid(params.laterId)
    if (!laterId) return validationError('Invalid later id')

    const entry = laterEntries.find((item) => item.id === laterId)
    if (!entry || entry.ownerId !== userId) return notFound()
    if (!isChatMember(entry.message.chat_id, userId)) return notFound()

    entry.done = true
    return new HttpResponse(null, { status: 204 })
  }),
]
