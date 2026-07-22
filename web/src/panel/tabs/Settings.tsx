import { useEffect, useMemo, useRef, useState } from 'react'
import { Button, Skeleton } from '@web/ui'
import type { TabProps } from './types'
import './Settings.css'

/**
 * The server's own settings file, edited in place.
 *
 * Every game writes a different file with different key names — server.properties,
 * PalWorldSettings.ini, serverconfig.xml, a Valheim launch-flag sidecar — and the
 * host flattens all of them into one string map. So this screen is a renderer for
 * a dictionary it has never seen: it picks a control from the shape of the value,
 * and leans on the knowledge base below for the labels and plain-English notes
 * that turn `bEnableInvaderEnemy` into something a person can decide about.
 *
 * Edits are collected and sent in one go. A save is a file write on the host and
 * the settings only bite at the next start, so a live-saving field would spend a
 * round trip per keystroke to change nothing anyone can see yet.
 */

type Game = 'minecraft' | 'palworld' | 'valheim' | 'sdtd' | 'zomboid' | 'tmodloader' | 'ark' | 'arksa' | 'unknown'

/**
 * Which game this is, read out of the keys themselves.
 *
 * The tab contract has no `info` action, and it is better this way: every one of
 * these games writes a marker key none of the others use, so the settings file
 * is its own identification. The order matters where two games share a key —
 * tModLoader's lowercase `motd` and `difficulty` are Minecraft's too.
 */
function detectGame(props: Record<string, string>): Game {
  const has = (key: string): boolean => key in props
  if (has('PalCaptureRate') || has('ServerPlayerMaxNum')) return 'palworld'
  if (has('ModifierCombat') || (has('world') && has('Crossplay'))) return 'valheim'
  if (has('ServerMaxPlayerCount') || has('DayNightLength')) return 'sdtd'
  if (has('PauseEmpty') || has('PublicName')) return 'zomboid'
  // Survival Ascended rebuilt every map on World Partition and renamed them with
  // a _WP suffix, which is the only thing here that tells the two ARKs apart
  if (has('SessionName') || has('ServerPVE')) return (props.Map ?? '').endsWith('_WP') ? 'arksa' : 'ark'
  if (has('worldname') || has('maxplayers')) return 'tmodloader'
  if (has('max-players') || has('level-name')) return 'minecraft'
  return 'unknown'
}

const GAME_LABEL: Record<Game, string> = {
  minecraft: 'Minecraft',
  palworld: 'Palworld',
  valheim: 'Valheim',
  sdtd: '7 Days to Die',
  zomboid: 'Project Zomboid',
  tmodloader: 'tModLoader',
  ark: 'ARK: Survival Evolved',
  arksa: 'ARK: Survival Ascended',
  unknown: 'Server'
}

// ---------- knowledge base: labels, explanations, groups ----------

const ACRONYMS: [RegExp, string][] = [
  [/\bPv P\b/g, 'PvP'],
  [/\bU Id\b/g, 'UID'],
  [/\bHp\b/g, 'HP'],
  [/\bUi\b/g, 'UI'],
  [/\bId\b/g, 'ID'],
  [/\bXp\b/g, 'XP'],
  [/\bRest Api\b/gi, 'REST API'],
  [/\bRcon\b/gi, 'RCON'],
  [/\bUNKO\b/g, 'Poop']
]

/** Keys whose auto-generated label reads badly. */
const KEY_LABELS: Record<string, string> = {
  Crossplay: 'Crossplay (Xbox / Game Pass players)',
  SaveIntervalSeconds: 'Save the world every (seconds)',
  BackupCount: 'Backups to keep',
  BackupShortSeconds: 'First backup after (seconds)',
  BackupLongSeconds: 'Then a backup every (seconds)',
  ModifierCombat: 'Combat difficulty',
  ModifierDeathPenalty: 'Death penalty',
  ModifierResources: 'Resource drops',
  ModifierRaids: 'Raid frequency',
  ModifierPortals: 'Portal rules',
  KeyNoBuildCost: 'Free building (no materials)',
  KeyPlayerEvents: 'Raids follow players',
  KeyPassiveMobs: 'Passive creatures (never attack)',
  KeyNoMap: 'No map'
}

