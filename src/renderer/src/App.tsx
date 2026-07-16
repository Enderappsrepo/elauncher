import { NavLink, Route, Routes, useNavigate } from 'react-router-dom'
import { useEffect, useRef, useState } from 'react'
import { useAppState } from './state'
import { useToast } from './toast'
import { tileGradient } from './fmt'
import { setTheme, useTheme } from './theme'
import { IconBox, IconCloud, IconGrid, IconHome, IconImport, IconLogout, IconMoon, IconSearch, IconServer, IconSettings, IconShield, IconSun, IconUser, IconWifi } from './icons'
import logoUrl from './assets/icon.png'
import { UpdateCard, useAppVersion } from './updates'
import ImportPackModal from './components/ImportPackModal'
import Select from './components/Select'
import CloudAuthModal from './components/CloudAuthModal'
import MigrateModal from './components/MigrateModal'
import HomePage from './pages/HomePage'
import InstancesPage from './pages/InstancesPage'
import InstancePage from './pages/InstancePage'
import ModBrowserPage from './pages/ModBrowserPage'
import ModpacksPage from './pages/ModpacksPage'
import SettingsPage from './pages/SettingsPage'
import SkinsPage from './pages/SkinsPage'
import PlayPage from './pages/PlayPage'
import ServerPage from './pages/ServerPage'
import AdminPage from './pages/AdminPage'
import NewsArticlePage from './pages/NewsArticlePage'

