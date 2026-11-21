import { AppRouter } from '@/app/AppRouter'
import { AuthProvider } from '@/features/auth/AuthProvider'
import { WsProvider } from '@/features/ws/WsProvider'

/** Корневой компонент приложения: сессия, WebSocket и маршруты. */
function App() {
  return (
    <AuthProvider>
      <WsProvider>
        <AppRouter />
      </WsProvider>
    </AuthProvider>
  )
}

export default App
