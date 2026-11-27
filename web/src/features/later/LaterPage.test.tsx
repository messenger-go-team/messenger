import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { MemoryRouter, Route, Routes } from 'react-router'
import { describe, expect, it } from 'vitest'
import type { User } from '@/api/auth'
import { login } from '@/api/auth'
import { AuthContext, type AuthContextValue } from '@/features/auth/auth-context'
import { LaterPage } from '@/features/later/LaterPage'
import { LaterRemindersProvider } from '@/features/later/LaterRemindersProvider'
import { expectScrollChainWithinViewport } from '@/test/scrollChain'
import { expectMainTabs } from '@/test/mainTabs'
import { server } from '../../../mocks/server'
import { seedLaterMocks } from '../../../mocks/handlers/later'

const ALICE: User = {
  id: '00000000-0000-4000-8000-000000000001',
  username: 'alice_1',
  created_at: '2026-01-01T00:00:00Z',
}

const MESSAGE = {
  id: '20000000-0000-4000-8000-000000000001',
  chat_id: '10000000-0000-4000-8000-000000000001',
  seq: 1,
  sender_id: ALICE.id,
  body: 'Не забыть ответить',
  created_at: '2026-11-14T15:00:00Z',
}

async function authValue(): Promise<AuthContextValue> {
  const session = await login({ username: 'alice_1', password: 'correct-horse-battery' })
  return {
    user: ALICE,
    accessToken: session.access_token,
    isReady: true,
    isAuthenticated: true,
    logoutError: null,
    login: async () => undefined,
    register: async () => undefined,
    logout: async () => undefined,
  }
}

function laterView(auth: AuthContextValue) {
  return (
    <AuthContext.Provider value={auth}>
      <MemoryRouter initialEntries={['/later']}>
        <LaterRemindersProvider>
          <Routes>
            <Route path="/later" element={<LaterPage />} />
          </Routes>
        </LaterRemindersProvider>
      </MemoryRouter>
    </AuthContext.Provider>
  )
}

/** Просроченная запись показывает toast; тесты списка сначала скрывают его кнопкой «Позже». */
async function dismissReminderToast() {
  const toast = await screen.findByRole('region', { name: 'Напоминание' })
  await userEvent.click(within(toast).getByRole('button', { name: 'Позже' }))
}

function renderLater(auth: AuthContextValue) {
  return render(laterView(auth))
}

