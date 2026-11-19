import { Route, Routes } from 'react-router'
import { ChangePasswordPage } from '@/features/auth/ChangePasswordPage'
import { ForgotPasswordPage } from '@/features/auth/ForgotPasswordPage'
import { LoginPage } from '@/features/auth/LoginPage'
import { RegisterPage } from '@/features/auth/RegisterPage'
import { RequireAuth } from '@/features/auth/RequireAuth'
import { ChatListPage } from '@/features/chats/ChatListPage'
import { LaterPage } from '@/features/later/LaterPage'
import { ContactsPlaceholderPage } from '@/pages/ContactsPlaceholderPage'
import { NotFoundPage } from '@/pages/NotFoundPage'

/** Описывает верхнеуровневые маршруты приложения и fallback для неизвестного URL. */
export function AppRouter() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/register" element={<RegisterPage />} />
      <Route path="/forgot-password" element={<ForgotPasswordPage />} />
      <Route element={<RequireAuth />}>
        <Route path="/" element={<ChatListPage />} />
        <Route path="/chats/:chatId" element={<ChatListPage />} />
        <Route path="/contacts" element={<ContactsPlaceholderPage />} />
        <Route path="/later" element={<LaterPage />} />
        <Route path="/change-password" element={<ChangePasswordPage />} />
      </Route>
      <Route path="*" element={<NotFoundPage />} />
    </Routes>
  )
}
