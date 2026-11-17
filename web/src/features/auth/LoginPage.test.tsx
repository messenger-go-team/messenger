import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router'
import { describe, expect, it } from 'vitest'
import { AuthProvider } from '@/features/auth/AuthProvider'
import { LoginPage } from '@/features/auth/LoginPage'

function renderLogin() {
  return render(
    <AuthProvider>
      <MemoryRouter initialEntries={['/login']}>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/" element={<h1>Домашняя</h1>} />
          <Route path="/register" element={<h1>Регистрация</h1>} />
        </Routes>
      </MemoryRouter>
    </AuthProvider>,
  )
}

describe('LoginPage', () => {
  it('shows client validation for invalid username', async () => {
    const user = userEvent.setup()
    renderLogin()

    await screen.findByRole('heading', { name: 'Вход' })

    await user.type(screen.getByLabelText('Логин'), 'ab')
    await user.type(screen.getByLabelText('Пароль'), 'correct-horse-battery')
    await user.click(screen.getByRole('button', { name: 'Войти' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(/3–32/)
  })

  it('logs in with mock credentials and redirects home', async () => {
    const user = userEvent.setup()
    renderLogin()

    await screen.findByRole('heading', { name: 'Вход' })

    await user.type(screen.getByLabelText('Логин'), 'alice_1')
    await user.type(screen.getByLabelText('Пароль'), 'correct-horse-battery')
    await user.click(screen.getByRole('button', { name: 'Войти' }))

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Домашняя' })).toBeInTheDocument()
    })
  })

  it('shows API error for wrong password', async () => {
    const user = userEvent.setup()
    renderLogin()

    await screen.findByRole('heading', { name: 'Вход' })

    await user.type(screen.getByLabelText('Логин'), 'alice_1')
    await user.type(screen.getByLabelText('Пароль'), 'wrong-password')
    await user.click(screen.getByRole('button', { name: 'Войти' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(/логин или пароль/i)
  })
})
