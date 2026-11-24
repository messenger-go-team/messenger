import { AppRouter } from '@/app/AppRouter'
import { AuthProvider } from '@/features/auth/AuthProvider'
import { LaterRemindersProvider } from '@/features/later/LaterRemindersProvider'
import { WsProvider } from '@/features/ws/WsProvider'

/** Корневой компонент приложения: сессия, WebSocket, Later-напоминания и маршруты. */
function App() {
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
