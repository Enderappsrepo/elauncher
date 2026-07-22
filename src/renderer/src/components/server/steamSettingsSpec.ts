import type { SteamServerGame } from '@shared/types'
import { ARK_MAPS } from '@shared/ark'

/**
 * What the settings panel shows for each SteamCMD game.
 *
 * Every one of these games keeps its settings in a different file with a
 * different spelling of the same ideas — Valheim in a sidecar json, 7 Days to
 * Die in xml, Zomboid and tModLoader in flat ini/txt, ARK in a sectioned ini.
 * The main process already hides that behind one flat key/value map, so the
 * only thing left that differs per game is which keys matter and what a boolean
 * looks like. That's this table.
 *
 * Before it existed, all of these rendered Minecraft's server.properties fields,
 * which wrote keys like `motd` and `max-players` into configs that have no such
 * setting — the edits appeared to save and then did nothing.
 */

export type SteamField =
  | { key: string; label: string; type: 'text'; placeholder?: string; hint?: string }
  | { key: string; label: string; type: 'number'; fallback: string; min: number; max: number; hint?: string }
  | { key: string; label: string; type: 'bool'; on: string; off: string; hint?: string }
  | { key: string; label: string; type: 'select'; options: { value: string; label: string }[]; hint?: string }

export interface SteamGameSettingsSpec {
  /** curated fields, in display order */
  fields: SteamField[]
  /** launcher-managed keys: shown read-only with the reason, never editable */
  locked: Record<string, string>
  /** keys hidden entirely — secrets the panel has no reason to echo */
  hidden?: string[]
  /** what the advanced list is called in the footer note */
  configName: string
}

const onOff = (on: string, off: string) => ({ on, off })

/** Most of these games spell booleans lowercase; ARK is the outlier with True/False. */
const LOWER = onOff('true', 'false')

const arkFields = (game: 'ark' | 'arksa'): SteamField[] => [
  {
    key: 'Map',
    label: 'Map',
    type: 'select',
    options: ARK_MAPS[game].map((m) => ({ value: m.id, label: m.label })),
    hint: 'Each map keeps its own world — switching parks the current one instead of deleting it.'
  },
  { key: 'SessionName', label: 'Session name (shown in the server browser)', type: 'text' },
  { key: 'ServerPassword', label: 'Join password (optional)', type: 'text', placeholder: 'Empty = anyone with the address' },
  { key: 'MaxPlayers', label: 'Max players', type: 'number', fallback: '20', min: 1, max: 200 },
  {
    key: 'ServerPVE',
    label: 'PvE only',
    type: 'bool',
    ...onOff('True', 'False'),
    hint: 'Players cannot damage each other or their structures.'
  }
]

