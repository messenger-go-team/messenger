import { BrowserRouter } from 'react-router'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
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

  await worker.start()
}

/** Запускает MSW до React render, чтобы первые API-запросы компонентов не ушли в сеть. */
async function bootstrap() {
  await enableMocking()

  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </StrictMode>,
  )
}
void bootstrap()
