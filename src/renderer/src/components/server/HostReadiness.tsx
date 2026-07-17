import { useEffect, useState } from 'react'
import type { HostReport, HostVerdict } from '@shared/types'
import { IconGauge } from '../../icons'

const VERDICT_STYLE: Record<HostVerdict, { label: string; color: string; bg: string }> = {
  great: { label: 'Great', color: 'var(--green)', bg: 'var(--green-soft)' },
  good: { label: 'Good', color: 'var(--accent)', bg: 'var(--accent-soft)' },
  tight: { label: 'Tight', color: '#fbbf24', bg: 'rgba(251, 191, 36, 0.12)' },
  no: { label: 'Not recommended', color: 'var(--red)', bg: 'var(--red-soft)' }
}

/** "This PC as a host" — honest per-game estimates from the machine's real specs. */
export default function HostReadiness(): React.JSX.Element | null {
  const [report, setReport] = useState<HostReport | null>(null)

  useEffect(() => {
    window.elauncher.host.report().then(setReport).catch(() => {})
  }, [])

  if (!report) return null
  const { specs } = report

  return (
    <div style={{ marginTop: 28 }}>
      <div className="home-section" style={{ margin: '0 0 14px' }}>
        <h2>
          <IconGauge size={16} /> This PC as a host
        </h2>
        <span className="small faint">rough estimates</span>
      </div>
      <div className="card settings-section">
        <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
          <span className="chip on-banner">{specs.cpuModel}</span>
          <span className="chip on-banner">
            {specs.threads} threads · {specs.speedGHz} GHz
          </span>
          <span className="chip on-banner">{specs.ramGB} GB RAM</span>
          <span className="chip on-banner">{specs.diskType === 'Unknown' ? 'Disk: unknown' : `${specs.diskType} storage`}</span>
        </div>

        {report.games.map((game) => {
          const style = VERDICT_STYLE[game.verdict]
          return (
            <div
              key={game.game}
              className="row"
              style={{ gap: 10, padding: '10px 0 8px', borderTop: '1px solid rgba(255,255,255,.06)', flexWrap: 'wrap' }}
            >
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ fontWeight: 650 }}>{game.game}</div>
                <div className="small faint">{game.note}</div>
              </div>
              {game.verdict !== 'no' && <span className="small faint">{game.players} players</span>}
              <span className="chip" style={{ color: style.color, background: style.bg, borderColor: 'transparent' }}>
                {style.label}
              </span>
            </div>
          )
        })}

        <div style={{ marginTop: 4 }}>
          {report.limitations.map((limit, i) => (
            <div key={i} className="hint" style={{ marginTop: 4 }}>
              • {limit}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
