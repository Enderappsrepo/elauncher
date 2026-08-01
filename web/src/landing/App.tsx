import { useState } from 'react'
import {
  ArrowDownToLine,
  Bell,
  Blocks,
  FolderInput,
  Gamepad2,
  LayoutGrid,
  Link2,
  MonitorSmartphone,
  MoonStar,
  MousePointerClick,
  RefreshCw,
  Search,
  Share2,
  Shirt,
  SlidersHorizontal,
  UserCheck,
  Zap
} from 'lucide-react'
import { Collapse, MotionRoot, Reveal, motion, staggerChild, staggerParent } from '@web/ui/motion'
import { GAME_HUE, GAME_LINEUP } from '@web/lib/games'
import type { Game } from '@web/lib/games'
import { useRelease } from './useRelease'
import '@web/styles/ui.css'
import './Landing.css'

/* Copy is the product's own voice, carried from the live page rather than
 * rewritten — what changed is the structure and motion around it, and the
 * hosting story catching up with what the host actually runs. */

const FEATURES = [
  [UserCheck, 'Real Microsoft login', 'Sign in with your Microsoft account — multiple accounts supported, tokens stored locally on your PC.'],
  [LayoutGrid, 'Instances done right', 'Every setup lives in its own instance with its own mods, worlds, and settings. Duplicate, tweak, break things safely.'],
  [Blocks, 'Fabric, Forge & NeoForge', 'Pick a Minecraft version and loader — ELauncher installs the right Java and loader files for you.'],
  [Search, 'Modrinth + CurseForge', 'Search, install, and update mods, resource packs, and shaders from both platforms without leaving the launcher.'],
  [Share2, 'Shareable modpacks', "Export any instance as a pack file or publish it to your group's cloud library — friends install and update it with one click."],
  [Zap, 'Performance tuned', 'Optimized JVM flags, automatic memory sizing, and one-click performance mod setups that stop the stutter.'],
  [Shirt, 'Skin manager', "Preview skins in 3D, keep a wardrobe of favorites, grab any player's skin by name, and apply in one click."],
  [RefreshCw, 'Updates itself', 'The launcher checks for new versions, downloads them in the background, and installs on restart.'],
  [FolderInput, 'Bring your setups with you', 'Migrate instances from other launchers — worlds, mods, and settings come along automatically.']
] as const

const HOSTING = [
  [MousePointerClick, 'One-click servers', 'The launcher downloads, configures and starts each game’s dedicated server — no wikis, no batch files.'],
  [MonitorSmartphone, 'Full control panel', 'Console, settings, players & moderation, files and automation — the whole panel, on your phone.'],
  [Bell, 'Notified instantly', 'Push alerts when the server starts, stops, crashes, or a friend joins.'],
  [Link2, 'Shareable invite pages', 'Hand friends one link — a live status page they apply through, with your own questions and approval before they’re let in.'],
  [MoonStar, 'Sleeps when empty', 'An idle server frees its memory and holds its port; the first player to connect wakes it.'],
  [SlidersHorizontal, 'Runs itself', 'Scheduled restarts, rolling backups, crash auto-restart and a memory guard, all automatic.']
] as const

const STEPS = [
  ['Build your pack', 'Set up an instance with the mods, settings, and performance tweaks you want your group to run.'],
  ['Publish to your cloud', "Push it to your group's own free cloud library (powered by Supabase) straight from the launcher."],
  ['Friends click install', 'Everyone sees the pack on their Modpacks page. One click installs it; when you update it, they get a badge and update in one click too.']
] as const

/** Launch prices for the seeded plans; the shop inside the panel is the live
 *  source of truth, so these say "from". */
const RENT = [
  ['Minecraft', '$4'],
  ['tModLoader', '$5'],
  ['Valheim', '$6'],
  ['Project Zomboid', '$7'],
  ['Palworld', '$8'],
  ['7 Days to Die', '$9'],
  ['ARK: Survival Evolved', '$12'],
  ['ARK: Survival Ascended', '$18']
] as const

