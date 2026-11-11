import { useEffect, useRef, type ReactNode } from 'react'
import { api } from './format'

/** Each step's title takes focus when the step opens, so keyboard and screen-reader users land on it. */
export function StepTitle({ children }: { children: ReactNode }): React.JSX.Element {
  const ref = useRef<HTMLHeadingElement>(null)
  useEffect(() => ref.current?.focus(), [])
  return (
    <h1 ref={ref} tabIndex={-1}>
      {children}
    </h1>
  )
}

/** The window never navigates; web links open in the player's browser. */
export function ExternalLink({ href, children }: { href: string; children: ReactNode }): React.JSX.Element {
  return (
    <a
      className="link"
      href={href}
      onClick={(e) => {
        e.preventDefault()
        void api.openExternal(href)
      }}
    >
      {children}
    </a>
  )
}

export function Notice({ tone = 'info', children }: { tone?: 'info' | 'warn' | 'error'; children: ReactNode }): React.JSX.Element {
  if (tone === 'error') return <div className="formerr" role="alert">{children}</div>
  return <div className={tone === 'warn' ? 'formwarn' : 'formnote'} role="status">{children}</div>
}
