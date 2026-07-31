import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { toast } from 'sonner'
import type { ServerGame, ServerKind } from '@shared/types'
import { Button, Skeleton } from '@web/ui'
import { Collapse, motion, staggerChild, staggerParent } from '@web/ui/motion'
import type { TabProps } from './types'
import './Version.css'

/**
 * Version tab: change a Minecraft server's loader and version WITHOUT resetting
 * the world, the mods or the configs.
 *
 * The Automation tab still owns the destructive "delete everything and rebuild"
 * — the recovery hammer for a server broken past repair, or a jump between
 * versions whose mods can't survive the trip. This tab is the everyday one: pin
 * the exact NeoForge/Forge/Fabric build a modpack asks for, or bump it, and keep
 * everything anyone built. The host swaps only the loader binaries underneath.
 */

/** `info`, narrowed to the fields this tab reads. */
interface VersionInfo {
  game: ServerGame
  kind: ServerKind
  minecraftVersion: string
  /** the exact loader build the server runs now, or null for paper/vanilla */
  loaderVersion: string | null
}

const LOADERS: ServerKind[] = ['paper', 'vanilla', 'fabric', 'neoforge', 'forge']

const LOADER_LABEL: Record<ServerKind, string> = {
  paper: 'Paper',
  vanilla: 'Vanilla',
  fabric: 'Fabric',
  neoforge: 'NeoForge',
  forge: 'Forge'
}

/** The modded kinds are the only ones with a separately-versioned loader build. */
const isModded = (kind: ServerKind): boolean => kind === 'fabric' || kind === 'neoforge' || kind === 'forge'

/** Recent Minecraft releases, so the picker still has something when Mojang is unreachable. */
const MC_FALLBACK = ['1.21.4', '1.21.1', '1.20.1']

async function releaseVersions(): Promise<string[]> {
  try {
    const res = await fetch('https://piston-meta.mojang.com/mc/game/version_manifest_v2.json')
    const manifest = (await res.json()) as { versions: { id: string; type: string }[] }
    return manifest.versions.filter((v) => v.type === 'release').map((v) => v.id).slice(0, 40)
  } catch {
    return MC_FALLBACK
  }
}

function say(e: unknown): string {
  return e instanceof Error ? e.message : 'Something went wrong.'
}

function Note({ tone, children }: { tone?: 'warn'; children: ReactNode }): React.JSX.Element {
  return <p className={tone === 'warn' ? 'formnote ver-warn' : 'formnote'}>{children}</p>
}

