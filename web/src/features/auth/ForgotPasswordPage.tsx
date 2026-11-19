import { useId, useState, type FormEvent } from 'react'
import { Link, Navigate } from 'react-router'
import { Button, buttonVariants } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { cn } from '@/lib/utils'
import { useAuth } from '@/features/auth/useAuth'
import { AuthLayout } from '@/features/auth/AuthLayout'
import { hasFieldErrors, validateEmail } from '@/features/auth/validation'

/**
 * Экран «Забыли пароль?» по макету Figma.
 * Восстановление пароля в SPEC вне MVP и в OpenAPI отсутствует — UI только с клиентской валидацией.
 */
export function ForgotPasswordPage() {
  const { isAuthenticated, isReady } = useAuth()
  const emailId = useId()
  const [email, setEmail] = useState('')
  const [emailError, setEmailError] = useState<string | null>(null)
  const [submitted, setSubmitted] = useState(false)

  if (isReady && isAuthenticated) {
    return <Navigate to="/" replace />
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const errors = validateEmail(email)
    if (hasFieldErrors(errors)) {
      setEmailError(errors.email ?? null)
      setSubmitted(false)
      return
    }

    setEmailError(null)
    setSubmitted(true)
  }

  return (
    <AuthLayout title="Забыли пароль?">
      <form className="flex flex-col gap-8" onSubmit={onSubmit} noValidate>
        <p className="text-center text-xs leading-4 tracking-[0.024px] text-[color:var(--auth-muted)]">
          Введите адрес электронной почты, которую вы использовали для регистрации
        </p>

        <div className="flex flex-col gap-2">
          <div className="flex flex-col gap-1">
            <Label htmlFor={emailId}>Email</Label>
            <Input
              id={emailId}
              name="email"
              type="email"
              autoComplete="email"
              value={email}
              onChange={(event) => {
                setEmail(event.target.value)
                setSubmitted(false)
              }}
              aria-invalid={Boolean(emailError)}
              aria-describedby={emailError ? `${emailId}-error` : undefined}
            />
            {emailError ? (
              <p id={`${emailId}-error`} className="text-xs text-destructive" role="alert">
                {emailError}
              </p>
            ) : null}
          </div>

          {submitted ? (
            <p className="text-sm text-muted-foreground" role="status">
              Если аккаунт с таким email существует, мы отправим инструкции по восстановлению.
              Восстановление пароля пока недоступно на сервере.
            </p>
          ) : null}

          <div className="flex flex-col items-center gap-6">
            <Button type="submit" size="lg" className="w-full rounded-lg">
              Восстановить аккаунт
            </Button>
            <p className="text-center text-sm leading-5 text-muted-foreground">
              Вспомнили пароль?{' '}
              <Link
                to="/login"
                className={cn(
                  buttonVariants({ variant: 'link' }),
                  'inline h-auto p-0 text-sm font-medium',
                )}
              >
                Войти
              </Link>
            </p>
          </div>
        </div>
      </form>
    </AuthLayout>
  )
}