function labelFor(key: string): string {
  if (KEY_LABELS[key]) return KEY_LABELS[key]
  let out = key
    .replace(/^b(?=[A-Z])/, '')
    .replace(/_/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .trim()
  for (const [pattern, to] of ACRONYMS) out = out.replace(pattern, to)
  return out
}

const HINTS: Record<string, string> = {
  // valheim — launch flags, so blank/off everywhere means "leave it to the game"
  Crossplay:
    'Runs the server on the PlayFab network so Xbox and Game Pass players can join, not just Steam. Steam players still join normally.',
  SaveIntervalSeconds: 'How often the world is written to disk. Blank uses the game default of 1800 (30 minutes).',
  BackupCount: 'How many backups Valheim keeps before deleting the oldest. Blank uses the game default of 4.',
  BackupShortSeconds: 'How long after startup the first backup is taken. Blank uses the game default of 7200 (2 hours).',
  BackupLongSeconds: 'The gap between backups after that first one. Blank uses the game default of 43200 (12 hours).',
  ModifierCombat: 'How hard enemies hit and how much they take.',
  ModifierDeathPenalty: 'What you lose when you die, from keeping everything to hardcore.',
  ModifierResources: 'How much material the world drops when gathered.',
  ModifierRaids: 'How often base raids come for you.',
  ModifierPortals: 'Whether portals can carry ores and metals, or exist at all.',
  KeyNoBuildCost: 'Build without spending materials.',
  KeyPlayerEvents: 'Raids trigger around players wherever they are, rather than only at bases.',
  KeyPassiveMobs: 'Creatures never attack. They can still be killed.',
  KeyNoMap: 'No map or minimap — navigate by landmarks alone.',
  // palworld
  Difficulty: 'Overall preset. "None" means the individual sliders below are used instead.',
  DeathPenalty: 'What you drop when you die.',
  DayTimeSpeedRate: 'How fast daytime passes. 2 = days go by twice as fast.',
  NightTimeSpeedRate: 'How fast nighttime passes.',
  ExpRate: 'XP multiplier for players and Pals.',
  PalCaptureRate: 'Capture-chance multiplier when throwing Pal Spheres.',
  PalSpawnNumRate: 'How many wild Pals spawn — higher means more Pals but more server load.',
  PalDamageRateAttack: 'Damage dealt by your Pals.',
  PalDamageRateDefense: 'Damage taken by your Pals — higher makes them squishier.',
  PalStomachDecreaceRate: 'How fast Pals get hungry.',
  PalStaminaDecreaceRate: 'How fast Pals tire out.',
  PalAutoHPRegeneRate: 'Passive HP regen for Pals.',
  PalEggDefaultHatchingTime: 'Hours for the largest eggs to hatch.',
  WorkSpeedRate: 'Work speed of Pals at your bases.',
  PlayerDamageRateAttack: 'Damage dealt by players.',
  PlayerDamageRateDefense: 'Damage taken by players — higher means you take more.',
  PlayerStomachDecreaceRate: 'How fast players get hungry.',
  PlayerStaminaDecreaceRate: 'How fast player stamina drains.',
  bEnablePlayerToPlayerDamage: 'Players can damage each other (needed for PvP).',
  bEnableFriendlyFire: 'Attacks also hurt your own guildmates and Pals.',
  bEnableInvaderEnemy: 'Raid events — hostile groups periodically attack bases.',
  bIsPvP: 'Enables full PvP mode between players.',
  bHardcore: 'Hardcore — dying has permanent consequences.',
  bPalLost: 'A Pal that faints with its owner is lost forever.',
  ServerPlayerMaxNum: 'Maximum players connected at once.',
  bEnableFastTravel: 'Allow fast travel between unlocked statues.',
  ItemWeightRate: 'Item weight multiplier. 0 = everything is weightless.',
  CollectionDropRate: 'Resource yield from trees, ore, and other gatherables.',
  EnemyDropItemRate: 'Loot dropped by defeated enemies.',
  DropItemMaxNum: 'Max items lying on the ground before the oldest despawn.',
  DropItemAliveMaxHours: 'Hours before dropped items despawn.',
  BaseCampMaxNum: 'Maximum base camps across the whole server.',
  BaseCampWorkerMaxNum: 'Maximum Pals working at one base.',
  BuildObjectDeteriorationDamageRate: 'How fast unattended buildings decay. 0 = no decay.',
  GuildPlayerMaxNum: 'Maximum members per guild.',
  CoopPlayerMaxNum: 'Cap for invite-code co-op — not used by dedicated servers.',
  bAllowGlobalPalboxImport: 'Let players import Pals from other servers. Off keeps progression local.',
  bAllowGlobalPalboxExport: 'Let players export Pals to the global Palbox.',
  CrossplayPlatforms: 'Which platforms are allowed to join together.',
  RESTAPIEnabled: 'Management API ELauncher uses — leave on.',
  RCONEnabled: 'Legacy admin protocol — ELauncher uses the REST API instead.',
  bEnableVoiceChat: 'Built-in proximity voice chat.',
  ServerName: 'Name shown on the join / community-browser screen.',
  ServerDescription: 'Description shown in the server browser.',
  ServerPassword: 'Join password. Empty = anyone with the address can join.',
  // minecraft
  motd: 'The message shown under the server in the multiplayer list.',
  'max-players': 'Maximum players allowed online at once.',
  gamemode: 'Default game mode for players who join.',
  difficulty: 'Peaceful disables hostile mobs; hard is the toughest.',
  'view-distance': 'Chunks sent to players. Lower = smoother, less RAM/CPU.',
  'simulation-distance': 'Chunks that actively tick (mobs, crops). Big performance lever.',
  pvp: 'Allow players to damage each other.',
  'white-list': 'Only let allow-listed players join.',
  'online-mode': 'Verify accounts with Mojang. Keep on unless offline/cracked.',
  hardcore: 'One life — on death the player is banned/spectator.',
  'spawn-protection': 'Radius around spawn only ops can build in. 0 = off.',
  'allow-nether': 'Enable the Nether dimension.',
  'allow-flight': 'Allow flight mods/elytra without kicking for "flying".',
  'enable-command-block': 'Allow command blocks in the world.',
  'level-seed': 'World generation seed. Blank = random.',
  'level-name': 'Folder name of the world.',
  'spawn-monsters': 'Whether hostile mobs spawn.',
  'player-idle-timeout': 'Minutes before an idle player is kicked. 0 = never.',
  'max-tick-time': 'Watchdog: ms a tick can take before the server force-restarts. -1 = off.'
}

type Option = [value: string, label: string]

/**
 * Fixed-choice settings, keyed by game rather than by key alone: `Difficulty`
 * means a Palworld preset here and a 0-5 number in 7 Days to Die, and a select
 * offering the wrong four values would quietly write a setting the game ignores.
 */
const ENUMS: Partial<Record<Game, Record<string, Option[]>>> = {
  palworld: {
    Difficulty: [
      ['None', 'None (use sliders)'],
      ['Casual', 'Casual'],
      ['Normal', 'Normal'],
      ['Hard', 'Hard']
    ],
    DeathPenalty: [
      ['None', 'Keep everything'],
      ['Item', 'Drop items'],
      ['ItemAndEquipment', 'Drop items + equipment'],
      ['All', 'Drop everything (incl. Pals)']
    ]
  },
  minecraft: {
    gamemode: [
      ['survival', 'Survival'],
      ['creative', 'Creative'],
      ['adventure', 'Adventure'],
      ['spectator', 'Spectator']
    ],
    difficulty: [
      ['peaceful', 'Peaceful'],
      ['easy', 'Easy'],
      ['normal', 'Normal'],
      ['hard', 'Hard']
    ]
  },
  // valheim world modifiers — '' means the value the world was made with
  valheim: {
    ModifierCombat: [
      ['', 'Leave as the world has it'],
      ['veryeasy', 'Very easy'],
      ['easy', 'Easy'],
      ['hard', 'Hard'],
      ['veryhard', 'Very hard']
    ],
    ModifierDeathPenalty: [
      ['', 'Leave as the world has it'],
      ['casual', 'Casual — keep everything'],
      ['veryeasy', 'Very easy'],
      ['easy', 'Easy'],
      ['hard', 'Hard'],
      ['hardcore', 'Hardcore']
    ],
    ModifierResources: [
      ['', 'Leave as the world has it'],
      ['muchless', 'Much less'],
      ['less', 'Less'],
      ['more', 'More'],
      ['muchmore', 'Much more'],
      ['most', 'Most']
    ],
    ModifierRaids: [
      ['', 'Leave as the world has it'],
      ['none', 'No raids'],
      ['muchless', 'Much less often'],
      ['less', 'Less often'],
      ['more', 'More often'],
      ['muchmore', 'Much more often']
    ],
    ModifierPortals: [
      ['', 'Leave as the world has it'],
      ['casual', 'Casual — carry anything'],
      ['hard', 'Hard'],
      ['veryhard', 'Very hard — no portals']
    ]
  }
}

/**
 * Mirrors src/shared/ark.ts. The two lists never overlap, and an ASE map name on
 * an ASA server boots an empty world, so the picker is per-game.
 */
const ARK_MAPS: Record<'ark' | 'arksa', Option[]> = {
  ark: [
    ['TheIsland', 'The Island'],
    ['TheCenter', 'The Center'],
    ['ScorchedEarth_P', 'Scorched Earth'],
    ['Ragnarok', 'Ragnarok'],
    ['Aberration_P', 'Aberration'],
    ['Extinction', 'Extinction'],
    ['Valguero_P', 'Valguero'],
    ['CrystalIsles', 'Crystal Isles'],
    ['LostIsland', 'Lost Island'],
    ['Fjordur', 'Fjordur'],
    ['Genesis', 'Genesis: Part 1'],
    ['Gen2', 'Genesis: Part 2']
  ],
  arksa: [
    ['TheIsland_WP', 'The Island'],
    ['TheCenter_WP', 'The Center'],
    ['ScorchedEarth_WP', 'Scorched Earth'],
    ['Aberration_WP', 'Aberration'],
    ['Extinction_WP', 'Extinction'],
    ['Ragnarok_WP', 'Ragnarok'],
    ['Astraeos_WP', 'Astraeos']
  ]
}

/** The curated top section per game: [key, friendly label]. */
type Essential = [key: string, label?: string]

const ESSENTIALS: Record<Game, Essential[]> = {
  palworld: [
    ['ServerName', 'Server name'],
    ['ServerDescription', 'Description'],
    ['ServerPassword', 'Join password'],
    ['ServerPlayerMaxNum', 'Max players'],
    ['Difficulty'],
    ['DeathPenalty'],
    ['ExpRate', 'XP rate'],
    ['PalCaptureRate', 'Capture rate'],
    ['bEnablePlayerToPlayerDamage', 'PvP damage'],
    ['bEnableInvaderEnemy', 'Raids']
  ],
  minecraft: [
    ['motd', 'MOTD'],
    ['max-players', 'Max players'],
    ['gamemode', 'Game mode'],
    ['difficulty', 'Difficulty'],
    ['view-distance', 'View distance'],
    ['pvp', 'PvP'],
    ['white-list', 'Whitelist only']
  ],
  valheim: [
    ['name', 'Server name'],
    ['world', 'World name'],
    ['password', 'Join password'],
    ['public', 'Visible in server list']
  ],
  sdtd: [
    ['ServerName', 'Server name'],
    ['ServerPassword', 'Join password'],
    ['ServerMaxPlayerCount', 'Max players'],
    ['GameDifficulty', 'Difficulty (0-5)'],
    ['DayNightLength', 'Day length (min)'],
    ['ServerDescription', 'Description']
  ],
  // Zomboid writes ~150 keys into its .ini, so the rest land in the grouped list
  zomboid: [
    ['PublicName', 'Server name'],
    ['Password', 'Join password'],
    ['MaxPlayers', 'Max players'],
    ['PublicDescription', 'Description'],
    ['Public', 'List in the public browser'],
    ['PauseEmpty', 'Pause when empty']
  ],
  tmodloader: [
    ['worldname', 'World name'],
    ['password', 'Join password'],
    ['maxplayers', 'Max players'],
    ['motd', 'Message of the day'],
    ['difficulty', 'Difficulty (0-3)']
  ],
  ark: [
    ['Map', 'Map'],
    ['SessionName', 'Server name'],
    ['ServerPassword', 'Join password'],
    ['MaxPlayers', 'Max players'],
    ['ServerPVE', 'PvE only (no player combat)']
  ],
  arksa: [
    ['Map', 'Map'],
    ['SessionName', 'Server name'],
    ['ServerPassword', 'Join password'],
    ['MaxPlayers', 'Max players'],
    ['ServerPVE', 'PvE only (no player combat)']
  ],
  unknown: []
}

/** [title, icon, keys it claims, a note about when they actually bite]. */
type Group = [title: string, icon: string, match: RegExp, note?: string]

const GROUPS: Partial<Record<Game, Group[]>> = {
  palworld: [
    ['Pals', '🐾', /^Pal|Egg|Monster|Capture|Spawn/],
    ['Players & combat', '⚔️', /Player|Damage|Stamina|Stomach|Regene|AimAssist|PvP|Invader|Friendly|Poop|UNKO|Hardcore|Respawn|Enhance|Death/i],
    ['Items & drops', '🎒', /Item|Drop|Collection|Supply|Equipment|Weight|Corruption/i],
    ['Base & guilds', '🏠', /Base|Guild|Build|Building/i],
    ['World & time', '🌍', /Time|Random|Difficulty|WorkSpeed|Day|Night|Exp|Predator|Boss/i],
    ['Multiplayer', '👥', /Coop|Multiplay|Login|FastTravel|Start|Logout|Chat|ClientMod|Crossplay|Voice|Show/i],
    ['Saves & logs', '💾', /Save|Backup|Log|Reset|Alive|Interval|TTL|Cache/i],
    ['Network', '🌐', /Port|RCON|REST|Region|Auth|Ban|Lobby|IP$|Palbox/i]
  ],
  minecraft: [
    ['Gameplay', '⚔️', /gamemode|difficulty|hardcore|pvp|force-gamemode|flight|command-block|gamerule|spawn-(monsters|animals|npcs)/i],
    ['World', '🌍', /level-|generate|max-world|nether|view-distance|simulation-distance|spawn-protection/i],
    ['Players & access', '👥', /max-players|white|online-mode|idle|op-permission|enforce|prevent-proxy|hidden/i],
    ['Network & performance', '🌐', /port|server-ip|network|rate-limit|tick|entity-broadcast|sync-chunk|native|compression|status/i]
  ],
  valheim: [
    ['Who can join', '🌐', /^Crossplay$/],
    ['Saves & backups', '💾', /^(SaveInterval|Backup)/],
    [
      'World modifiers',
      '🌍',
      /^(Modifier|Key)/,
      'Valheim only applies world modifiers while it is generating a world. On a server whose world already exists these are stored but have no effect until a new world is made.'
    ]
  ]
}

/** Settings whose value is prose or a long string, so they get the full width. */
const WIDE_KEYS = new Set([
  'ServerName',
  'ServerDescription',
  'motd',
  'ServerPassword',
  'level-seed',
  'CrossplayPlatforms',
  'PublicDescription',
  'SessionName'
])

const PLATFORMS = ['Steam', 'Xbox', 'PS5', 'Mac']

const isBool = (value: string): boolean => /^(true|false)$/i.test(value)
const isTrue = (value: string): boolean => /^true$/i.test(value)

/** Palworld and both ARKs read True/False; every other game reads lowercase, and
 *  a config written with the wrong casing is silently ignored. */
function boolStr(game: Game, on: boolean): string {
  const titleCase = game === 'palworld' || game === 'ark' || game === 'arksa'
  return titleCase ? (on ? 'True' : 'False') : on ? 'true' : 'false'
}

/** Palworld writes its rates as 1.000000; nobody wants to read that in a field. */
function trimNum(value: string): string {
  const n = Number(value)
  return Number.isFinite(n) && value.trim() !== '' ? String(n) : value
}

function toProps(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries((raw ?? {}) as Record<string, unknown>)) {
    out[key] = value === null || value === undefined ? '' : String(value)
  }
  return out
}