const FAQ = [
  ['Is it free?', 'Completely free — no ads, no subscriptions, and no accounts required beyond your normal Microsoft login. No telemetry.'],
  ['Do I need to own Minecraft?', "Yes. ELauncher signs you in with your real Microsoft account and launches the game you already own — it's a launcher, not a pirated client."],
  ['Is my Microsoft account safe?', "Sign-in happens through Microsoft's official login window (OAuth). ELauncher never sees your password; game tokens are stored locally on your machine only."],
  ['How do updates work?', 'The launcher checks for new versions when it starts, downloads them in the background, and installs them when you restart. The portable and macOS builds instead tell you when a new version is out and link you here to grab it.'],
  ['What about the "cloud" — whose servers are those?', 'Your own. The modpack cloud is a free Supabase project that one person in your group sets up in about five minutes. Nobody else’s server is involved.'],
  ['How does the server hosting work?', 'The launcher runs a dedicated server on your PC — Minecraft, Palworld, ARK, Valheim, 7 Days to Die, Project Zomboid or tModLoader — and links it to a free cloud relay. From the web panel (or your phone) you get live status, console, full settings, player moderation, and automation. Your PC stays the host; the panel is just the remote control.'],
  ['Can I rent a server instead of hosting one?', 'Yes. The shop inside the panel rents managed servers for every supported game, from $4/month. You pay by PayPal or card link, a human approves it, and the server builds itself on our machines — then it shows up in your panel like any other server.'],
  ['Can I let friends manage a server?', 'Yes — grant any ELauncher account access to a specific server and it shows up in their launcher and phone panel with console and controls, scoped to just that server. Revoke anytime.'],
  ['Mac or Linux?', 'Windows and macOS are both available — the Mac build comes for Apple Silicon and Intel. Because it is unsigned, the first launch needs a quick trip through System Settings → Privacy & Security → Open Anyway, after which it runs like any other app. Linux is still on the roadmap.']
] as const

