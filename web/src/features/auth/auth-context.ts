import { createContext } from 'react'
import type { LoginRequest, RegisterRequest, User } from '@/api/auth'

export interface AuthContextValue {
  user: User | null
  accessToken: string | null
  /** false пока не завершена попытка восстановить сессию через refresh. */
  isReady: boolean
  isAuthenticated: boolean
  /** Задан, если выход не подтверждён и cookie могла сохраниться. */
  logoutError: string | null
  login: (credentials: LoginRequest) => Promise<void>
  register: (data: RegisterRequest) => Promise<void>
  logout: () => Promise<void>
}

export const AuthContext = createContext<AuthContextValue | null>(null)
