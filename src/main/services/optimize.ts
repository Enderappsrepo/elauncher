import type {
  GraphicsPreset,
  InstalledMod,
  ModConflict,
  ModLoader,
  OptimizationPlan,
  OptimizeResult,
  PerfCategory,
  PerfMod
} from '@shared/types'
import { getInstance } from './instances'
import { installMod, listInstalledMods, modrinthFetch } from './mods'
import { setGameOptions } from './gameOptions'
import { emitProgress, getRunStates, setInstallingState } from './game'

/**
 * Curated performance-mod catalog. Every entry is a Modrinth slug, so no API key
 * is needed and Modrinth's own version data decides real compatibility. Grouped
 * by the loader the instance uses; `core` mods deliver the big wins, `extra` are
 * safe quality-of-life boosts, and `shaders` unlocks shader packs.
 */
interface CatalogEntry {
  slug: string
  name: string
  blurb: string
  category: PerfCategory
}

const FABRIC: CatalogEntry[] = [
  { slug: 'sodium', name: 'Sodium', blurb: 'Rewrites the render engine — the single biggest FPS boost', category: 'core' },
  { slug: 'lithium', name: 'Lithium', blurb: 'Optimizes physics, mob AI and chunk ticking', category: 'core' },
  { slug: 'ferrite-core', name: 'FerriteCore', blurb: 'Cuts memory usage substantially', category: 'core' },
  { slug: 'modernfix', name: 'ModernFix', blurb: 'Faster load times and lower memory use', category: 'core' },
  { slug: 'immediatelyfast', name: 'ImmediatelyFast', blurb: 'Speeds up text, item and UI rendering', category: 'extra' },
  { slug: 'entityculling', name: 'Entity Culling', blurb: "Skips rendering entities you can't see", category: 'extra' },
  { slug: 'sodium-extra', name: 'Sodium Extra', blurb: 'Extra toggles for fog, particles and weather', category: 'extra' },
  { slug: 'dynamic-fps', name: 'Dynamic FPS', blurb: 'Drops resource use when the window is unfocused', category: 'extra' },
  { slug: 'krypton', name: 'Krypton', blurb: 'Optimizes the networking stack', category: 'extra' },
  { slug: 'reeses-sodium-options', name: "Reese's Sodium Options", blurb: 'A cleaner, more complete video menu', category: 'extra' },
  { slug: 'modmenu', name: 'Mod Menu', blurb: 'In-game mod list & config screens', category: 'extra' },
  { slug: 'iris', name: 'Iris Shaders', blurb: "Shader support that keeps Sodium's speed", category: 'shaders' }
]

const FORGE: CatalogEntry[] = [
  { slug: 'embeddium', name: 'Embeddium', blurb: "Sodium's render engine, ported to Forge", category: 'core' },
  { slug: 'ferrite-core', name: 'FerriteCore', blurb: 'Cuts memory usage substantially', category: 'core' },
  { slug: 'modernfix', name: 'ModernFix', blurb: 'Faster load times and lower memory use', category: 'core' },
  { slug: 'immediatelyfast', name: 'ImmediatelyFast', blurb: 'Speeds up text, item and UI rendering', category: 'extra' },
  { slug: 'entityculling', name: 'Entity Culling', blurb: "Skips rendering entities you can't see", category: 'extra' },
  { slug: 'saturn', name: 'Saturn', blurb: 'Memory & math optimizations', category: 'extra' },
  { slug: 'oculus', name: 'Oculus Shaders', blurb: 'Shader support for Forge (pairs with Embeddium)', category: 'shaders' }
]

const NEOFORGE: CatalogEntry[] = [
  { slug: 'embeddium', name: 'Embeddium', blurb: "Sodium's render engine, ported to NeoForge", category: 'core' },
  { slug: 'ferrite-core', name: 'FerriteCore', blurb: 'Cuts memory usage substantially', category: 'core' },
  { slug: 'modernfix', name: 'ModernFix', blurb: 'Faster load times and lower memory use', category: 'core' },
  { slug: 'immediatelyfast', name: 'ImmediatelyFast', blurb: 'Speeds up text, item and UI rendering', category: 'extra' },
  { slug: 'entityculling', name: 'Entity Culling', blurb: "Skips rendering entities you can't see", category: 'extra' },
  { slug: 'oculus', name: 'Oculus Shaders', blurb: 'Shader support (pairs with Embeddium)', category: 'shaders' }
]

const CATALOG: Record<Exclude<ModLoader, 'vanilla'>, CatalogEntry[]> = {
  fabric: FABRIC,
  forge: FORGE,
  neoforge: NEOFORGE
}