export function App(): React.JSX.Element {
  const release = useRelease()

  return (
    <MotionRoot>
      <div className="shell">
        <a className="skip" href="#home">
          Skip to content
        </a>
        <header className="topbar">
          <div className="wrap row">
            <span className="brand">
              <span className="mark" aria-hidden />
              <span className="wordmark">ELauncher</span>
            </span>
            <nav className="topnav" aria-label="Sections">
              <a href="#features">Features</a>
              <a href="#hosting">Hosting</a>
              <a href="#rent">Pricing</a>
              <a href="#faq">FAQ</a>
            </nav>
            <span className="spacer" />
            <a className="btn ghost sm" href="#download">
              Download
            </a>
            <a className="btn primary sm" href="/elauncher/manage/">
              Open panel
            </a>
          </div>
        </header>

        <main id="home">
          <motion.section
            className="wrap hero"
            variants={staggerParent}
            initial="hidden"
            animate="show"
          >
            <motion.span variants={staggerChild} className="pill running">
              <span className="dot" aria-hidden />
              Free forever · Windows &amp; macOS
            </motion.span>
            <motion.h1 variants={staggerChild} className="display">
              Play modded, <em>host anything.</em>
            </motion.h1>
            <motion.p variants={staggerChild} className="lede">
              A clean, fast launcher for you and your friends — Microsoft login, mod loaders, a built-in
              mod browser, one-click modpacks, and{' '}
              <strong>your own game servers — Minecraft, Palworld, ARK and more</strong> — managed from
              the app or your phone.
            </motion.p>
            <motion.div variants={staggerChild} className="row cta">
              <a className="btn primary" href={release.setupUrl}>
                <ArrowDownToLine size={17} aria-hidden />
                Download for Windows
              </a>
              <a className="btn ghost" href={release.macUrl}>
                <ArrowDownToLine size={17} aria-hidden />
                Download for Mac
              </a>
              <a className="btn ghost" href={release.portableUrl}>
                Portable version
              </a>
            </motion.div>
            <motion.p variants={staggerChild} className="dim meta">
              <strong>{release.version ?? 'Latest release'}</strong>
              {release.size ? ` · ${release.size}` : ''} · installs in seconds · updates itself automatically
            </motion.p>

            <LauncherShot />
          </motion.section>

          <Section id="games" kicker="Eight servers, one panel" title="Every game your group plays">
            <motion.div
              className="ggrid"
              variants={staggerParent}
              initial="hidden"
              whileInView="show"
              viewport={{ once: true, margin: '0px 0px -60px 0px' }}
            >
              {GAME_LINEUP.map(({ id, label, blurb }) => (
                <motion.article key={id} variants={staggerChild} className="surface gcard" style={gameStyle(id)}>
                  <span className="gdot" aria-hidden>
                    {label.slice(0, 1)}
                  </span>
                  <div>
                    <h3>{label}</h3>
                    <p className="dim">{blurb}</p>
                  </div>
                </motion.article>
              ))}
            </motion.div>
          </Section>

          <Section id="features" kicker="Everything built in" title="One launcher instead of five tools">
            <motion.div
              className="fgrid"
              variants={staggerParent}
              initial="hidden"
              whileInView="show"
              viewport={{ once: true, margin: '0px 0px -60px 0px' }}
            >
              {FEATURES.map(([Icon, title, body]) => (
                <motion.article key={title} variants={staggerChild} className="surface pad fcard">
                  <span className="fic" aria-hidden>
                    <Icon size={17} />
                  </span>
                  <h3>{title}</h3>
                  <p className="dim">{body}</p>
                </motion.article>
              ))}
            </motion.div>
          </Section>

          <Section kicker="The good part" title="Made for playing with friends">
            <div className="steps">
              {STEPS.map(([title, body], i) => (
                <Reveal key={title} delay={i * 0.08} className="step" as="article">
                  <span className="stepno" aria-hidden>
                    {i + 1}
                  </span>
                  <h3>{title}</h3>
                  <p className="dim">{body}</p>
                </Reveal>
              ))}
            </div>
          </Section>

          <Section id="hosting" kicker="Game server hosting" title="Run a server. Control it from anywhere.">
            <div className="host-split">
              <motion.div
                className="host-features"
                variants={staggerParent}
                initial="hidden"
                whileInView="show"
                viewport={{ once: true, margin: '0px 0px -60px 0px' }}
              >
                {HOSTING.map(([Icon, title, body]) => (
                  <motion.div key={title} variants={staggerChild} className="hf">
                    <span className="fic" aria-hidden>
                      <Icon size={17} />
                    </span>
                    <div>
                      <b>{title}</b>
                      <span className="dim">{body}</span>
                    </div>
                  </motion.div>
                ))}
                <motion.div variants={staggerChild}>
                  <a className="btn primary" href="/elauncher/manage/">
                    Open the panel →
                  </a>
                </motion.div>
              </motion.div>
              <Reveal className="phone-col">
                <PhoneShot />
              </Reveal>
            </div>
          </Section>

          <Section id="rent" kicker="Or skip the hardware" title="Rent a server, keep the panel">
            <Reveal>
              <div className="surface surface-lift pad rent">
                <p className="dim rent-lede">
                  Don&apos;t want a PC running all night? Rent a managed server on our machines — it lands in
                  the same panel, with the same console, files, mods and automation, from{' '}
                  <strong>$4/month</strong>.
                </p>
                <ul className="rentlist">
                  {RENT.map(([game, price]) => (
                    <li key={game}>
                      <span>{game}</span>
                      <span className="mono rent-price">from {price}/mo</span>
                    </li>
                  ))}
                </ul>
                <div className="row cta">
                  <a className="btn primary" href="/elauncher/manage/">
                    <Gamepad2 size={17} aria-hidden />
                    Browse plans in the shop
                  </a>
                </div>
                <p className="dim small center">
                  Pay by PayPal or card link. A human approves every order; the server builds itself and
                  appears in your panel, usually within the hour.
                </p>
              </div>
            </Reveal>
          </Section>

          <section className="wrap" id="download">
            <Reveal>
              <div className="surface surface-lift pad getit">
                <h2>Get ELauncher</h2>
                <div className="row cta">
                  <a className="btn primary" href={release.setupUrl}>
                    <ArrowDownToLine size={17} aria-hidden />
                    Download for Windows
                  </a>
                  <a className="btn ghost" href={release.macUrl}>
                    <ArrowDownToLine size={17} aria-hidden />
                    Download for Mac
                  </a>
                  <a className="btn ghost" href={release.portableUrl}>
                    Portable .exe
                  </a>
                </div>
                <p className="dim meta">
                  <strong>Windows</strong> may show a SmartScreen warning on first run — choose{' '}
                  <strong>More info → Run anyway</strong>. <strong>Mac</strong> download is for Apple
                  Silicon; <a href={release.macIntelUrl}>Intel Macs are here</a>. macOS blocks it the
                  first time — open <strong>System Settings → Privacy &amp; Security → Open Anyway</strong>.
                  Both builds are unsigned because code-signing certificates are costly for a community
                  project.
                </p>
              </div>
            </Reveal>
          </section>

          <Section id="faq" kicker="Questions" title="FAQ">
            <div className="stack faq">
              {FAQ.map(([q, a], i) => (
                <FaqRow key={q} question={q} answer={a} index={i} />
              ))}
            </div>
          </Section>
        </main>

        <footer className="wrap foot">
          <div className="row">
            <a href="#download">Download</a>
            <a href="/elauncher/manage/">Web panel</a>
            <a href="#faq">FAQ</a>
          </div>
          <p className="dim small">
            ELauncher is a community project, not affiliated with Mojang, Microsoft, Modrinth,
            Overwolf/CurseForge, Pocketpair, Studio Wildcard, Iron Gate, The Fun Pimps, The Indie Stone,
            or Re-Logic. Minecraft is a trademark of Mojang Synergies AB.
          </p>
        </footer>
      </div>
    </MotionRoot>
  )
}

/* per-game hue, shared vocabulary with the panel's badges */
function gameStyle(id: Game): React.CSSProperties {
  return { '--hue': GAME_HUE[id] } as React.CSSProperties
}

