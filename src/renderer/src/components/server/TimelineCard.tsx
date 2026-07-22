import { useEffect, useMemo, useState } from 'react'
import type { LocalServer, ServerTimeline, TimelineEventKind } from '@shared/types'
import { IconGauge } from '../../icons'

/**
 * A server's last day, drawn so a failure can be read rather than reconstructed.
 *
 * Memory and players share one time axis with the lifecycle events marked on it,
 * because the useful sentence is almost always about both at once — "memory
 * climbed all evening, then it was restarted at 11" is invisible in either
 * stream alone.
 */

/** Semantic colour per event, separate from the app accent: red reads as trouble. */
const EVENT_STYLE: Record<TimelineEventKind, { color: string; label: string }> = {
  start: { color: 'var(--green, #4a7c59)', label: 'Started' },
  ready: { color: 'var(--green, #4a7c59)', label: 'Online' },
  stop: { color: 'var(--muted, #7b8794)', label: 'Stopped' },
  crash: { color: 'var(--red, #b4453f)', label: 'Crashed' },
  restart: { color: 'var(--amber, #b4762a)', label: 'Restarted' },
  oom: { color: 'var(--red, #b4453f)', label: 'Memory restart' },
  sleep: { color: 'var(--accent, #4d7cfe)', label: 'Slept' },
  wake: { color: 'var(--accent, #4d7cfe)', label: 'Woke' },
  backup: { color: 'var(--muted, #7b8794)', label: 'Backed up' }
}

const fmtClock = (t: number): string =>
  new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

export default function TimelineCard({ server }: { server: LocalServer }): React.JSX.Element | null {
  const [data, setData] = useState<ServerTimeline | null>(null)

  useEffect(() => {
    if (!server.automation?.timeline) return
    let alive = true
    const load = (): void => {
      window.elauncher.server
        .getTimeline(server.id)
        .then((t) => alive && setData(t))
        .catch(() => {})
    }
    load()
    const poll = setInterval(load, 30_000)
    return () => {
      alive = false
      clearInterval(poll)
    }
  }, [server.id, server.automation?.timeline])

  const view = useMemo(() => {
    if (!data || data.samples.length < 2) return null
    const samples = data.samples
    const from = samples[0].t
    const to = samples[samples.length - 1].t
    const span = Math.max(1, to - from)
    const peakMem = Math.max(1, ...samples.map((s) => s.memMb ?? 0))
    const peakPlayers = Math.max(1, ...samples.map((s) => s.players))

    const x = (t: number): number => ((t - from) / span) * 100
    // memory as an area, players as a line — two shapes so they never read as
    // the same quantity on one axis
    const memPath = samples.map((s, i) => `${i === 0 ? 'M' : 'L'} ${x(s.t)} ${40 - ((s.memMb ?? 0) / peakMem) * 40}`).join(' ')
    const memArea = `${memPath} L 100 40 L 0 40 Z`
    const playerPath = samples
      .map((s, i) => `${i === 0 ? 'M' : 'L'} ${x(s.t)} ${40 - (s.players / peakPlayers) * 34}`)
      .join(' ')

    return {
      from,
      to,
      peakMem,
      peakPlayers,
      memArea,
      playerPath,
      // only events inside the sampled window can be positioned honestly
      events: data.events.filter((e) => e.t >= from && e.t <= to).map((e) => ({ ...e, x: x(e.t) })),
      // events older than the window still matter — list them without a mark
      older: data.events.filter((e) => e.t < from).slice(-4).reverse()
    }
  }, [data])

  if (!server.automation?.timeline) return null

  return (
    <div className="card settings-section">
      <div className="section-title">
        <span className="row" style={{ gap: 9 }}>
          <IconGauge size={15} /> History
        </span>
        {view && (
          <span className="small faint" style={{ marginLeft: 'auto' }}>
            {fmtClock(view.from)} – {fmtClock(view.to)}
          </span>
        )}
      </div>

      {!view ? (
        <div className="hint">
          Nothing recorded yet — history is sampled while the server runs, so this fills in a few minutes after it
          starts.
        </div>
      ) : (
        <>
          <div style={{ position: 'relative' }}>
            <svg viewBox="0 0 100 40" preserveAspectRatio="none" style={{ width: '100%', height: 120, display: 'block' }}>
              <path d={view.memArea} fill="var(--accent, #4d7cfe)" opacity="0.16" />
              <path
                d={view.playerPath}
                fill="none"
                stroke="var(--green, #4a7c59)"
                strokeWidth="0.8"
                vectorEffect="non-scaling-stroke"
              />
              {view.events.map((e, i) => (
                <line
                  key={i}
                  x1={e.x}
                  x2={e.x}
                  y1="0"
                  y2="40"
                  stroke={EVENT_STYLE[e.kind]?.color ?? 'var(--muted)'}
                  strokeWidth="1"
                  vectorEffect="non-scaling-stroke"
                  opacity="0.75"
                />
              ))}
            </svg>
          </div>

          <div className="row small faint" style={{ gap: 14, flexWrap: 'wrap', marginTop: 6 }}>
            <span>
              <span style={{ color: 'var(--accent, #4d7cfe)' }}>■</span> Memory · peak{' '}
              {(view.peakMem / 1024).toFixed(1)} GB
            </span>
            <span>
              <span style={{ color: 'var(--green, #4a7c59)' }}>—</span> Players · peak {view.peakPlayers}
            </span>
          </div>

          {view.events.length > 0 && (
            <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 5 }}>
              {[...view.events].reverse().slice(0, 8).map((e, i) => (
                <div key={i} className="row small" style={{ gap: 9 }}>
                  <span className="faint" style={{ fontVariantNumeric: 'tabular-nums', minWidth: 44 }}>
                    {fmtClock(e.t)}
                  </span>
                  <span style={{ color: EVENT_STYLE[e.kind]?.color, fontWeight: 600, minWidth: 96 }}>
                    {EVENT_STYLE[e.kind]?.label ?? e.kind}
                  </span>
                  <span className="faint">{e.detail}</span>
                </div>
              ))}
            </div>
          )}

          {view.older.length > 0 && (
            <div className="hint" style={{ marginTop: 10 }}>
              Earlier: {view.older.map((e) => `${EVENT_STYLE[e.kind]?.label ?? e.kind} ${fmtClock(e.t)}`).join(' · ')}
            </div>
          )}
        </>
      )}
    </div>
  )
}