/**
 * The two mutually-exclusive rendering stacks. Sodium and Embeddium are the same
 * engine forked for different loaders; each carries its own shader bridge (Iris
 * vs Oculus) plus companion mods that inherit the split. A mod from one stack
 * cannot load while any mod from the other is present — the game aborts with a
 * hard "incompatible mods" error. Slugs here may live outside CATALOG (Sodium
 * and Veil aren't offered on Forge/NeoForge but are commonly installed anyway),
 * so conflicts are checked against everything in the mods folder, not just the
 * catalog.
 */
const RENDER_STACKS: Record<string, string[]> = {
  sodium: ['sodium', 'sodium-extra', 'reeses-sodium-options', 'iris', 'veil'],
  embeddium: ['embeddium', 'oculus']
}

const SLUG_STACK = new Map<string, string>(
  Object.entries(RENDER_STACKS).flatMap(([stack, slugs]) => slugs.map((slug) => [slug, stack] as const))
)

/** Every slug that belongs to a render stack — folded into the bulk lookup so installed mods resolve to a slug. */
const STACK_SLUGS = [...SLUG_STACK.keys()]

/**
 * Best-effort match of a mod's jar file name to a render-stack slug. Covers jars
 * added outside the launcher (manual drops, imported packs) that carry no
 * Modrinth id in our metadata. Slugs are matched on token boundaries so e.g.
 * "veil" doesn't hit "unveiled".
 */
function stackSlugFromFileName(fileName: string): string | undefined {
  const lower = fileName.toLowerCase()
  return STACK_SLUGS.find((slug) => new RegExp(`(^|[^a-z0-9])${slug}([^a-z0-9]|$)`).test(lower))
}

interface ActiveStackMod {
  stack: string
  name: string
}

/**
 * Render-stack mods that are currently *enabled* in the instance, tagged with
 * their stack and display name. Disabled (.disabled) jars are inert and ignored.
 */
function activeStackMods(installed: InstalledMod[], idToSlug: Map<string, string>): ActiveStackMod[] {
  const active: ActiveStackMod[] = []
  for (const mod of installed) {
    if (!mod.enabled) continue
    const slug = (mod.projectId && idToSlug.get(mod.projectId)) || stackSlugFromFileName(mod.fileName)
    const stack = slug ? SLUG_STACK.get(slug) : undefined
    if (stack) active.push({ stack, name: mod.title ?? mod.displayName })
  }
  return active
}

/** Summarize opposing render-stack mods installed together into a single user-facing warning. */
function describeConflicts(active: ActiveStackMod[]): ModConflict[] {
  const sodiumSide = [...new Set(active.filter((a) => a.stack === 'sodium').map((a) => a.name))]
  const embeddiumSide = [...new Set(active.filter((a) => a.stack === 'embeddium').map((a) => a.name))]
  if (sodiumSide.length === 0 || embeddiumSide.length === 0) return []
  return [
    {
      mods: [...embeddiumSide, ...sodiumSide],
      reason: `${embeddiumSide.join(' + ')} can't run alongside ${sodiumSide.join(' + ')}. Sodium and Embeddium are the same rendering engine built for different loaders, so the game refuses to load both at once. Remove one set in the Mods tab.`
    }
  ]
}

/** Shape of the Modrinth bulk-projects response entries we care about. */
interface ModrinthProject {
  id: string
  slug: string
  title: string
  icon_url?: string
  game_versions: string[]
  loaders: string[]
}

/**
 * Build the optimization plan for an instance: which curated mods are already
 * installed, which are compatible and ready to install, and which don't have a
 * build for this Minecraft version + loader. One bulk Modrinth request resolves
 * canonical ids, icons and aggregate compatibility for the whole catalog.
 */
export async function getOptimizationPlan(instanceId: string): Promise<OptimizationPlan> {
  const instance = getInstance(instanceId)
  if (instance.loader === 'vanilla') return { loaderSupported: false, mods: [], conflicts: [] }

  const catalog = CATALOG[instance.loader]
  // Resolve the catalog *and* every render-stack mod in one request, so mods
  // already installed but not in the catalog (e.g. Sodium/Veil on NeoForge)
  // still map from their Modrinth id back to a slug for conflict detection.
  const lookupSlugs = [...new Set([...catalog.map((c) => c.slug), ...STACK_SLUGS])]

  let bySlug = new Map<string, ModrinthProject>()
  let idToSlug = new Map<string, string>()
  try {
    const projects = (await modrinthFetch(
      `/projects?ids=${encodeURIComponent(JSON.stringify(lookupSlugs))}`
    )) as ModrinthProject[]
    bySlug = new Map(projects.map((p) => [p.slug, p]))
    idToSlug = new Map(projects.map((p) => [p.id, p.slug]))
  } catch {
    // network/API failure: every mod falls back to "unavailable" rather than crashing the tab
  }

  const installed = listInstalledMods(instanceId)
  const installedIds = new Set(
    installed.filter((m) => m.source === 'modrinth' && m.projectId).map((m) => m.projectId!)
  )
  const active = activeStackMods(installed, idToSlug)

  const mods: PerfMod[] = catalog.map((entry) => {
    const proj = bySlug.get(entry.slug)
    const base = { slug: entry.slug, name: entry.name, blurb: entry.blurb, category: entry.category }
    if (!proj) return { ...base, status: 'incompatible' }
    const shared = { ...base, projectId: proj.id, iconUrl: proj.icon_url }
    if (installedIds.has(proj.id)) return { ...shared, status: 'installed' }
    const compatible =
      proj.game_versions.includes(instance.minecraftVersion) && proj.loaders.includes(instance.loader)
    if (!compatible) return { ...shared, status: 'incompatible' }
    // Compatible on paper — but would installing it clash with a render mod
    // already in the pack? (e.g. Embeddium while Sodium/Iris/Veil are present.)
    const stack = SLUG_STACK.get(entry.slug)
    const clash = stack ? active.find((a) => a.stack !== stack) : undefined
    if (clash) return { ...shared, status: 'conflict', conflictsWith: clash.name }
    return { ...shared, status: 'available' }
  })

  return { loaderSupported: true, mods, conflicts: describeConflicts(active) }
}

