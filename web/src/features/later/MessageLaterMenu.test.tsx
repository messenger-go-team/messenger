import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { login } from '@/api/auth'
import { listLater } from '@/api/later'
import { MessageLaterMenu } from '@/features/later/MessageLaterMenu'
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
})
