import type { SteamServerGame } from './types'

/**
 * How each SteamCMD game is described to a person. Shared because three places
 * need the same words — the main process (log lines and error messages), the
 * create modal, and the settings tab — and a game named differently in the
 * picker than in the error it produces reads like two different products.
 *
 * The technical half of a game's definition (app id, ports, protocol) stays in
 * main/services/steamgames.ts: the renderer has no use for it.
 */
export interface SteamGameInfo {
  label: string
  blurb: string
  /** rough steady-state RAM in GB, shown in the picker so a heavy game is not a surprise */
  ramHintGb: number
}

export const STEAM_GAME_INFO: Record<SteamServerGame, SteamGameInfo> = {
  valheim: { label: 'Valheim', blurb: 'Co-op Viking survival and building.', ramHintGb: 4 },
  sdtd: { label: '7 Days to Die', blurb: 'Open-world zombie survival crafting.', ramHintGb: 8 },
  zomboid: { label: 'Project Zomboid', blurb: 'Isometric zombie survival sandbox.', ramHintGb: 4 },
  tmodloader: { label: 'tModLoader', blurb: 'Modded Terraria — the lightest server here.', ramHintGb: 3 },
  ark: { label: 'ARK: Survival Evolved', blurb: 'Dinosaur survival. A large download and heavy to run.', ramHintGb: 8 },
  arksa: {
    label: 'ARK: Survival Ascended',
    blurb: 'The Unreal 5 remake of ARK. The heaviest server here.',
    ramHintGb: 16
  }
}

/** Asked of raw strings off the wire, so it reads the table rather than a copy of it. */
export function isSteamGameId(game: string | undefined): game is SteamServerGame {
  return game !== undefined && Object.prototype.hasOwnProperty.call(STEAM_GAME_INFO, game)
}

/** Every Steam game, in the order the create picker offers them. */
export const STEAM_GAME_IDS = Object.keys(STEAM_GAME_INFO) as SteamServerGame[]
