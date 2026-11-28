import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { describe, expect, it, vi } from 'vitest'
import { AppNav } from '@/components/AppNav'

describe('AppNav', () => {
  it('shows Важно, Чаты, Контакты, Профиль (Figma mobile bottom / desktop rail)', () => {
    render(
      <MemoryRouter initialEntries={['/contacts']}>
        <AppNav active="contacts" onLogout={vi.fn()} />
      </MemoryRouter>,
    )

    const nav = screen.getByRole('navigation', { name: 'Основная навигация' })
    expect(nav).toBeInTheDocument()
    expect(nav.className).toMatch(/h-\[60px]/)
    expect(nav.className).toMatch(/md:w-\[68px\]/)
    expect(nav.className).toMatch(/lg:w-12/)
    expect(screen.getByRole('link', { name: 'Важно' })).toHaveAttribute('href', '/later')
    expect(screen.getByRole('link', { name: 'Чаты' })).toHaveAttribute('href', '/')
    expect(screen.getByLabelText('Контакты')).toHaveAttribute('aria-current', 'page')
    expect(screen.getByRole('link', { name: 'Профиль' })).toHaveAttribute('href', '/profile')
  })

  it('marks Важно current and keeps logout for md+ rail only', () => {
    const onLogout = vi.fn()
    render(
      <MemoryRouter initialEntries={['/later']}>
        <AppNav active="later" onLogout={onLogout} />
      </MemoryRouter>,
    )

    expect(screen.getByLabelText('Важно')).toHaveAttribute('aria-current', 'page')
    const logout = screen.getByRole('button', { name: 'Выйти' })
    expect(logout.className).toMatch(/hidden/)
    expect(logout.className).toMatch(/md:inline-flex/)
  })
})