export function Version({ row, ask }: TabProps): React.JSX.Element {
  const [info, setInfo] = useState<VersionInfo | null>(null)
  const [loadFailed, setLoadFailed] = useState('')

  const [loader, setLoader] = useState<ServerKind>('paper')
  const [mc, setMc] = useState('')
  const [build, setBuild] = useState('')

  const [mcList, setMcList] = useState<string[] | null>(null)
  const [builds, setBuilds] = useState<string[] | null>(null)
  const [buildsErr, setBuildsErr] = useState('')

  const [arming, setArming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState('')
  const [done, setDone] = useState('')

  // The shell is free to hand down a fresh `ask` each render; keying the loads
  // below off it directly would turn them into an endless relay loop.
  const askRef = useRef(ask)
  askRef.current = ask
  // guards the build fetch against races when loader/mc change in quick succession
  const buildReq = useRef(0)

  useEffect(() => {
    let alive = true
    setInfo(null)
    setLoadFailed('')
    setArming(false)
    setDone('')
    setFailed('')
    askRef
      .current<VersionInfo>('info')
      .then((res) => {
        if (!alive) return
        setInfo(res)
        setLoader(res.kind)
        setMc(res.minecraftVersion)
      })
      .catch((e: unknown) => {
        if (alive) setLoadFailed(say(e))
      })
    return () => {
      alive = false
    }
  }, [row.server_id])

  useEffect(() => {
    let alive = true
    void releaseVersions().then((list) => {
      if (alive) setMcList(list)
    })
    return () => {
      alive = false
    }
  }, [])

  // Load the specific loader builds for the chosen loader + Minecraft version.
  // Host-side (via the relay) so the maven endpoints' absent CORS headers never
  // matter, and preselecting the build the server already runs when it applies.
  useEffect(() => {
    if (!info) return
    if (!isModded(loader) || !mc) {
      setBuilds(null)
      setBuildsErr('')
      return
    }
    const token = ++buildReq.current
    setBuilds(null)
    setBuildsErr('')
    askRef
      .current<string[]>('loaderVersions', { loader, mc })
      .then((list) => {
        if (token !== buildReq.current) return
        const current = info.loaderVersion
        const onCurrent = loader === info.kind && mc === info.minecraftVersion && !!current
        // the running build can be older than what maven lists first — keep it offered
        const opts = onCurrent && current && !list.includes(current) ? [current, ...list] : list
        setBuilds(opts)
        setBuild(onCurrent && current ? current : (opts[0] ?? ''))
      })
      .catch((e: unknown) => {
        if (token !== buildReq.current) return
        setBuildsErr(say(e))
        setBuilds([])
      })
  }, [loader, mc, info])

  const mcOptions = useMemo(() => {
    const base = mcList ?? []
    // whatever the server is on, and whatever is picked, must always be selectable
    const extra = [info?.minecraftVersion, mc].filter((v): v is string => !!v && !base.includes(v))
    return [...new Set([...extra, ...base])]
  }, [mcList, info, mc])

  if (loadFailed) {
    return (
      <p className="formerr" role="alert">
        {loadFailed}
      </p>
    )
  }

  if (!info) {
    return (
      <div className="stack" aria-busy="true">
        <Skeleton height={90} />
        <Skeleton height={320} />
      </div>
    )
  }

  if (info.game !== 'minecraft') {
    return <Note>Only Minecraft servers have a loader and version to change.</Note>
  }

  const modded = isModded(loader)
  const kindChanged = loader !== info.kind
  const mcChanged = mc !== info.minecraftVersion
  const buildChanged = modded && !kindChanged && !mcChanged && build !== (info.loaderVersion ?? '')
  const bigChange = kindChanged || mcChanged
  // a modded target with no build resolved yet can't be applied — the host needs the exact one
  const buildBlocked = modded && (builds === null || !build)

  const target = modded ? `${LOADER_LABEL[loader]} ${build}` : LOADER_LABEL[loader]
  const describe = (): string => `${target} (Minecraft ${mc})`
  const currentLabel = `${LOADER_LABEL[info.kind]}${info.loaderVersion ? ` ${info.loaderVersion}` : ''}`

  const actionLabel = bigChange
    ? `Switch to ${target}…`
    : buildChanged
      ? `Update to ${target}…`
      : `Reinstall ${target}…`

  function beginApply(): void {
    setFailed('')
    setDone('')
    setArming(true)
  }

  /**
   * Apply the swap. The host stops the server, replaces only the loader binaries,
   * and starts it back up. That runs an installer for Forge/NeoForge and takes
   * minutes, while the relay stops waiting after twenty seconds — so a timeout
   * here means "no answer yet", never "nothing happened".
   */
  async function apply(): Promise<void> {
    setBusy(true)
    setFailed('')
    const sentAt = Date.now()
    try {
      await ask('swap', { loader, version: mc, loaderVersion: modded ? build : undefined })
      const nice = describe()
      setDone(`Now running ${nice} — it's starting back up with your world, mods and configs kept.`)
      toast.success(`Switched to ${nice}`)
      setArming(false)
      const res = await askRef.current<VersionInfo>('info').catch(() => null)
      if (res) setInfo(res)
    } catch (e) {
      setFailed(
        Date.now() - sentAt > 20_000
          ? 'The panel stopped waiting, but the host is still working — installing a loader takes a few minutes. Watch the console for progress; your world was not reset. If the launcher is offline, nothing was changed.'
          : say(e)
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <motion.div className="stack" variants={staggerParent} initial="hidden" animate="show">
      <motion.section variants={staggerChild} className="surface pad stack">
        <h2>Loader &amp; version</h2>
        <p className="formnote">
          Currently <b>{currentLabel}</b> · Minecraft {info.minecraftVersion}. Switching keeps the world, the mods and
          every config in place — only the loader files underneath are replaced.
        </p>
      </motion.section>

      <motion.section variants={staggerChild} className="surface pad stack">
        <div className="field">
          <label htmlFor="ver-loader">Loader</label>
          <select
            id="ver-loader"
            className="input"
            value={loader}
            disabled={busy}
            onChange={(e) => {
              setLoader(e.target.value as ServerKind)
              setArming(false)
            }}
          >
            {LOADERS.map((k) => (
              <option key={k} value={k}>
                {LOADER_LABEL[k]}
              </option>
            ))}
          </select>
        </div>

        <div className="field">
          <label htmlFor="ver-mc">Minecraft version</label>
          <select
            id="ver-mc"
            className="input"
            value={mc}
            disabled={busy || mcOptions.length === 0}
            onChange={(e) => {
              setMc(e.target.value)
              setArming(false)
            }}
          >
            {mcOptions.map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </select>
        </div>

        {modded && (
          <div className="field">
            <label htmlFor="ver-build">{LOADER_LABEL[loader]} build</label>
            <select
              id="ver-build"
              className="input"
              value={build}
              disabled={busy || builds === null || builds.length === 0}
              onChange={(e) => {
                setBuild(e.target.value)
                setArming(false)
              }}
            >
              {builds === null ? (
                <option value="">Loading builds…</option>
              ) : builds.length === 0 ? (
                <option value="">No builds for this version</option>
              ) : (
                builds.map((v) => (
                  <option key={v} value={v}>
                    {v}
                  </option>
                ))
              )}
            </select>
            {buildsErr && (
              <p className="formerr" role="alert">
                {buildsErr}
              </p>
            )}
            {!buildsErr && builds !== null && builds.length > 0 && (
              <Note>Pick the exact build your modpack asks for — the newest is at the top.</Note>
            )}
          </div>
        )}

        {bigChange ? (
          <Note tone="warn">
            The world is kept, but this server&rsquo;s mods and configs were built for {LOADER_LABEL[info.kind]}{' '}
            {info.minecraftVersion}. After the switch you may need to update them from the Mods and Files tabs, or the
            server may not start until they match.
          </Note>
        ) : buildChanged ? (
          <Note>Only the loader build changes — your world, mods and configs stay as they are.</Note>
        ) : (
          <Note>
            This reinstalls the current files without touching your world — handy if the server binaries got corrupted.
          </Note>
        )}

        {failed && (
          <p className="formerr" role="alert">
            {failed}
          </p>
        )}
        {done && <Note>{done}</Note>}

        {!arming ? (
          <Button variant="primary" block disabled={busy || buildBlocked} onClick={beginApply}>
            {actionLabel}
          </Button>
        ) : (
          <Collapse open={arming}>
            <div className="stack">
              <p className="formnote">
                <b>“{row.name}”</b> will stop, switch to <b>{describe()}</b>, and start again. Your world, mods and
                configs are kept. This can take a few minutes while the loader installs.
              </p>
              <div className="row">
                <Button variant="primary" disabled={busy} onClick={() => void apply()}>
                  {busy ? 'Switching…' : 'Stop & switch now'}
                </Button>
                <Button variant="ghost" disabled={busy} onClick={() => setArming(false)}>
                  Cancel
                </Button>
              </div>
            </div>
          </Collapse>
        )}
      </motion.section>

      <motion.section variants={staggerChild} className="surface pad stack">
        <h3>Need a clean slate?</h3>
        <p className="formnote">
          To wipe the world, mods and configs and reinstall from scratch, use <b>Delete every file and rebuild</b> at
          the bottom of the Automation tab. That one has no undo.
        </p>
      </motion.section>
    </motion.div>
  )
}
