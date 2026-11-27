import { BrowserRouter } from 'react-router'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { appBasename } from '@/app/basename'
import './index.css'
import App from './App.tsx'

/**
 * Динамически загружает MSW только в явно включённом mock-режиме.
 * Это не добавляет worker в startup path приложения, работающего с реальным backend.
 */
async function enableMocking() {
  if (import.meta.env.VITE_API_MOCK !== 'true') {
    return
  }

  const { worker } = await import('../mocks/browser')
  const { seedAliceDemoContacts } = await import('../mocks/data/auth')

  await worker.start()
  // Длинный список контактов для локальной/телефонной приёмки (Vitest этот путь не грузит).
  seedAliceDemoContacts()
}

/** Запускает MSW до React render, чтобы первые API-запросы компонентов не ушли в сеть. */
async function bootstrap() {
  await enableMocking()

  const basename = appBasename(import.meta.env.BASE_URL)

  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <BrowserRouter basename={basename || undefined}>
        <App />
      </BrowserRouter>
    </StrictMode>,
  )
}
void bootstrap()
