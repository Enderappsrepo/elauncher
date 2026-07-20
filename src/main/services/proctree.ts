import { spawn, type ChildProcess } from 'child_process'

/**
 * Kill a server process and everything it spawned.
 *
 * Game servers are rarely one process: UE and Unity dedicated servers re-exec
 * themselves, and a Minecraft JVM launched through a wrapper leaves the wrapper
 * holding the port. `proc.kill()` only ever reaches the process we spawned, so
 * on Windows it maps to TerminateProcess on the parent and orphans the rest —
 * the port stays bound and the next start fails. Kill the tree instead.
 */
export function killProcessTree(proc: ChildProcess): void {
  if (proc.pid === undefined) return
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { windowsHide: true })
  } else {
    // servers are spawned detached, so each leads its own process group (-pid)
    try {
      process.kill(-proc.pid, 'SIGKILL')
    } catch {
      proc.kill('SIGKILL')
    }
  }
}
