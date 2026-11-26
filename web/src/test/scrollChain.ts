import { expect } from 'vitest'

function classes(element: Element): string[] {
  return (element.getAttribute('class') ?? '').split(/\s+/)
}

/**
 * Регрессия #45 (375×667): jsdom не считает раскладку, поэтому проверяем flex-цепочку
 * по классам. У flex-элемента в колонке min-height по умолчанию auto, и длинный контент
 * растягивает его вместо прокрутки: нижние табы и поле отправки уходят за экран.
 * Каждый предок scroll-контейнера до корня `h-svh` должен иметь `min-h-0`.
 */
export function expectScrollChainWithinViewport(scroller: Element): void {
  expect(classes(scroller), 'scroll-контейнер').toEqual(
    expect.arrayContaining(['min-h-0', 'flex-1', 'overflow-y-auto']),
  )

  let element = scroller.parentElement
  while (element && !classes(element).includes('h-svh')) {
    expect(
      classes(element),
      `предок scroll-контейнера <${element.tagName.toLowerCase()} class="${element.getAttribute('class')}"> без min-h-0`,
    ).toContain('min-h-0')
    element = element.parentElement
  }

  expect(element, 'корень страницы с h-svh не найден').not.toBeNull()
  expect(classes(element!)).toEqual(expect.arrayContaining(['min-h-0', 'overflow-hidden']))
}
