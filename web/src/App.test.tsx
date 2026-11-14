import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { describe, expect, it } from 'vitest'
import App from './App'

// Router smoke tests фиксируют основной маршрут и wildcard fallback без browser history.
describe('App', () => {
  it('renders the application', () => {
    render(
      <MemoryRouter initialEntries={['/']}>
        <App />
      </MemoryRouter>,
    )

    expect(screen.getByRole('heading', { name: 'Messenger' })).toBeInTheDocument()
  })

  it('renders not found page for unknown routes', () => {
    render(
      <MemoryRouter initialEntries={['/unknown']}>
        <App />
      </MemoryRouter>,
    )

    expect(
      screen.getByRole('heading', {
        name: '404 — Страница не найдена',
      }),
    ).toBeInTheDocument()
  })
})
