const APP_HEIGHT_VAR = '--app-height'

/**
 * Высота оболочки = visualViewport (клавиатура открыта → меньше, закрыта → полный экран).
 * Композер в flex-колонке едет вместе с низом #root.
 */
export function syncShellToVisualViewport(): void {
  const vv = window.visualViewport
  const height = Math.round(vv?.height ?? window.innerHeight)
  const offsetTop = Math.round(vv?.offsetTop ?? 0)

  document.documentElement.style.setProperty(APP_HEIGHT_VAR, `${height}px`)

  const root = document.getElementById('root')
  if (root) {
    // iOS сдвигает visual viewport вверх при фокусе — удерживаем #root в видимой области.
    root.style.transform = offsetTop ? `translateY(${offsetTop}px)` : ''
  }

  window.scrollTo?.(0, 0)
  document.documentElement.scrollTop = 0
  document.body.scrollTop = 0
}

/** @deprecated alias — то же, что syncShellToVisualViewport */
export function syncShellAfterKeyboard(): void {
  syncShellToVisualViewport()
}

/**
 * Снимает фокус с поля и синхронизирует оболочку (отправка / успешный логин).
 */
export function dismissVirtualKeyboard(): void {
  const active = document.activeElement
  if (active instanceof HTMLElement) {
    active.blur()
  }
  // Два кадра: blur → анимация клавиатуры → актуальный visualViewport.height.
  window.requestAnimationFrame(() => {
    syncShellToVisualViewport()
    window.setTimeout(() => syncShellToVisualViewport(), 50)
    window.setTimeout(() => syncShellToVisualViewport(), 300)
  })
}

/**
 * Постоянно держит --app-height в sync с клавиатурой (в т.ч. кнопка «скрыть»).
 */
export function installKeyboardShellSync(): () => void {
  let focusOutTimer: number | undefined

  const onViewportChange = () => {
    syncShellToVisualViewport()
  }

  const onFocusOut = () => {
    window.clearTimeout(focusOutTimer)
    focusOutTimer = window.setTimeout(() => {
      const active = document.activeElement
      const stillEditing =
        active instanceof HTMLElement &&
        (active.tagName === 'INPUT' ||
          active.tagName === 'TEXTAREA' ||
          active.tagName === 'SELECT' ||
          active.isContentEditable)
      if (!stillEditing) {
        syncShellToVisualViewport()
      }
    }, 50)
    // Повтор после анимации системной «скрыть клавиатуру».
    window.setTimeout(() => syncShellToVisualViewport(), 350)
  }

  syncShellToVisualViewport()

  const vv = window.visualViewport
  vv?.addEventListener('resize', onViewportChange)
  vv?.addEventListener('scroll', onViewportChange)
  window.addEventListener('resize', onViewportChange)
  document.addEventListener('focusout', onFocusOut)
  document.addEventListener('focusin', onViewportChange)

  return () => {
    window.clearTimeout(focusOutTimer)
    vv?.removeEventListener('resize', onViewportChange)
    vv?.removeEventListener('scroll', onViewportChange)
    window.removeEventListener('resize', onViewportChange)
    document.removeEventListener('focusout', onFocusOut)
    document.removeEventListener('focusin', onViewportChange)
    document.documentElement.style.removeProperty(APP_HEIGHT_VAR)
    const root = document.getElementById('root')
    if (root) root.style.transform = ''
  }
}
