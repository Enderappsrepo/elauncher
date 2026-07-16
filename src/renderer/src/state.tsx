import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import type {
  AccountsState,
  CloudUpdateMap,
  CloudUser,
  GameStateEvent,
  Instance,
  InstanceRunState,
  PackTaskEvent,
  ProgressEvent
} from '@shared/types'

interface AppState {
  accounts: AccountsState
  instances: Instance[]
  runStates: Record<string, InstanceRunState>
  progress: Record<string, ProgressEvent>
  /** running modpack install/import tasks, keyed by cloud pack id or 'import' */
  packTasks: Record<string, PackTaskEvent>
  lastGameEvents: Record<string, GameStateEvent>
  cloudAvailable: boolean
  cloudUser: CloudUser | null
  cloudUpdates: CloudUpdateMap
  refreshAccounts: () => Promise<void>
  refreshInstances: () => Promise<void>
  refreshCloud: () => Promise<void>
  login: () => Promise<void>
  logout: (uuid: string) => Promise<void>
  setActiveAccount: (uuid: string) => Promise<void>
  launch: (instanceId: string) => Promise<string | null>
  kill: (instanceId: string) => Promise<void>
}

const Ctx = createContext<AppState | null>(null)

export function AppStateProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const [accounts, setAccounts] = useState<AccountsState>({ accounts: [], activeUuid: null })
  const [instances, setInstances] = useState<Instance[]>([])
  const [runStates, setRunStates] = useState<Record<string, InstanceRunState>>({})
  const [progress, setProgress] = useState<Record<string, ProgressEvent>>({})
  const [packTasks, setPackTasks] = useState<Record<string, PackTaskEvent>>({})
  const [lastGameEvents, setLastGameEvents] = useState<Record<string, GameStateEvent>>({})
  const [cloudAvailable, setCloudAvailable] = useState(false)
  const [cloudUser, setCloudUser] = useState<CloudUser | null>(null)
  const [cloudUpdates, setCloudUpdates] = useState<CloudUpdateMap>({})

  const refreshAccounts = useCallback(async () => {
    setAccounts(await window.elauncher.auth.getState())
  }, [])

  const refreshInstances = useCallback(async () => {
    setInstances(await window.elauncher.instances.list())
  }, [])

  const refreshCloud = useCallback(async () => {
    const available = await window.elauncher.cloud.available()
    setCloudAvailable(available)
    if (!available) return
    const user = await window.elauncher.cloud.getUser().catch(() => null)
    setCloudUser(user)
    setCloudUpdates(user ? await window.elauncher.cloud.checkUpdates() : {})
  }, [])

  useEffect(() => {
    void refreshAccounts()
    void refreshInstances()
    void refreshCloud()
    void window.elauncher.game.getStates().then(setRunStates)

    const offProgress = window.elauncher.game.onProgress((e) => {
      setProgress((p) => ({ ...p, [e.instanceId]: e }))
    })
    const offPackTasks = window.elauncher.packs.onProgress((e) => {
      setPackTasks((tasks) => {
        if (e.done) {
          if (!(e.taskId in tasks)) return tasks
          const next = { ...tasks }
          delete next[e.taskId]
          return next
        }
        return { ...tasks, [e.taskId]: e }
      })
    })
    const offState = window.elauncher.game.onState((e) => {
      setRunStates((s) => ({ ...s, [e.instanceId]: e.state }))
      setLastGameEvents((s) => ({ ...s, [e.instanceId]: e }))
      if (e.state !== 'installing') {
        setProgress((p) => {
          const next = { ...p }
          delete next[e.instanceId]
          return next
        })
      }
      // playtime/lastPlayed change when a game starts or exits
      if (e.state === 'idle' || e.state === 'running') void refreshInstances()
    })
    return () => {
      offProgress()
      offPackTasks()
      offState()
    }
  }, [refreshAccounts, refreshInstances, refreshCloud])

  const login = useCallback(async () => {
    await window.elauncher.auth.login()
    await refreshAccounts()
  }, [refreshAccounts])

  const logout = useCallback(
    async (uuid: string) => {
      setAccounts(await window.elauncher.auth.logout(uuid))
    },
    []
  )

  const setActiveAccount = useCallback(async (uuid: string) => {
    setAccounts(await window.elauncher.auth.setActive(uuid))
  }, [])

  const launch = useCallback(
    async (instanceId: string): Promise<string | null> => {
      const result = await window.elauncher.game.launch(instanceId)
      await refreshInstances()
      return result.ok ? null : (result.error ?? 'Unknown error')
    },
    [refreshInstances]
  )

  const kill = useCallback(async (instanceId: string) => {
    await window.elauncher.game.kill(instanceId)
  }, [])

  const value = useMemo(
    () => ({
      accounts,
      instances,
      runStates,
      progress,
      packTasks,
      lastGameEvents,
      cloudAvailable,
      cloudUser,
      cloudUpdates,
      refreshAccounts,
      refreshInstances,
      refreshCloud,
      login,
      logout,
      setActiveAccount,
      launch,
      kill
    }),
    [accounts, instances, runStates, progress, packTasks, lastGameEvents, cloudAvailable, cloudUser, cloudUpdates, refreshAccounts, refreshInstances, refreshCloud, login, logout, setActiveAccount, launch, kill]
  )

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useAppState(): AppState {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error('useAppState must be used inside AppStateProvider')
  return ctx
}
