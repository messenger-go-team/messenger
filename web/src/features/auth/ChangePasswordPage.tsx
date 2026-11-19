import { useId, useState, type FormEvent } from 'react'
import { Link } from 'react-router'
import { EyeIcon, EyeOffIcon } from 'lucide-react'
import { Button, buttonVariants } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { cn } from '@/lib/utils'
import { useAuth } from '@/features/auth/useAuth'
import { AuthLayout } from '@/features/auth/AuthLayout'
import { hasFieldErrors, validateCredentials } from '@/features/auth/validation'

/**
 * Экран «Сменить пароль» по макету Figma.
 * Эндпоинта смены пароля в OpenAPI нет — форма валидируется на клиенте.
 */
export function ChangePasswordPage() {
  const { user } = useAuth()
  const usernameId = useId()
  const passwordId = useId()
  const passwordConfirmId = useId()

  const [password, setPassword] = useState('')
  const [passwordConfirm, setPasswordConfirm] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [showPasswordConfirm, setShowPasswordConfirm] = useState(false)
  const [fieldErrors, setFieldErrors] = useState<{
    password?: string
    passwordConfirm?: string
  }>({})
  const [submitted, setSubmitted] = useState(false)

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const errors = validateCredentials(user?.username ?? 'user_1', password, {
      requirePasswordConfirm: true,
      passwordConfirm,
    })
    const nextErrors = {
      password: errors.password,
      passwordConfirm: errors.passwordConfirm,
    }
    setFieldErrors(nextErrors)
    if (hasFieldErrors(nextErrors)) {
      setSubmitted(false)
      return
    }

    setSubmitted(true)
  }

  return (
    <AuthLayout title="Сменить пароль">
      <form className="flex flex-col gap-8" onSubmit={onSubmit} noValidate>
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1 opacity-50">
            <Label htmlFor={usernameId} className="text-[color:var(--auth-muted)]">
              Логин
            </Label>
            <Input id={usernameId} name="username" value={user?.username ?? ''} disabled readOnly />
          </div>

          <div className="flex flex-col gap-1">
            <Label htmlFor={passwordId}>Пароль</Label>
            <div className="relative">
              <Input
                id={passwordId}
                name="password"
                type={showPassword ? 'text' : 'password'}
                autoComplete="new-password"
                value={password}
                onChange={(event) => {
                  setPassword(event.target.value)
                  setSubmitted(false)
                }}
                aria-invalid={Boolean(fieldErrors.password)}
                aria-describedby={fieldErrors.password ? `${passwordId}-error` : undefined}
                className="pr-10"
              />
              <button
                type="button"
                className="absolute top-1/2 right-3 -translate-y-1/2 rounded-md p-1 text-muted-foreground hover:text-foreground"
                onClick={() => setShowPassword((value) => !value)}
                aria-label={showPassword ? 'Скрыть пароль' : 'Показать пароль'}
              >
                {showPassword ? <EyeOffIcon className="size-5" /> : <EyeIcon className="size-5" />}
              </button>
            </div>
            {fieldErrors.password ? (
              <p id={`${passwordId}-error`} className="text-xs text-destructive" role="alert">
                {fieldErrors.password}
              </p>
            ) : null}
          </div>

          <div className="flex flex-col gap-1">
            <Label htmlFor={passwordConfirmId}>Повторите пароль</Label>
            <div className="relative">
              <Input
                id={passwordConfirmId}
                name="passwordConfirm"
                type={showPasswordConfirm ? 'text' : 'password'}
                autoComplete="new-password"
                value={passwordConfirm}
                onChange={(event) => {
                  setPasswordConfirm(event.target.value)
                  setSubmitted(false)
                }}
                aria-invalid={Boolean(fieldErrors.passwordConfirm)}
                aria-describedby={
                  fieldErrors.passwordConfirm ? `${passwordConfirmId}-error` : undefined
                }
                className="pr-10"
              />
              <button
                type="button"
                className="absolute top-1/2 right-3 -translate-y-1/2 rounded-md p-1 text-muted-foreground hover:text-foreground"
                onClick={() => setShowPasswordConfirm((value) => !value)}
                aria-label={showPasswordConfirm ? 'Скрыть повтор пароля' : 'Показать повтор пароля'}
              >
                {showPasswordConfirm ? (
                  <EyeOffIcon className="size-5" />
                ) : (
                  <EyeIcon className="size-5" />
                )}
              </button>
            </div>
            {fieldErrors.passwordConfirm ? (
              <p
                id={`${passwordConfirmId}-error`}
                className="text-xs text-destructive"
                role="alert"
              >
                {fieldErrors.passwordConfirm}
              </p>
            ) : null}
          </div>
        </div>

        {submitted ? (
          <p className="text-sm text-muted-foreground" role="status">
            Форма заполнена верно. Смена пароля на сервере пока недоступна.
          </p>
        ) : null}

        <div className="flex flex-col items-center gap-6">
          <Button type="submit" size="lg" className="w-full rounded-lg">
            Сменить пароль
          </Button>
          <Link
            to="/"
            className={cn(buttonVariants({ variant: 'link' }), 'h-auto p-0 text-sm font-medium')}
          >
            Вернуться в профиль
          </Link>
        </div>
      </form>
    </AuthLayout>
  )
}
