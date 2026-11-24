import { describe, expect, it } from 'vitest'
import { login } from '@/api/auth'
import { listLater, saveForLater } from '@/api/later'
import { INITIAL_CHAT_ID } from '../../mocks/data/history'

const saveBody = {
  chat_id: INITIAL_CHAT_ID,
  message_id: '20000000-0000-4000-8000-000000000002',
  due_at: null,
}

function request(path: string, method: string, token?: string, body?: object | string) {
  return fetch(new URL(path, window.location.origin), {
    method,
    headers: {
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

describe('Later contract on MSW', () => {
  it('checks authorization before rejecting query strings on all four operations', async () => {
    const { access_token } = await login({ username: 'alice_1', password: 'correct-horse-battery' })
    const { entry } = await saveForLater(access_token, saveBody)
    const path = '/later/' + entry.id
    const operations = [
      ['GET', '/later'],
      ['POST', '/later'],
      ['PATCH', path],
      ['POST', path + '/done'],
    ] as const

    for (const [method, route] of operations) {
      for (const query of ['?limit=1', '?invalid=%ZZ']) {
        expect((await request(route + query, method)).status).toBe(401)
        const body = route === '/later' && method === 'POST' ? { ...saveBody } : undefined
        expect((await request(route + query, method, access_token, body)).status).toBe(422)
      }
    }
    expect((await listLater(access_token)).entries).toEqual([entry])
  })

  it('rejects extra fields, bodies on Done and invalid dates without changing the entry', async () => {
    const { access_token } = await login({ username: 'alice_1', password: 'correct-horse-battery' })
    const { entry } = await saveForLater(access_token, saveBody)
    const path = '/later/' + entry.id
    expect(
      (await request('/later', 'POST', access_token, { ...saveBody, owner_id: 'other' })).status,
    ).toBe(422)
    expect(
      (await request(path, 'PATCH', access_token, { due_at: null, owner_id: 'other' })).status,
    ).toBe(422)
    expect((await request(path + '/done', 'POST', access_token, {})).status).toBe(422)

    for (const due_at of ['2026-02-30T19:00:00Z', '2099-03-01T10:00:00.1234567Z']) {
      expect((await request(path, 'PATCH', access_token, { due_at })).status).toBe(422)
    }
    expect((await listLater(access_token)).entries).toEqual([entry])

    const due_at = '2099-03-01T10:00:00.123456Z'
    const accepted = await request(path, 'PATCH', access_token, { due_at })
    expect(accepted.status).toBe(200)
    expect((await listLater(access_token)).entries[0]?.due_at).toBe(due_at)
  })

  it('updates one active entry, keeps it private and can save it again after Done', async () => {
    const alice = await login({ username: 'alice_1', password: 'correct-horse-battery' })
    const { entry: first } = await saveForLater(alice.access_token, saveBody)
    const due_at = '2099-03-01T10:00:00.123456Z'
    const updated = await request('/later', 'POST', alice.access_token, { ...saveBody, due_at })
    expect(updated.status).toBe(200)
    const { entry } = await updated.json()
    expect(entry).toMatchObject({ id: first.id, created_at: first.created_at, due_at })
    expect((await listLater(alice.access_token)).entries).toEqual([entry])

    const bob = await login({ username: 'bob_2', password: 'correct-horse-battery' })
    const path = '/later/' + first.id
    expect((await listLater(bob.access_token)).entries).toEqual([])
    expect((await request(path, 'PATCH', bob.access_token, { due_at: null })).status).toBe(404)
    expect((await request(path + '/done', 'POST', bob.access_token)).status).toBe(404)
    expect((await listLater(alice.access_token)).entries).toEqual([entry])

    expect((await request(path + '/done', 'POST', alice.access_token)).status).toBe(204)
    expect((await request(path + '/done', 'POST', alice.access_token)).status).toBe(204)
    expect((await listLater(alice.access_token)).entries).toEqual([])
    const { entry: savedAgain } = await saveForLater(alice.access_token, saveBody)
    expect(savedAgain.id).not.toBe(first.id)
    expect((await request(path + '/done', 'POST', alice.access_token)).status).toBe(204)
    expect((await listLater(alice.access_token)).entries).toEqual([savedAgain])
  })
})
