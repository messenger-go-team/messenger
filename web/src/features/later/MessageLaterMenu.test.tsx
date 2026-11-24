import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'
import { login } from '@/api/auth'
import { listLater } from '@/api/later'
import { MessageLaterMenu } from '@/features/later/MessageLaterMenu'
import { server } from '../../../mocks/server'
import { INITIAL_CHAT_ID } from '../../../mocks/data/history'

describe('MessageLaterMenu', () => {
  it('saves without due_at as null and lists the entry', async () => {
    const session = await login({ username: 'alice_1', password: 'correct-horse-battery' })
    render(
      <MessageLaterMenu
        accessToken={session.access_token}
        chatId={INITIAL_CHAT_ID}
        messageId="20000000-0000-4000-8000-000000000002"
      />,
    )
    await userEvent.click(screen.getByRole('button', { name: 'Действия с сообщением' }))
    await userEvent.click(screen.getByRole('menuitem', { name: 'Просто сохранить' }))
    expect(await screen.findByRole('status')).toHaveTextContent(/Сохранено без срока/i)
    const list = await listLater(session.access_token)
    expect(list.entries).toHaveLength(1)
    expect(list.entries[0]?.due_at).toBeNull()
    expect(list.entries[0]?.status).toBe('unscheduled')
  })

  it('opens custom time picker from Выбрать время', async () => {
    const session = await login({ username: 'alice_1', password: 'correct-horse-battery' })
    render(
      <MessageLaterMenu
        accessToken={session.access_token}
        chatId={INITIAL_CHAT_ID}
        messageId="20000000-0000-4000-8000-000000000003"
      />,
    )
    await userEvent.click(screen.getByRole('button', { name: 'Действия с сообщением' }))
    await userEvent.click(screen.getByRole('menuitem', { name: 'Выбрать время' }))
    expect(screen.getByText('Напомнить')).toBeInTheDocument()
    expect(screen.getByLabelText('Дата')).toBeInTheDocument()
    expect(screen.getByLabelText('Время')).toBeInTheDocument()
  })

  it('keeps the trigger visible for touch and portals the menu', async () => {
    const session = await login({ username: 'alice_1', password: 'correct-horse-battery' })
    const { container } = render(
      <div style={{ overflow: 'hidden', height: 40 }}>
        <MessageLaterMenu
          accessToken={session.access_token}
          chatId={INITIAL_CHAT_ID}
          messageId="20000000-0000-4000-8000-000000000004"
        />
      </div>,
    )
    const trigger = screen.getByRole('button', { name: 'Действия с сообщением' })
    expect(trigger.parentElement?.className).toContain('opacity-100')
    await userEvent.click(trigger)
    const menu = await screen.findByRole('menu', { name: 'Вернуться позже' })
    expect(menu).toBeInTheDocument()
    expect(container.contains(menu)).toBe(false)
    expect(document.body.contains(menu)).toBe(true)
    expect(menu.parentElement).toHaveAttribute('data-placement')
  })

  it('moves focus into the menu and closes the previous panel', async () => {
    const session = await login({ username: 'alice_1', password: 'correct-horse-battery' })
    const user = userEvent.setup()
    render(
      <>
        <MessageLaterMenu
          accessToken={session.access_token}
          chatId={INITIAL_CHAT_ID}
          messageId="20000000-0000-4000-8000-000000000005"
        />
        <MessageLaterMenu
          accessToken={session.access_token}
          chatId={INITIAL_CHAT_ID}
          messageId="20000000-0000-4000-8000-000000000006"
        />
      </>,
    )
    const [first, second] = screen.getAllByRole('button', { name: 'Действия с сообщением' })
    first?.focus()
    await user.keyboard('{Enter}')
    expect(screen.getByRole('menuitem', { name: 'Просто сохранить' })).toHaveFocus()
    await user.keyboard('{ArrowDown}')
    expect(screen.getByRole('menuitem', { name: 'Через 1 час' })).toHaveFocus()
    await user.click(second!)
    expect(screen.getAllByRole('menu', { name: 'Вернуться позже' })).toHaveLength(1)
    await user.keyboard('{Escape}')
    expect(second).toHaveFocus()
    expect(screen.queryByRole('menu', { name: 'Вернуться позже' })).not.toBeInTheDocument()
  })

  it('shows a save error inside the open menu', async () => {
    server.use(
      http.post('/later', () =>
        HttpResponse.json({ code: 'unavailable', message: 'down' }, { status: 503 }),
      ),
    )
    const session = await login({ username: 'alice_1', password: 'correct-horse-battery' })
    render(
      <MessageLaterMenu
        accessToken={session.access_token}
        chatId={INITIAL_CHAT_ID}
        messageId="20000000-0000-4000-8000-000000000002"
      />,
    )
    await userEvent.click(screen.getByRole('button', { name: 'Действия с сообщением' }))
    const menu = screen.getByRole('menu', { name: 'Вернуться позже' })
    await userEvent.click(screen.getByRole('menuitem', { name: 'Просто сохранить' }))
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(/Не удалось сохранить/i)
    expect(menu.contains(alert)).toBe(true)
  })
})
