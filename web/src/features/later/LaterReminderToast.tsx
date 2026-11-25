import { useNavigate } from 'react-router'
import { Bell } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { formatChatListTime } from '@/features/chats/formatChatListTime'
import { useLaterReminders } from '@/features/later/useLaterReminders'

/**
 * Toast напоминания Later (Figma mobile 496:84911, tablet 537:110293).
 * Mobile (<580) — на всю ширину внизу; tablet+ (md:) — карточка справа внизу.
 * «Позже» скрывает toast в этой сессии, «Открыть» переходит к сообщению в чате.
 */
export function LaterReminderToast() {
  const { activeReminder, dismissReminder } = useLaterReminders()
  const navigate = useNavigate()

  if (!activeReminder) return null

  const { message, due_at: dueAt, id } = activeReminder
  const dueLabel = dueAt ? formatChatListTime(dueAt) : ''

  function open() {
    dismissReminder(id)
    navigate(`/chats/${message.chat_id}`, { state: { focusMessageId: message.id } })
  }

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-0 z-50 p-3 md:inset-x-auto md:right-4 md:bottom-4 md:w-96 md:p-0">
      <section
        aria-label="Напоминание"
        aria-live="polite"
        className="pointer-events-auto rounded-xl border border-border bg-card p-4 text-card-foreground shadow-lg"
      >
        <div className="flex items-start gap-3">
          <span
            aria-hidden
            className="inline-flex size-9 shrink-0 items-center justify-center rounded-full bg-accent text-foreground"
          >
            <Bell className="size-4" />
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="text-sm font-semibold">Напоминание</h2>
            {dueLabel ? <p className="text-xs text-muted-foreground">Срок: {dueLabel}</p> : null}
            <p className="mt-1 line-clamp-2 text-sm break-words">{message.body}</p>
          </div>
        </div>
        <div className="mt-3 flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={() => dismissReminder(id)}>
            Позже
          </Button>
          <Button type="button" onClick={open}>
            Открыть
          </Button>
        </div>
      </section>
    </div>
  )
}