const say = (e: unknown): string => (e instanceof Error ? e.message : 'Something went wrong.')

// ---------- controls ----------

function Control({
  game,
  propKey,
  value,
  original,
  pristine,
  id,
  onChange
}: {
  game: Game
  propKey: string
  value: string
  /** the value as the host has it, which is what picks the control: choosing
   *  from what is being typed turns a half-cleared number field into a text box
   *  under the cursor */
  original: string
  /** untouched since it was read, so it can be prettied without fighting typing */
  pristine: boolean
  id: string
  onChange: (value: string) => void
}): React.JSX.Element {
  if (game === 'palworld' && propKey === 'CrossplayPlatforms') {
    const active = new Set(
      value
        .replace(/[()]/g, '')
        .split(',')
        .map((part) => part.trim())
        .filter(Boolean)
    )
    return (
      <div className="set-seg">
        {PLATFORMS.map((platform) => (
          <Button
            key={platform}
            variant={active.has(platform) ? 'primary' : undefined}
            aria-pressed={active.has(platform)}
            onClick={() =>
              onChange(
                `(${PLATFORMS.filter((p) => (p === platform ? !active.has(p) : active.has(p))).join(',')})`
              )
            }
          >
            {platform}
          </Button>
        ))}
      </div>
    )
  }

  // ARK's map is a launch argument rather than an ini value, and its list is
  // per-game, so it can't live in the key-keyed enums
  const options = propKey === 'Map' && (game === 'ark' || game === 'arksa') ? ARK_MAPS[game] : ENUMS[game]?.[propKey]
  if (options) {
    return (
      <select id={id} className="input" value={value} onChange={(e) => onChange(e.target.value)}>
        {/* a file can hold a value no build of the game offers any more; keeping
            it listed stops the picker from silently rewriting it on save */}
        {!options.some(([option]) => option === value) && <option value={value}>{value || '—'}</option>}
        {options.map(([option, label]) => (
          <option key={option} value={option}>
            {label}
          </option>
        ))}
      </select>
    )
  }

  const numeric = /^-?\d+(\.\d+)?$/.test(original)
  if (game === 'palworld' && /Rate$/.test(propKey) && numeric) {
    const current = Number(value)
    return (
      <div className="set-seg">
        {[0.5, 1, 2, 3].map((preset) => (
          <Button
            key={preset}
            variant={Math.abs(current - preset) < 0.001 ? 'primary' : undefined}
            aria-pressed={Math.abs(current - preset) < 0.001}
            onClick={() => onChange(String(preset))}
          >
            ×{preset}
          </Button>
        ))}
        <input
          id={id}
          className="input"
          type="number"
          step="0.1"
          min="0"
          value={pristine ? trimNum(value) : value}
          onChange={(e) => onChange(e.target.value)}
        />
      </div>
    )
  }

  if (numeric) {
    return (
      <input
        id={id}
        className="input"
        type="number"
        step="any"
        value={pristine ? trimNum(value) : value}
        onChange={(e) => onChange(e.target.value)}
      />
    )
  }

  return <input id={id} className="input" value={value} onChange={(e) => onChange(e.target.value)} />
}

