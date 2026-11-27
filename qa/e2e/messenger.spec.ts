import { randomUUID } from 'node:crypto'
import { expect } from '@playwright/test'
import type { Page, WebSocketRoute } from '@playwright/test'
import {
  chatSocket,
  history,
  incomingFrames,
  login,
  messageRow,
  openPersonalChat,
  parseFrame,
  register,
  reloadAndReadHistory,
  sendMessage,
  test,
  waitForFrame,
} from './fixtures'
import type { Frame } from './fixtures'

test('login opens the protected app with the right profile', async ({ page, request }) => {
  const account = await register(request)
  await login(page, account, '/app/profile')
  await page.getByRole('link', { name: 'Профиль', exact: true }).click()
  await expect(page).toHaveURL(/\/app\/profile$/)
  await expect(page.getByRole('heading', { name: 'Профиль', exact: true })).toBeVisible()
  await expect(page.getByText(account.username, { exact: true })).toBeVisible()
})

test('message reaches the peer and reload retrieves it from History', async ({
  page, peer, request, baseURL,
}) => {
  if (!baseURL) throw new Error('Configure the E2E baseURL')
  const a = await register(request)
  const b = await register(request)
  const body = `E2E History ${randomUUID()}`
  const received = incomingFrames(peer, baseURL)
  await login(page, a)
  await login(peer, b)
  const chatId = await openPersonalChat(page, a, b, 201)
  expect(await openPersonalChat(peer, b, a, 200)).toBe(chatId)

  await sendMessage(page, b, body)
  const message = await waitForFrame(received, (frame) =>
    frame.type === 'message.new' && frame.payload.chat_id === chatId && frame.payload.body === body,
  'peer receives the real WebSocket message')
  expect(message.payload.sender_id).toBe(a.id)
  await expect(messageRow(peer, a, body)).toHaveCount(1)
  await expect(messageRow(peer, a, body)).toHaveAttribute('data-message-id', message.payload.message_id!)

  const messages = await reloadAndReadHistory(peer, chatId)
  expect(messages).toMatchObject([{
    id: message.payload.message_id,
    chat_id: chatId,
    sender_id: a.id,
    seq: message.payload.seq,
    body,
  }])
  await expect(messageRow(peer, a, body)).toHaveCount(1)
  await expect(messageRow(peer, a, body)).toHaveAttribute('data-message-id', message.payload.message_id!)
})

interface Attempt {
  frame: Frame
  server: WebSocketRoute
  closures: Array<{ side: 'server' | 'page'; code?: number; reason?: string }>
}

async function interceptFirstConfirmation(page: Page, baseURL: string, body: string) {
  const attempts: Attempt[] = []
  const suppressed: Frame[] = []
  const forwardedAcks: Frame[] = []
  await page.routeWebSocket((url) => chatSocket(url, baseURL), (client) => {
    const server = client.connectToServer()
    const closures: Attempt['closures'] = []
    // Record which half closed first and forward the same close to the other half.
    server.onClose((code, reason) => {
      closures.push({ side: 'server', code, reason })
      if (closures.length === 1) void client.close({ code, reason })
    })
    client.onClose((code, reason) => {
      closures.push({ side: 'page', code, reason })
      if (closures.length === 1) void server.close({ code, reason })
    })
    client.onMessage((raw) => {
      const frame = parseFrame(raw)
      if (frame?.type === 'message.send' && frame.payload.body === body) {
        attempts.push({ frame, server, closures })
      }
      server.send(raw)
    })
    server.onMessage((raw) => {
      const frame = parseFrame(raw)
      const first = attempts[0]
      if (first && frame && frame.payload.client_msg_id === first.frame.payload.client_msg_id &&
          frame.payload.chat_id === first.frame.payload.chat_id) {
        if (server === first.server && (frame.type === 'message.ack' || frame.type === 'message.new')) {
          // Neither of the first successful attempt's confirmations reaches the app.
          suppressed.push(frame)
          return
        }
        if (frame.type === 'message.ack') forwardedAcks.push(frame)
      }
      client.send(raw)
    })
  })
  return { attempts, suppressed, forwardedAcks }
}

