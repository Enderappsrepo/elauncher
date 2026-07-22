import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'

/* Panel primitives. Styles live in styles/ui.css so the whole component layer
 * can be read in one place rather than reconstructed from a dozen files. */

export type RunState = 'running' | 'stopped' | 'starting' | 'stopping' | 'error' | 'archived'

const PILL_CLASS: Record<RunState, string> = {
  running: 'running',
  stopped: 'stopped',
  starting: 'busy',
  stopping: 'busy',
  error: 'error',
  archived: 'stopped'
}

const PILL_LABEL: Record<RunState, string> = {
  running: 'Running',
  stopped: 'Stopped',
  starting: 'Starting',
  stopping: 'Stopping',
  error: 'Crashed',
  archived: 'Archived'
}

export function StatusPill({ state }: { state: RunState }): React.JSX.Element {
  return (
    <span className={`pill ${PILL_CLASS[state]}`}>
      <span className="dot" aria-hidden />
      {PILL_LABEL[state]}
    </span>
  )
}

type ButtonProps = {
  children: ReactNode
  variant?: 'primary' | 'danger' | 'ghost'
  size?: 'sm'
  block?: boolean
} & React.ButtonHTMLAttributes<HTMLButtonElement>

export function Button({ children, variant, size, block, className = '', ...rest }: ButtonProps): React.JSX.Element {
  const classes = ['btn', variant, size, block ? 'block' : '', className].filter(Boolean).join(' ')
  return (
    <button className={classes} {...rest}>
      {children}
    </button>
  )
}

/**
 * Tab strip with a single indicator that slides between items.
 *
 * Measured from the DOM rather than computed from widths: the labels are
 * variable-width and the strip scrolls sideways on a phone, so the only
 * trustworthy source for where a tab actually is, is the tab.
 */
export function Tabs<T extends string>({
  tabs,
  value,
  onChange,
  labels
}: {
  tabs: readonly T[]
  value: T
  onChange: (tab: T) => void
  labels: Record<T, string>
}): React.JSX.Element {
  const stripRef = useRef<HTMLDivElement>(null)
  const [ink, setInk] = useState<{ left: number; width: number } | null>(null)

  useLayoutEffect(() => {
    const strip = stripRef.current
    if (!strip) return
    const measure = (): void => {
      const active = strip.querySelector<HTMLElement>('[aria-selected="true"]')
      if (active) setInk({ left: active.offsetLeft, width: active.offsetWidth })
    }
    measure()
    // labels reflow on resize and when a font finally lands
    const observer = new ResizeObserver(measure)
    observer.observe(strip)
    return () => observer.disconnect()
  }, [value, tabs])

  useEffect(() => {
    const strip = stripRef.current
    const active = strip?.querySelector<HTMLElement>('[aria-selected="true"]')
    // keep the selected tab reachable when the strip is scrolled past it
    active?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' })
  }, [value])

  return (
    <div className="tabs" role="tablist" ref={stripRef}>
      {ink && <span className="tab-ink" style={{ transform: `translateX(${ink.left}px)`, width: ink.width }} />}
      {tabs.map((tab) => (
        <button
          key={tab}
          role="tab"
          aria-selected={tab === value}
          className="tab"
          onClick={() => onChange(tab)}
        >
          {labels[tab]}
        </button>
      ))}
    </div>
  )
}

/** Classify a log line for colour. Every game writes its own format; these are
 *  the shapes they share rather than any one server's grammar. */
function lineTone(line: string): string {
  if (/\b(ERROR|SEVERE|FATAL|Exception|failed)\b/i.test(line)) return 'err'
  if (/\bWARN(ING)?\b/i.test(line)) return 'warn'
  if (/\b(joined|left|logged in|Done \()/i.test(line)) return 'say'
  return ''
}

/**
 * Console view.
 *
 * Sticks to the bottom only when the reader is already there — scrolling up to
 * read something and being yanked back down by the next line is the single most
 * irritating thing a live log can do.
 */
export function Console({
  text,
  freshFrom,
  children
}: {
  text: string
  /** index of the first line that arrived in the latest push, for the flash */
  freshFrom?: number
  children?: ReactNode
}): React.JSX.Element {
  const logRef = useRef<HTMLDivElement>(null)
  const pinned = useRef(true)

  const lines = text ? text.split('\n') : []

  useLayoutEffect(() => {
    const el = logRef.current
    if (el && pinned.current) el.scrollTop = el.scrollHeight
  }, [text])

  const onScroll = (): void => {
    const el = logRef.current
    if (!el) return
    pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
  }

  return (
    <div className="console">
      <div className="console-log" ref={logRef} onScroll={onScroll}>
        {lines.map((line, i) => (
          <span
            key={`${i}-${line}`}
            className={`console-line ${lineTone(line)} ${freshFrom !== undefined && i >= freshFrom ? 'fresh' : ''}`}
          >
            {line || ' '}
          </span>
        ))}
      </div>
      {children && <div className="console-bar">{children}</div>}
    </div>
  )
}

export function Skeleton({ height, width }: { height: number; width?: number | string }): React.JSX.Element {
  return <div className="skeleton" style={{ height, width: width ?? '100%' }} />
}