function SettingRow({
  game,
  propKey,
  label,
  value,
  original,
  pristine,
  onChange
}: {
  game: Game
  propKey: string
  label: string
  value: string
  original: string
  pristine: boolean
  onChange: (value: string) => void
}): React.JSX.Element {
  const hint = HINTS[propKey]
  const id = `set-${propKey}`
  // a set of buttons has nothing a <label for> can point at, so the row labels
  // the group instead of naming a control that cannot be focused
  const group = game === 'palworld' && propKey === 'CrossplayPlatforms'

  if (isBool(original)) {
    return (
      <label className="set-check" htmlFor={id}>
        <input
          id={id}
          type="checkbox"
          checked={isTrue(value)}
          onChange={(e) => onChange(boolStr(game, e.target.checked))}
        />
        <span className="set-checkbody">
          <span className="set-checklabel">{label}</span>
          {hint && <span className="set-hint">{hint}</span>}
        </span>
      </label>
    )
  }

  return (
    <div className="field" role={group ? 'group' : undefined} aria-label={group ? label : undefined}>
      {group ? <span className="set-label">{label}</span> : <label htmlFor={id}>{label}</label>}
      <Control
        game={game}
        propKey={propKey}
        value={value}
        original={original}
        pristine={pristine}
        id={id}
        onChange={onChange}
      />
      {hint && <p className="set-hint">{hint}</p>}
    </div>
  )
}

