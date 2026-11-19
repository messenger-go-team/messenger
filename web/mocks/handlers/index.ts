import { authHandlers } from './auth'
import { historyHandlers } from './history'
import { laterHandlers } from './later'

/** Единый порядок handlers используется browser worker и Node test server без расхождений. */
export const handlers = [...authHandlers, ...historyHandlers, ...laterHandlers]