describe('LaterPage', () => {
  it('shows empty Important state', async () => {
    seedLaterMocks([])
    const auth = await authValue()
    renderLater(auth)
    expect(await screen.findByText('Пока пусто')).toBeInTheDocument()
  })

  it('shows all main tabs with Важно current', async () => {
    seedLaterMocks([])
    const auth = await authValue()
    renderLater(auth)
    await screen.findByRole('heading', { name: 'Важно' })
    expectMainTabs('Важно')
  })

  it('keeps the Important list scrollable inside the viewport on mobile (min-h-0 chain)', async () => {
    seedLaterMocks([])
    const auth = await authValue()
    renderLater(auth)

    const pane = (await screen.findByRole('heading', { name: 'Важно' })).closest('section')!
    expectScrollChainWithinViewport(pane.querySelector('.overflow-y-auto')!)
  })

  it('lifts the reminder toast above the mobile tab bar and keeps md+ position', async () => {
    seedLaterMocks([
      {
        id: '98fcaed4-d453-4cba-b561-4100fe7aa314',
        message: MESSAGE,
        due_at: '2020-01-01T00:00:00.000Z',
        created_at: '2026-11-14T15:00:00Z',
        updated_at: '2026-11-14T15:00:00Z',
      },
    ])
    const auth = await authValue()
    renderLater(auth)

    const toast = (await screen.findByRole('region', { name: 'Напоминание' })).parentElement!
    const toastClasses = toast.className.split(/\s+/)
    const navClasses = screen
      .getByRole('navigation', { name: 'Основная навигация' })
      .className.split(/\s+/)

    // Отступ toast на mobile = высота нижнего tab bar (без префикса брейкпоинта) + safe-area.
    const barHeight = navClasses.find((name) => /^h-\[\d+px\]$/.test(name))?.match(/\d+/)?.[0]
    expect(barHeight).toBeDefined()
    expect(toastClasses).toContain(`bottom-[calc(${barHeight}px+env(safe-area-inset-bottom,0px))]`)
    expect(toastClasses).not.toContain('bottom-0')
    // С md навигация в боковом rail: toast остаётся карточкой справа внизу.
    expect(toastClasses).toEqual(
      expect.arrayContaining(['md:bottom-4', 'md:right-4', 'md:inset-x-auto', 'md:w-96']),
    )
  })

  it('uses the shared reminders provider: one GET /later for provider and page', async () => {
    seedLaterMocks([])
    let requests = 0
    server.use(
      http.get('/later', () => {
        requests += 1
        return HttpResponse.json({ server_time: '2026-11-24T12:00:00Z', entries: [] })
      }),
    )
    renderLater(await authValue())
    expect(await screen.findByText('Пока пусто')).toBeInTheDocument()
    expect(requests).toBe(1)
  })

  it('groups entries into three sections', async () => {
    seedLaterMocks([
      {
        id: '98fcaed4-d453-4cba-b561-4100fe7aa314',
        message: MESSAGE,
        due_at: '2020-01-01T00:00:00.000Z',
        created_at: '2026-11-14T15:00:00Z',
        updated_at: '2026-11-14T15:00:00Z',
      },
      {
        id: 'a2e461f6-e1d8-44ec-b633-4debfda53b9f',
        message: { ...MESSAGE, id: '20000000-0000-4000-8000-000000000002', body: 'Через год' },
        due_at: '2099-01-01T00:00:00.000Z',
        created_at: '2026-11-14T15:01:00Z',
        updated_at: '2026-11-14T15:01:00Z',
      },
      {
        id: 'b5ab7aaa-6a79-4e1a-a2db-0582d215fc4b',
        message: {
          ...MESSAGE,
          id: '20000000-0000-4000-8000-000000000003',
          body: 'Сохранить на потом',
        },
        due_at: null,
        created_at: '2026-11-14T15:02:00Z',
        updated_at: '2026-11-14T15:02:00Z',
      },
    ])
    const auth = await authValue()
    renderLater(auth)
    expect(await screen.findByRole('heading', { name: 'Сейчас' })).toBeInTheDocument()
    await dismissReminderToast()
    expect(screen.getByRole('heading', { name: 'Запланировано' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Без срока' })).toBeInTheDocument()
    expect(screen.getByText('Не забыть ответить')).toBeInTheDocument()
    expect(screen.getByText('Через год')).toBeInTheDocument()
    expect(screen.getByText('Сохранить на потом')).toBeInTheDocument()
  })

  it('removes entry after Готово confirmation', async () => {
    seedLaterMocks([
      {
        id: '98fcaed4-d453-4cba-b561-4100fe7aa314',
        message: MESSAGE,
        due_at: null,
        created_at: '2026-11-14T15:00:00Z',
        updated_at: '2026-11-14T15:00:00Z',
      },
    ])
    const auth = await authValue()
    renderLater(auth)
    expect(await screen.findByText('Не забыть ответить')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Готово' }))
    const dialog = await screen.findByRole('alertdialog')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Готово' }))
    expect(await screen.findByText('Пока пусто')).toBeInTheDocument()
  })

  it('drops the entry and says the message is unavailable when Готово returns 404', async () => {
    seedLaterMocks([
      {
        id: '98fcaed4-d453-4cba-b561-4100fe7aa314',
        message: MESSAGE,
        due_at: null,
        created_at: '2026-11-14T15:00:00Z',
        updated_at: '2026-11-14T15:00:00Z',
      },
    ])
    server.use(
      http.post('/later/:laterId/done', () =>
        HttpResponse.json({ code: 'not_found', message: 'Сообщение недоступно.' }, { status: 404 }),
      ),
    )
    renderLater(await authValue())
    expect(await screen.findByText('Не забыть ответить')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Готово' }))
    const dialog = await screen.findByRole('alertdialog')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Готово' }))
    expect(await screen.findByText('Сообщение недоступно')).toBeInTheDocument()
    expect(screen.queryByText('Не забыть ответить')).not.toBeInTheDocument()
  })

  it('drops the entry and says the message is unavailable when reschedule returns 404', async () => {
    seedLaterMocks([
      {
        id: '98fcaed4-d453-4cba-b561-4100fe7aa314',
        message: MESSAGE,
        due_at: null,
        created_at: '2026-11-14T15:00:00Z',
        updated_at: '2026-11-14T15:00:00Z',
      },
    ])
    server.use(
      http.patch('/later/:laterId', () =>
        HttpResponse.json({ code: 'not_found', message: 'Сообщение недоступно.' }, { status: 404 }),
      ),
    )
    renderLater(await authValue())
    expect(await screen.findByText('Не забыть ответить')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Перенести' }))
    const panel = screen.getByLabelText('Перенести срок')
    await userEvent.click(within(panel).getByRole('button', { name: 'Без срока' }))
    expect(await screen.findByText('Сообщение недоступно')).toBeInTheDocument()
    expect(screen.queryByText('Не забыть ответить')).not.toBeInTheDocument()
  })

  it('reschedules entry due_at from the list', async () => {
    seedLaterMocks([
      {
        id: '98fcaed4-d453-4cba-b561-4100fe7aa314',
        message: MESSAGE,
        due_at: null,
        created_at: '2026-11-14T15:00:00Z',
        updated_at: '2026-11-14T15:00:00Z',
      },
    ])
    const auth = await authValue()
    renderLater(auth)
    expect(await screen.findByRole('heading', { name: 'Без срока' })).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Перенести' }))
    const panel = screen.getByLabelText('Перенести срок')
    await userEvent.clear(within(panel).getByLabelText('Дата'))
    await userEvent.type(within(panel).getByLabelText('Дата'), '2099-01-02')
    await userEvent.clear(within(panel).getByLabelText('Время'))
    await userEvent.type(within(panel).getByLabelText('Время'), '10:30')
    await userEvent.click(within(panel).getByRole('button', { name: 'Сохранить срок' }))
    expect(await screen.findByRole('heading', { name: 'Запланировано' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Без срока' })).not.toBeInTheDocument()
  })

  it('orders equal RFC3339 instants by created_at and id, not by fraction digits', async () => {
    seedLaterMocks([
      {
        id: 'b0000000-0000-4000-8000-000000000004',
        message: { ...MESSAGE, id: '20000000-0000-4000-8000-000000000014', body: 'Больший id' },
        due_at: '2099-03-01T10:00:00.100Z',
        created_at: '2026-06-01T00:00:00.2Z',
        updated_at: '2026-06-01T00:00:00.2Z',
      },
      {
        id: 'a0000000-0000-4000-8000-000000000003',
        message: { ...MESSAGE, id: '20000000-0000-4000-8000-000000000013', body: 'Меньший id' },
        due_at: '2099-03-01T10:00:00.1Z',
        created_at: '2026-06-01T00:00:00.20Z',
        updated_at: '2026-06-01T00:00:00.20Z',
      },
      {
        id: 'c0000000-0000-4000-8000-000000000002',
        message: { ...MESSAGE, id: '20000000-0000-4000-8000-000000000012', body: 'Раньше создана' },
        due_at: '2099-03-01T10:00:00.100Z',
        created_at: '2026-06-01T00:00:00.1Z',
        updated_at: '2026-06-01T00:00:00.1Z',
      },
      {
        id: 'd0000000-0000-4000-8000-000000000001',
        message: { ...MESSAGE, id: '20000000-0000-4000-8000-000000000011', body: 'Целая секунда' },
        due_at: '2099-03-01T10:00:00Z',
        created_at: '2026-06-01T00:00:00Z',
        updated_at: '2026-06-01T00:00:00Z',
      },
    ])
    const auth = await authValue()
    renderLater(auth)
    const whole = await screen.findByText('Целая секунда')
    const earlier = screen.getByText('Раньше создана')
    const smallerId = screen.getByText('Меньший id')
    const largerId = screen.getByText('Больший id')
    expect(whole.compareDocumentPosition(earlier) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(
      earlier.compareDocumentPosition(smallerId) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
    expect(
      smallerId.compareDocumentPosition(largerId) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
  })

  it.each(['scheduled', 'unscheduled'] as const)(
    'orders %s entries that differ only below a millisecond',
    async (status) => {
      const scheduled = status === 'scheduled'
      const earlier = {
        id: 'f0000000-0000-4000-8000-000000000005',
        message: { ...MESSAGE, body: 'Раньше' },
        due_at: scheduled ? '2099-03-01T10:00:00.000100Z' : null,
        created_at: scheduled ? '2026-06-01T00:00:01Z' : '2026-06-01T00:00:00.000100Z',
        updated_at: '2026-06-01T00:00:01Z',
        status,
      }
      const later = {
        ...earlier,
        id: 'a0000000-0000-4000-8000-000000000004',
        message: { ...MESSAGE, body: 'Позже' },
        due_at: scheduled ? '2099-03-01T10:00:00.000900Z' : null,
        created_at: scheduled ? '2026-06-01T00:00:00Z' : '2026-06-01T00:00:00.000900Z',
      }
      server.use(
        http.get('/later', () =>
          HttpResponse.json({
            server_time: '2026-06-01T00:00:02Z',
            entries: [earlier, later],
          }),
        ),
      )
      renderLater(await authValue())
      expect((await screen.findAllByRole('listitem')).map((item) => item.textContent)).toEqual([
        expect.stringContaining('Раньше'),
        expect.stringContaining('Позже'),
      ])
    },
  )

  it('collapses one Important group and leaves the others open', async () => {
    seedLaterMocks([
      {
        id: '98fcaed4-d453-4cba-b561-4100fe7aa314',
        message: MESSAGE,
        due_at: '2020-01-01T00:00:00.000Z',
        created_at: '2026-11-14T15:00:00Z',
        updated_at: '2026-11-14T15:00:00Z',
      },
      {
        id: 'a2e461f6-e1d8-44ec-b633-4debfda53b9f',
        message: { ...MESSAGE, id: '20000000-0000-4000-8000-000000000002', body: 'Через год' },
        due_at: '2099-01-01T00:00:00.000Z',
        created_at: '2026-11-14T15:01:00Z',
        updated_at: '2026-11-14T15:01:00Z',
      },
    ])
    const auth = await authValue()
    renderLater(auth)
    await dismissReminderToast()
    expect(await screen.findByText('Не забыть ответить')).toBeInTheDocument()
    const scheduled = screen.getByRole('button', { name: 'Запланировано' })
    expect(scheduled).toHaveAttribute('aria-expanded', 'true')
    await userEvent.click(scheduled)
    expect(scheduled).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText('Через год')).not.toBeInTheDocument()
    expect(screen.getByText('Не забыть ответить')).toBeInTheDocument()
    await userEvent.click(scheduled)
    expect(screen.getByText('Через год')).toBeInTheDocument()
  })

  it('reorders scheduled entries by due_at after reschedule', async () => {
    seedLaterMocks([
      {
        id: '98fcaed4-d453-4cba-b561-4100fe7aa314',
        message: { ...MESSAGE, body: 'Десятое февраля' },
        due_at: '2099-02-10T10:00:00.000Z',
        created_at: '2026-11-14T15:00:00Z',
        updated_at: '2026-11-14T15:00:00Z',
      },
      {
        id: 'a2e461f6-e1d8-44ec-b633-4debfda53b9f',
        message: {
          ...MESSAGE,
          id: '20000000-0000-4000-8000-000000000002',
          body: 'Пятнадцатое февраля',
        },
        due_at: '2099-02-15T10:00:00.000Z',
        created_at: '2026-11-14T15:01:00Z',
        updated_at: '2026-11-14T15:01:00Z',
      },
    ])
    const auth = await authValue()
    renderLater(auth)
    expect(await screen.findByText('Десятое февраля')).toBeInTheDocument()
    const moveButtons = screen.getAllByRole('button', { name: 'Перенести' })
    await userEvent.click(moveButtons[1]!)
    const panel = screen.getByLabelText('Перенести срок')
    await userEvent.clear(within(panel).getByLabelText('Дата'))
    await userEvent.type(within(panel).getByLabelText('Дата'), '2099-02-05')
    await userEvent.click(within(panel).getByRole('button', { name: 'Сохранить срок' }))
    await screen.findByText('Пятнадцатое февраля')
    const first = screen.getByText('Пятнадцатое февраля')
    const second = screen.getByText('Десятое февраля')
    expect(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('clears a complete error after a successful retry', async () => {
    seedLaterMocks([
      {
        id: '98fcaed4-d453-4cba-b561-4100fe7aa314',
        message: MESSAGE,
        due_at: null,
        created_at: '2026-11-14T15:00:00Z',
        updated_at: '2026-11-14T15:00:00Z',
      },
    ])
    let calls = 0
    server.use(
      http.post('/later/:laterId/done', () => {
        calls += 1
        if (calls === 1) {
          return HttpResponse.json({ code: 'unavailable', message: 'down' }, { status: 503 })
        }
        return new HttpResponse(null, { status: 204 })
      }),
    )
    const auth = await authValue()
    renderLater(auth)
    expect(await screen.findByText('Не забыть ответить')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Готово' }))
    await userEvent.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Готово' }),
    )
    expect(await screen.findByRole('alert')).toHaveTextContent(/Не удалось отметить готовым/i)
    await userEvent.click(screen.getByRole('button', { name: 'Готово' }))
    await userEvent.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Готово' }),
    )
    expect(await screen.findByText('Пока пусто')).toBeInTheDocument()
    expect(screen.queryByText(/Не удалось отметить готовым/i)).not.toBeInTheDocument()
  })

  it('shows error and retry', async () => {
    server.use(
      http.get('/later', () =>
        HttpResponse.json({ code: 'unavailable', message: 'down' }, { status: 503 }),
      ),
    )
    const auth = await authValue()
    renderLater(auth)
    expect(await screen.findByRole('alert')).toHaveTextContent(/Не удалось загрузить/i)
    expect(screen.getByRole('button', { name: 'Повторить' })).toBeInTheDocument()
  })

  it('clears list when session ends', async () => {
    seedLaterMocks([
      {
        id: '98fcaed4-d453-4cba-b561-4100fe7aa314',
        message: MESSAGE,
        due_at: null,
        created_at: '2026-11-14T15:00:00Z',
        updated_at: '2026-11-14T15:00:00Z',
      },
    ])
    const auth = await authValue()
    const { rerender } = renderLater(auth)
    expect(await screen.findByText('Не забыть ответить')).toBeInTheDocument()
    rerender(
      <AuthContext.Provider
        value={{
          ...auth,
          accessToken: null,
          isAuthenticated: false,
          user: null,
        }}
      >
        <MemoryRouter initialEntries={['/later']}>
          <LaterRemindersProvider>
            <Routes>
              <Route path="/later" element={<LaterPage />} />
            </Routes>
          </LaterRemindersProvider>
        </MemoryRouter>
      </AuthContext.Provider>,
    )
    expect(await screen.findByText('Пока пусто')).toBeInTheDocument()
  })

  it('clears the old account immediately while the new list is loading', async () => {
    seedLaterMocks([
      {
        id: '98fcaed4-d453-4cba-b561-4100fe7aa314',
        message: MESSAGE,
        due_at: null,
        created_at: '2026-11-14T15:00:00Z',
        updated_at: '2026-11-14T15:00:00Z',
      },
    ])
    const auth = await authValue()
    const { rerender } = renderLater(auth)
    expect(await screen.findByText(MESSAGE.body)).toBeVisible()

    const bob = await login({ username: 'bob_2', password: 'correct-horse-battery' })
    rerender(
      laterView({
        ...auth,
        accessToken: bob.access_token,
        user: { ...ALICE, id: '00000000-0000-4000-8000-000000000002', username: 'bob_2' },
      }),
    )
    expect(screen.queryByText(MESSAGE.body)).not.toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('Загрузка')
    expect(await screen.findByText('Пока пусто')).toBeVisible()
  })
})
