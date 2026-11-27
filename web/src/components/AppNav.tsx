import type { ReactNode } from 'react'
import { Link } from 'react-router'
import { LogOut } from 'lucide-react'
import attentionIcon from '@/assets/attention.png'
import attentionActiveIcon from '@/assets/attention_active.png'
import chatIcon from '@/assets/chat.png'
import chatActiveIcon from '@/assets/chat_active.png'
import contactIcon from '@/assets/contact.png'
import contactActiveIcon from '@/assets/contact_active.png'
import userIcon from '@/assets/user.png'
import userActiveIcon from '@/assets/user_active.png'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

export type AppNavActive = 'later' | 'chats' | 'contacts' | 'profile'

interface AppNavProps {
  active: AppNavActive
  /** «Выйти» только в side rail (md+). На mobile logout в профиле. */
  onLogout?: () => void
  className?: string
}

/**
 * Навигация MVP (Figma ready messenger):
 * - mobile (&lt;580): нижний tab bar 375×60
 * - tablet (md…lg): левый rail 68px (Figma Tablet navigation)
 * - desktop (lg+): левый rail 48px
 */
export function AppNav({ active, onLogout, className }: AppNavProps) {
  return (
    <nav
      aria-label="Основная навигация"
      className={cn(
        'flex shrink-0 border-border bg-muted/40',
        // Mobile bottom bar
        'h-[60px] w-full flex-row items-center justify-around border-t px-10',
        // Tablet side rail 68px
        'md:h-auto md:w-[68px] md:flex-col md:justify-between md:border-t-0 md:border-r md:px-0 md:py-6',
        // Desktop side rail 48px
        'lg:w-12 lg:py-3',
        className,
      )}
    >
      <div className="contents md:flex md:flex-col md:items-center md:gap-3">
        <NavItem label="Важно" to="/later" active={active === 'later'} chipIcon>
          <img
            src={active === 'later' ? attentionActiveIcon : attentionIcon}
            alt=""
            width={40}
            height={40}
            className="size-10"
            aria-hidden
          />
        </NavItem>
        <NavItem label="Чаты" to="/" active={active === 'chats'} chipIcon>
          <img
            src={active === 'chats' ? chatActiveIcon : chatIcon}
            alt=""
            width={40}
            height={40}
            className="size-10"
            aria-hidden
          />
        </NavItem>
        <NavItem label="Контакты" to="/contacts" active={active === 'contacts'} chipIcon>
          <img
            src={active === 'contacts' ? contactActiveIcon : contactIcon}
            alt=""
            width={40}
            height={40}
            className="size-10"
            aria-hidden
          />
        </NavItem>
      </div>
      <div className="contents md:flex md:flex-col md:items-center md:gap-2">
        <NavItem label="Профиль" to="/profile" active={active === 'profile'} chipIcon>
          <img
            src={active === 'profile' ? userActiveIcon : userIcon}
            alt=""
            width={40}
            height={40}
            className="size-10"
            aria-hidden
          />
        </NavItem>
        {onLogout ? (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Выйти"
            title="Выйти"
            className="hidden md:inline-flex"
            onClick={onLogout}
          >
            <LogOut className="size-4" />
          </Button>
        ) : null}
      </div>
    </nav>
  )
}

function NavItem({
  children,
  label,
  to,
  active,
  chipIcon = false,
}: {
  children: ReactNode
  label: string
  to: string
  active: boolean
  /** Иконка уже с подложкой (Figma chip) — не красим bg-accent повторно. */
  chipIcon?: boolean
}) {
  const className = cn(
    // Figma tablet hit 44×44; mobile tabs slightly larger
    // Figma 415:8407 — soft accent chip behind active icon
    'inline-flex size-11 items-center justify-center rounded-xl text-muted-foreground transition-colors hover:bg-accent md:size-11 lg:size-10',
    active && !chipIcon && 'bg-accent text-foreground',
    // Chip-иконки: без hover-подложки поверх PNG
    chipIcon && 'hover:bg-transparent',
  )

  if (active) {
    return (
      <span className={className} aria-label={label} title={label} aria-current="page">
        {children}
      </span>
    )
  }

  return (
    <Link to={to} className={className} aria-label={label} title={label}>
      {children}
    </Link>
  )
}
