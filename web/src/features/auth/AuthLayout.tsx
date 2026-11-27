import type { ReactNode } from 'react'
import tidingLogo from '@/assets/tiding-logo.svg'
import { cn } from '@/lib/utils'

interface AuthLayoutProps {
  title: string
  footer?: ReactNode
  children: ReactNode
}

/** Общая оболочка экранов входа и регистрации по макету Tiding (#42 / Figma OAuth 129:3450). */
export function AuthLayout({ title, footer, children }: AuthLayoutProps) {
  return (
    <main
      className="flex h-full min-h-0 justify-center overflow-y-auto overscroll-y-contain bg-[var(--auth-surface)] px-4 py-8 font-auth md:py-12 lg:py-16"
    >
      {/* Desktop OAuth column = 448px (Figma 129:3445 / 129:3450) */}
      <div className="flex w-full max-w-[448px] flex-col items-center gap-10">
        <header className="flex w-full max-w-[272px] flex-col items-center gap-2 text-center">
          <img
            src={tidingLogo}
            alt=""
            width={88}
            height={88}
            className="size-[88px] shrink-0"
            aria-hidden
          />
          <div className="flex w-full flex-col items-center gap-2">
            <p className="text-[40px] leading-[66px] font-bold tracking-[0.8px] text-primary">
              Tiding
            </p>
            <p className="text-lg leading-6 font-semibold text-muted-foreground">
              Важные вести не теряются
            </p>
          </div>
        </header>

        <div className="flex w-full flex-col items-center gap-10">
          <h1 className="w-full text-center text-2xl leading-8 font-semibold tracking-[-0.24px] text-foreground">
            {title}
          </h1>

          <div className="flex w-full flex-col gap-8">
            <section
              className={cn(
                // Card: padding 40, content 368 — как OAuth block 129:3450
                'w-full rounded-2xl bg-card p-10 text-card-foreground shadow-[0px_2px_4px_rgba(0,0,0,0.03)]',
                // Inputs: radius 12px; focus — border #94A3B8, без ring/glow
                '[&_[data-slot=input]]:rounded-[12px]',
                '[&_[data-slot=input]:focus]:border-[#94A3B8] [&_[data-slot=input]:focus]:ring-0',
                '[&_[data-slot=input]:focus-visible]:border-[#94A3B8] [&_[data-slot=input]:focus-visible]:ring-0 [&_[data-slot=input]:focus-visible]:ring-offset-0',
                // Кнопки: 14px Medium как в макете (не text-base от size=lg)
                '[&_[data-slot=button]]:text-sm [&_a.inline-flex]:text-sm',
              )}
            >
              {children}
            </section>
            {footer ? (
              <p className="px-1 text-center text-xs leading-4 tracking-[0.024px] text-[color:var(--auth-muted)]">
                {footer}
              </p>
            ) : null}
          </div>
        </div>
      </div>
    </main>
  )
}
