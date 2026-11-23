import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Bookmark, Calendar, Clock, MoreVertical, Moon } from 'lucide-react'
import { saveForLater } from '@/api/later'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { dueAtEvening, dueAtInOneHour, toDueAtPayload } from '@/features/later/dueAt'
import { cn } from '@/lib/utils'

type Panel = 'closed' | 'menu' | 'picker'
type Placement = 'above' | 'below'

const MENU_ESTIMATE_PX = 280

function eveningHint(now = new Date()): string {
  return now.getHours() >= 19 ? 'завтра в 19:00' : 'сегодня в 19:00'
}

function pad(value: number) {
  return String(value).padStart(2, '0')
}

function defaultPickerValues(now = new Date()) {
  return {
    date: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`,
    time: `${pad(now.getHours())}:${pad(now.getMinutes())}`,
  }
}

function placePanel(
  trigger: DOMRect,
  placement: Placement,
  width: number,
): { top: number; left: number } {
  const margin = 8
  const left = Math.min(
    Math.max(margin, trigger.left + trigger.width / 2 - width / 2),
    window.innerWidth - width - margin,
  )
  if (placement === 'below') {
    return { top: trigger.bottom + margin, left }
  }
  return { top: Math.max(margin, trigger.top - MENU_ESTIMATE_PX - margin), left }
}

/** Меню «Вернуться позже» на сообщении: 4 пресета + выбор даты/времени. */
export function MessageLaterMenu({
  accessToken,
  chatId,
  messageId,
  disabled,
}: {
  accessToken: string
  chatId: string
  messageId: string
  disabled?: boolean
  align?: 'start' | 'end'
}) {
  const [panel, setPanel] = useState<Panel>('closed')
  const [placement, setPlacement] = useState<Placement>('below')
  const [coords, setCoords] = useState<{ top: number; left: number } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [picker, setPicker] = useState(defaultPickerValues)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const dateId = useId()
  const timeId = useId()

  function openPanel(next: Panel) {
    const rect = triggerRef.current?.getBoundingClientRect()
    if (rect) {
      const spaceBelow = window.innerHeight - rect.bottom
      const spaceAbove = rect.top
      const nextPlacement: Placement =
        spaceBelow >= MENU_ESTIMATE_PX || spaceBelow >= spaceAbove ? 'below' : 'above'
      setPlacement(nextPlacement)
      setCoords(placePanel(rect, nextPlacement, next === 'picker' ? 256 : 224))
    }
    setPanel(next)
  }

  useLayoutEffect(() => {
    if (panel === 'closed' || !triggerRef.current) return
    const update = () => {
      const rect = triggerRef.current?.getBoundingClientRect()
      if (!rect) return
      setCoords(placePanel(rect, placement, panel === 'picker' ? 256 : 224))
    }
    update()
    window.addEventListener('scroll', update, true)
    window.addEventListener('resize', update)
    return () => {
      window.removeEventListener('scroll', update, true)
      window.removeEventListener('resize', update)
    }
  }, [panel, placement])

  useEffect(() => {
    if (panel === 'closed') return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setPanel('closed')
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [panel])

  async function persist(dueAt: string | null, successText: string) {
    setBusy(true)
    setError(null)
    try {
      await saveForLater(accessToken, {
        chat_id: chatId,
        message_id: messageId,
        due_at: toDueAtPayload(dueAt),
      })
      setPanel('closed')
      setNotice(successText)
      window.setTimeout(() => setNotice(null), 2500)
    } catch {
      setError('Не удалось сохранить. Повторите попытку.')
    } finally {
      setBusy(false)
    }
  }

  function submitPicker() {
    const local = new Date(`${picker.date}T${picker.time}:00`)
    if (Number.isNaN(local.getTime())) {
      setError('Проверьте дату и время.')
      return
    }
    void persist(local.toISOString(), 'Напоминание сохранено')
  }

  const floating =
    panel !== 'closed' && coords
      ? createPortal(
          <div
            className="fixed z-50"
            style={{ top: coords.top, left: coords.left }}
            data-placement={placement}
          >
            {panel === 'menu' ? (
              <div
                role="menu"
                aria-label="Вернуться позже"
                className="w-56 rounded-lg border border-border bg-card py-1 shadow-md"
              >
                <p className="px-3 py-2 text-xs font-medium text-muted-foreground">
                  Вернуться позже
                </p>
                <button
                  type="button"
                  role="menuitem"
                  className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-accent"
                  disabled={busy}
                  onClick={() => void persist(null, 'Сохранено без срока')}
                >
                  <Bookmark className="size-4 shrink-0" aria-hidden />
                  Просто сохранить
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-accent"
                  disabled={busy}
                  onClick={() => void persist(dueAtInOneHour(), 'Напомним через час')}
                >
                  <Clock className="size-4 shrink-0" aria-hidden />
                  Через 1 час
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm hover:bg-accent"
                  disabled={busy}
                  onClick={() => void persist(dueAtEvening(), 'Напомним вечером')}
                >
                  <span className="inline-flex items-center gap-2">
                    <Moon className="size-4 shrink-0" aria-hidden />
                    Вечером
                  </span>
                  <span className="text-xs text-muted-foreground">{eveningHint()}</span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-accent"
                  disabled={busy}
                  onClick={() => {
                    setPicker(defaultPickerValues())
                    openPanel('picker')
                  }}
                >
                  <Calendar className="size-4 shrink-0" aria-hidden />
                  Выбрать время
                </button>
              </div>
            ) : null}

            {panel === 'picker' ? (
              <div className="w-64 space-y-3 rounded-lg border border-border bg-card p-3 shadow-md">
                <p className="text-sm font-medium">Напомнить</p>
                <div className="space-y-1">
                  <label htmlFor={dateId} className="text-xs text-muted-foreground">
                    Дата
                  </label>
                  <Input
                    id={dateId}
                    type="date"
                    value={picker.date}
                    onChange={(event) =>
                      setPicker((value) => ({ ...value, date: event.target.value }))
                    }
                  />
                </div>
                <div className="space-y-1">
                  <label htmlFor={timeId} className="text-xs text-muted-foreground">
                    Время
                  </label>
                  <Input
                    id={timeId}
                    type="time"
                    value={picker.time}
                    onChange={(event) =>
                      setPicker((value) => ({ ...value, time: event.target.value }))
                    }
                  />
                </div>
                <div className="flex gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    className="flex-1"
                    disabled={busy}
                    onClick={() => openPanel('menu')}
                  >
                    Назад
                  </Button>
                  <Button type="button" className="flex-1" disabled={busy} onClick={submitPicker}>
                    Выбрать
                  </Button>
                </div>
              </div>
            ) : null}
          </div>,
          document.body,
        )
      : null

  return (
    <div
      className={cn(
        'relative transition-opacity',
        // Touch / coarse pointer: always visible. Fine+hover: show on bubble hover/focus.
        'opacity-100',
        '[@media(hover:hover)_and_(pointer:fine)]:opacity-0',
        '[@media(hover:hover)_and_(pointer:fine)]:group-hover/bubble:opacity-100',
        'focus-within:opacity-100',
        panel !== 'closed' && 'opacity-100',
        disabled && 'pointer-events-none opacity-0',
      )}
    >
      <button
        ref={triggerRef}
        type="button"
        className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent"
        aria-label="Действия с сообщением"
        aria-haspopup="menu"
        aria-expanded={panel !== 'closed'}
        disabled={disabled || busy}
        onClick={() => {
          setError(null)
          if (panel === 'closed') openPanel('menu')
          else setPanel('closed')
        }}
      >
        <MoreVertical className="size-4" />
      </button>

      {floating}

      {error ? (
        <p
          className="absolute top-8 left-1/2 z-20 w-48 -translate-x-1/2 rounded-md bg-destructive/10 px-2 py-1 text-xs text-destructive"
          role="alert"
        >
          {error}
        </p>
      ) : null}
      {notice ? (
        <p
          className="absolute top-8 left-1/2 z-20 w-48 -translate-x-1/2 rounded-md border border-border bg-card px-2 py-1 text-xs text-muted-foreground shadow"
          role="status"
        >
          {notice}
        </p>
      ) : null}
    </div>
  )
}
