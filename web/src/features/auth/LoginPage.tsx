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

/** Экран входа по username и паролю (SPEC FR-AUTH / FR-WEB-1). */
export function LoginPage() {
  const { login, isAuthenticated, isReady } = useAuth()
  const navigate = useNavigate()
  const usernameId = useId()
  const passwordId = useId()

  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [fieldErrors, setFieldErrors] = useState<{ username?: string; password?: string }>({})
  const [formError, setFormError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  if (isReady && isAuthenticated) {
    return <Navigate to="/" replace />
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setFormError(null)

    const errors = validateCredentials(username, password)
    setFieldErrors(errors)
    if (hasFieldErrors(errors)) {
      return
    }

    setSubmitting(true)
    try {
      await login({ username, password })
      void navigate('/', { replace: true })
    } catch (error) {
      setFormError(messageFromAuthError(error))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <AuthLayout
      title="Вход"
      footer="Нажимая «Вход» вы принимаете политику конфиденциальности, пользовательское соглашение и правило персональных рекомендаций"
    >
      <form className="flex flex-col gap-8" onSubmit={onSubmit} noValidate>
        <div className="flex flex-col gap-3">
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
                autoComplete="current-password"
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
        </div>

        {formError ? (
          <p className="text-sm text-destructive" role="alert">
            {formError}
          </p>
        ) : null}

        <div className="flex flex-col items-center gap-1">
          <Button type="submit" size="lg" className="w-full rounded-lg" disabled={submitting}>
            {submitting ? 'Вход…' : 'Войти'}
          </Button>
          <p className="text-xs leading-4 tracking-[0.024px] text-muted-foreground">или</p>
          <Link
            to="/register"
            className={cn(buttonVariants({ variant: 'outline', size: 'lg' }), 'w-full rounded-lg')}
          >
            Зарегистрироваться
          </Link>
        </div>
      </form>
    </AuthLayout>
  )
}
