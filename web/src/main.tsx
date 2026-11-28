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
  const { findHistoryMessage } = await import('../mocks/data/history')
  const { seedLaterMocks } = await import('../mocks/handlers/later')

  await worker.start()
  // Длинный список контактов для локальной/телефонной приёмки (Vitest этот путь не грузит).
  seedAliceDemoContacts()
  // Due-напоминание для пути «Открыть» → чат → подсветка (#45 phone AC).
  const target = findHistoryMessage('20000000-0000-4000-8000-000000000003')
  if (target) {
    const now = new Date().toISOString()
    seedLaterMocks([
      {
        id: '30000000-0000-4000-8000-000000000001',
        message: target,
        due_at: '2020-01-01T00:00:00.000Z',
        created_at: now,
        updated_at: now,
      },
    ])
  }
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
