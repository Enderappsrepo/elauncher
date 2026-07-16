import { useEffect, useRef, useState, type ReactNode } from 'react'
import { IconDots } from '../icons'

interface MenuProps {
  children: ReactNode
  trigger?: ReactNode
}

/** Small dropdown menu anchored to a trigger button, closes on outside click / Escape. */
export default function Menu({ children, trigger }: MenuProps): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div
      className="menu-anchor"
      ref={ref}
      onClick={(e) => e.stopPropagation()}
    >
      <button
        className="icon-btn"
        aria-label="More actions"
        onClick={() => setOpen((o) => !o)}
      >
        {trigger ?? <IconDots size={16} />}
      </button>
      {open && (
        <div className="menu" onClick={() => setOpen(false)}>
          {children}
        </div>
      )}
    </div>
  )
}
