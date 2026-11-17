import type { ReactNode } from 'react'

interface AuthLayoutProps {
  title: string
  children: ReactNode
}

/** Общая оболочка экранов входа и регистрации. */
export function AuthLayout({ title, children }: AuthLayoutProps) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-muted/40 p-6">
      <div className="flex w-full max-w-md flex-col items-center gap-8">
        <header className="flex flex-col items-center gap-2 text-center">
          <div
            className="flex size-16 items-center justify-center rounded-full bg-primary/15 text-2xl font-bold text-primary"
            aria-hidden
          >
            T
          </div>
          <p className="text-3xl font-bold tracking-tight text-primary">Tiding</p>
          <p className="text-sm text-muted-foreground">Личные чаты и важные сообщения</p>
        </header>

        <h1 className="w-full text-center text-2xl font-semibold tracking-tight">{title}</h1>

        <section className="w-full rounded-2xl border bg-card p-8 text-card-foreground shadow-sm">
          {children}
        </section>
      </div>
    </main>
  )
}
