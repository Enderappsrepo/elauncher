/** Game metadata shared by the landing page, the shop and the panel.
 *
 * One file because the three keep drifting: the landing advertised two games
 * while the host ran eight. The panel re-exports from here, the landing reads
 * the lineup, and the shop groups its plans with the same labels and hues.
 */

/** Games a server can be. Published by the host; older clouds send nothing. */
export type Game =
  | 'minecraft' | 'palworld' | 'valheim' | 'sdtd' | 'zomboid' | 'tmodloader' | 'ark' | 'arksa'

export const GAME_LABEL: Record<Game, string> = {
  minecraft: 'Minecraft',
  palworld: 'Palworld',
  valheim: 'Valheim',
  sdtd: '7 Days to Die',
  zomboid: 'Project Zomboid',
  tmodloader: 'tModLoader',
  ark: 'ARK: Survival Evolved',
  arksa: 'ARK: Survival Ascended'
}

/**
 * A colour per game, so a list of eight servers is scannable without reading a
 * word of it. Hue only — the badge takes its lightness from the theme, or the
 * light one would be unreadable.
 */
export const GAME_HUE: Record<Game, number> = {
  minecraft: 140,
  palworld: 202,
  valheim: 28,
  sdtd: 8,
  zomboid: 96,
  tmodloader: 268,
  ark: 178,
  arksa: 318
}

export function gameLabel(game: string | null): string {
  if (game && game in GAME_LABEL) return GAME_LABEL[game as Game]
  // deliberately not 'Server': a null game means the host has not published one
  // yet (old cloud, or a box that predates the column), and calling that a
  // generic 'Server' hides the fact that the data is simply missing
  return 'Unknown game'
}

/** The lineup as the landing and shop present it — display order, one line each. */
export const GAME_LINEUP: ReadonlyArray<{ id: Game; label: string; blurb: string }> = [
  { id: 'minecraft', label: 'Minecraft', blurb: 'Vanilla, Paper, Fabric, Forge & NeoForge' },
  { id: 'palworld', label: 'Palworld', blurb: 'Dedicated server with live REST controls' },
  { id: 'ark', label: 'ARK: Survival Evolved', blurb: 'Full RCON moderation built in' },
  { id: 'arksa', label: 'ARK: Survival Ascended', blurb: 'The new ARK, hosted the same way' },
  { id: 'valheim', label: 'Valheim', blurb: 'Your world, up before the next raid' },
  { id: 'sdtd', label: '7 Days to Die', blurb: 'Horde nights on your own terms' },
  { id: 'zomboid', label: 'Project Zomboid', blurb: 'Persistent co-op survival' },
  { id: 'tmodloader', label: 'tModLoader', blurb: 'Modded Terraria for the whole group' }
]
