import { describe, expect, it } from 'vitest'
import { cn } from './utils'

// Проверяется совместная семантика clsx и tailwind-merge, на которую опираются UI-компоненты.
describe('cn', () => {
  it('merges conditional classes', () => {
    expect(cn('flex', { hidden: false, 'items-center': true })).toBe('flex items-center')
  })

  it('resolves conflicting Tailwind classes', () => {
    expect(cn('px-4 bg-blue-500', 'px-8 bg-red-500')).toBe('px-8 bg-red-500')
  })

  it('preserves non-conflicting classes', () => {
    expect(cn('px-4', 'py-2')).toBe('px-4 py-2')
  })
})
