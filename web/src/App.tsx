import { AppRouter } from '@/app/AppRouter'
import { AuthProvider } from '@/features/auth/AuthProvider'

/** Корневой компонент приложения: сессия и маршруты. */
function App() {
  return (
    <AuthProvider>
      <AppRouter />
    </AuthProvider>
  )
}

export default App
