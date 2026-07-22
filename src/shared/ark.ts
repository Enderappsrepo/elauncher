/**
 * The maps each ARK ships with, shared because both sides need the same list:
 * the main process validates the map before it reaches a launch line, and the
 * settings panel offers it. Two copies would drift, and a map name the game
 * doesn't know boots a server that loads forever and answers nobody.
 *
 * Survival Ascended rebuilt its maps on World Partition and renamed them to
 * match, so the two lists deliberately never overlap.
 */
export interface ArkMap {
  /** what the game expects as the first launch argument */
  id: string
  label: string
}

export const ARK_MAPS: Record<'ark' | 'arksa', ArkMap[]> = {
  ark: [
    { id: 'TheIsland', label: 'The Island' },
    { id: 'TheCenter', label: 'The Center' },
    { id: 'ScorchedEarth_P', label: 'Scorched Earth' },
    { id: 'Ragnarok', label: 'Ragnarok' },
    { id: 'Aberration_P', label: 'Aberration' },
    { id: 'Extinction', label: 'Extinction' },
    { id: 'Valguero_P', label: 'Valguero' },
    { id: 'CrystalIsles', label: 'Crystal Isles' },
    { id: 'LostIsland', label: 'Lost Island' },
    { id: 'Fjordur', label: 'Fjordur' },
    { id: 'Genesis', label: 'Genesis: Part 1' },
    { id: 'Gen2', label: 'Genesis: Part 2' }
  ],
  arksa: [
    { id: 'TheIsland_WP', label: 'The Island' },
    { id: 'TheCenter_WP', label: 'The Center' },
    { id: 'ScorchedEarth_WP', label: 'Scorched Earth' },
    { id: 'Aberration_WP', label: 'Aberration' },
    { id: 'Extinction_WP', label: 'Extinction' },
    { id: 'Ragnarok_WP', label: 'Ragnarok' },
    { id: 'Astraeos_WP', label: 'Astraeos' }
  ]
}

/** The map a new server starts on when nobody picks one. */
export const arkDefaultMap = (game: 'ark' | 'arksa'): string => ARK_MAPS[game][0].id

export const isArkMap = (game: 'ark' | 'arksa', id: string): boolean => ARK_MAPS[game].some((m) => m.id === id)
