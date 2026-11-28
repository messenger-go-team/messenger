/**
 * Брейкпоинты раскладок MVP (#45).
 * Согласованы с дизайном: mobile 375–580, tablet 580–1080, desktop ≥1080 (CSS px).
 * В Tailwind: `md:` = tablet+ (580px), `lg:` = desktop (1080px) — см. `index.css`.
 */
export const BREAKPOINTS = {
  mobileMin: 375,
  tablet: 580,
  desktop: 1080,
} as const

export type LayoutBucket = 'mobile' | 'tablet' | 'desktop'

/** Корзина ширины viewport для тестов и JS (границы как у CSS min-width). */
export function layoutBucket(widthPx: number): LayoutBucket {
  if (widthPx >= BREAKPOINTS.desktop) return 'desktop'
  if (widthPx >= BREAKPOINTS.tablet) return 'tablet'
  return 'mobile'
}
