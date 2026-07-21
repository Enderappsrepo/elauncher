import { app } from 'electron'
import { readFileSync } from 'fs'
import { readFile, statfs } from 'fs/promises'
import { cpus, freemem, hostname, loadavg, totalmem, uptime } from 'os'
import { join } from 'path'
import { dataRoot } from '../paths'
import { HEADLESS } from './headless'

/**
 * Machine-wide vitals for the box doing the hosting — the numbers an admin
 * needs to answer "is this host healthy?" without SSHing in. Deliberately
 * separate from specs.ts: that estimates *capacity* on a 12h cadence, this
 * samples *load* on the relay heartbeat.
 *
 * Everything here works on both Windows and a headless Linux VPS; readings the
 * platform can't give us come back null rather than zero, so the panel can say
 * "unknown" instead of drawing a reassuring empty gauge.
 */

export interface HostVitals {
  hostName: string
  platform: string
  appVersion: string
  headless: boolean
  cpuModel: string
  cpuThreads: number
  cpuPercent: number | null
  ramUsedMB: number | null
  ramTotalMB: number | null
  diskFreeGB: number | null
  diskTotalGB: number | null
  uptimeSeconds: number
  load1: number | null
}

/**
 * The launcher's own version. Electron's app.getVersion() falls back to the
 * Electron version when the app runs unpackaged — which is exactly how a VPS
 * host runs it (git clone + build), so the fleet view would advertise "43.1.1"
 * for every Linux box and hide the thing an admin actually wants to spot: a
 * host still running old code.
 */
function launcherVersion(): string {
  const version = app.getVersion()
  if (version !== process.versions.electron) return version
  try {
    const pkg = JSON.parse(readFileSync(join(app.getAppPath(), 'package.json'), 'utf8')) as { version?: string }
    return pkg.version ?? version
  } catch {
    return version
  }
}

/**
 * os.cpus() exposes cumulative tick counters, so a percentage only means
 * anything as a delta between two reads. Keeping the previous sample makes each
 * call report "since last time" instead of an average over the box's uptime,
 * which would flatline near idle on a long-lived VPS.
 */
let prevTicks: { idle: number; total: number } | null = null

function readTicks(): { idle: number; total: number } {
  let idle = 0
  let total = 0
  for (const core of cpus()) {
    const t = core.times
    idle += t.idle
    total += t.user + t.nice + t.sys + t.idle + t.irq
  }
  return { idle, total }
}

function sampleCpuPercent(): number | null {
  const now = readTicks()
  const prev = prevTicks
  prevTicks = now
  if (!prev) return null // first read has nothing to diff against
  const idleDelta = now.idle - prev.idle
  const totalDelta = now.total - prev.total
  if (totalDelta <= 0) return null
  return Math.round(Math.max(0, Math.min(100, (1 - idleDelta / totalDelta) * 100)))
}

/**
 * Memory actually available to start a server with. On Linux os.freemem()
 * excludes the page cache, so a perfectly healthy box reads as ~95% full —
 * MemAvailable is the number that reflects what a new process can really get.
 */
async function availableRamMB(): Promise<number> {
  if (process.platform === 'linux') {
    try {
      const meminfo = await readFile('/proc/meminfo', 'utf8')
      const match = /^MemAvailable:\s+(\d+) kB/m.exec(meminfo)
      if (match) return Math.round(Number(match[1]) / 1024)
    } catch {
      // older kernel or unreadable /proc — fall back to freemem below
    }
  }
  return Math.round(freemem() / 1048576)
}

/** Free space on the volume holding worlds and server files — the one that fills up. */
async function diskGB(): Promise<{ freeGB: number | null; totalGB: number | null }> {
  try {
    const fs = await statfs(dataRoot)
    const blockSize = Number(fs.bsize)
    return {
      freeGB: Math.round((Number(fs.bavail) * blockSize) / 1073741824),
      totalGB: Math.round((Number(fs.blocks) * blockSize) / 1073741824)
    }
  } catch {
    return { freeGB: null, totalGB: null }
  }
}

export async function collectHostVitals(): Promise<HostVitals> {
  const list = cpus()
  const totalMB = Math.round(totalmem() / 1048576)
  const availableMB = await availableRamMB()
  const { freeGB, totalGB } = await diskGB()
  return {
    hostName: hostname(),
    platform: `${process.platform}-${process.arch}`,
    appVersion: launcherVersion(),
    headless: HEADLESS,
    cpuModel: (list[0]?.model ?? 'Unknown CPU').replace(/\((R|TM|C)\)/gi, '').replace(/\s*@.*$/, '').replace(/\s+/g, ' ').trim(),
    cpuThreads: list.length,
    cpuPercent: sampleCpuPercent(),
    ramUsedMB: Math.max(0, totalMB - availableMB),
    ramTotalMB: totalMB,
    diskFreeGB: freeGB,
    diskTotalGB: totalGB,
    uptimeSeconds: Math.round(uptime()),
    // Windows has no load average — os.loadavg() just returns zeroes there
    load1: process.platform === 'win32' ? null : Math.round(loadavg()[0] * 100) / 100
  }
}