/**
 * Install the given Modrinth projects into the instance, reusing the vetted
 * mod-install pipeline (which resolves the right file, pulls dependencies and
 * de-dupes). Reports progress through the shared install UI. One mod failing
 * (e.g. no build for this exact version) never aborts the rest.
 */
export async function applyOptimization(instanceId: string, projectIds: string[]): Promise<OptimizeResult> {
  const busy = getRunStates()[instanceId]
  if (busy === 'running' || busy === 'installing') {
    throw new Error('This instance is busy — wait for it to finish before optimizing.')
  }
  if (projectIds.length === 0) return { installed: 0, failed: 0, blocked: 0 }

  // Re-derive the plan against the pack as it is *right now* and only install
  // mods it still rates installable. This is the safety net that keeps a stale
  // selection (or a caller that skipped the UI) from dropping a conflicting
  // renderer like Embeddium next to an installed Sodium.
  const plan = await getOptimizationPlan(instanceId)
  const installable = new Set(
    plan.mods.filter((m) => m.status === 'available' && m.projectId).map((m) => m.projectId!)
  )
  const toInstall = projectIds.filter((id) => installable.has(id))
  const blocked = projectIds.length - toInstall.length
  if (toInstall.length === 0) return { installed: 0, failed: 0, blocked }

  setInstallingState(instanceId, true)
  let installed = 0
  let failed = 0
  try {
    for (let i = 0; i < toInstall.length; i++) {
      emitProgress(instanceId, `Installing performance mods (${i + 1}/${toInstall.length})`, i / toInstall.length)
      try {
        await installMod({ instanceId, source: 'modrinth', projectId: toInstall[i] })
        installed++
      } catch (e) {
        failed++
        console.warn(`Optimize: failed to install ${toInstall[i]}:`, e)
      }
    }
    emitProgress(instanceId, 'Performance mods installed', 1)
  } finally {
    setInstallingState(instanceId, false)
  }
  return { installed, failed, blocked }
}

/**
 * options.txt values for each graphics preset. Only well-established, version-safe
 * keys are written (the game ignores any it doesn't recognize); `setGameOptions`
 * merges them in, leaving keybinds and everything else untouched.
 */
const PRESETS: Record<GraphicsPreset, Record<string, string>> = {
  performance: {
    renderDistance: '8',
    simulationDistance: '8',
    maxFps: '260',
    graphicsMode: '0',
    particles: '2',
    ao: 'false',
    entityShadows: 'false',
    enableVsync: 'false',
    bobView: 'false',
    biomeBlendRadius: '0',
    mipmapLevels: '0',
    entityDistanceScaling: '0.75'
  },
  balanced: {
    renderDistance: '12',
    simulationDistance: '12',
    maxFps: '120',
    graphicsMode: '1',
    particles: '1',
    ao: 'true',
    entityShadows: 'true',
    enableVsync: 'true',
    bobView: 'true',
    biomeBlendRadius: '2',
    mipmapLevels: '2',
    entityDistanceScaling: '1.0'
  },
  quality: {
    renderDistance: '20',
    simulationDistance: '16',
    maxFps: '120',
    graphicsMode: '2',
    particles: '0',
    ao: 'true',
    entityShadows: 'true',
    enableVsync: 'true',
    bobView: 'true',
    biomeBlendRadius: '5',
    mipmapLevels: '4',
    entityDistanceScaling: '2.0'
  }
}

/** Apply a graphics preset by merge-writing its values into the instance's options.txt. */
export function applyGraphicsPreset(instanceId: string, preset: GraphicsPreset): void {
  const values = PRESETS[preset]
  if (!values) throw new Error(`Unknown graphics preset: ${preset}`)
  setGameOptions(instanceId, values)
}
