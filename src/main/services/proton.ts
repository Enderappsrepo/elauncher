import { spawnSync } from 'child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { app } from 'electron'
import { downloadToFile } from './mods'

/**
 * GE-Proton, the Windows compatibility layer, for the one game here that has no
 * Linux server build: ARK: Survival Ascended. Wildcard never shipped one, so the
 * Windows binary run under Proton is the only way to host ASA on a Linux box —
 * it is what every working ASA-on-Linux deployment does.
 *
 * This is the one place the launcher downloads a third-party runtime rather than
 * implementing something itself, which is a deliberate exception: a compatibility
 * layer is not a protocol that can be reimplemented, and the reason the rule
 * exists (Windows Defender flagging unsigned helper exes) does not apply to a
 * Linux-only runtime.
 *
 * Nothing here is reachable on Windows — ASA runs natively there.
 */

const RELEASES_API = 'https://api.github.com/repos/GloriousEggroll/proton-ge-custom/releases/latest'

const protonRoot = (): string => join(app.getPath('userData'), 'proton')

/**
 * Records which build was installed. Its presence is also the "already done"
 * check, so a half-extracted tree from an interrupted download is re-fetched
 * rather than run: the marker is written last, on purpose.
 */
const markerPath = (): string => join(protonRoot(), 'installed.json')

/**
 * Proton insists on a Steam client directory and writes into it. There is no
 * Steam client on a headless host, and it does not need one — it only needs the
 * path to exist and be writable.
 */
const compatClientDir = (): string => join(protonRoot(), 'steam')

export interface ProtonInstall {
  /** the `proton` launcher script inside the extracted build */
  script: string
  version: string
}

/**
 * The installed build, or null. Synchronous because the launch path is: a server
 * starting cannot await a download, so Proton is fetched during the install and
 * only read back here.
 */
export function readProton(): ProtonInstall | null {
  try {
    const saved = JSON.parse(readFileSync(markerPath(), 'utf-8')) as ProtonInstall
    return saved.script && existsSync(saved.script) ? saved : null
  } catch {
    return null
  }
}

/** Proton's launcher is a python3 script; a host without python cannot run it. */
function hasPython3(): boolean {
  try {
    return spawnSync('python3', ['--version'], { stdio: 'ignore' }).status === 0
  } catch {
    return false
  }
}

/**
 * The tarball this machine can actually run. GE-Proton publishes an ARM build
 * alongside the x86_64 one and lists it *first*, so matching "any .tar.gz" picks
 * aarch64 on an ordinary server — 400 MB of binaries that cannot execute, which
 * only surfaces as a launch failure much later.
 *
 * The x86_64 asset carries no architecture suffix; ARM is spelled out.
 */
function assetPattern(): RegExp {
  return process.arch === 'arm64' ? /^GE-Proton[\d.-]+-aarch64\.tar\.gz$/ : /^GE-Proton[\d.-]+\.tar\.gz$/
}

/** The newest GE-Proton release, and the tarball to fetch for it. */
async function latestRelease(): Promise<{ version: string; url: string }> {
  const res = await fetch(RELEASES_API, {
    headers: { 'User-Agent': 'ELauncher', Accept: 'application/vnd.github+json' }
  })
  if (!res.ok) throw new Error(`Could not reach GitHub to find a GE-Proton release (${res.status}).`)
  const body = (await res.json()) as { tag_name?: string; assets?: { name: string; browser_download_url: string }[] }
  const asset = (body.assets ?? []).find((a) => assetPattern().test(a.name))
  if (!asset || !body.tag_name) {
    throw new Error(`The latest GE-Proton release has no ${process.arch} build attached — try again later.`)
  }
  return { version: body.tag_name, url: asset.browser_download_url }
}

/**
 * Make sure a Proton build is on disk, downloading one if not, and hand back the
 * launcher script.
 *
 * Resolved from the latest release on first install and then frozen: the marker
 * pins whatever was current when this host set ASA up, so a later GE-Proton
 * regression cannot change a working server underneath the operator. Deleting
 * the proton folder is how you deliberately move to a newer build.
 */
export async function ensureProton(onProgress: (phase: string, progress: number) => void): Promise<ProtonInstall> {
  const existing = readProton()
  if (existing) return existing

  if (!hasPython3()) {
    throw new Error(
      "Proton needs python3, which isn't installed on this host. Install it (sudo apt install python3) and try again."
    )
  }

  const root = protonRoot()
  mkdirSync(root, { recursive: true })
  onProgress('Finding a GE-Proton release', -1)
  const { version, url } = await latestRelease()

  const archive = join(root, 'proton-download.tar.gz')
  onProgress(`Downloading ${version}`, -1)
  await downloadToFile(url, archive, (received, total) => {
    if (total > 0) onProgress(`Downloading ${version}`, received / total)
  })

  onProgress(`Extracting ${version}`, -1)
  try {
    // tar ships on every Linux; node has no built-in reader for .tar.gz and a
    // dependency for one file type isn't worth it
    const untar = spawnSync('tar', ['-xzf', archive, '-C', root], { stdio: 'pipe' })
    if (untar.status !== 0) {
      throw new Error(`Could not extract GE-Proton: ${untar.stderr?.toString().trim() || 'tar failed'}`)
    }
  } finally {
    rmSync(archive, { force: true })
  }

  // the tarball's top-level folder is the version, but read it back rather than
  // assume the tag and the folder agree
  const dir = readdirSync(root).find((n) => n.startsWith('GE-Proton') && existsSync(join(root, n, 'proton')))
  if (!dir) throw new Error('GE-Proton extracted without a proton script — the download may have been truncated.')

  const install: ProtonInstall = { script: join(root, dir, 'proton'), version: dir }
  mkdirSync(compatClientDir(), { recursive: true })
  writeFileSync(markerPath(), JSON.stringify(install, null, 2), 'utf-8')
  return install
}

/**
 * The environment `proton run` requires. Both compat paths are mandatory —
 * without them Proton exits immediately complaining about a missing compat data
 * path, which reads like the game failing to start.
 *
 * The prefix lives inside the server's own folder so it is deleted, backed up
 * and moved with that server rather than lingering in shared state.
 */
export function protonEnv(prefixDir: string): NodeJS.ProcessEnv {
  mkdirSync(prefixDir, { recursive: true })
  mkdirSync(compatClientDir(), { recursive: true })
  return {
    STEAM_COMPAT_DATA_PATH: prefixDir,
    STEAM_COMPAT_CLIENT_INSTALL_PATH: compatClientDir(),
    // headless box: there is no GPU and nothing to present to, and a server that
    // tries to initialise a real renderer under Proton falls over
    PROTON_USE_WINED3D: '1',
    PROTON_NO_ESYNC: '1',
    PROTON_NO_FSYNC: '1'
  }
}

/** Where a server's Wine prefix lives. Kept with the server, not in shared state. */
export const protonPrefixDir = (serverDir: string): string => join(serverDir, 'protonprefix')
