import { listChats, type ChatsResponse } from '@/api/history'

/** One GET /chats in flight for this authenticated session, shared by History and the UI. */
export function createChatListReader() {
  let revision = 0
  let active: { token: string; revision: number; response: Promise<ChatsResponse> } | null = null
  let cached: { token: string; response: ChatsResponse } | null = null

  async function load(token: string, reuse = false): Promise<ChatsResponse> {
    while (active) {
      const previous = active
      if (previous.token === token && previous.revision === revision) return previous.response
      await previous.response.catch(() => undefined)
    }
    if (reuse && cached?.token === token) return cached.response

    const startedAt = revision
    const response = listChats(token)
      .then((result) => {
        if (revision === startedAt) cached = { token, response: result }
        return result
      })
      .finally(() => {
        active = null
      })
    active = { token, revision, response }
    return response
  }

  return {
    load,
    invalidate() {
      revision += 1
      cached = null
    },
  }
}
