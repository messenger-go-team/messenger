import { useId, useState, type FormEvent } from 'react'
import { Link, Navigate, useNavigate } from 'react-router'
import { EyeIcon, EyeOffIcon } from 'lucide-react'
import { Button, buttonVariants } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { cn } from '@/lib/utils'
import { useAuth } from '@/features/auth/useAuth'
import { messageFromAuthError } from '@/features/auth/authErrors'
import { AuthLayout } from '@/features/auth/AuthLayout'
import { hasFieldErrors, validateCredentials } from '@/features/auth/validation'

/**
 * Экран регистрации по username и паролю (SPEC FR-AUTH-1).
 * Поле Email в макете опционально для MVP: OpenAPI его не принимает и не валидирует.
 */
export function RegisterPage() {
  const { register, isAuthenticated, isReady } = useAuth()
  const navigate = useNavigate()
  const emailId = useId()
  const usernameId = useId()
  const passwordId = useId()
  const passwordConfirmId = useId()

  const [email, setEmail] = useState('')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [passwordConfirm, setPasswordConfirm] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [showPasswordConfirm, setShowPasswordConfirm] = useState(false)
  const [fieldErrors, setFieldErrors] = useState<{
    email?: string
    username?: string
    password?: string
    passwordConfirm?: string
  }>({})
  const [formError, setFormError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  if (isReady && isAuthenticated) {
    return <Navigate to="/" replace />
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setFormError(null)

    // Email в макете есть, но для MVP не обязателен и в API не отправляется (SPEC / OpenAPI).
    const errors = validateCredentials(username, password, {
      requirePasswordConfirm: true,
      passwordConfirm,
    })
    setFieldErrors(errors)
    if (hasFieldErrors(errors)) {
      return
    }

    setSubmitting(true)
    try {
      await register({ username, password })
      void navigate('/', { replace: true })
    } catch (error) {
      setFormError(messageFromAuthError(error))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <AuthLayout
      title="Регистрация"
      footer="Регистрируясь вы соглашаетесь с политикой конфиденциальности и политикой обработки персональных данных"
    >
      <form className="flex flex-col gap-8" onSubmit={onSubmit} noValidate>
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <Label htmlFor={emailId}>Email</Label>
            <Input
              id={emailId}
              name="email"
              type="email"
              autoComplete="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              aria-invalid={Boolean(fieldErrors.email)}
              aria-describedby={fieldErrors.email ? `${emailId}-error` : undefined}
              disabled={submitting}
            />
            {fieldErrors.email ? (
              <p id={`${emailId}-error`} className="text-xs text-destructive" role="alert">
                {fieldErrors.email}
              </p>
            ) : null}
          </div>

          <div className="flex flex-col gap-1">
            <Label htmlFor={usernameId}>Логин</Label>
            <Input
              id={usernameId}
              name="username"
              autoComplete="username"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              aria-invalid={Boolean(fieldErrors.username)}
              aria-describedby={fieldErrors.username ? `${usernameId}-error` : undefined}
              disabled={submitting}
            />
            {fieldErrors.username ? (
              <p id={`${usernameId}-error`} className="text-xs text-destructive" role="alert">
                {fieldErrors.username}
              </p>
            ) : null}
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
                onChange={(event) => setPassword(event.target.value)}
                aria-invalid={Boolean(fieldErrors.password)}
                aria-describedby={fieldErrors.password ? `${passwordId}-error` : undefined}
                disabled={submitting}
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
                onChange={(event) => setPasswordConfirm(event.target.value)}
                aria-invalid={Boolean(fieldErrors.passwordConfirm)}
                aria-describedby={
                  fieldErrors.passwordConfirm ? `${passwordConfirmId}-error` : undefined
                }
                disabled={submitting}
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

        {formError ? (
          <p className="text-sm text-destructive" role="alert">
            {formError}
          </p>
        ) : null}

        <div className="flex flex-col items-center gap-6">
          <Button type="submit" size="lg" className="w-full rounded-lg" disabled={submitting}>
            {submitting ? 'Регистрация…' : 'Зарегистрироваться'}
          </Button>
          <p className="text-center text-sm leading-5 text-muted-foreground">
            Уже есть аккаунт?{' '}
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
      </form>
    </AuthLayout>
  )
}
