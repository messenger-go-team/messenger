const STORAGE_KEY = 'tiding.rememberUsername'

/** Читает сохранённый логин для чекбокса «Запомнить меня». */
export function readRememberedUsername(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY)
  } catch {
    return null
  }
}

/** Сохраняет или очищает логин в зависимости от «Запомнить меня». */
export function writeRememberedUsername(username: string, remember: boolean): void {
  try {
    if (remember) {
      localStorage.setItem(STORAGE_KEY, username)
    } else {
      localStorage.removeItem(STORAGE_KEY)
    }
  } catch {
    // localStorage может быть недоступен (приватный режим) — игнорируем.
  }
}