test('reconnect retries a committed send once without creating another message', async ({
  page, peer, request, baseURL,
}) => {
  if (!baseURL) throw new Error('Configure the E2E baseURL')
  const a = await register(request)
  const b = await register(request)
  const body = `E2E retry ${randomUUID()}`
  const { attempts, suppressed, forwardedAcks } = await interceptFirstConfirmation(page, baseURL, body)
  const peerFrames = incomingFrames(peer, baseURL)
  await login(page, a)
  const peerToken = await login(peer, b)
  const chatId = await openPersonalChat(page, a, b, 201)
  expect(await openPersonalChat(peer, b, a, 200)).toBe(chatId)

  await sendMessage(page, b, body)
  const firstAck = await waitForFrame(suppressed, (frame) => frame.type === 'message.ack',
    'the real server committed the first send and its ack was withheld')
  const firstOwnNew = await waitForFrame(suppressed, (frame) => frame.type === 'message.new',
    'the first server broadcast was also withheld from the sender')
  const peerNew = await waitForFrame(peerFrames, (frame) =>
    frame.type === 'message.new' && frame.payload.chat_id === chatId && frame.payload.body === body,
  'the peer receives the committed first send')
  expect(attempts.length).toBe(1)
  const first = attempts[0]
  expect(first.frame.payload).toMatchObject({ body, chat_id: chatId, client_msg_id: expect.any(String) })
  expect(firstAck.id).toBe(first.frame.id)
  expect(firstOwnNew.payload).toMatchObject(firstAck.payload)
  expect(peerNew.payload).toMatchObject({ ...firstAck.payload, body, sender_id: a.id })

  const expected = {
    id: firstAck.payload.message_id,
    chat_id: chatId,
    sender_id: a.id,
    seq: firstAck.payload.seq,
    body,
  }
  expect(await history(request, chatId, peerToken)).toMatchObject([expected])
  await expect(messageRow(peer, a, body)).toHaveCount(1)
  await expect(messageRow(page, b, body).getByTitle('Отправляется')).toBeVisible()
  expect(forwardedAcks).toHaveLength(0)
  expect(attempts.length).toBe(1)

  // Close the real upstream socket on A only. B's connection stays active.
  expect(first.closures).toHaveLength(0)
  await first.server.close({ code: 4001, reason: 'E2E controlled disconnect' })
  await expect.poll(() => first.closures.map(({ side }) => side), {
    message: 'the upstream close reaches the page before any app-initiated close',
  }).toEqual(['server', 'page'])
  expect(first.closures[1]).toEqual({ ...first.closures[0], side: 'page' })
  await expect.poll(() => attempts.length, { message: 'resend after a real disconnect' }).toBe(2)
  const retry = attempts[1]
  // Use a boolean identity comparison to avoid dumping routed socket internals on failure.
  expect(retry.server !== first.server, 'resend uses a replacement socket').toBe(true)
  expect(retry.frame.id).not.toBe(first.frame.id)
  expect(retry.frame.payload).toEqual(first.frame.payload)
  const retryAck = await waitForFrame(forwardedAcks, (frame) => frame.id === retry.frame.id,
    'the replacement socket receives a real ack for the retry')
  expect(retryAck.payload).toEqual(firstAck.payload)

  const sent = messageRow(page, b, body)
  await expect(sent).toHaveCount(1)
  await expect(sent).toHaveAttribute('data-message-id', firstAck.payload.message_id!)
  await expect(sent).toHaveAttribute('data-seq', String(firstAck.payload.seq))
  await expect(sent.getByTitle('Отправлено')).toBeVisible()
  await expect(messageRow(peer, a, body)).toHaveCount(1)
  expect(await history(request, chatId, peerToken)).toMatchObject([expected])
  expect(attempts.length).toBe(2)
})
