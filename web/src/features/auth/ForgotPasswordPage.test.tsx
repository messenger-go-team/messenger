import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router'
import { describe, expect, it } from 'vitest'
import { AuthProvider } from '@/features/auth/AuthProvider'
import { ForgotPasswordPage } from '@/features/auth/ForgotPasswordPage'

function renderForgot() {
  return render(
    <AuthProvider>
      <MemoryRouter initialEntries={['/forgot-password']}>
        <Routes>
          <Route path="/forgot-password" element={<ForgotPasswordPage />} />
          <Route path="/login" element={<h1>Вход</h1>} />
        </Routes>
      </MemoryRouter>
    </AuthProvider>,
  )
}

describe('ForgotPasswordPage', () => {
  it('validates email and shows a recovery notice without calling an API', async () => {
    const user = userEvent.setup()
    renderForgot()

    await screen.findByRole('heading', { name: 'Забыли пароль?' })
    await user.click(screen.getByRole('button', { name: 'Восстановить аккаунт' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/email/i)

    await user.type(screen.getByLabelText('Email'), 'alice@example.com')
    await user.click(screen.getByRole('button', { name: 'Восстановить аккаунт' }))
    expect(await screen.findByRole('status')).toHaveTextContent(/инструкции/i)
  })
})
