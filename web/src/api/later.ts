import { apiRequest } from './client'

/** Сообщение внутри Later entry (упрощённо для UI списка). */
export interface LaterMessageRef {
  id: string
  chat_id: string
  body: string
}

export interface LaterEntry {
  id: string
  status: 'due' | 'scheduled' | 'unscheduled'
  message: LaterMessageRef
  due_at: string | null
  created_at: string
}

export interface LaterList {
  server_time: string
  entries: LaterEntry[]
}

/** GET /later — активные записи «Вернуться позже». */
export function listLater(accessToken: string): Promise<LaterList> {
  return apiRequest<LaterList>('/later', {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  })
}
