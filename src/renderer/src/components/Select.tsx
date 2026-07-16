import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { IconCheck, IconChevronDown } from '../icons'

export interface SelectOption {
  value: string
  label: string
}

interface Props {
  value: string
  options: SelectOption[]
  onChange: (value: string) => void
  placeholder?: string
  disabled?: boolean
  style?: CSSProperties
}

/**
 * Themed dropdown replacing native <select>, whose OS popup is unreliable in
 * frameless Electron windows on Windows (electron#29665 and friends).
 */
export default function Select({
  value,
  options,
  onChange,
  placeholder = 'Select…',
  disabled,
  style
}: Props): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [openUp, setOpenUp] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const selected = options.find((o) => o.value === value)

  const toggle = (): void => {
    if (!open && ref.current) {
      // flip upward when the trigger is near the bottom of the window
      const rect = ref.current.getBoundingClientRect()
      setOpenUp(window.innerHeight - rect.bottom < 300 && rect.top > window.innerHeight - rect.bottom)
    }
    setOpen((o) => !o)
  }

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    // capture phase so Escape closes only the dropdown, not a surrounding modal
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopImmediatePropagation()
        setOpen(false)
      }
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [open])

  useEffect(() => {
    if (open) {
      listRef.current
        ?.querySelector('.select-option.selected')
        ?.scrollIntoView({ block: 'nearest' })
    }
  }, [open])

  return (
    <div className="select" ref={ref} style={style} onClick={(e) => e.stopPropagation()}>
      <button
        type="button"
        className={`select-trigger${open ? ' open' : ''}`}
        disabled={disabled}
        onClick={toggle}
      >
        <span className={`select-label${selected ? '' : ' faint'}`}>{selected?.label ?? placeholder}</span>
        <span className="chev">
          <IconChevronDown size={15} />
        </span>
      </button>
      {open && (
        <div className={`select-menu${openUp ? ' up' : ''}`} ref={listRef}>
          {options.length === 0 ? (
            <div className="select-empty">No options</div>
          ) : (
            options.map((o) => (
              <button
                type="button"
                key={o.value}
                className={`select-option${o.value === value ? ' selected' : ''}`}
                onClick={() => {
                  onChange(o.value)
                  setOpen(false)
                }}
              >
                <span className="opt-label">{o.label}</span>
                {o.value === value && <IconCheck size={14} />}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  )
}