function Section({
  id,
  kicker,
  title,
  children
}: {
  id?: string
  kicker: string
  title: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <section className="wrap sec" id={id}>
      <Reveal>
        <p className="kicker">{kicker}</p>
        <h2 className="sec-title">{title}</h2>
      </Reveal>
      {children}
    </section>
  )
}

/**
 * FAQ row: a real button + region pair (not <details>) so the open/close can
 * animate. One stays independently openable — comparison shopping across
 * answers is the whole use of a FAQ.
 */
function FaqRow({ question, answer, index }: { question: string; answer: string; index: number }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const id = `faq-${index}`
  return (
    <Reveal className="surface faqrow" delay={Math.min(index, 4) * 0.03}>
      <button
        className="faq-q"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((o) => !o)}
      >
        {question}
        <motion.span
          className="faq-plus"
          aria-hidden
          animate={{ rotate: open ? 45 : 0 }}
          transition={{ duration: 0.22 }}
        >
          +
        </motion.span>
      </button>
      <Collapse open={open}>
        <p id={id} className="dim faq-a">
          {answer}
        </p>
      </Collapse>
    </Reveal>
  )
}

/** The launcher, sketched in markup. A real screenshot rots with every release;
 *  this stays current because it is made of the same tokens the app is. */
function LauncherShot(): React.JSX.Element {
  const instances = [
    ['Create SMP', 'NeoForge 1.21.1', 'c1'],
    ['Fabulously Optimized', 'Fabric 1.21.4', 'c2'],
    ['Vanilla+', 'Fabric 1.21.4', 'c3'],
    ['RLCraft', 'Forge 1.12.2', 'c4'],
    ['Friends Pack S3', 'NeoForge 1.21.1', 'c5'],
    ['Hardcore UHC', 'Vanilla 1.21.4', 'c6']
  ] as const
  return (
    <motion.div
      className="shot"
      aria-hidden
      initial={{ opacity: 0, y: 28, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{ duration: 0.7, delay: 0.35, ease: [0.22, 1, 0.36, 1] }}
    >
      <div className="bar">
        <i />
        <i />
        <i />
      </div>
      <div className="shot-body">
        <div className="shot-side">
          <div className="s-brand">
            <span className="mark sm" /> E<span className="s-accent">Launcher</span>
          </div>
          {['Home', 'Instances', 'Modpacks', 'Browse', 'Skins', 'Settings'].map((item, i) => (
            <div key={item} className={`s-item${i === 1 ? ' on' : ''}`}>
              <i /> {item}
            </div>
          ))}
          <div className="s-play">▶ Play</div>
        </div>
        <div className="shot-main">
          <div className="m-title">Instances</div>
          <div className="m-sub">6 instances · 2 shared with friends</div>
          <motion.div
            className="shot-grid"
            variants={staggerParent}
            initial="hidden"
            whileInView="show"
            viewport={{ once: true }}
          >
            {instances.map(([name, loader, cover]) => (
              <motion.div key={name} variants={staggerChild} className="shot-card">
                <div className={`cover ${cover}`} />
                <div className="meta">
                  <b>{name}</b>
                  <span>{loader}</span>
                </div>
              </motion.div>
            ))}
          </motion.div>
        </div>
      </div>
    </motion.div>
  )
}

/** The panel on a phone — the hosting pitch is "it fits in your pocket", so the
 *  pitch is drawn at pocket size, live pulse and all. */
function PhoneShot(): React.JSX.Element {
  return (
    <div className="phone" aria-hidden>
      <div className="phone-scr">
        <div className="p-top">
          <span className="mark sm" />
          <span>
            ELauncher <b>Remote</b>
          </span>
          <span className="p-live">● live</span>
        </div>
        <div className="p-card">
          <div className="p-row">
            <span className="p-tile pal">P</span>
            <div className="p-id">
              <div className="p-nm">Pal Kingdom</div>
              <div className="p-sub">2 playing — Jedi, Ben</div>
            </div>
            <span className="pill running">
              <span className="dot" aria-hidden />
              Running
            </span>
          </div>
          <div className="p-pills">
            <span>2h 44m</span>
            <span>7.8 GB · 23%</span>
            <span>v0.6.4</span>
          </div>
          <div className="p-acts">
            <span className="p-btn stop">Stop</span>
            <span className="p-btn">Restart</span>
          </div>
        </div>
        <div className="p-card dimmed">
          <div className="p-row">
            <span className="p-tile mc">S</span>
            <div className="p-id">
              <div className="p-nm">Survival SMP</div>
              <div className="p-sub">Asleep — join to wake it</div>
            </div>
            <span className="pill stopped">
              <span className="dot" aria-hidden />
              Sleeping
            </span>
          </div>
        </div>
      </div>
    </div>
  )
}
