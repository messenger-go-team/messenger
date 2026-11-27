import { useEffect } from 'react'
import { installKeyboardShellSync } from '@/lib/dismissVirtualKeyboard'

/** Глобальный sync оболочки после закрытия системной клавиатуры на mobile. */
export function useKeyboardShellSync(): void {
  useEffect(() => installKeyboardShellSync(), [])
}
