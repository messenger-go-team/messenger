import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router'
import { describe, expect, it, vi } from 'vitest'
import { ChangePasswordPage } from '@/features/auth/ChangePasswordPage'

vi.mock('@/features/auth/useAuth', () => ({
  useAuth: () => ({
    user: {
      id: '00000000-0000-4000-8000-000000000001',
      username: 'alice_1',
      created_at: '2026-01-01T00:00:00Z',
    },
  }),
}))

describe('ChangePasswordPage', () => {
  it('shows a notice after a valid password form', async () => {
    const user = userEvent.setup()
    render(
      <MemoryRouter>
        <Routes>
          <Route path="/" element={<ChangePasswordPage />} />
        </Routes>
      </MemoryRouter>,
    )

    await user.type(screen.getByLabelText('Пароль'), 'correct-horse-battery')
    await user.type(screen.getByLabelText('Повторите пароль'), 'correct-horse-battery')
    await user.click(screen.getByRole('button', { name: 'Сменить пароль' }))

    expect(await screen.findByRole('status')).toHaveTextContent(/пока недоступна/i)
  })
})
