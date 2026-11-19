import { http, HttpResponse } from 'msw'
import { authenticateAccessToken } from '../lib/authentication'

/** In-memory Later list for MSW until backend #87 is wired. */
let laterEntries: Array<{
  id: string
  status: 'due' | 'scheduled' | 'unscheduled'
  message: { id: string; chat_id: string; body: string }
  due_at: string | null
  created_at: string
}> = []

export function resetLaterMocks() {
  laterEntries = []
}

export function seedLaterMocks(entries: typeof laterEntries): void {
  laterEntries = entries
}

export const laterHandlers = [
  http.get('/later', async ({ request }) => {
    const userId = await authenticateAccessToken(request)
    if (!userId) {
      return HttpResponse.json(
        { code: 'unauthorized', message: 'A valid access token is required' },
        { status: 401 },
      )
    }
    return HttpResponse.json({
      server_time: new Date().toISOString(),
      entries: laterEntries,
    })
  }),
]
