import { AppRouter } from '@/app/AppRouter'
import { AuthProvider } from '@/features/auth/AuthProvider'
import { LaterRemindersProvider } from '@/features/later/LaterRemindersProvider'
import { WsProvider } from '@/features/ws/WsProvider'
import { useKeyboardShellSync } from '@/lib/useKeyboardShellSync'

/** Корневой компонент приложения: сессия, WebSocket, Later-напоминания и маршруты. */
function App() {
  // iOS: системная «скрыть клавиатуру» иначе оставляет композер/табы на прежней высоте.
  useKeyboardShellSync()

  return (
    <AuthProvider>
      <WsProvider>
        <LaterRemindersProvider>
          <AppRouter />
        </LaterRemindersProvider>
      </WsProvider>
    </AuthProvider>
  )
}

export default App
