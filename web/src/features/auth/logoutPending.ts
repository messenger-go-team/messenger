const STORAGE_KEY = 'tiding.logoutPending'

/** Ключ sessionStorage: незавершённый выход должен пережить перезагрузку вкладки. */
export const LOGOUT_PENDING_KEY = STORAGE_KEY

/** Читает отметку, что refresh-cookie ещё нужно отозвать. */
export function readLogoutPending(): boolean {
  try {
    return sessionStorage.getItem(STORAGE_KEY) === '1'
  } catch {
    return false
  }
}

/** Ставит или снимает отметку до запроса, чтобы reload не восстановил сессию. */
export function writeLogoutPending(pending: boolean): void {
  try {
    if (pending) {
      sessionStorage.setItem(STORAGE_KEY, '1')
    } else {
      sessionStorage.removeItem(STORAGE_KEY)
    }
  } catch {
    // sessionStorage может быть недоступен — выход всё равно уйдёт в этой вкладке.
  }
}
