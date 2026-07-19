import { execFile } from 'child_process'
import { copyFileSync, existsSync, mkdirSync } from 'fs'
import { dirname, join } from 'path'
import { steamcmdDir } from './steamcmd'

/**
 * Steam game servers must not run as root. Palworld's Linux binary (like other
 * Unreal dedicated servers) exits immediately with "Refusing to run with the
 * root privileges." — and the documented VPS setup (HOSTING-LINUX.md) runs the
 * whole headless host as root so it can manage the firewall and apt.
 *
 * So the host stays root and only the game process drops privileges: a system
 * user is created on demand, gets traverse-only ACLs down to the data dir
 * (which lives under /root, mode 700), takes ownership of the server's folder,
 * and the game is spawned through setpriv as that user.
 */
export const GAME_USER = 'elauncher-game'
export const GAME_USER_HOME = '/var/lib/elauncher-game'

export interface GameUserContext {
  user: string
  home: string
  /** argv prefix that re-execs as the game user (setpriv ships with util-linux) */
  wrap: (exe: string, args: string[]) => [string, string[]]
  /** child env for the game user — root's HOME/XDG pins must not leak through */
  env: (base: NodeJS.ProcessEnv) => NodeJS.ProcessEnv
}

function run(cmd: string, args: string[]): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      { env: { ...process.env, DEBIAN_FRONTEND: 'noninteractive' } },
      (error, stdout, stderr) => {
        const code = error ? ((error as NodeJS.ErrnoException & { code?: number | string }).code === 'ENOENT' ? -2 : 1) : 0
        resolve({ code, out: `${stdout}${stderr}`.trim() })
      }
    )
  })
}

export function isRootLinux(): boolean {
  return process.platform === 'linux' && process.getuid?.() === 0
}

let cached: GameUserContext | null = null

/** Create (once) and describe the unprivileged game user. Null when not a root Linux host. */
export async function ensureSteamGameUser(): Promise<GameUserContext | null> {
  if (!isRootLinux()) return null
  if (cached) return cached
  if ((await run('getent', ['passwd', GAME_USER])).code !== 0) {
    const add = await run('useradd', [
      '--system',
      '--create-home',
      '--home-dir',
      GAME_USER_HOME,
      '--shell',
      '/usr/sbin/nologin',
      GAME_USER
    ])
    // 9 = name already in use (raced by a parallel start) — anything else is fatal
    if (add.code !== 0 && (await run('getent', ['passwd', GAME_USER])).code !== 0) {
      throw new Error(
        `Could not create the "${GAME_USER}" user needed to run this game without root privileges: ${add.out || `useradd exited with ${add.code}`}`
      )
    }
  }
  cached = {
    user: GAME_USER,
    home: GAME_USER_HOME,
    wrap: (exe, args) => ['setpriv', ['--reuid', GAME_USER, '--regid', GAME_USER, '--clear-groups', '--', exe, ...args]],
    env: (base) => {
      const env: NodeJS.ProcessEnv = { ...base, HOME: GAME_USER_HOME, USER: GAME_USER, LOGNAME: GAME_USER }
      // the systemd unit pins these to /root for the host — the game user can't use them
      for (const k of ['XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS']) {
        delete env[k]
      }
      return env
    }
  }
  return cached
}

/**
 * Grant the game user execute-only ACLs on every directory above `dir` —
 * without this it can't even reach its files, since the data dir sits under
 * /root (mode 700). setfacl comes from the `acl` package; auto-install it the
 * same way steamcmd auto-installs lib32gcc-s1, with a chmod o+x fallback for
 * non-apt hosts (traverse-only: no listing or reading is exposed).
 */
async function grantPathTraversal(dir: string, log?: (line: string) => void): Promise<void> {
  const ancestors: string[] = []
  for (let d = dirname(dir); d !== dirname(d); d = dirname(d)) ancestors.push(d)
  const spec = `u:${GAME_USER}:--x`
  for (const ancestor of ancestors) {
    let res = await run('setfacl', ['-m', spec, ancestor])
    if (res.code === -2) {
      await run('apt-get', ['-o', 'DPkg::Lock::Timeout=120', '-y', 'install', 'acl'])
      res = await run('setfacl', ['-m', spec, ancestor])
    }
    if (res.code !== 0) {
      log?.(`[ELauncher] setfacl unavailable (${res.out || 'not installed'}) — falling back to chmod o+x on the data path`)
      for (const a of ancestors) await run('chmod', ['o+x', a])
      return
    }
  }
}

/**
 * Make `dir` (a server folder) fully owned by the game user, and place the
 * steamclient.so the game dlopens from its home. Called before every start:
 * SteamCMD updates and panel config edits run as root and re-root files.
 */
export async function prepareServerDirForGameUser(ctx: GameUserContext, dir: string, log?: (line: string) => void): Promise<void> {
  await grantPathTraversal(dir, log)
  const chown = await run('chown', ['-R', `${ctx.user}:${ctx.user}`, dir])
  if (chown.code !== 0) {
    throw new Error(`Could not hand the server folder to the "${ctx.user}" user: ${chown.out || `chown exited with ${chown.code}`}`)
  }
  try {
    const source = join(steamcmdDir, 'linux64', 'steamclient.so')
    const target = join(ctx.home, '.steam', 'sdk64', 'steamclient.so')
    if (existsSync(source) && !existsSync(target)) {
      mkdirSync(dirname(target), { recursive: true })
      copyFileSync(source, target)
    }
    // the game user must own its ~/.steam tree — the Steam runtime writes logs there
    await run('chown', ['-R', `${ctx.user}:${ctx.user}`, join(ctx.home, '.steam')])
  } catch {
    // best-effort, mirrors placeSteamClientLib: the server only degrades without it
  }
}
