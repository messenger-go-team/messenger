import { Link } from 'react-router'
import { buttonVariants } from '@/components/ui/button'
import { cn } from '@/lib/utils'

/** Заглушка пункта навигации до экрана контактов (#70). */
export function ContactsPlaceholderPage() {
  return (
    <main className="flex min-h-svh flex-col items-center justify-center gap-4 bg-background p-6 text-center">
      <h1 className="text-2xl font-semibold">Контакты</h1>
      <p className="max-w-md text-muted-foreground">
        Отдельный экран контактов появится в задаче #70. Поиск людей и создание чата уже есть в
        списке чатов.
      </p>
      <Link to="/" className={cn(buttonVariants({ variant: 'outline' }))}>
        К чатам
      </Link>
    </main>
  )
}