/** Sidebar quick-jump: type an instance name, hit Enter, you're there. */
function QuickSearch(): React.JSX.Element {
  const { instances, runStates } = useAppState()
  const navigate = useNavigate()
  const [q, setQ] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  // Ctrl+K (or Cmd+K) focuses the jump box from anywhere in the app
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        inputRef.current?.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const query = q.trim().toLowerCase()
  const matches = query
    ? instances.filter((i) => i.name.toLowerCase().includes(query)).slice(0, 5)
    : []

  const go = (id: string): void => {
    navigate(`/instances/${id}`)
    setQ('')
  }

  return (
    <div className="quick-search">
      <div className="search-wrap">
        <IconSearch size={14} />
        <input
          ref={inputRef}
          placeholder="Jump to instance…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && matches[0]) go(matches[0].id)
            if (e.key === 'Escape') setQ('')
          }}
        />
        <span className="kbd">Ctrl K</span>
      </div>
      {matches.length > 0 && (
        <div className="quick-results">
          {matches.map((i) => (
            <button key={i.id} onClick={() => go(i.id)}>
              <span className="tile ql-tile" style={{ background: tileGradient(i.id) }}>
                {i.name.charAt(0).toUpperCase()}
              </span>
              <span className="ql-name">{i.name}</span>
              <span className="ql-meta">
                {runStates[i.id] === 'running' ? <span className="dot pulse" style={{ color: 'var(--green)' }} /> : i.minecraftVersion}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/** Dark/Light theme switch, reusing the segmented-control styling. */
function ThemeToggle(): React.JSX.Element {
  const [theme] = useTheme()
  return (
    <div className="segmented theme-seg">
      <button className={theme === 'dark' ? 'active' : ''} onClick={() => setTheme('dark')}>
        <IconMoon size={14} /> Dark
      </button>
      <button className={theme === 'light' ? 'active' : ''} onClick={() => setTheme('light')}>
        <IconSun size={14} /> Light
      </button>
    </div>
  )
}

function AccountSection(): React.JSX.Element {
  const { accounts, login, logout, setActiveAccount } = useAppState()
  const toast = useToast()
  const [busy, setBusy] = useState(false)
  const active = accounts.accounts.find((a) => a.uuid === accounts.activeUuid)

  const doLogin = async (): Promise<void> => {
    setBusy(true)
    try {
      await login()
      toast.success('Signed in')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {accounts.accounts.length > 1 && (
        <Select
          value={accounts.activeUuid ?? ''}
          onChange={(uuid) => void setActiveAccount(uuid)}
          options={accounts.accounts.map((a) => ({ value: a.uuid, label: a.name }))}
        />
      )}
      {active ? (
        <div className="account-card">
          <img
            src={`https://mc-heads.net/avatar/${active.uuid.replace(/-/g, '')}/64`}
            alt=""
            onError={(e) => {
              e.currentTarget.style.visibility = 'hidden'
            }}
          />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="name">{active.name}</div>
            <div className="small faint">Microsoft account</div>
          </div>
          <button className="icon-btn" title="Sign out" onClick={() => void logout(active.uuid)}>
            <IconLogout size={15} />
          </button>
        </div>
      ) : (
        <button className="primary" disabled={busy} onClick={() => void doLogin()}>
          {busy ? 'Signing in…' : 'Sign in with Microsoft'}
        </button>
      )}
      {active && (
        <button className="ghost small" style={{ padding: '6px 10px' }} disabled={busy} onClick={() => void doLogin()}>
          Add account
        </button>
      )}
    </div>
  )
}

function CloudAccountSection(): React.JSX.Element | null {
  const { cloudAvailable, cloudUser, refreshCloud } = useAppState()
  const toast = useToast()
  const [showAuth, setShowAuth] = useState(false)

  if (!cloudAvailable) return null

  const signOut = async (): Promise<void> => {
    await window.elauncher.cloud.signOut()
    await refreshCloud()
    toast.success('Signed out of ELauncher account')
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {cloudUser ? (
        <div className="account-card">
          <div
            className="tile"
            style={{ width: 32, height: 32, fontSize: 14, background: 'linear-gradient(135deg, var(--accent), var(--accent-2))' }}
          >
            {cloudUser.username.charAt(0).toUpperCase()}
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="name">{cloudUser.username}</div>
            <div className="small faint">{cloudUser.isAdmin ? 'ELauncher admin' : 'ELauncher account'}</div>
          </div>
          <button className="icon-btn" title="Sign out of ELauncher account" onClick={() => void signOut()}>
            <IconLogout size={15} />
          </button>
        </div>
      ) : (
        <button className="ghost small" style={{ padding: '6px 10px' }} onClick={() => setShowAuth(true)}>
          <IconCloud size={14} /> Sign in to ELauncher
        </button>
      )}
      {showAuth && <CloudAuthModal onClose={() => setShowAuth(false)} />}
    </div>
  )
}

export default function App(): React.JSX.Element {
  const { refreshInstances, cloudAvailable, cloudUser, cloudUpdates } = useAppState()
  const appVersion = useAppVersion()
  const toast = useToast()
  const navigate = useNavigate()
  const [showImport, setShowImport] = useState(false)
  const [showMigrate, setShowMigrate] = useState(false)
  const updateCount = Object.keys(cloudUpdates).length

  const onImported = async (id: string, name: string): Promise<void> => {
    setShowImport(false)
    await refreshInstances()
    toast.success(`Installed "${name}"`)
    navigate(`/instances/${id}`)
  }

  const onMigrated = async (id: string): Promise<void> => {
    setShowMigrate(false)
    await refreshInstances()
    navigate(`/instances/${id}`)
  }

  return (
    <div className="app">
      <nav className="sidebar">
        <div className="sidebar-brand">
          <img className="logo-mark-img" src={logoUrl} alt="" draggable={false} />
          <span className="brand-name">
            E<span className="brand-accent">Launcher</span>
          </span>
          <span className="brand-ver">{appVersion ? `v${appVersion}` : ''}</span>
        </div>
        <QuickSearch />
        <div className="section-label">Library</div>
        <NavLink to="/" end className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}>
          <IconHome /> Home
        </NavLink>
        <NavLink to="/instances" className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}>
          <IconGrid /> Instances
          {updateCount > 0 && <span className="nav-badge">{updateCount}</span>}
        </NavLink>
        {cloudAvailable && (
          <NavLink to="/packs" className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}>
            <IconCloud /> Modpacks
          </NavLink>
        )}
        <NavLink to="/mods" className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}>
          <IconBox /> Browse
        </NavLink>
        <NavLink to="/skins" className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}>
          <IconUser /> Skins
        </NavLink>
        <NavLink to="/play" className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}>
          <IconWifi /> Play Together
        </NavLink>
        <NavLink to="/server" className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}>
          <IconServer /> Server
        </NavLink>
        <div className="section-label">App</div>
        <NavLink to="/settings" className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}>
          <IconSettings /> Settings
        </NavLink>
        {cloudUser?.isAdmin && (
          <NavLink to="/admin" className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}>
            <IconShield /> Admin
          </NavLink>
        )}
        <button className="sidebar-cta" onClick={() => setShowImport(true)}>
          <IconImport size={15} /> Install modpack
        </button>
        <button className="sidebar-quiet" onClick={() => setShowMigrate(true)}>
          <IconBox size={14} /> Migrate from another launcher
        </button>
        <div className="spacer" />
        <UpdateCard />
        <div className="sidebar-foot">
          <ThemeToggle />
          <CloudAccountSection />
          <AccountSection />
        </div>
      </nav>
      <div className="workspace">
        <div className="dragbar" />
        <main className="main">
          <Routes>
            <Route path="/" element={<HomePage />} />
            <Route path="/news/:id" element={<NewsArticlePage />} />
            <Route path="/instances" element={<InstancesPage />} />
            <Route path="/instances/:id" element={<InstancePage />} />
            <Route path="/packs" element={<ModpacksPage />} />
            <Route path="/mods" element={<ModBrowserPage />} />
            <Route path="/skins" element={<SkinsPage />} />
            <Route path="/play" element={<PlayPage />} />
            <Route path="/server" element={<ServerPage />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="/admin" element={<AdminPage />} />
          </Routes>
        </main>
      </div>
      {showImport && <ImportPackModal onClose={() => setShowImport(false)} onImported={(id, name) => void onImported(id, name)} />}
      {showMigrate && <MigrateModal onClose={() => setShowMigrate(false)} onImported={(id) => void onMigrated(id)} />}
    </div>
  )
}
