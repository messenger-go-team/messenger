import { setupServer } from 'msw/node'
import { handlers } from './handlers'

/** Node MSW server для Vitest, использующий те же handlers, что и browser worker. */
export const server = setupServer(...handlers)
