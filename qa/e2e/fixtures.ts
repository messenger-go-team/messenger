import { randomBytes } from 'node:crypto'
import { expect, test as base } from '@playwright/test'
import type { APIRequestContext, Page, Request, Response } from '@playwright/test'

export interface Account {
  id: string
  username: string
  password: string
}

export interface Message {
  id: string
  chat_id: string
  sender_id: string
  seq: number
  body: string
}

export interface Frame {
  type: string
  id: string
  payload: {
    body?: string
    chat_id?: string
    client_msg_id?: string
    message_id?: string
    sender_id?: string
    seq?: number
  }
}

const UUID = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i

export const test = base.extend<{ peer: Page }>({
  peer: async ({ browser, baseURL, ignoreHTTPSErrors }, use, testInfo) => {
    const context = await browser.newContext({ baseURL, ignoreHTTPSErrors })
    try {
      const peer = await context.newPage()
      await use(peer)
      if (testInfo.status !== testInfo.expectedStatus && !peer.isClosed()) {
        await peer.screenshot({ timeout: 2_000 }).then((body) =>
          testInfo.attach('peer-screenshot', { body, contentType: 'image/png' }),
        ).catch(() => {})
      }
    } finally {
      await context.close()
    }
  },
})

export async function register(request: APIRequestContext): Promise<Account> {
  const username = 'qa138_' + randomBytes(8).toString('hex')
  const password = randomBytes(24).toString('base64url')
  const response = await request.post('/auth/register', {
    data: { username, password },
    maxRedirects: 0,
  })
  expect(response.status(), 'real Auth registration').toBe(201)
  const user = await response.json()
  expect(user.username).toBe(username)
  expect(user.id).toMatch(UUID)
  return { id: user.id, username, password }
}

function atPath(url: string, origin: string, pathname: string): boolean {
  const target = new URL(url)
  return target.origin === origin && target.pathname === pathname
}

function waitForResponse(page: Page, method: string, pathname: string): Promise<Response> {
  const origin = new URL(page.url()).origin
  return page.waitForResponse((response) =>
    response.request().method() === method && atPath(response.url(), origin, pathname),
  )
}

export async function login(page: Page, account: Account, startPath = '/app/login'): Promise<string> {
  await page.goto(startPath)
  await expect(page).toHaveURL(/\/app\/login$/)
  await page.getByLabel('Логин', { exact: true }).fill(account.username)
  await page.getByLabel('Пароль', { exact: true }).fill(account.password)
  const [auth, profile] = await Promise.all([
    waitForResponse(page, 'POST', '/auth/login'),
    waitForResponse(page, 'GET', '/me'),
    page.getByRole('button', { name: 'Войти', exact: true }).click(),
  ])
  expect(auth.status(), 'real Auth login').toBe(200)
  expect(profile.status(), 'authenticated browser profile').toBe(200)
  expect(await profile.json()).toMatchObject({ id: account.id, username: account.username })
  await expect(page.getByRole('heading', { name: 'Чаты', exact: true })).toBeVisible()
  const { access_token: token } = await auth.json()
  expect(typeof token === 'string' && token !== '', 'login issued an access token').toBe(true)
  return token
}

export async function openPersonalChat(
  page: Page,
  owner: Account,
  peer: Account,
  expectedStatus: 200 | 201,
): Promise<string> {
  await page.getByRole('searchbox', { name: 'Поиск по логину' }).fill(peer.username)
  const [response] = await Promise.all([
    waitForResponse(page, 'POST', '/chats/personal'),
    page.getByRole('button', { name: `Написать ${peer.username}`, exact: true }).click(),
  ])
  expect(response.status(), 'real History personal chat').toBe(expectedStatus)
  const chat = await response.json()
  expect(chat.id).toMatch(UUID)
  expect(chat.type).toBe('personal')
  expect(chat.last_seq).toBe(0)
  expect(chat.members.map((member: { id: string }) => member.id).sort())
    .toEqual([owner.id, peer.id].sort())
  await expect(page).toHaveURL(new URL(`/app/chats/${chat.id}`, page.url()).href)
  await expect(thread(page, peer)).toBeVisible()
  return chat.id
}

export function thread(page: Page, peer: Account) {
  return page.getByRole('region', { name: `Чат с ${peer.username}`, exact: true })
}

export function messageRow(page: Page, peer: Account, body: string) {
  return thread(page, peer).getByRole('listitem').filter({ has: page.getByText(body, { exact: true }) })
}

export async function sendMessage(page: Page, peer: Account, body: string): Promise<void> {
  const chat = thread(page, peer)
  await chat.getByRole('textbox', { name: 'Сообщение', exact: true }).fill(body)
  await chat.getByRole('button', { name: 'Отправить', exact: true }).click()
}

export function parseFrame(raw: string | Buffer): Frame | undefined {
  if (typeof raw !== 'string') return
  try {
    const value = JSON.parse(raw)
    if (typeof value?.type === 'string' && typeof value?.id === 'string' &&
        typeof value.payload === 'object' && value.payload !== null) {
      return value
    }
  } catch {
    return undefined
  }
}

export function chatSocket(url: URL, baseURL: string): boolean {
  return url.host === new URL(baseURL).host && url.pathname === '/ws'
}

export function incomingFrames(page: Page, baseURL: string): Frame[] {
  const frames: Frame[] = []
  page.on('websocket', (socket) => {
    if (!chatSocket(new URL(socket.url()), baseURL)) return
    socket.on('framereceived', ({ payload }) => {
      const frame = parseFrame(payload)
      if (frame) frames.push(frame)
    })
  })
  return frames
}

export async function waitForFrame(
  frames: Frame[],
  matches: (frame: Frame) => boolean,
  description: string,
): Promise<Frame> {
  let matched: Frame | undefined
  await expect.poll(() => {
    matched = frames.find(matches)
    return matched !== undefined
  }, { message: description }).toBe(true)
  if (!matched) throw new Error(description)
  return matched
}

export async function history(
  request: APIRequestContext,
  chatId: string,
  token: string,
): Promise<Message[]> {
  const response = await request.get(`/chats/${chatId}/messages?after_seq=0&limit=100`, {
    headers: { Authorization: `Bearer ${token}` },
    maxRedirects: 0,
  })
  expect(response.status(), 'real History response').toBe(200)
  const payload = await response.json()
  expect(payload.has_more_after).toBe(false)
  return payload.messages
}

export async function reloadAndReadHistory(page: Page, chatId: string): Promise<Message[]> {
  const documentUrl = page.url()
  const origin = new URL(documentUrl).origin
  const requests = new Set<Request>()
  let navigationStarted = false
  function onRequest(request: Request) {
    if (request.isNavigationRequest() && request.url() === documentUrl) {
      navigationStarted = true
    }
    if (navigationStarted && request.method() === 'GET' &&
        atPath(request.url(), origin, `/chats/${chatId}/messages`)) {
      requests.add(request)
    }
  }
  page.on('request', onRequest)
  try {
    const [response] = await Promise.all([
      page.waitForResponse((candidate) => requests.has(candidate.request())),
      page.reload(),
    ])
    expect(response.status(), 'browser history after reload').toBe(200)
    const payload = await response.json()
    return payload.messages
  } finally {
    page.off('request', onRequest)
  }
}
