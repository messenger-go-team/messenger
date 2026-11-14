import { Button } from '@/components/ui/button'

/** Стартовая страница текущего frontend-каркаса. */
export function HomePage() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-background p-6">
      <section className="flex flex-col items-center gap-4 rounded-xl border bg-card p-8 text-card-foreground shadow-sm">
        <h1 className="text-2xl font-bold">Messenger</h1>

        <p className="text-muted-foreground">React + TypeScript + Tailwind CSS + shadcn/ui</p>

        <Button type="button">Начать общение</Button>
      </section>
    </main>
  )
}
