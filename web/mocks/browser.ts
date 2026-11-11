import { setupWorker } from 'msw/browser'
import { handlers } from './handlers'

/** Browser MSW worker; запускается только при `VITE_API_MOCK=true`. */
export const worker = setupWorker(...handlers)
