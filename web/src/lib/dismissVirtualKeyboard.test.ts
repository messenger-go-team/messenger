import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  dismissVirtualKeyboard,
  dismissVirtualKeyboardAfterSend,
  installKeyboardShellSync,
  syncShellToVisualViewport,
} from './dismissVirtualKeyboard'

describe('dismissVirtualKeyboard', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
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

  it.each([
    { height: 667, scale: 1, keepsFocus: true },
    { height: 390, scale: 1, keepsFocus: false },
    { height: 390, scale: 2, keepsFocus: true },
  ])(
    'handles Enter with viewport height $height and scale $scale',
    ({ height, scale, keepsFocus }) => {
      vi.stubGlobal('innerHeight', 667)
      vi.stubGlobal('visualViewport', { height, scale, offsetTop: 0 })
      // A touchscreen with no on-screen keyboard must still accept repeated keyboard sends.
      vi.stubGlobal('matchMedia', () => ({ matches: false }))
      const input = document.createElement('input')
      document.body.appendChild(input)
      input.focus()
      vi.spyOn(window, 'scrollTo').mockImplementation(() => {})

      dismissVirtualKeyboardAfterSend()

      expect(document.activeElement === input).toBe(keepsFocus)
      input.remove()
    },
  )

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
