import type { ReactNode } from 'react'
import tidingLogo from '@/assets/tiding-logo.svg'

interface AuthLayoutProps {
  title: string
  footer?: ReactNode
  children: ReactNode
}

/** Общая оболочка экранов входа и регистрации по макету Tiding (#42 / Figma OAuth). */
export function AuthLayout({ title, footer, children }: AuthLayoutProps) {
  return (
    <main className="flex min-h-screen justify-center bg-[var(--auth-surface)] px-4 py-8">
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
            <section className="w-full rounded-2xl bg-card p-10 text-card-foreground shadow-[0px_2px_4px_rgba(0,0,0,0.03)]">
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
