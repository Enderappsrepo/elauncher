import { spawn } from 'child_process'
import { cpus, freemem, totalmem } from 'os'
import { isCloudConfigured } from '@shared/cloudConfig'
import type { HostGameEstimate, HostReport, HostSpecs, HostVerdict } from '@shared/types'
import { getClient } from './cloud'

/**
 * Host performance estimator: reads the PC's real specs and scores them per
 * game with transparent heuristics. Numbers are deliberately conservative
 * bands, not promises — hosting is workload-dependent (view distance, mods,
 * base sizes), so the notes say what actually moves each number.
 */

let diskTypeCache: HostSpecs['diskType'] | null = null

/** MediaType of the C: drive's physical disk (world saves live on C:). */
async function detectDiskType(): Promise<HostSpecs['diskType']> {
  if (diskTypeCache) return diskTypeCache
  if (process.platform !== 'win32') return (diskTypeCache = 'Unknown')
  try {
    const out = await new Promise<string>((resolve, reject) => {
      const ps = spawn(
        'powershell',
        [
          '-NoProfile',
          '-Command',
          '(Get-PhysicalDisk -DeviceNumber (Get-Partition -DriveLetter C).DiskNumber | Select-Object -First 1).MediaType'
        ],
        { windowsHide: true }
      )
      let buf = ''
      ps.stdout?.on('data', (chunk: Buffer) => (buf += chunk.toString()))
      ps.on('error', reject)
      ps.on('exit', () => resolve(buf.trim()))
    })
    diskTypeCache = /ssd/i.test(out) ? 'SSD' : /hdd/i.test(out) ? 'HDD' : 'Unknown'
  } catch {
    diskTypeCache = 'Unknown'
  }
  return diskTypeCache
}

function cleanCpuModel(model: string): string {
  return model
    .replace(/\((R|TM|C)\)/gi, '')
    .replace(/\s*@.*$/, '')
    .replace(/\bCPU\b/i, '')
    .replace(/\s+/g, ' ')
    .trim()
}

export async function collectSpecs(): Promise<HostSpecs> {
  const list = cpus()
  return {
    cpuModel: cleanCpuModel(list[0]?.model ?? 'Unknown CPU'),
    threads: list.length,
    speedGHz: Math.round((Math.max(0, ...list.map((c) => c.speed)) / 1000) * 10) / 10,
    ramGB: Math.round(totalmem() / 1073741824),
    freeRamGB: Math.round((freemem() / 1073741824) * 10) / 10,
    diskType: await detectDiskType()
  }
}

function verdictFor(players: number, greatAt: number, goodAt: number, tightAt: number): HostVerdict {
  if (players >= greatAt) return 'great'
  if (players >= goodAt) return 'good'
  if (players >= tightAt) return 'tight'
  return 'no'
}

const band = (top: number, lowFactor: number): string => `~${Math.max(2, Math.round(top * lowFactor))}–${top}`

export function buildReport(specs: HostSpecs): HostReport {
  const games: HostGameEstimate[] = []
  const limitations: string[] = []
  // OS + launcher + a browser tab or two
  const headroomGB = Math.max(0, specs.ramGB - 4)

  // Minecraft vanilla/paper — the tick loop is single-thread bound
  const mcHeap = Math.min(8, headroomGB)
  const mcCpuCap = specs.speedGHz >= 3.8 ? 40 : specs.speedGHz >= 3.2 ? 25 : specs.speedGHz >= 2.6 ? 15 : 8
  const mcPlayers = mcHeap >= 2 ? Math.min(mcCpuCap, Math.round(mcHeap * 8)) : 0
  games.push({
    game: 'Minecraft (Vanilla / Paper)',
    verdict: mcPlayers === 0 ? 'no' : verdictFor(mcPlayers, 20, 10, 4),
    players: mcPlayers ? band(mcPlayers, 0.6) : '0',
    note: mcPlayers
      ? 'Ticks are single-thread bound — clock speed and view-distance matter more than core count.'
      : 'Not enough free memory for a 2 GB server heap.'
  })

  // Minecraft modded — heavier heap, roughly half the players
  const moddedOk = headroomGB >= 4
  const moddedPlayers = moddedOk ? Math.max(2, Math.round(mcPlayers / 2)) : 0
  games.push({
    game: 'Minecraft (Modded)',
    verdict: moddedOk ? verdictFor(moddedPlayers, 12, 6, 3) : 'no',
    players: moddedOk ? band(moddedPlayers, 0.5) : '0',
    note: moddedOk
      ? 'Big packs want a 4–6 GB heap; the mod list moves this number more than players do.'
      : 'Modded servers want at least 4 GB of free memory for the heap alone.'
  })

  // Palworld — memory-hungry, scales with bases as much as players
  if (specs.ramGB < 10) {
    games.push({
      game: 'Palworld',
      verdict: 'no',
      players: '0',
      note: 'The dedicated server alone wants ~8 GB of memory — this PC cannot fit it comfortably.'
    })
  } else {
    let palPlayers = Math.round(Math.min(32, 4 + (specs.ramGB - 10) / 0.4))
    if (specs.threads < 8) palPlayers = Math.min(palPlayers, 16)
    if (specs.threads < 6) palPlayers = Math.min(palPlayers, 8)
    games.push({
      game: 'Palworld',
      verdict: verdictFor(palPlayers, 24, 12, 6),
      players: band(palPlayers, 0.5),
      note:
        specs.ramGB >= 16
          ? 'Memory creeps up over long runs — pair with the memory-guard restart in Automation.'
          : '16 GB RAM is the comfortable floor; lean on scheduled restarts below that.'
    })
  }

  if (specs.diskType === 'HDD') {
    limitations.push(
      'Mechanical hard drive detected — world saves and chunk loading will stutter. Moving to an SSD is the single biggest upgrade for hosting.'
    )
  }
  if (specs.threads < 6) {
    limitations.push(`Only ${specs.threads} CPU threads — one busy server will compete with Windows and anything else running.`)
  }
  if (specs.ramGB < 12) {
    limitations.push('Palworld and a Minecraft server together will not fit in memory — one at a time.')
  } else if (specs.ramGB < 20) {
    limitations.push('One heavy server at a time is realistic; two big ones together will squeeze memory.')
  } else {
    limitations.push(
      `Concurrently, roughly ${Math.max(1, Math.floor((specs.ramGB - 6) / 9))} Palworld-sized or ${Math.max(1, Math.floor((specs.ramGB - 6) / 4))} Minecraft-sized servers fit in memory.`
    )
  }
  limitations.push('Playing on this PC while it hosts costs ~2 cores and extra memory — bands assume the PC hosts while friends play from their own machines.')
  if (specs.freeRamGB < 4) {
    limitations.push(`Only ${specs.freeRamGB} GB free right now — close some apps before starting a big server.`)
  }

  return { specs, games, limitations, generatedAt: Date.now() }
}

export async function getHostReport(): Promise<HostReport> {
  return buildReport(await collectSpecs())
}

/** Publish the report so the phone dashboard can show the same card. */
export function startHostReportPublisher(): void {
  const publish = async (): Promise<void> => {
    try {
      if (!isCloudConfigured()) return
      const supabase = getClient()
      const me = (await supabase.auth.getSession()).data.session?.user.id
      if (!me) return
      const report = await getHostReport()
      await supabase
        .from('host_specs')
        .upsert({ owner_id: me, specs: report.specs, report, updated_at: new Date().toISOString() })
    } catch {
      // table missing or offline — the in-launcher card still works
    }
  }
  setTimeout(() => void publish(), 8_000)
  setInterval(() => void publish(), 12 * 3_600_000)
}
