import '@testing-library/jest-dom/vitest'
import { afterAll, afterEach, beforeAll } from 'vitest'
import { server } from '../../mocks/server'
import { resetAuthData } from '../../mocks/data/auth'

beforeAll(() => {
  server.listen()
})

afterEach(() => {
  server.resetHandlers()
  resetAuthData()
})

afterAll(() => {
  server.close()
})
