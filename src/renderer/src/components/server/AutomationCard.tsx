import { useEffect, useState } from 'react'
import type { LocalServer, ServerAutomation } from '@shared/types'
import { useToast } from '../../toast'
import { IconZap } from '../../icons'
import Select from '../Select'

const SAVE_MINUTES = [0, 5, 10, 15, 30, 60]
const RESTART_HOURS = [4, 6, 8, 12, 24]
const BACKUP_HOURS = [0, 1, 3, 6, 12, 24]
const KEEP_OPTIONS = [3, 5, 10, 20]

/** Scheduled saves/restarts/backups + lifecycle switches; identical for every game. */
export default function AutomationCard({ server }: { server: LocalServer }): React.JSX.Element {
  const toast = useToast()
  const [auto, setAuto] = useState<ServerAutomation>(server.automation ?? {})
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    setAuto(server.automation ?? {})
    setDirty(false)
    // reload only when switching servers — not on every record refresh mid-edit
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [server.id])

  const patch = (p: Partial<ServerAutomation>): void => {
    setAuto((a) => ({ ...a, ...p }))
    setDirty(true)
  }

  const save = async (): Promise<void> => {
    if (typeof window.elauncher.server.setAutomation !== 'function') {
      toast.error('The launcher core is out of date — restart ELauncher (or npm run dev) and try again.')
      return
    }
    setSaving(true)
    try {
      await window.elauncher.server.setAutomation(server.id, auto)
      setDirty(false)
      toast.success('Automation saved — schedules run while the server is online')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not save automation')
    } finally {
      setSaving(false)
    }
  }

  const restartValue =
    auto.restartMode === 'interval'
      ? `every-${auto.restartEveryHours ?? 6}`
      : auto.restartMode === 'daily'
        ? 'daily'
        : 'off'
  const restartOn = auto.restartMode === 'interval' || auto.restartMode === 'daily'

  return (
    <div className="card settings-section">
      <div className="section-title">
        <span className="row" style={{ gap: 9 }}>
          <IconZap size={15} /> Automation
        </span>
      </div>
      <div className="props-grid">
        <div className="field">
          <label>Auto-save world</label>
          <Select
            value={String(auto.saveIntervalMin ?? 0)}
            onChange={(v) => patch({ saveIntervalMin: Number(v) })}
            options={SAVE_MINUTES.map((m) => ({ value: String(m), label: m === 0 ? 'Off' : `Every ${m} min` }))}
          />
        </div>
        <div className="field">
          <label>Scheduled restart</label>
          <Select
            value={restartValue}
            onChange={(v) => {
              if (v === 'off') patch({ restartMode: 'off' })
              else if (v === 'daily') patch({ restartMode: 'daily', restartDailyAt: auto.restartDailyAt ?? '04:00' })
              else patch({ restartMode: 'interval', restartEveryHours: Number(v.replace('every-', '')) })
            }}
            options={[
              { value: 'off', label: 'Off' },
              ...RESTART_HOURS.map((h) => ({ value: `every-${h}`, label: `Every ${h} hours` })),
              { value: 'daily', label: 'Daily at a set time' }
            ]}
          />
        </div>
        {auto.restartMode === 'daily' && (
          <div className="field">
            <label>Restart time</label>
            <input
              type="time"
              value={auto.restartDailyAt ?? '04:00'}
              onChange={(e) => patch({ restartDailyAt: e.target.value || '04:00' })}
            />
          </div>
        )}
        {restartOn && (
          <div className="field">
            <label>Warn players (minutes)</label>
            <input
              type="number"
              min={1}
              max={15}
              value={auto.restartWarningMin ?? 5}
              onChange={(e) => patch({ restartWarningMin: Math.min(15, Math.max(1, Number(e.target.value) || 5)) })}
            />
          </div>
        )}
        <div className="field">
          <label>World backups</label>
          <Select
            value={String(auto.backupIntervalHours ?? 0)}
            onChange={(v) => patch({ backupIntervalHours: Number(v) })}
            options={BACKUP_HOURS.map((h) => ({ value: String(h), label: h === 0 ? 'Off' : `Every ${h} hour${h === 1 ? '' : 's'}` }))}
          />
        </div>
        {(auto.backupIntervalHours ?? 0) > 0 && (
          <div className="field">
            <label>Keep backups</label>
            <Select
              value={String(auto.backupKeep ?? 5)}
              onChange={(v) => patch({ backupKeep: Number(v) })}
              options={KEEP_OPTIONS.map((k) => ({ value: String(k), label: `Last ${k}` }))}
            />
          </div>
        )}
        <div className="field">
          <label>Restart above memory</label>
          <Select
            value={String(auto.restartAboveMemoryMB ?? 0)}
            onChange={(v) => patch({ restartAboveMemoryMB: Number(v) })}
            options={[0, 4096, 6144, 8192, 10240, 12288, 16384].map((mb) => ({
              value: String(mb),
              label: mb === 0 ? 'Off' : `${mb / 1024} GB`
            }))}
          />
          <div className="hint">Warned restart when the server process crosses this — tames Palworld's slow memory creep.</div>
        </div>
      </div>
      <label className="checkbox-row">
        <input
          type="checkbox"
          checked={Boolean(auto.restartOnCrash)}
          onChange={(e) => patch({ restartOnCrash: e.target.checked })}
        />
        <span>
          Restart automatically after a crash{' '}
          <span className="faint small">— skipped when it crashes right after boot, to avoid a loop</span>
        </span>
      </label>
      <label className="checkbox-row">
        <input type="checkbox" checked={Boolean(auto.autoStart)} onChange={(e) => patch({ autoStart: e.target.checked })} />
        <span>Start this server when the launcher opens</span>
      </label>
      <div className="row">
        <button className="primary" disabled={saving || !dirty} onClick={() => void save()}>
          {saving ? 'Saving…' : 'Save automation'}
        </button>
        <span className="small faint">
          restarts warn players in-game first; backups land in the server folder under backups/
        </span>
      </div>
    </div>
  )
}
