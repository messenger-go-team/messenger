import type { ReactNode } from 'react'
import { Link } from 'react-router'
import { Bell, LogOut, MessageCircle, User, Users } from 'lucide-react'
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
      <div className="contents md:flex md:flex-col md:items-center md:gap-[28px]">
        <NavItem label="Важно" to="/later" active={active === 'later'}>
          <Bell className="size-5" />
        </NavItem>
        <NavItem label="Чаты" to="/" active={active === 'chats'}>
          <MessageCircle className="size-5" />
        </NavItem>
        <NavItem label="Контакты" to="/contacts" active={active === 'contacts'}>
          <Users className="size-5" />
        </NavItem>
      </div>
      <div className="contents md:flex md:flex-col md:items-center md:gap-2">
        <NavItem label="Профиль" to="/profile" active={active === 'profile'}>
          <User className="size-5" />
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
}: {
  children: ReactNode
  label: string
  to: string
  active: boolean
}) {
  const className = cn(
    // Figma tablet hit 44×44; mobile tabs slightly larger
    // Figma 415:8407 — soft accent chip behind active icon
    'inline-flex size-11 items-center justify-center rounded-xl text-muted-foreground transition-colors hover:bg-accent md:size-11 lg:size-10',
    active && 'bg-accent text-foreground',
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
