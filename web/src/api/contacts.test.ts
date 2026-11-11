import { expect, it } from 'vitest'
import { addContact, getContacts, login, register, removeContact } from './auth'

const aliceId = '00000000-0000-4000-8000-000000000001'

/** Получает access token стандартного fixture-пользователя для contact-сценариев. */
async function token() {
  return (await login({ username: 'alice_1', password: 'correct-horse-battery' })).access_token
}

/** Вызывает handler напрямую, чтобы дополнительно проверить статус и пустое тело 204. */
async function deleteContact(contactId: string, accessToken: string) {
  return fetch(`/contacts/${contactId}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${accessToken}` },
  })
}

// Удаление контакта идемпотентно: существование связи не раскрывается через HTTP status.
it('deletes an existing contact with an empty 204 response', async () => {
  const access = await token()
  await addContact(aliceId, access)

  const response = await deleteContact(aliceId, access)

  expect(response.status).toBe(204)
  expect(await response.text()).toBe('')
  expect(await getContacts(access)).toEqual({ contacts: [] })
})

it('returns 204 when deleting the same contact repeatedly', async () => {
  const access = await token()
  await addContact(aliceId, access)

  expect((await deleteContact(aliceId, access)).status).toBe(204)
  expect((await deleteContact(aliceId, access)).status).toBe(204)
})

it('returns 204 for a contact that is already absent', async () => {
  const response = await deleteContact('00000000-0000-4000-8000-000000000099', await token())

  expect(response.status).toBe(204)
  expect(await response.text()).toBe('')
})

it.each(['', 'invalid-token'])('rejects invalid authorization %s', async (access) => {
  await expect(removeContact(aliceId, access)).rejects.toMatchObject({ status: 401 })
})

it('rejects missing authorization', async () => {
  expect((await fetch(`/contacts/${aliceId}`, { method: 'DELETE' })).status).toBe(401)
})

it('rejects invalid UUID', async () => {
  await expect(removeContact('invalid', await token())).rejects.toMatchObject({ status: 422 })
})

// Владельцем операции является `sub` JWT; изменение одного набора не затрагивает другой.
it('isolates deletion by authenticated owner', async () => {
  const alice = await token()
  await register({ username: 'bob_1', password: 'test-password' })
  const bob = (await login({ username: 'bob_1', password: 'test-password' })).access_token
  await addContact(aliceId, alice)
  await addContact(aliceId, bob)
  await removeContact(aliceId, alice)
  expect(await getContacts(alice)).toEqual({ contacts: [] })
  expect((await getContacts(bob)).contacts).toEqual([{ id: aliceId, username: 'alice_1' }])
})
