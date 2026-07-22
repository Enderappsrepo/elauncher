import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ServerFileEntry } from '@shared/types'
import { Button, Skeleton } from '@web/ui'
import type { RequestAction } from '../relay'
import type { TabProps } from './types'
import './Files.css'

/**
 * The server folder, from a phone.
 *
 * Everything here is a round trip to a machine that may be asleep, on hotel
 * wifi, or busy generating chunks — so the tab never claims anything it has not
 * been told. A rename shows the new name because the host answered, not because
 * a button was pressed.
 */

/**
 * Transfer sizing. Bytes travel base64'd inside the relay's jsonb column and it
 * settles one request per poll, so throughput is chunk size times parallelism
 * per round trip. The host refuses a slice over 512 KB and sendRequest gives up
 * after 22 seconds — between them, that is what holds this at 256 KB.
 */
const CHUNK = 256 * 1024
const PARALLEL = 3
/** Past this an image is a download, not a preview: it has to arrive first. */
const PREVIEW_MAX = 8 * 1048576

const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico']
/** Characters Windows rejects in a name, caught here so the trip isn't wasted. */
const NAME_BAD = /[\\/:*?"<>|]/

const extOf = (name: string): string => (name.includes('.') ? name.split('.').pop()!.toLowerCase() : '')
const isImage = (name: string): boolean => IMAGE_EXTS.includes(extOf(name))
const baseOf = (rel: string): string => rel.split('/').pop() ?? rel

const fmtBytes = (n: number): string =>
  n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : n >= 1024 ? `${(n / 1024).toFixed(0)} KB` : `${n} B`

function fmtWhen(ms: number): string {
  const diff = Date.now() - ms
  if (diff < 60_000) return 'just now'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} min ago`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`
  if (diff < 6 * 86_400_000) return `${Math.floor(diff / 86_400_000)}d ago`
  return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

const msgOf = (e: unknown): string => (e instanceof Error ? e.message : 'That did not work.')

/** Safari only grew randomUUID in 15.4, and this panel lives on phones. */
const newUploadId = (): string =>
  (crypto.randomUUID?.() ?? `${Date.now()}${Math.random()}`).replace(/[^a-zA-Z0-9]/g, '')

const base64Of = (blob: Blob): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const url = String(reader.result)
      resolve(url.slice(url.indexOf(',') + 1))
    }
    reader.onerror = () => reject(new Error('Could not read that file.'))
    reader.readAsDataURL(blob)
  })

type SortKey = 'name' | 'newest' | 'largest'

type View =
  | { kind: 'list' }
  | { kind: 'edit'; rel: string; text: string; saved: string }
  | { kind: 'image'; rel: string; name: string; url: string }

/** A question the tab is waiting on an answer to, asked in place. */
type Pending =
  | { kind: 'mkdir' }
  | { kind: 'rename'; from: string }
  | { kind: 'delete'; names: string[] }
  | { kind: 'discard' }

interface Transfer {
  id: string
  name: string
  way: 'up' | 'down'
  sent: number
  total: number
  state: 'live' | 'done' | 'bad'
  error?: string
}

interface Notice {
  text: string
  bad: boolean
}

