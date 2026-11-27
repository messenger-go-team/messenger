import { screen, within } from '@testing-library/react'
import { expect } from 'vitest'

const MAIN_TABS = ['Важно', 'Чаты', 'Контакты'] as const

/**
 * На каждой странице с навигацией все три основные вкладки на месте и в одном порядке,
 * текущая отмечена aria-current="page" (на staging с контактов пропадала «Важно»).
 * `null` — текущая страница не из трёх вкладок (профиль).
 */
export function expectMainTabs(active: (typeof MAIN_TABS)[number] | null): void {
  const nav = screen.getByRole('navigation', { name: 'Основная навигация' })
  const tabs = within(nav)
    .getAllByLabelText(/^(Важно|Чаты|Контакты)$/)
    .map((element) => element.getAttribute('aria-label'))
  expect(tabs).toEqual([...MAIN_TABS])

  for (const label of MAIN_TABS) {
    const tab = within(nav).getByLabelText(label)
    if (label === active) {
      expect(tab).toHaveAttribute('aria-current', 'page')
    } else {
      expect(tab).not.toHaveAttribute('aria-current')
      expect(tab.tagName).toBe('A')
    }
  }
}
