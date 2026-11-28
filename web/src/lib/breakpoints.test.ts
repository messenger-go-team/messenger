/// <reference types="node" />
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { BREAKPOINTS, layoutBucket } from '@/lib/breakpoints'

// Читаем исходник напрямую: vitest не обрабатывает CSS, а `?raw` отдаёт пустую строку.
const indexCss = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '../index.css'),
  'utf8',
)

/** Значения `--breakpoint-*` из `@theme` в index.css: имя → строка значения. */
function parseThemeBreakpoints(css: string): Record<string, string> {
  const result: Record<string, string> = {}
  for (const match of css.matchAll(/--breakpoint-([\w-]+)\s*:\s*([^;]+);/g)) {
    result[match[1]] = match[2].trim()
  }
  return result
}

function px(value: string | undefined): number {
  const match = /^(\d+(?:\.\d+)?)px$/.exec(value ?? '')
  if (!match) throw new Error(`брейкпоинт должен быть в px, получено: ${value}`)
  return Number(match[1])
}

describe('layoutBucket', () => {
  it('uses #45 thresholds: mobile <580, tablet 580–1079, desktop ≥1080', () => {
    expect(layoutBucket(375)).toBe('mobile')
    expect(layoutBucket(579)).toBe('mobile')
    expect(layoutBucket(BREAKPOINTS.tablet)).toBe('tablet')
    expect(layoutBucket(767)).toBe('tablet')
    expect(layoutBucket(1079)).toBe('tablet')
    expect(layoutBucket(BREAKPOINTS.desktop)).toBe('desktop')
    expect(layoutBucket(1440)).toBe('desktop')
  })
})

describe('index.css --breakpoint-* ↔ BREAKPOINTS', () => {
  const theme = parseThemeBreakpoints(indexCss)

  it('md: = tablet, lg: = desktop', () => {
    expect(px(theme.md)).toBe(BREAKPOINTS.tablet)
    expect(px(theme.lg)).toBe(BREAKPOINTS.desktop)
  })

  it('sm: остаётся дефолтным Tailwind (640px), а не совпадает с md:', () => {
    expect(px(theme.sm)).toBe(640)
  })

  it('все брейкпоинты в px: Tailwind сортирует по единице, rem и px смешивать нельзя', () => {
    expect(Object.keys(theme).sort()).toEqual(['2xl', 'lg', 'md', 'sm', 'xl'])
    for (const value of Object.values(theme)) expect(() => px(value)).not.toThrow()
  })
})
