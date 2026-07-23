import type { RunState } from '@web/ui'

/* Game names, hues and the lineup moved to @web/lib/games so the landing page
 * and shop share them; re-exported here so the panel's imports keep working. */
export { GAME_HUE, GAME_LABEL, gameLabel } from '@web/lib/games'
export type { Game } from '@web/lib/games'

export interface ServerRow {
  server_id: string
  /** whose machine runs it — a server shared with you is queued against its owner */
  owner_id: string
  /** null on clouds that predate the column, or hosts that have not updated */
  game: string | null
  name: string
  state: RunState
  players: string[]
  address: string | null
  console: string
  memory_mb: number | null
  cpu_percent: number | null
  started_at: string | null
  version: string | null
}

/**
 * Design/debug hook, in the same family as the old panel's __mockRelay and
 * __mockHealth: render the full UI with no cloud behind it.
 *
 * Worth keeping rather than deleting after the rewrite — the panel's hardest
 * states to reach on demand are a crashed server and a box mid-restart, and
 * both are one assignment away here.
 */
declare global {
  interface Window {
    __mockServers?: ServerRow[]
  }
}

export function mockServers(): ServerRow[] {
  return [
    {
      server_id: '1',
      owner_id: '00000000-0000-4000-8000-000000000001',
      name: 'Survival',
      game: 'minecraft',
      state: 'running',
      players: ['Enderkiller124', 'Nova', 'pip'],
      address: '80.190.76.136:25565',
      version: '1.21.4',
      memory_mb: 3480,
      cpu_percent: 34,
      started_at: new Date(Date.now() - 7_200_000).toISOString(),
      console: [
        '[12:04:41] [Server thread/INFO]: Starting minecraft server version 1.21.4',
        '[12:04:52] [Server thread/INFO]: Preparing level "world"',
        '[12:05:03] [Server thread/INFO]: Done (11.284s)! For help, type "help"',
        '[12:41:18] [Server thread/INFO]: Nova joined the game',
        '[12:58:02] [Server thread/WARN]: Can\'t keep up! Is the server overloaded?',
        '[13:02:55] [Server thread/INFO]: pip joined the game'
      ].join('\n')
    },
    {
      server_id: '2',
      owner_id: '00000000-0000-4000-8000-000000000001',
      name: 'Palworld — Dedicated',
      game: 'palworld',
      state: 'starting',
      players: [],
      address: '80.190.76.136:8211',
      version: 'v0.3.11',
      memory_mb: 9120,
      cpu_percent: 78,
      started_at: new Date(Date.now() - 24_000).toISOString(),
      console: ['[S_API] SteamAPI_Init()', 'Setting breakpad minidump AppID = 2394010', 'LogInit: Display: Starting Game.'].join('\n')
    },
    {
      server_id: '3',
      owner_id: '00000000-0000-4000-8000-000000000001',
      name: 'ATM10',
      game: 'minecraft',
      state: 'error',
      players: [],
      address: '80.190.76.136:25566',
      version: 'neoforge-21.1.72',
      memory_mb: null,
      cpu_percent: null,
      started_at: null,
      console: [
        '[13:10:02] [main/INFO]: Loading 412 mods',
        '[13:10:44] [main/ERROR]: Failed to load mod "ae2wtlib": missing dependency',
        '[13:10:44] [main/FATAL]: Exception in server tick loop'
      ].join('\n')
    },
    {
      server_id: '4',
      owner_id: '00000000-0000-4000-8000-000000000001',
      name: 'Creative',
      game: 'valheim',
      state: 'stopped',
      players: [],
      address: '80.190.76.136:25567',
      version: '1.21.1',
      memory_mb: null,
      cpu_percent: null,
      started_at: null,
      console: '[09:12:30] [Server thread/INFO]: Stopping server'
    }
  ]
}

export function uptime(startedAt: string | null): string {
  if (!startedAt) return '—'
  const secs = Math.max(0, Math.floor((Date.now() - new Date(startedAt).getTime()) / 1000))
  if (secs < 60) return `${secs}s`
  if (secs < 3600) return `${Math.floor(secs / 60)}m`
  const h = Math.floor(secs / 3600)
  return h < 48 ? `${h}h ${Math.floor((secs % 3600) / 60)}m` : `${Math.floor(h / 24)}d`
}