export const STEAM_SETTINGS: Record<SteamServerGame, SteamGameSettingsSpec> = {
  valheim: {
    configName: "Valheim's launch options",
    fields: [
      { key: 'name', label: 'Server name', type: 'text' },
      {
        key: 'world',
        label: 'World name',
        type: 'text',
        hint: 'Renaming this starts a brand new world; the old one stays on disk.'
      },
      {
        key: 'password',
        label: 'Join password',
        type: 'text',
        hint: 'At least 5 characters, and it cannot appear inside the server name.'
      },
      { key: 'public', label: 'List in the public server browser', type: 'bool', ...LOWER },
      { key: 'Crossplay', label: 'Crossplay (PC and console players)', type: 'bool', ...LOWER },
      {
        key: 'SaveIntervalSeconds',
        label: 'Autosave interval (seconds)',
        type: 'number',
        fallback: '',
        min: 0,
        max: 86_400,
        hint: 'Blank leaves it to the game.'
      },
      { key: 'BackupCount', label: 'Backups to keep', type: 'number', fallback: '', min: 0, max: 100 }
    ],
    // valheim's player cap is fixed by the game at 10, so there's no field for
    // it; the launch flags it does accept are all editable above
    locked: {}
  },
  sdtd: {
    configName: 'serverconfig.xml',
    fields: [
      { key: 'ServerName', label: 'Server name', type: 'text' },
      { key: 'ServerDescription', label: 'Description', type: 'text' },
      { key: 'ServerPassword', label: 'Join password (optional)', type: 'text', placeholder: 'Empty = anyone with the address' },
      { key: 'ServerMaxPlayerCount', label: 'Max players', type: 'number', fallback: '8', min: 1, max: 64 },
      { key: 'GameDifficulty', label: 'Difficulty (0 easiest – 5 hardest)', type: 'number', fallback: '2', min: 0, max: 5 },
      { key: 'DayNightLength', label: 'Day length (real minutes)', type: 'number', fallback: '60', min: 10, max: 240 },
      { key: 'ServerIsPublic', label: 'List in the public server browser', type: 'bool', ...LOWER }
    ],
    locked: {
      ServerPort: "pinned to the server's allocated port",
      TelnetEnabled: 'pinned on — ELauncher manages the server through it',
      TelnetPort: 'pinned to the game port + 3',
      UserDataFolder: 'kept inside the server folder so backups and the files tab find it'
    },
    hidden: ['TelnetPassword']
  },
  zomboid: {
    configName: "Project Zomboid's server ini",
    fields: [
      { key: 'PublicName', label: 'Server name', type: 'text' },
      { key: 'PublicDescription', label: 'Description', type: 'text' },
      { key: 'Password', label: 'Join password (optional)', type: 'text', placeholder: 'Empty = anyone with the address' },
      { key: 'MaxPlayers', label: 'Max players', type: 'number', fallback: '8', min: 1, max: 100 },
      { key: 'PVP', label: 'PvP enabled', type: 'bool', ...LOWER },
      {
        key: 'PauseEmpty',
        label: 'Pause the world when empty',
        type: 'bool',
        ...LOWER,
        hint: 'Stops time passing while nobody is online.'
      },
      { key: 'Public', label: 'List in the public server browser', type: 'bool', ...LOWER }
    ],
    locked: {
      DefaultPort: "pinned to the server's allocated port",
      UDPPort: 'pinned to the game port + 1',
      RCONPort: 'pinned to the game port + 2'
    },
    // generated by the launcher and never worth echoing back, same as 7DtD's
    // telnet password and ARK's admin password
    hidden: ['RCONPassword']
  },
  tmodloader: {
    configName: 'serverconfig.txt',
    fields: [
      { key: 'worldname', label: 'World name', type: 'text' },
      { key: 'motd', label: 'Message of the day', type: 'text' },
      { key: 'password', label: 'Join password (optional)', type: 'text', placeholder: 'Empty = anyone with the address' },
      { key: 'maxplayers', label: 'Max players', type: 'number', fallback: '8', min: 1, max: 255 },
      {
        key: 'difficulty',
        label: 'World difficulty',
        type: 'select',
        options: [
          { value: '0', label: 'Classic' },
          { value: '1', label: 'Expert' },
          { value: '2', label: 'Master' },
          { value: '3', label: 'Journey' }
        ],
        hint: 'Applies when the world is generated; changing it later does nothing.'
      }
    ],
    locked: {
      port: "pinned to the server's allocated port",
      world: 'the world file ELauncher generated for this server',
      worldpath: 'kept inside the server folder so backups and the files tab find it'
    }
  },
  ark: {
    configName: 'GameUserSettings.ini',
    fields: arkFields('ark'),
    locked: {
      Port: "pinned to the server's allocated port",
      QueryPort: 'pinned to the game port + 2',
      RCONPort: 'pinned to the game port + 3',
      RCONEnabled: 'pinned on — ELauncher manages the server through it'
    },
    hidden: ['ServerAdminPassword']
  },
  arksa: {
    configName: 'GameUserSettings.ini',
    fields: arkFields('arksa'),
    locked: {
      Port: "pinned to the server's allocated port",
      QueryPort: 'pinned to the game port + 2',
      RCONPort: 'pinned to the game port + 3',
      RCONEnabled: 'pinned on — ELauncher manages the server through it'
    },
    hidden: ['ServerAdminPassword']
  }
}

/** ARK's keys are PascalCase with acronyms: RCONPort -> "RCON Port", XPMultiplier -> "XP Multiplier". */
export const prettifyKey = (key: string): string =>
  key
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/([a-z\d])([A-Z])/g, '$1 $2')
    .replace(/[_-]/g, ' ')
    .replace(/^./, (c) => c.toUpperCase())
