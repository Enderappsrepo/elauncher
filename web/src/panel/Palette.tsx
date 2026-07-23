import { useEffect } from 'react'
import { Command } from 'cmdk'
import { Activity, Play, ReceiptText, Server, ShieldCheck, ShoppingBag, Square } from 'lucide-react'
import { toast } from 'sonner'
import { AnimatePresence, motion } from '@web/ui/motion'
import { gameLabel } from '@web/lib/games'
import type { ServerRow } from './data'

/* The command palette: every server and screen, one keystroke away.
 *
 * On a phone this is reachable from the search button in the top bar; on a
 * desktop it is ⌘K/Ctrl-K. It deliberately reuses the relay's own verbs —
 * "start"/"stop" here queue exactly what the card buttons queue, so there is
 * one behaviour to trust, not two.
 */

export type PaletteSection = 'servers' | 'shop' | 'billing' | 'health' | 'admin'

const SECTION_ITEMS: ReadonlyArray<{ id: PaletteSection; label: string; icon: React.JSX.Element }> = [
  { id: 'servers', label: 'Servers', icon: <Server size={15} /> },
  { id: 'shop', label: 'Shop', icon: <ShoppingBag size={15} /> },
  { id: 'billing', label: 'Billing', icon: <ReceiptText size={15} /> },
  { id: 'health', label: 'Health', icon: <Activity size={15} /> },
  { id: 'admin', label: 'Admin', icon: <ShieldCheck size={15} /> }
]

export function Palette({
  open,
  onClose,
  servers,
  isAdmin,
  goSection,
  openServer,
  control
}: {
  open: boolean
  onClose: () => void
  servers: ServerRow[]
  isAdmin: boolean
  goSection: (section: PaletteSection) => void
  openServer: (id: string) => void
  control: (row: ServerRow, action: 'start' | 'stop') => Promise<void>
}): React.JSX.Element {
  // palette-local shortcut: Escape closes (cmdk handles arrows/enter)
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  function run(fn: () => void): void {
    onClose()
    fn()
  }

  function power(row: ServerRow, action: 'start' | 'stop'): void {
    run(() => {
      // the toast is about the send, not the outcome — the card's status pill
      // reports the real state when the host does
      toast.promise(control(row, action), {
        loading: `Sending ${action} to ${row.name}…`,
        success: `${action === 'start' ? 'Start' : 'Stop'} sent to ${row.name}`,
        error: (e: unknown) => (e instanceof Error ? e.message : 'Could not send that.')
      })
    })
  }

  const sections = SECTION_ITEMS.filter((s) => s.id !== 'admin' || isAdmin)

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="palette-veil"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.16 }}
          onClick={onClose}
        >
          <motion.div
            className="palette"
            role="dialog"
            aria-label="Command palette"
            initial={{ opacity: 0, y: 14, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.985 }}
            transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
            onClick={(e) => e.stopPropagation()}
          >
            <Command label="Command palette" loop>
              <Command.Input placeholder="Jump to a server, screen or action…" autoFocus />
              <Command.List>
                <Command.Empty>Nothing matches — try a server name.</Command.Empty>

                {servers.length > 0 && (
                  <Command.Group heading="Servers">
                    {servers.map((row) => (
                      <Command.Item
                        key={row.server_id}
                        value={`open ${row.name} ${gameLabel(row.game)}`}
                        onSelect={() => run(() => openServer(row.server_id))}
                      >
                        <Server size={15} aria-hidden />
                        <span className="pal-label">{row.name}</span>
                        <span className={`pal-state ${row.state}`}>{row.state}</span>
                      </Command.Item>
                    ))}
                  </Command.Group>
                )}

                <Command.Group heading="Go to">
                  {sections.map((s) => (
                    <Command.Item key={s.id} value={`go ${s.label}`} onSelect={() => run(() => goSection(s.id))}>
                      {s.icon}
                      <span className="pal-label">{s.label}</span>
                    </Command.Item>
                  ))}
                </Command.Group>

                {servers.length > 0 && (
                  <Command.Group heading="Power">
                    {servers
                      .filter((r) => r.state === 'stopped' || r.state === 'error')
                      .map((row) => (
                        <Command.Item
                          key={`start-${row.server_id}`}
                          value={`start ${row.name}`}
                          onSelect={() => power(row, 'start')}
                        >
                          <Play size={15} aria-hidden />
                          <span className="pal-label">Start {row.name}</span>
                        </Command.Item>
                      ))}
                    {servers
                      .filter((r) => r.state === 'running')
                      .map((row) => (
                        <Command.Item
                          key={`stop-${row.server_id}`}
                          value={`stop ${row.name}`}
                          onSelect={() => power(row, 'stop')}
                        >
                          <Square size={15} aria-hidden />
                          <span className="pal-label">Stop {row.name}</span>
                        </Command.Item>
                      ))}
                  </Command.Group>
                )}
              </Command.List>
            </Command>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
