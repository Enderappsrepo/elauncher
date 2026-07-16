import { useEffect, useState } from 'react'

export type Theme = 'dark' | 'light'

const STORAGE_KEY = 'elauncher.theme'

/** Native titlebar caption-button colors per theme (Windows overlay). */
const TITLEBAR: Record<Theme, { color: string; symbolColor: string }> = {
  dark: { color: '#0b0b11', symbolColor: '#a0a3b6' },
  light: { color: '#f5f6fb', symbolColor: '#565b73' }
}

export function getTheme(): Theme {
  return localStorage.getItem(STORAGE_KEY) === 'light' ? 'light' : 'dark'
}

const listeners = new Set<(t: Theme) => void>()

/** Paint the DOM + native titlebar for a theme without persisting it. */
export function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme
  // best-effort: the titlebar overlay only exists on the Windows frameless window
  void window.elauncher?.app?.setTitleBarTheme(TITLEBAR[theme]).catch(() => {})
}

export function setTheme(theme: Theme): void {
  localStorage.setItem(STORAGE_KEY, theme)
  applyTheme(theme)
  listeners.forEach((fn) => fn(theme))
}

/** React hook: current theme + a toggle. Kept in sync across every mounted toggle. */
export function useTheme(): [Theme, () => void] {
  const [theme, setLocal] = useState<Theme>(getTheme)
  useEffect(() => {
    listeners.add(setLocal)
    return () => {
      listeners.delete(setLocal)
    }
  }, [])
  return [theme, () => setTheme(theme === 'dark' ? 'light' : 'dark')]
}
