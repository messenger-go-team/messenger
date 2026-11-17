import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router'
import { describe, expect, it } from 'vitest'
import { AuthProvider } from '@/features/auth/AuthProvider'
import { RegisterPage } from '@/features/auth/RegisterPage'

function renderRegister() {
  return render(
    <AuthProvider>
      <MemoryRouter initialEntries={['/register']}>
        <Routes>
          <Route path="/register" element={<RegisterPage />} />
          <Route path="/" element={<h1>Домашняя</h1>} />
        </Routes>
      </MemoryRouter>
    </AuthProvider>,
  )
}

describe('RegisterPage', () => {
  it('registers a new user on mocks and redirects home', async () => {
    const user = userEvent.setup()
    renderRegister()

    await screen.findByRole('heading', { name: 'Регистрация' })

    await user.type(screen.getByLabelText('Логин'), 'carol_3')
    await user.type(screen.getByLabelText('Пароль'), 'correct-horse-battery')
    await user.type(screen.getByLabelText('Повтор пароля'), 'correct-horse-battery')
    await user.click(screen.getByRole('button', { name: 'Зарегистрироваться' }))

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Домашняя' })).toBeInTheDocument()
    })
  })

  it('shows conflict when username is taken', async () => {
    const user = userEvent.setup()
    renderRegister()

    await screen.findByRole('heading', { name: 'Регистрация' })

    await user.type(screen.getByLabelText('Логин'), 'alice_1')
    await user.type(screen.getByLabelText('Пароль'), 'correct-horse-battery')
    await user.type(screen.getByLabelText('Повтор пароля'), 'correct-horse-battery')
    await user.click(screen.getByRole('button', { name: 'Зарегистрироваться' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(/Логин уже занят/)
  })
})
