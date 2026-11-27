import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { Bookmark, Calendar, Clock, MoreVertical, Moon } from 'lucide-react'
import { saveForLater } from '@/api/later'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { dueAtEvening, dueAtInOneHour, toDueAtPayload } from '@/features/later/dueAt'
import { useOptionalLaterReminders } from '@/features/later/useLaterReminders'
import { cn } from '@/lib/utils'

type Panel = 'closed' | 'menu' | 'picker'
type Placement = 'above' | 'below'

const MENU_ESTIMATE_PX = 280

/** Hover/focus ряда: Figma 426:22967 — серо-голубой muted, не cyan accent. */
const menuItemClass =
  'mx-1 flex w-[calc(100%-0.5rem)] items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-foreground hover:bg-muted focus:bg-muted focus:outline-none'

type MenuCloser = (returnFocus: boolean) => void

let activeLaterMenu: { id: symbol; close: MenuCloser } | null = null

function claimLaterMenu(id: symbol, close: MenuCloser) {
  if (activeLaterMenu && activeLaterMenu.id !== id) activeLaterMenu.close(false)
  activeLaterMenu = { id, close }
}

function releaseLaterMenu(id: symbol) {
  if (activeLaterMenu?.id === id) activeLaterMenu = null
}

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
  const reminders = useOptionalLaterReminders()
  const [panel, setPanel] = useState<Panel>('closed')
  const [placement, setPlacement] = useState<Placement>('below')
  const [coords, setCoords] = useState<{ top: number; left: number } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [noticeCoords, setNoticeCoords] = useState<{ top: number; left: number } | null>(null)
  const [picker, setPicker] = useState(defaultPickerValues)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const floatingRef = useRef<HTMLDivElement>(null)
  const panelId = useRef<symbol | null>(null)
  const saving = useRef(false)
  const instanceId = useRef(Symbol('later-menu'))
  const dateId = useId()
  const timeId = useId()

  function closePanel(returnFocus: boolean) {
    panelId.current = null
    setPanel('closed')
    releaseLaterMenu(instanceId.current)
    if (returnFocus) triggerRef.current?.focus()
  }

  function openPanel(next: Panel) {
    claimLaterMenu(instanceId.current, closePanel)
    panelId.current = Symbol()
    const rect = triggerRef.current?.getBoundingClientRect()
    if (rect) {
      const spaceBelow = window.innerHeight - rect.bottom
      const spaceAbove = rect.top
      const nextPlacement: Placement =
        spaceBelow >= MENU_ESTIMATE_PX || spaceBelow >= spaceAbove ? 'below' : 'above'
      setPlacement(nextPlacement)
      setCoords(placePanel(rect, nextPlacement, next === 'picker' ? 214 : 216))
    }
    setPanel(next)
  }

  useLayoutEffect(() => {
    if (panel === 'closed' || !triggerRef.current) return
    const update = () => {
      const rect = triggerRef.current?.getBoundingClientRect()
      if (!rect) return
      setCoords(placePanel(rect, placement, panel === 'picker' ? 214 : 216))
    }
    update()
    window.addEventListener('scroll', update, true)
    window.addEventListener('resize', update)
    return () => {
      window.removeEventListener('scroll', update, true)
      window.removeEventListener('resize', update)
    }
  }, [panel, placement])

  useLayoutEffect(() => {
    if (panel === 'menu') {
      menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus()
    }
    if (panel === 'picker') {
      document.getElementById(dateId)?.focus()
    }
  }, [panel, dateId])

  useEffect(() => {
    const id = instanceId.current
    return () => {
      panelId.current = null
      releaseLaterMenu(id)
    }
  }, [])

  function onMenuKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const items = Array.from(
      menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [],
    )
    const index = items.indexOf(document.activeElement as HTMLElement)
    if (event.key === 'Escape') {
      event.preventDefault()
      closePanel(true)
      return
    }
    if (event.key === 'Tab') {
      // Let native Tab continue in the chat's focus order from the trigger.
      closePanel(true)
      return
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      if (items.length === 0) return
      const next =
        event.key === 'ArrowDown'
          ? items[(index + 1 + items.length) % items.length]
          : items[(index - 1 + items.length) % items.length]
      next?.focus()
    }
  }

  async function persist(dueAt: string | null, successText: string) {
    const submittedPanel = panelId.current
    if (!submittedPanel || saving.current) return
    saving.current = true
    setBusy(true)
    setError(null)
    try {
      const saved = await saveForLater(accessToken, {
        chat_id: chatId,
        message_id: messageId,
        due_at: toDueAtPayload(dueAt),
      })
      // Общий список и таймер ближайшего срока должны сразу увидеть новую запись.
      reminders?.replaceEntry(saved.entry, saved.server_time)
      // This response can arrive after dismissal or after another panel opens.
      if (panelId.current === submittedPanel) {
        closePanel(floatingRef.current?.contains(document.activeElement) ?? false)
      }
      const rect = triggerRef.current?.getBoundingClientRect()
      const noticeWidth = 192
      if (rect) {
        // Держим тост справа от триггера / в viewport — не наезжает на список чатов.
        const left = Math.min(
          Math.max(rect.left, 12),
          window.innerWidth - noticeWidth - 12,
        )
        setNoticeCoords({ top: rect.bottom + 8, left })
      } else {
        setNoticeCoords(null)
      }
      setNotice(successText)
      window.setTimeout(() => {
        setNotice(null)
        setNoticeCoords(null)
      }, 2500)
    } catch {
      if (panelId.current === submittedPanel) {
        setError('Не удалось сохранить. Повторите попытку.')
      }
    } finally {
      saving.current = false
      setBusy(false)
    }
  }

  function submitPicker() {
    if (saving.current) return
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
          <>
            {/* Figma Shadow — серый dim+blur только под выбором времени. */}
            {panel === 'picker' ? (
              <button
                type="button"
                aria-label="Закрыть"
                className="fixed inset-0 z-40 border-0 bg-slate-900/25 backdrop-blur-[2px]"
                onClick={() => closePanel(true)}
              />
            ) : null}
            <div
              ref={floatingRef}
              className="fixed z-50"
              style={{ top: coords.top, left: coords.left }}
              aria-busy={busy}
              data-placement={placement}
            >
              {panel === 'menu' ? (
                <div
                  ref={menuRef}
                  role="menu"
                  aria-label="Вернуться позже"
                  // Figma Dropdown Menu later ≈ 216×148, radius ~8–12
                  className="w-[216px] overflow-hidden rounded-xl border border-border bg-card py-1 shadow-md"
                  onKeyDown={onMenuKeyDown}
                >
                  <p className="border-b border-border px-3 py-2 text-xs font-medium text-muted-foreground">
                    Вернуться позже
                  </p>
                  <button
                    type="button"
                    role="menuitem"
                    className={menuItemClass}
                    aria-disabled={busy}
                    onClick={() => void persist(null, 'Сохранено без срока')}
                  >
                    <Bookmark className="size-4 shrink-0" aria-hidden />
                    Просто сохранить
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    className={menuItemClass}
                    aria-disabled={busy}
                    onClick={() => void persist(dueAtInOneHour(), 'Напомним через час')}
                  >
                    <Clock className="size-4 shrink-0" aria-hidden />
                    Через 1 час
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    className={cn(menuItemClass, 'justify-between')}
                    aria-disabled={busy}
                    onClick={() => void persist(dueAtEvening(), 'Напомним вечером')}
                  >
                    <span className="inline-flex items-center gap-2">
                      <Moon className="size-4 shrink-0" aria-hidden />
                      Вечером
                    </span>
                    <span className="text-xs text-muted-foreground">{eveningHint()}</span>
                  </button>
                  <div className="my-1 border-t border-border" role="separator" />
                  <button
                    type="button"
                    role="menuitem"
                    className={menuItemClass}
                    aria-disabled={busy}
                    onClick={() => {
                      if (saving.current) return
                      setPicker(defaultPickerValues())
                      openPanel('picker')
                    }}
                  >
                    <Calendar className="size-4 shrink-0" aria-hidden />
                    Выбрать время
                  </button>
                  {error ? (
                    <p className="px-3 py-2 text-xs text-destructive" role="alert">
                      {error}
                    </p>
                  ) : null}
                </div>
              ) : null}

              {panel === 'picker' ? (
                <div
                  // Figma Time picker ≈ 214×166: дата‖время, outline «Выбрать»
                  className="w-[214px] space-y-3 overflow-hidden rounded-xl border border-border bg-card p-3 shadow-md"
                  onKeyDown={(event) => {
                    if (event.key !== 'Escape') return
                    event.preventDefault()
                    closePanel(true)
                  }}
                >
                  <p className="border-b border-border pb-2 text-sm font-medium">Напомнить</p>
                  <div className="grid grid-cols-2 gap-2">
                    <div className="space-y-1">
                      <label htmlFor={dateId} className="text-xs text-muted-foreground">
                        Дата
                      </label>
                      <Input
                        id={dateId}
                        type="date"
                        value={picker.date}
                        className="h-9 rounded-md px-2"
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
                        className="h-9 rounded-md px-2"
                        onChange={(event) =>
                          setPicker((value) => ({ ...value, time: event.target.value }))
                        }
                      />
                    </div>
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    className="w-full"
                    aria-disabled={busy}
                    onClick={submitPicker}
                  >
                    Выбрать
                  </Button>
                  {error ? (
                    <p className="text-xs text-destructive" role="alert">
                      {error}
                    </p>
                  ) : null}
                </div>
              ) : null}
            </div>
          </>,
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
        disabled={disabled}
        onKeyDown={(event) => {
          if (panel === 'closed' && event.key === 'ArrowDown') {
            event.preventDefault()
            setError(null)
            openPanel('menu')
          }
        }}
        onClick={() => {
          setError(null)
          if (panel === 'closed') openPanel('menu')
          else closePanel(true)
        }}
      >
        <MoreVertical className="size-4" />
      </button>

      {floating}

      {notice
        ? createPortal(
            <p
              className="pointer-events-none fixed z-[60] w-48 rounded-md border border-border bg-card px-2 py-1 text-xs text-muted-foreground shadow-md"
              style={
                noticeCoords
                  ? { top: noticeCoords.top, left: noticeCoords.left }
                  : { top: 16, right: 16 }
              }
              role="status"
            >
              {notice}
            </p>,
            document.body,
          )
        : null}
    </div>
  )
}
