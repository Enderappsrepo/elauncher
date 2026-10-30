import { useCallback, useEffect, useRef, useState } from 'react'
import { Button, Spinner } from '@web/ui'
import type { NvmpSetupStatus } from '@shared/nvmpUpload'
import type { TabProps } from './types'
import { selectNvmpFiles, transferNvmpFiles, type NvmpSelection } from '../nvmpTransfer'

const message = (error: unknown): string => error instanceof Error ? error.message : String(error)
const bytes = (n: number): string => n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(2)} GB` : `${(n / 1024 ** 2).toFixed(1)} MB`
export function NvmpSetup({ row, ask, onStart }: TabProps & { onStart: () => Promise<void> }): React.JSX.Element {
  const [status, setStatus] = useState<NvmpSetupStatus | null>(null)
  const [selection, setSelection] = useState<NvmpSelection | null>(null)
  const [loadOrder, setLoadOrder] = useState('FalloutNV.esm\n')
  const [canEdit, setCanEdit] = useState(false)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [sent, setSent] = useState(0)
  const [current, setCurrent] = useState('')
  const [confirmDiscard, setConfirmDiscard] = useState(false)
  const controller = useRef<AbortController | null>(null)
  const folder = useRef<HTMLInputElement>(null)
  const active = useRef(true)
  const stopped = row.state === 'stopped'
  const refresh = useCallback(async (): Promise<NvmpSetupStatus> => {
    const next = await ask<NvmpSetupStatus>('nvmpStatus')
    if (active.current) { setStatus(next); setSent(next.receivedBytes) }
    return next
  }, [ask])
  useEffect(() => {
    active.current = true
    void Promise.all([refresh(), ask<{ canShare: boolean }>('info')]).then(([next, info]) => {
      if (active.current) { setCanEdit(info.canShare); setLoadOrder(next.loadOrder || 'FalloutNV.esm\n') }
    }).catch((e) => { if (active.current) setError(message(e)) })
    return () => { active.current = false; controller.current?.abort() }
  }, [ask, refresh])
  async function choose(files: File[]): Promise<void> {
    if (!files.length) return
    setBusy('Reading folder…'); setError(''); setNotice('')
    try { setSelection(await selectNvmpFiles(files)) } catch (e) { setSelection(null); setError(message(e)) }
    finally { setBusy('') }
  }
  async function upload(): Promise<void> {
    if (!selection || !canEdit || !stopped || busy) return
    const stop = new AbortController(); controller.current = stop
    setBusy('Uploading'); setError(''); setNotice('')
    try {
      const session = await ask<NvmpSetupStatus>('nvmpBegin', { files: selection.manifest })
      if (!active.current || stop.signal.aborted) return
      setStatus(session)
      await transferNvmpFiles(ask, selection, session, stop.signal, (count, path) => {
        if (active.current) { setSent(count); setCurrent(path) }
      })
      const next = await refresh()
      if (active.current) setNotice(stop.signal.aborted ? 'Paused. Reselect the same Data folder after reopening this page to resume.' : next.completedFiles === next.totalFiles ? 'Files uploaded. Check your load order below, then finish setup.' : 'Upload paused. You can resume from the saved progress.')
    } catch (e) { if (active.current) { setError(`${message(e)} Uploaded chunks are saved; resume to retry the missing ones.`); await refresh().catch(() => {}) } }
    finally { if (active.current) { setBusy(''); setCurrent('') }; controller.current = null }
  }
  async function finish(): Promise<void> {
    setBusy('Checking game files…'); setError(''); setNotice('')
    try {
      const next = await ask<NvmpSetupStatus>('nvmpFinish', { session: status?.session, loadOrder })
      setStatus(next); setSelection(null); setNotice('Game files validated. You can start your server now.')
    } catch (e) { setError(message(e)); await refresh().catch(() => {}) }
    finally { setBusy('') }
  }
  async function discard(): Promise<void> {
    setBusy('Discarding upload…'); setError('')
    try { const next = await ask<NvmpSetupStatus>('nvmpDiscard', { session: status?.session }); setStatus(next); setSent(0); setLoadOrder(next.loadOrder); setSelection(null); setConfirmDiscard(false); setNotice('Unfinished upload removed. Existing installed game files were kept.') }
    catch (e) { setError(message(e)) }
    finally { setBusy('') }
  }
  const complete = status && status.totalFiles > 0 && status.totalFiles === status.completedFiles
  const percent = status?.totalBytes ? Math.min(100, Math.floor(sent * 100 / status.totalBytes)) : 0
  return <section className="surface pad stack">
    <h2>NV:MP game setup</h2>
    <p>Upload the <b>Data</b> folder from your Fallout: New Vegas installation. These files belong to this server only. Every player must use matching DLCs, mods and load order.</p>
    {error && <p className="formerr" role="alert">{error}</p>}
    {notice && <p className="formnote" role="status">{notice}</p>}
    {!status && !error && <p><Spinner /> Checking setup…</p>}
    {status?.phase === 'ready' && <div className="stack">
      <p className="formnote">Game files are ready. Players join using the NV:MP launcher’s Connect via IP option.</p>
      {stopped && canEdit && <Button variant="primary" disabled={!!busy} onClick={() => { setError(''); void onStart().catch((e) => setError(message(e))) }}>Start server</Button>}
    </div>}
    {!stopped && <p className="formnote">Stop the server before changing its game files.</p>}
    {!canEdit && status && <p className="formnote">The renting customer or host can upload and replace game files.</p>}
    {canEdit && <>
      <h3>1. Choose your Data folder</h3>
      <p className="dim">Use a desktop browser with folder selection, such as Chrome or Edge. Keep this page open during transfer. If interrupted, choose the same folder again and resume. Up to 64 GB total, 16 GB per file.</p>
      <input ref={folder} type="file" multiple {...{ webkitdirectory: '' }} hidden onChange={(e) => { const files = [...(e.target.files ?? [])]; e.target.value = ''; void choose(files) }} />
      <div className="row">
        <Button disabled={!!busy || !stopped || status?.phase === 'committing'} onClick={() => folder.current?.click()}>Choose Data folder</Button>
        <Button variant="primary" disabled={!selection || !!busy || !stopped} onClick={() => void upload()}>{status?.phase === 'uploading' ? 'Resume upload' : status?.phase === 'ready' ? 'Upload replacement files' : 'Upload game files'}</Button>
        {busy === 'Uploading' && <Button onClick={() => { controller.current?.abort(); setBusy('Pausing…') }}>Pause</Button>}
      </div>
      {selection && <p>{selection.manifest.length} files selected · {bytes(selection.manifest.reduce((n, f) => n + f.size, 0))}</p>}
      {!!selection?.skipped.length && <details><summary>{selection.skipped.length} executable files excluded — DLL/native plugins need host assistance</summary><ul>{selection.skipped.slice(0, 20).map((p) => <li key={p}>{p}</li>)}</ul></details>}
      {status && status.phase !== 'ready' && status.totalFiles > 0 && <div className="stack" aria-live="polite">
        <progress value={percent} max={100} aria-label="Game files uploaded" style={{ width: '100%' }} />
        <span>{percent}% · {bytes(sent)} / {bytes(status.totalBytes)}</span>
        {current && <span className="dim" style={{ overflowWrap: 'anywhere' }}>{current}</span>}
      </div>}
      {busy && <p role="status"><Spinner /> {busy}</p>}
      {status?.phase !== 'ready' && <>
        <h3>2. Match your load order</h3>
        <p className="dim">One plugin filename per line, starting with FalloutNV.esm. Include the DLCs and mods your group uses, in the same order as your client. You can import plugins_override.txt.</p>
        <input type="file" accept=".txt" disabled={!!busy} aria-label="Import load order" onChange={(e) => { const file = e.target.files?.[0]; e.target.value = ''; if (file) { if (file.size > 65536) setError('The load order file is too large.'); else void file.text().then(setLoadOrder).catch((err) => setError(message(err))) } }} />
        <textarea aria-label="Plugin load order" rows={8} value={loadOrder} disabled={!!busy} onChange={(e) => setLoadOrder(e.target.value)} spellCheck={false} />
        <Button variant="primary" disabled={!stopped || !!busy || (!complete && status?.phase !== 'committing')} onClick={() => void finish()}>Validate files and finish setup</Button>
      </>}
      {status?.session && status.phase !== 'ready' && <div className="stack">
        {confirmDiscard ? <><p>Discard this unfinished upload? Previously installed files will be kept.</p><div className="row"><Button variant="danger" disabled={!!busy || !stopped} onClick={() => void discard()}>Discard upload</Button><Button disabled={!!busy} onClick={() => setConfirmDiscard(false)}>Keep upload</Button></div></> : <Button variant="ghost" disabled={!!busy || !stopped} onClick={() => setConfirmDiscard(true)}>Discard unfinished upload</Button>}
      </div>}
    </>}
  </section>
}
