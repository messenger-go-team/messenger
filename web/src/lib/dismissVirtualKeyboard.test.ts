import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  dismissVirtualKeyboard,
  installKeyboardShellSync,
  syncShellToVisualViewport,
} from './dismissVirtualKeyboard'

describe('dismissVirtualKeyboard', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
    document.documentElement.style.removeProperty('--app-height')
    document.getElementById('root')?.remove()
  })

  it('sets --app-height from visual viewport', () => {
    Object.defineProperty(window, 'visualViewport', {
      configurable: true,
      value: { height: 500, offsetTop: 0, addEventListener: vi.fn(), removeEventListener: vi.fn() },
    })

    syncShellToVisualViewport()

    expect(document.documentElement.style.getPropertyValue('--app-height')).toBe('500px')
  })

  it('translates #root by visualViewport.offsetTop while keyboard pans the page', () => {
    const root = document.createElement('div')
    root.id = 'root'
    document.body.appendChild(root)
    Object.defineProperty(window, 'visualViewport', {
      configurable: true,
      value: {
        height: 420,
        offsetTop: 120,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      },
    })

    syncShellToVisualViewport()

    expect(root.style.transform).toBe('translateY(120px)')
    expect(document.documentElement.style.getPropertyValue('--app-height')).toBe('420px')
  })

  it('blurs the active field on dismiss', () => {
    const input = document.createElement('input')
    document.body.appendChild(input)
    input.focus()
    vi.spyOn(window, 'scrollTo').mockImplementation(() => {})

    dismissVirtualKeyboard()

    expect(document.activeElement).not.toBe(input)
    input.remove()
  })

  it('installKeyboardShellSync updates height on focusout after keyboard hide', () => {
    vi.useFakeTimers()
    Object.defineProperty(window, 'visualViewport', {
      configurable: true,
      value: {
        height: 640,
        offsetTop: 0,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      },
    })
    const stop = installKeyboardShellSync()
    expect(document.documentElement.style.getPropertyValue('--app-height')).toBe('640px')

    Object.defineProperty(window, 'visualViewport', {
      configurable: true,
      value: {
        height: 640,
        offsetTop: 0,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      },
    })
    document.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
    vi.advanceTimersByTime(350)
    expect(document.documentElement.style.getPropertyValue('--app-height')).toBe('640px')

    stop()
  })
})
