import { useNavigate } from 'react-router'
import toastIcon from '@/assets/toast.svg'
import { Button } from '@/components/ui/button'
import { formatReminderDueLabel } from '@/features/chats/formatChatListTime'
import { useLaterReminders } from '@/features/later/useLaterReminders'

/**
 * Toast напоминания Later (Figma desktop 426:22631 ≈ 328×212;
 * mobile 496:84911, tablet 537:110293).
 * Mobile (<580) — на всю ширину над нижним tab bar (60px + safe-area);
 * tablet+ (md:) — карточка справа внизу (навигация в rail).
 * «Позже» скрывает toast в этой сессии, «Открыть» переходит к сообщению в чате.
 *
 * Имя отправителя в макете есть, в Later Message контракте — только sender_id;
 * без отдельного lookup username не показываем.
 */
export function LaterReminderToast() {
  const { activeReminder, dismissReminder } = useLaterReminders()
  const navigate = useNavigate()

  if (!activeReminder) return null

  const { message, due_at: dueAt, id } = activeReminder
  const dueLabel = dueAt ? formatReminderDueLabel(dueAt) : ''

  function open() {
    dismissReminder(id)
    navigate(`/chats/${message.chat_id}`, { state: { focusMessageId: message.id } })
  }

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-[calc(60px+env(safe-area-inset-bottom,0px))] z-50 p-3 md:inset-x-auto md:right-4 md:bottom-4 md:w-[328px] md:p-0">
      <section
        aria-label="Напоминание"
        aria-live="polite"
        className="pointer-events-auto rounded-xl border border-border bg-card p-4 text-card-foreground shadow-lg"
      >
        <div className="flex items-center gap-2">
          <img
            src={toastIcon}
            alt=""
            width={20}
            height={20}
            className="size-5 shrink-0"
            aria-hidden
          />
          <h2 className="min-w-0 flex-1 text-sm leading-5 font-semibold">Напоминание</h2>
          {dueLabel ? (
            <time
              className="shrink-0 text-xs leading-4 text-muted-foreground"
              dateTime={dueAt ?? undefined}
            >
              {dueLabel}
            </time>
          ) : null}
        </div>
        <p className="mt-3 line-clamp-3 text-sm leading-5 break-words text-muted-foreground">
          {message.body}
        </p>
        <div className="mt-4 flex justify-end gap-2">
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
