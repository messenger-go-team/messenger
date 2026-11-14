import '@testing-library/jest-dom/vitest'
import { afterAll, afterEach, beforeAll } from 'vitest'
import { server } from '../../mocks/server'
import { resetAuthData } from '../../mocks/data/auth'
import { resetHistoryData } from '../../mocks/data/history'

// Один server обслуживает весь test run; незамоканные запросы MSW сообщает стандартным способом.
beforeAll(() => {
  server.listen()
})

afterEach(() => {
  // Сначала убираем временные handlers теста, затем восстанавливаем независимые data stores.
  server.resetHandlers()
  resetHistoryData()
  resetAuthData()
})

afterAll(() => {
  server.close()
})
