/** BeamMP-specific metadata; this game is installed from GitHub, not SteamCMD. */
export const BEAMMP_LABEL = 'BeamNG.drive (BeamMP)'
export const BEAMMP_DEFAULT_MAP = '/levels/gridmap_v2/info.json'
export const BEAMMP_DEFAULT_PLAYERS = 8
export const BEAMMP_DEFAULT_CARS = 2
export const BEAMMP_BASE_PORT = 30814

/** Stock map paths from https://docs.beammp.com/server/server-maintenance/. */
export const BEAMMP_MAPS: ReadonlyArray<{ value: string; label: string }> = [
  { value: BEAMMP_DEFAULT_MAP, label: 'Gridmap v2' },
  { value: '/levels/west_coast_usa/info.json', label: 'West Coast, USA' },
  { value: '/levels/east_coast_usa/info.json', label: 'East Coast, USA' },
  { value: '/levels/italy/info.json', label: 'Italy' },
  { value: '/levels/johnson_valley/info.json', label: 'Johnson Valley' },
  { value: '/levels/utah/info.json', label: 'Utah' },
  { value: '/levels/hirochi_raceway/info.json', label: 'Hirochi Raceway' },
  { value: '/levels/industrial/info.json', label: 'Industrial Site' },
  { value: '/levels/small_island/info.json', label: 'Small Island, USA' },
  { value: '/levels/jungle_rock_island/info.json', label: 'Jungle Rock Island' },
  { value: '/levels/automation_test_track/info.json', label: 'Automation Test Track' },
  { value: '/levels/smallgrid/info.json', label: 'Small Grid' },
  { value: '/levels/driver_training/info.json', label: 'Driver Training' },
  { value: '/levels/derby/info.json', label: 'Derby Arenas' }
]
