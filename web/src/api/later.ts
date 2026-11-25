import { apiRequest } from './client'

/** Сообщение внутри Later entry (контракт Message). */
export interface LaterMessageRef {
  id: string
  chat_id: string
  seq: number
  sender_id: string
  body: string
  created_at: string
}

export type LaterStatus = 'due' | 'scheduled' | 'unscheduled'

export interface LaterEntry {
  id: string
  status: LaterStatus
  message: LaterMessageRef
  due_at: string | null
  created_at: string
  updated_at: string
}

export interface LaterList {
  server_time: string
  entries: LaterEntry[]
}

export interface LaterEntryResult {
  server_time: string
  entry: LaterEntry
}

export interface SaveForLaterRequest {
  chat_id: string
  message_id: string
  due_at: string | null
}

/** GET /later — активные записи «Вернуться позже». `signal` отменяет запрос прежнего аккаунта. */
export function listLater(
  accessToken: string,
  init: { signal?: AbortSignal } = {},
): Promise<LaterList> {
  return apiRequest<LaterList>('/later', {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
    signal: init.signal,
  })
}

/** POST /later — создать или обновить активную запись. */
export function saveForLater(
  accessToken: string,
  body: SaveForLaterRequest,
): Promise<LaterEntryResult> {
  return apiRequest<LaterEntryResult>('/later', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })
}

/** PATCH /later/{id} — перенести срок. */
export function rescheduleLater(
  accessToken: string,
  laterId: string,
  dueAt: string | null,
): Promise<LaterEntryResult> {
  return apiRequest<LaterEntryResult>(`/later/${laterId}`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ due_at: dueAt }),
  })
}

/** POST /later/{id}/done — «Готово». */
export function completeLater(accessToken: string, laterId: string): Promise<void> {
  return apiRequest<void>(`/later/${laterId}/done`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  })
}