export function Files({ row, userId, ask }: TabProps): React.JSX.Element {
  // The open folder belongs to a server, not to the tab — deriving it means a
  // switch can never leave the panel asking a new host for the old one's path.
  const [place, setPlace] = useState({ server: row.server_id, path: '' })
  const path = place.server === row.server_id ? place.path : ''

  const [entries, setEntries] = useState<ServerFileEntry[] | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState<Notice | null>(null)
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<SortKey>('name')
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const [menuFor, setMenuFor] = useState<string | null>(null)
  const [view, setView] = useState<View>({ kind: 'list' })
  const [pending, setPending] = useState<Pending | null>(null)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState<null | 'open' | 'act'>(null)
  const [transfers, setTransfers] = useState<Transfer[]>([])
  const [dropping, setDropping] = useState(false)

  const picker = useRef<HTMLInputElement>(null)
  const dragDepth = useRef(0)
  const nextId = useRef(0)
  const alive = useRef(true)
  // The shell rebuilds `ask` on every render, so no effect may key off it — the
  // listing would reload forever. The folder is mirrored for the same reason:
  // work that outlives a render needs to know where the panel is *now*.
  const askRef = useRef(ask)
  const pathRef = useRef(path)
  useEffect(() => {
    askRef.current = ask
    pathRef.current = path
  })
  useEffect(
    () => () => {
      alive.current = false
    },
    []
  )

  const call = useCallback(
    <T,>(action: RequestAction, params?: Record<string, unknown>): Promise<T> =>
      askRef.current<T>(action, params),
    []
  )

  // A slow folder that has been navigated away from must not overwrite the one
  // now on screen when it finally answers.
  const loadSeq = useRef(0)
  const load = useCallback(
    async (rel: string): Promise<void> => {
      const seq = ++loadSeq.current
      setEntries(null)
      setError('')
      try {
        const list = await call<ServerFileEntry[]>('files', { path: rel })
        if (seq !== loadSeq.current) return
        const found = Array.isArray(list) ? list : []
        setEntries(found)
        setSelected((prev) => {
          if (prev.size === 0) return prev
          const names = new Set(found.map((e) => e.name))
          const next = new Set([...prev].filter((n) => names.has(n)))
          return next.size === prev.size ? prev : next
        })
      } catch (e) {
        if (seq !== loadSeq.current) return
        setEntries([])
        setError(msgOf(e))
      }
    },
    [call]
  )

  useEffect(() => {
    void load(path)
  }, [load, path, row.server_id])

  // An editor or a preview from another server is pointing at a file this one
  // may not have.
  useEffect(() => {
    setView({ kind: 'list' })
    setSelected(new Set())
    setMenuFor(null)
    setPending(null)
    setQuery('')
  }, [row.server_id])

  // A preview holds a blob for as long as it is on screen and not a moment more.
  useEffect(() => {
    if (view.kind !== 'image') return
    const url = view.url
    return () => URL.revokeObjectURL(url)
  }, [view])

  const relOf = useCallback((name: string) => (path ? `${path}/${name}` : name), [path])

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase()
    return (entries ?? [])
      .filter((e) => !q || e.name.toLowerCase().includes(q))
      // folders lead whichever way the sort runs, the way every file manager does it
      .sort(
        (a, b) =>
          Number(b.isDir) - Number(a.isDir) ||
          (sort === 'newest'
            ? b.modifiedAt - a.modifiedAt
            : sort === 'largest'
              ? b.sizeBytes - a.sizeBytes
              : a.name.localeCompare(b.name, undefined, { numeric: true }))
      )
  }, [entries, query, sort])

  function goTo(rel: string): void {
    setPlace({ server: row.server_id, path: rel })
    setMenuFor(null)
    setPending(null)
    setSelected(new Set())
    setQuery('')
  }

  function toggle(name: string): void {
    setSelected((prev) => {
      const next = new Set(prev)
      if (!next.delete(name)) next.add(name)
      return next
    })
  }

  function askFor(next: Pending, value = ''): void {
    setDraft(value)
    setPending(next)
  }

  // ---------- transfers ----------

  function startTransfer(name: string, way: 'up' | 'down', total: number): string {
    const id = `x${nextId.current++}`
    setTransfers((list) => [...list, { id, name, way, sent: 0, total, state: 'live' }])
    return id
  }

  function advance(id: string, by: number): void {
    setTransfers((list) => list.map((t) => (t.id === id ? { ...t, sent: t.sent + by } : t)))
  }

  /** Finished transfers clear themselves; failed ones stay until they're read. */
  function settle(id: string, failure?: string): void {
    setTransfers((list) =>
      list.map((t) =>
        t.id === id
          ? { ...t, state: failure ? 'bad' : 'done', error: failure, sent: failure ? t.sent : t.total }
          : t
      )
    )
    if (failure) return
    window.setTimeout(() => {
      if (alive.current) setTransfers((list) => list.filter((t) => t.id !== id))
    }, 4000)
  }

  async function uploadOne(file: File, dest: string, id: string): Promise<void> {
    const target = dest ? `${dest}/${file.name}` : file.name
    const uploadId = newUploadId()
    const total = file.size
    const chunks = Math.ceil(total / CHUNK)
    let next = 0
    // Slices carry their own offset, so they may land in any order and several
    // can be in flight — the only reason a 40 MB world is bearable over a
    // transport that settles one request per poll.
    const worker = async (): Promise<void> => {
      for (let i = next++; i < chunks; i = next++) {
        const start = i * CHUNK
        const slice = file.slice(start, Math.min(start + CHUNK, total))
        const data = await base64Of(slice)
        await call('uploadChunk', { path: target, uploadId, offset: start, totalBytes: total, data })
        advance(id, slice.size)
      }
    }
    await Promise.all(Array.from({ length: Math.min(PARALLEL, Math.max(1, chunks)) }, worker))
    // the commit is its own round trip so it can only land after every slice has
    await call('uploadChunk', { path: target, uploadId, totalBytes: total, final: true })
  }

  async function uploadFiles(files: File[]): Promise<void> {
    const dest = path
    let ok = 0
    for (const file of files) {
      const id = startTransfer(file.name, 'up', file.size)
      try {
        await uploadOne(file, dest, id)
        settle(id)
        ok++
      } catch (e) {
        settle(id, msgOf(e))
      }
    }
    setNotice(
      ok === files.length
        ? { text: `Uploaded ${ok} file${ok === 1 ? '' : 's'}.`, bad: false }
        : { text: `Uploaded ${ok} of ${files.length} — the rest are listed below.`, bad: true }
    )
    if (pathRef.current === dest) await load(dest)
  }

  async function fetchBlob(rel: string, id?: string): Promise<Blob> {
    const parts: BlobPart[] = []
    let offset = 0
    for (;;) {
      const res = await call<{ data?: string; size?: number; eof?: boolean }>('downloadChunk', {
        path: rel,
        offset,
        length: CHUNK
      })
      const bytes = Uint8Array.from(atob(res?.data ?? ''), (c) => c.charCodeAt(0))
      parts.push(bytes)
      offset += bytes.length
      if (id) {
        const at = offset
        const size = res?.size ?? 0
        setTransfers((list) => list.map((t) => (t.id === id ? { ...t, sent: at, total: size } : t)))
      }
      // a zero-length slice ends the read as surely as eof does, and without it
      // a truncated answer would loop forever
      if (res?.eof || bytes.length === 0) break
    }
    return new Blob(parts)
  }

  async function download(rel: string, name: string): Promise<void> {
    const id = startTransfer(name, 'down', 0)
    try {
      const blob = await fetchBlob(rel, id)
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = name
      a.click()
      // the anchor never enters the document, so nothing but this keeps the blob
      // alive long enough for the browser to start writing it out
      window.setTimeout(() => URL.revokeObjectURL(url), 2000)
      settle(id)
    } catch (e) {
      settle(id, msgOf(e))
    }
  }

  async function downloadSelected(): Promise<void> {
    const picked = [...selected]
    const files = picked.filter((n) => !entries?.find((e) => e.name === n)?.isDir)
    if (files.length < picked.length) {
      setNotice({ text: 'Folders cannot be downloaded — zip them on the host first.', bad: true })
    }
    for (const name of files) await download(relOf(name), name)
  }

  // ---------- create, rename, delete ----------

  async function createFolder(name: string): Promise<void> {
    const clean = name.trim()
    if (!clean) return
    if (NAME_BAD.test(clean)) {
      setNotice({ text: 'That name has characters a folder cannot use.', bad: true })
      return
    }
    setBusy('act')
    try {
      await call('mkdir', { path: relOf(clean) })
      setPending(null)
      setNotice({ text: `Created ${clean}.`, bad: false })
      await load(path)
    } catch (e) {
      setNotice({ text: msgOf(e), bad: true })
    } finally {
      setBusy(null)
    }
  }

  async function renameTo(from: string, to: string): Promise<void> {
    const clean = to.trim()
    if (!clean || clean === from) {
      setPending(null)
      return
    }
    if (NAME_BAD.test(clean)) {
      setNotice({ text: 'That name has characters a file cannot use.', bad: true })
      return
    }
    setBusy('act')
    try {
      await call('movePath', { from: relOf(from), to: relOf(clean) })
      setSelected((prev) => {
        const next = new Set(prev)
        next.delete(from)
        return next
      })
      setPending(null)
      setMenuFor(null)
      setNotice({ text: `Renamed to ${clean}.`, bad: false })
      await load(path)
    } catch (e) {
      setNotice({ text: msgOf(e), bad: true })
    } finally {
      setBusy(null)
    }
  }

  async function remove(names: string[]): Promise<void> {
    if (names.length === 0) return
    const openRel = view.kind === 'list' ? null : view.rel
    setBusy('act')
    try {
      if (names.length === 1) {
        // one file wants a plain yes or no; a batch wants a tally, so that one
        // locked jar cannot hide the twenty that did go
        await call('deleteFile', { path: relOf(names[0]) })
        setNotice({ text: `Deleted ${names[0]}.`, bad: false })
      } else {
        const res = await call<{ deleted?: number; failed?: { path: string; error: string }[] }>(
          'deleteFiles',
          { paths: names.map(relOf) }
        )
        const failed = res?.failed ?? []
        setNotice(
          failed.length
            ? { text: `Deleted ${res?.deleted ?? 0}. Still here: ${failed.map((f) => f.path).join(', ')}.`, bad: true }
            : { text: `Deleted ${res?.deleted ?? names.length} items.`, bad: false }
        )
      }
      if (openRel && names.some((n) => relOf(n) === openRel)) setView({ kind: 'list' })
      setSelected((prev) => {
        const next = new Set(prev)
        for (const n of names) next.delete(n)
        return next
      })
    } catch (e) {
      setNotice({ text: msgOf(e), bad: true })
    } finally {
      setPending(null)
      setMenuFor(null)
      setBusy(null)
      // Emptying a world folder can outlast the relay's patience while the host
      // is still working, so the listing — not the request — is what says what
      // actually went.
      await load(pathRef.current)
    }
  }

  // ---------- open, edit, preview ----------

  async function openFile(entry: ServerFileEntry): Promise<void> {
    setMenuFor(null)
    setBusy('open')
    try {
      const res = await call<{ content?: string }>('readFile', { path: relOf(entry.name) })
      const text = res?.content ?? ''
      setNotice(null)
      setView({ kind: 'edit', rel: relOf(entry.name), text, saved: text })
    } catch (e) {
      setNotice({ text: msgOf(e), bad: true })
    } finally {
      setBusy(null)
    }
  }

  async function openImage(entry: ServerFileEntry): Promise<void> {
    if (entry.sizeBytes > PREVIEW_MAX) {
      setNotice({ text: 'That image is too large to preview — download it instead.', bad: true })
      return
    }
    setMenuFor(null)
    setBusy('open')
    try {
      const blob = await fetchBlob(relOf(entry.name))
      setNotice(null)
      setView({ kind: 'image', rel: relOf(entry.name), name: entry.name, url: URL.createObjectURL(blob) })
    } catch (e) {
      setNotice({ text: msgOf(e), bad: true })
    } finally {
      setBusy(null)
    }
  }

  function openEntry(entry: ServerFileEntry): void {
    if (selected.size > 0) return toggle(entry.name) // picking, not browsing
    if (entry.isDir) return goTo(relOf(entry.name))
    if (isImage(entry.name)) return void openImage(entry)
    // a binary has no sensible default action, so offer the ones it does have
    if (!entry.isText) return setMenuFor(entry.name)
    void openFile(entry)
  }

  async function save(): Promise<void> {
    if (view.kind !== 'edit') return
    const { rel, text } = view
    setBusy('act')
    try {
      await call('writeFile', { path: rel, content: text })
      setView((v) => (v.kind === 'edit' && v.rel === rel ? { ...v, saved: text } : v))
      setNotice({ text: `Saved ${baseOf(rel)}.`, bad: false })
    } catch (e) {
      setNotice({ text: msgOf(e), bad: true })
    } finally {
      setBusy(null)
    }
  }

  function leaveView(): void {
    if (view.kind === 'edit' && view.text !== view.saved) {
      askFor({ kind: 'discard' })
      return
    }
    setView({ kind: 'list' })
  }

  // ---------- upload entry points ----------

  function onPicked(e: React.ChangeEvent<HTMLInputElement>): void {
    const files = [...(e.target.files ?? [])]
    e.target.value = '' // so picking the same file twice still fires a change
    if (files.length) void uploadFiles(files)
  }

  const dragHasFiles = (e: React.DragEvent): boolean => [...e.dataTransfer.types].includes('Files')

  function onDrop(e: React.DragEvent): void {
    if (!dragHasFiles(e)) return
    e.preventDefault()
    dragDepth.current = 0
    setDropping(false)
    // getAsFile has to run before any await: the item list empties the moment
    // this handler returns. Dropped folders arrive as entries nothing can read.
    const items = [...e.dataTransfer.items]
    const files: File[] = []
    let folders = 0
    for (const item of items) {
      if (item.webkitGetAsEntry()?.isDirectory) {
        folders++
        continue
      }
      const file = item.getAsFile()
      if (file) files.push(file)
    }
    if (folders) setNotice({ text: 'Whole folders cannot be dropped — zip them first.', bad: true })
    if (files.length) void uploadFiles(files)
  }

  // ---------- render ----------

  const crumbs = path ? path.split('/') : []
  const working = busy !== null

  return (
    <div className="fm">
      {notice &&
        (notice.bad ? (
          <p className="formerr" role="alert">
            {notice.text}
          </p>
        ) : (
          <p className="formnote">{notice.text}</p>
        ))}

      {pending?.kind === 'delete' && (
        <div className="surface pad stack">
          <h2>
            Delete {pending.names.length === 1 ? `“${pending.names[0]}”` : `${pending.names.length} items`}?
          </h2>
          {pending.names.length > 1 && <p className="dim mono fm-name">{pending.names.join(', ')}</p>}
          <p className="dim">
            {pending.names.some((n) => entries?.find((e) => e.name === n)?.isDir)
              ? 'Folders go with everything inside them, and this cannot be undone.'
              : 'This cannot be undone.'}
          </p>
          <div className="row">
            <Button variant="danger" disabled={working} onClick={() => void remove(pending.names)}>
              {busy === 'act' ? 'Deleting…' : 'Delete'}
            </Button>
            <Button variant="ghost" disabled={working} onClick={() => setPending(null)}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      {pending?.kind === 'discard' && (
        <div className="surface pad stack">
          <h2>Leave without saving?</h2>
          <p className="dim">The edits you made to this file will be lost.</p>
          <div className="row">
            <Button
              variant="danger"
              onClick={() => {
                setPending(null)
                setView({ kind: 'list' })
              }}
            >
              Discard changes
            </Button>
            <Button variant="ghost" onClick={() => setPending(null)}>
              Keep editing
            </Button>
          </div>
        </div>
      )}

      {(pending?.kind === 'mkdir' || pending?.kind === 'rename') && (
        <div className="surface pad stack">
          <div className="field">
            <label htmlFor="fm-draft">
              {pending.kind === 'mkdir' ? 'Name the new folder' : `Rename “${pending.from}” to`}
            </label>
            <input
              id="fm-draft"
              className="input"
              autoFocus
              value={draft}
              disabled={working}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== 'Enter') return
                if (pending.kind === 'mkdir') void createFolder(draft)
                else void renameTo(pending.from, draft)
              }}
            />
          </div>
          <div className="row">
            <Button
              variant="primary"
              disabled={working || !draft.trim()}
              onClick={() =>
                pending.kind === 'mkdir' ? void createFolder(draft) : void renameTo(pending.from, draft)
              }
            >
              {busy === 'act' ? 'Working…' : pending.kind === 'mkdir' ? 'Create folder' : 'Rename'}
            </Button>
            <Button variant="ghost" disabled={working} onClick={() => setPending(null)}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      {view.kind === 'edit' && (
        <div className="surface pad stack">
          <div className="row">
            <Button variant="ghost" onClick={leaveView}>
              ← Files
            </Button>
            <span className="spacer" />
            {view.text !== view.saved && <span className="fm-dirty">Unsaved</span>}
          </div>
          <p className="fm-name mono dim">{view.rel}</p>
          <textarea
            className="fm-edit"
            spellCheck={false}
            value={view.text}
            aria-label={`Contents of ${view.rel}`}
            onChange={(e) => setView({ ...view, text: e.target.value })}
          />
          <div className="fm-tools">
            <Button variant="primary" disabled={working || view.text === view.saved} onClick={() => void save()}>
              {busy === 'act' ? 'Saving…' : 'Save file'}
            </Button>
            <Button onClick={() => void download(view.rel, baseOf(view.rel))}>Download</Button>
            <Button
              variant="danger"
              disabled={working}
              onClick={() => askFor({ kind: 'delete', names: [baseOf(view.rel)] })}
            >
              Delete
            </Button>
          </div>
        </div>
      )}

      {view.kind === 'image' && (
        <div className="surface pad stack">
          <div className="row">
            <Button variant="ghost" onClick={leaveView}>
              ← Files
            </Button>
            <span className="spacer" />
          </div>
          <p className="fm-name mono dim">{view.rel}</p>
          <div className="fm-prev">
            <img src={view.url} alt={view.name} />
          </div>
          <div className="fm-tools">
            <Button onClick={() => void download(view.rel, view.name)}>Download</Button>
            <Button
              variant="danger"
              disabled={working}
              onClick={() => askFor({ kind: 'delete', names: [view.name] })}
            >
              Delete
            </Button>
          </div>
        </div>
      )}

      {view.kind === 'list' && (
        <>
          <div className="fm-crumbs">
            <button className={`fm-crumb${crumbs.length ? '' : ' here'}`} onClick={() => goTo('')}>
              {row.name}
            </button>
            {crumbs.map((seg, i) => (
              <span key={`${i}-${seg}`} className="row" style={{ gap: 0 }}>
                <span className="fm-sep" aria-hidden>
                  ›
                </span>
                <button
                  className={`fm-crumb${i === crumbs.length - 1 ? ' here' : ''}`}
                  onClick={() => goTo(crumbs.slice(0, i + 1).join('/'))}
                >
                  {seg}
                </button>
              </span>
            ))}
          </div>

          <div className="fm-tools">
            <input ref={picker} type="file" multiple hidden onChange={onPicked} />
            <Button variant="primary" onClick={() => picker.current?.click()}>
              Upload
            </Button>
            <Button disabled={working} onClick={() => askFor({ kind: 'mkdir' })}>
              New folder
            </Button>
            <Button variant="ghost" disabled={working} onClick={() => void load(path)}>
              Refresh
            </Button>
          </div>

          <div className="fm-tools">
            <input
              className="input fm-find"
              value={query}
              aria-label="Filter this folder"
              placeholder="Filter this folder…"
              onChange={(e) => setQuery(e.target.value)}
            />
            <select
              className="input fm-sort"
              value={sort}
              aria-label="Sort by"
              onChange={(e) => setSort(e.target.value as SortKey)}
            >
              <option value="name">Name</option>
              <option value="newest">Newest</option>
              <option value="largest">Largest</option>
            </select>
          </div>

          {selected.size > 0 && (
            <div className="fm-sel">
              <strong>{selected.size} selected</strong>
              <span className="spacer" />
              <Button onClick={() => void downloadSelected()}>
                Download
              </Button>
              <Button
                variant="danger"
                disabled={working}
                onClick={() => askFor({ kind: 'delete', names: [...selected] })}
              >
                Delete
              </Button>
              <Button variant="ghost" onClick={() => setSelected(new Set())}>
                Clear
              </Button>
            </div>
          )}

          {error && (
            <p className="formerr" role="alert">
              {error}
            </p>
          )}

          <div
            className="fm-zone"
            onDragEnter={(e) => {
              if (!dragHasFiles(e)) return
              e.preventDefault()
              dragDepth.current++
              setDropping(true)
            }}
            onDragOver={(e) => {
              if (!dragHasFiles(e)) return
              e.preventDefault()
              e.dataTransfer.dropEffect = 'copy'
            }}
            onDragLeave={() => {
              // fires for every child crossed, so it takes a counter to know
              // when the pointer has actually left the zone
              if (--dragDepth.current <= 0) {
                dragDepth.current = 0
                setDropping(false)
              }
            }}
            onDrop={onDrop}
          >
            {dropping && <div className="fm-drop">Drop to upload here</div>}

            {entries === null || busy === 'open' ? (
              <div className="stack">
                {[0, 1, 2, 3].map((i) => (
                  <Skeleton key={i} height={56} />
                ))}
              </div>
            ) : shown.length > 0 ? (
              <div className="surface fm-list">
                {shown.map((entry) => {
                  const menu = menuFor === entry.name
                  const picked = selected.has(entry.name)
                  return (
                    <div key={entry.name} className="fm-item">
                      <div className={`fm-row${picked ? ' on' : ''}`}>
                        <button
                          className="fm-check"
                          role="checkbox"
                          aria-checked={picked}
                          aria-label={`Select ${entry.name}`}
                          onClick={() => toggle(entry.name)}
                        >
                          <span className="fm-box" aria-hidden>
                            ✓
                          </span>
                        </button>
                        <button className="fm-main" onClick={() => openEntry(entry)}>
                          <span className={`fm-icon${entry.isDir ? ' dir' : ''}`} aria-hidden>
                            {entry.isDir ? (
                              <svg
                                viewBox="0 0 24 24"
                                width="17"
                                height="17"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="2"
                                strokeLinejoin="round"
                              >
                                <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
                              </svg>
                            ) : (
                              extOf(entry.name).slice(0, 4) || 'file'
                            )}
                          </span>
                          <span className="fm-text">
                            <span className="fm-name">{entry.name}</span>
                            <span className="fm-meta">
                              {entry.isDir ? 'Folder' : fmtBytes(entry.sizeBytes)} · {fmtWhen(entry.modifiedAt)}
                            </span>
                          </span>
                        </button>
                        <button
                          className="fm-more"
                          aria-expanded={menu}
                          aria-label={`Actions for ${entry.name}`}
                          onClick={() => setMenuFor(menu ? null : entry.name)}
                        >
                          ⋯
                        </button>
                      </div>

                      {menu && (
                        <div className="fm-acts">
                          {entry.isDir && (
                            <Button onClick={() => goTo(relOf(entry.name))}>
                              Open
                            </Button>
                          )}
                          {!entry.isDir && entry.isText && (
                            <Button disabled={working} onClick={() => void openFile(entry)}>
                              Edit
                            </Button>
                          )}
                          {!entry.isDir && isImage(entry.name) && (
                            <Button disabled={working} onClick={() => void openImage(entry)}>
                              Preview
                            </Button>
                          )}
                          {!entry.isDir && (
                            <Button onClick={() => void download(relOf(entry.name), entry.name)}>
                              Download
                            </Button>
                          )}
                          <Button
                            disabled={working}
                            onClick={() => askFor({ kind: 'rename', from: entry.name }, entry.name)}
                          >
                            Rename
                          </Button>
                          <Button
                            variant="danger"
                            disabled={working}
                            onClick={() => askFor({ kind: 'delete', names: [entry.name] })}
                          >
                            Delete
                          </Button>
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            ) : error ? null : (
              <div className="surface fm-empty stack">
                <h2>{query.trim() ? 'Nothing matches that' : 'This folder is empty'}</h2>
                <p className="dim">
                  {query.trim()
                    ? `No file here contains “${query.trim()}”.`
                    : 'Upload a file, or drop one here.'}
                </p>
              </div>
            )}
          </div>
        </>
      )}

      {transfers.length > 0 && (
        <div className="stack" style={{ '--gap': '6px' } as React.CSSProperties}>
          {transfers.map((t) => {
            const pct = t.total ? Math.min(100, Math.round((t.sent / t.total) * 100)) : t.state === 'done' ? 100 : 0
            return (
              <div key={t.id} className={`fm-xfer ${t.state}`}>
                <span className="fm-xname">
                  {t.way === 'up' ? '↑' : '↓'} {t.name}
                  {t.state === 'bad' && t.error ? ` — ${t.error}` : ''}
                </span>
                {t.state === 'live' && (
                  <span className="fm-track" aria-hidden>
                    <span className="fm-fill" style={{ width: `${pct}%` }} />
                  </span>
                )}
                <span className="fm-xpct">
                  {t.state === 'bad' ? 'Failed' : t.state === 'done' ? 'Done' : `${pct}%`}
                </span>
                {t.state === 'bad' && (
                  <Button
                    variant="ghost"
                    aria-label={`Dismiss ${t.name}`}
                    onClick={() => setTransfers((list) => list.filter((x) => x.id !== t.id))}
                  >
                    ✕
                  </Button>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