// ---------- the tab ----------

export function Settings({ row, userId, ask }: TabProps): React.JSX.Element {
  const [props, setProps] = useState<Record<string, string> | null>(null)
  const [loadError, setLoadError] = useState('')
  const [edits, setEdits] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState('')
  const [saved, setSaved] = useState('')
  const [query, setQuery] = useState('')
  const [opened, setOpened] = useState<Record<string, boolean>>({})
  const [attempt, setAttempt] = useState(0)

  // makeAsk hands out a fresh closure for every render of the shell, so the load
  // is keyed on the server it is about rather than on the function's identity —
  // otherwise a parent that rebuilds `ask` inline would refetch forever
  const askRef = useRef(ask)
  useEffect(() => {
    askRef.current = ask
  })

  useEffect(() => {
    let alive = true
    setProps(null)
    setLoadError('')
    setEdits({})
    setSaved('')
    setSaveError('')
    void askRef.current<Record<string, string>>('getProps').then(
      (raw) => {
        if (alive) setProps(toProps(raw))
      },
      (e: unknown) => {
        if (alive) setLoadError(say(e))
      }
    )
    return () => {
      alive = false
    }
  }, [row.server_id, userId, attempt])

  const model = useMemo(() => {
    if (!props) return null
    const game = detectGame(props)
    const essentials = ESSENTIALS[game]
    const claimed = new Set(essentials.map(([key]) => key))
    const groups = GROUPS[game] ?? []
    const buckets = groups.map((group) => ({ title: group[0], icon: group[1], note: group[3], keys: [] as string[] }))
    buckets.push({ title: 'Other', icon: '⚙️', note: undefined, keys: [] })
    for (const key of Object.keys(props).filter((key) => !claimed.has(key)).sort()) {
      const at = groups.findIndex((group) => group[2].test(key))
      buckets[at === -1 ? buckets.length - 1 : at].keys.push(key)
    }
    return { game, essentials, buckets: buckets.filter((bucket) => bucket.keys.length > 0) }
  }, [props])

  if (loadError) {
    return (
      <div className="surface pad stack">
        <p className="formerr" role="alert">
          {loadError}
        </p>
        <div className="row">
          <Button variant="primary" onClick={() => setAttempt((n) => n + 1)}>
            Try again
          </Button>
        </div>
      </div>
    )
  }

  if (!props || !model) {
    return (
      <div className="stack">
        <Skeleton height={64} />
        <Skeleton height={220} />
        <Skeleton height={160} />
      </div>
    )
  }

  const { game, essentials, buckets } = model
  const valueOf = (key: string): string => edits[key] ?? props[key] ?? ''
  const change = (key: string) => (value: string) => {
    setEdits((prev) => ({ ...prev, [key]: value }))
    setSaved('')
  }

  const needle = query.trim().toLowerCase()
  const matches = (key: string): boolean =>
    !needle || `${key} ${labelFor(key)} ${HINTS[key] ?? ''}`.toLowerCase().includes(needle)

  const dirtyCount = Object.keys(edits).length

  async function save(): Promise<void> {
    setSaving(true)
    setSaveError('')
    setSaved('')
    try {
      const answer = await askRef.current<Record<string, string>>('setProps', { updates: edits })
      // the host replies with the file as it now reads, so a value it clamped or
      // normalised replaces what was typed instead of sitting there looking taken
      const written = toProps(answer)
      setProps((prev) => (Object.keys(written).length > 0 ? written : { ...(prev ?? {}), ...edits }))
      setEdits({})
      setSaved(
        row.state === 'running'
          ? 'Saved — the server picks these up on its next restart.'
          : 'Saved — they apply the next time this server starts.'
      )
    } catch (e) {
      setSaveError(say(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="stack set">
      <section className="surface pad stack">
        <h2>{GAME_LABEL[game]} settings</h2>
        <p className="dim">
          The essentials are up top; everything else this server writes is grouped below. Changes are sent
          together when you save, and the game reads them at its next start.
        </p>
      </section>

      {/* A server that has never started has no settings file yet, and the host
          answers with an empty map rather than an error. */}
      {essentials.length === 0 && buckets.length === 0 && (
        <section className="surface pad">
          <p className="dim">
            This server has not written a settings file yet. It appears here once the game has started for the
            first time and saved its own defaults.
          </p>
        </section>
      )}

      {essentials.length > 0 && (
        <section className="surface pad">
          <div className="set-grid">
            {essentials.map(([key, label]) => (
              <div key={key} className={WIDE_KEYS.has(key) || isBool(props[key] ?? '') ? 'full' : undefined}>
                <SettingRow
                  game={game}
                  propKey={key}
                  label={label ?? labelFor(key)}
                  value={valueOf(key)}
                  original={props[key] ?? ''}
                  pristine={!(key in edits)}
                  onChange={change(key)}
                />
              </div>
            ))}
          </div>
        </section>
      )}

      {buckets.length > 0 && (
        <div className="stack">
          <h2>Advanced settings</h2>
          {/* named for what it actually searches: the essentials above are always
              on screen, so filtering them would only make the page jump */}
          <input
            className="input"
            type="search"
            value={query}
            aria-label="Search the settings below"
            placeholder="Search these settings…"
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
      )}

      {needle && !buckets.some((bucket) => bucket.keys.some(matches)) && (
        <p className="dim">Nothing below matches “{query.trim()}”.</p>
      )}

      {buckets.map((bucket) => {
        const keys = bucket.keys.filter(matches)
        if (keys.length === 0) return null
        // a search is a request to see what matched, so it opens every group that
        // has a hit rather than leaving the answer one tap away
        const open = needle ? true : Boolean(opened[bucket.title])
        return (
          <section key={bucket.title} className="surface">
            <button
              className="set-grouphead"
              aria-expanded={open}
              onClick={() => setOpened((prev) => ({ ...prev, [bucket.title]: !open }))}
            >
              <span aria-hidden>{bucket.icon}</span>
              <span className="set-grouptitle">{bucket.title}</span>
              <span className="dim">{keys.length}</span>
              <span className={`set-chev ${open ? 'open' : ''}`} aria-hidden>
                ›
              </span>
            </button>
            {open && (
              <div className="set-groupbody stack">
                {bucket.note && <p className="formnote">{bucket.note}</p>}
                {keys.map((key) => (
                  <SettingRow
                    key={key}
                    game={game}
                    propKey={key}
                    label={labelFor(key)}
                    value={valueOf(key)}
                    original={props[key] ?? ''}
                    pristine={!(key in edits)}
                    onChange={change(key)}
                  />
                ))}
              </div>
            )}
          </section>
        )
      })}

      {/* The dock rides the bottom of the screen while there is anything to say or
          do: a save button at the far end of a 150-key list is a save button
          nobody on a phone ever reaches. */}
      {(dirtyCount > 0 || saved || saveError) && (
        <div className="set-dock">
          {saveError && (
            <p className="formerr" role="alert">
              {saveError}
            </p>
          )}
          {saved && !saveError && <p className="formnote">{saved}</p>}
          {dirtyCount > 0 && (
            <div className="row">
              <span className="dim">
                {dirtyCount} change{dirtyCount === 1 ? '' : 's'}
              </span>
              <span className="spacer" />
              <Button variant="ghost" disabled={saving} onClick={() => setEdits({})}>
                Discard
              </Button>
              <Button variant="primary" disabled={saving} onClick={save}>
                {saving ? 'Saving…' : 'Save settings'}
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
