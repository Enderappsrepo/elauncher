import { Button } from '@web/ui'
import { useRelease } from './useRelease'
import '@web/styles/ui.css'
import './Landing.css'

/* Copy is carried over from the previous page rather than rewritten — it is the
 * product's own voice and it was already doing its job. What changed is the
 * structure around it. */

const FEATURES = [
  ['Real Microsoft login', 'Sign in with your Microsoft account — multiple accounts supported, tokens stored locally on your PC.'],
  ['Instances done right', 'Every setup lives in its own instance with its own mods, worlds, and settings. Duplicate, tweak, break things safely.'],
  ['Fabric, Forge & NeoForge', 'Pick a Minecraft version and loader — ELauncher installs the right Java and loader files for you.'],
  ['Modrinth + CurseForge', 'Search, install, and update mods, resource packs, and shaders from both platforms without leaving the launcher.'],
  ['Shareable modpacks', "Export any instance as a pack file or publish it to your group's cloud library — friends install and update it with one click."],
  ['Performance tuned', 'Optimized JVM flags, automatic memory sizing, and one-click performance mod setups that stop the stutter.'],
  ['Skin manager', "Preview skins in 3D, keep a wardrobe of favorites, grab any player's skin by name, and apply in one click."],
  ['Updates itself', 'The launcher checks GitHub for new versions, downloads them in the background, and installs on restart.'],
  ['Bring your setups with you', 'Migrate instances from other launchers — worlds, mods, and settings come along automatically.']
] as const

const HOSTING = [
  ['One-click servers', 'Run a dedicated Minecraft or Palworld server straight from the launcher.'],
  ['Full control panel', 'Live console, settings, players, mods and files — from any browser or your phone.'],
  ['Notified instantly', 'Crashes and player joins reach your phone as push notifications.'],
  ['Runs itself', 'Scheduled restarts, backups, crash-restart and a memory guard, all automatic.']
] as const

const FAQ = [
  ['Is it free?', 'Yes — free and open source under the MIT license. No ads, no accounts required beyond your normal Microsoft login, no telemetry.'],
  ['Do I need to own Minecraft?', "Yes. ELauncher signs you in with your real Microsoft account and launches the game you already own — it's a launcher, not a pirated client."],
  ['Is my Microsoft account safe?', "Sign-in happens through Microsoft's official login window (OAuth). ELauncher never sees your password; game tokens are stored locally on your machine only."],
  ['How do updates work?', "The launcher checks this site's GitHub releases when it starts, downloads new versions in the background, and installs them when you restart. The portable build tells you when a new version is out and links you here instead."],
  ['What about the "cloud" — whose servers are those?', 'Your own. The modpack cloud is a free Supabase project that one person in your group sets up in about five minutes (instructions in the README). Nobody else’s server is involved.'],
  ['How does the server hosting work?', 'The launcher runs a dedicated Minecraft or Palworld server on your PC and links it to a free cloud relay. From the web panel you get live status, console, full settings, player moderation, and automation. Your PC stays the host; the panel is just the remote control.'],
  ['Can I let friends manage a server?', 'Yes — grant any ELauncher account access to a specific server and it shows up in their launcher and phone panel with console and controls, scoped to just that server. Revoke anytime.'],
  ['Mac or Linux?', 'Windows only right now. The code is open source, so a Mac/Linux build is mostly a packaging task — open an issue if you want it.']
] as const

export function App(): React.JSX.Element {
  const release = useRelease()

  return (
    <div className="shell">
      <header className="topbar">
        <div className="wrap row">
          <span className="brand">
            <span className="mark" aria-hidden />
            <span className="wordmark">ELauncher</span>
          </span>
          <span className="spacer" />
          <a className="btn ghost sm" href="/elauncher/manage/">
            Open panel
          </a>
        </div>
      </header>

      <main>
        <section className="wrap hero">
          <span className="pill running">
            <span className="dot" aria-hidden />
            Free &amp; open source · Windows 10/11
          </span>
          <h1 className="display">
            Play modded, <em>host anything.</em>
          </h1>
          <p className="lede">
            A clean, fast launcher for you and your friends — Microsoft login, mod loaders, a built-in mod
            browser, one-click modpacks, and <strong>your own Minecraft &amp; Palworld servers</strong> you
            manage from the app or your phone.
          </p>
          <div className="row cta">
            <a className="btn primary" href={release.setupUrl}>
              Download for Windows
            </a>
            <a className="btn ghost" href={release.portableUrl}>
              Portable version
            </a>
          </div>
          <p className="dim meta">
            <strong>{release.version ?? 'Latest release'}</strong>
            {release.size ? ` · ${release.size}` : ''} · installs in seconds · updates itself automatically
          </p>
        </section>

        <Section kicker="Everything built in" title="One launcher instead of five tools">
          <div className="fgrid stagger">
            {FEATURES.map(([title, body], i) => (
              <article key={title} className="surface pad" style={{ '--i': i } as React.CSSProperties}>
                <h3>{title}</h3>
                <p className="dim">{body}</p>
              </article>
            ))}
          </div>
        </Section>

        <Section kicker="Your servers" title="Run a server. Control it from anywhere.">
          <div className="fgrid stagger">
            {HOSTING.map(([title, body], i) => (
              <article key={title} className="surface pad" style={{ '--i': i } as React.CSSProperties}>
                <h3>{title}</h3>
                <p className="dim">{body}</p>
              </article>
            ))}
          </div>
        </Section>

        <Section kicker="Questions" title="FAQ">
          <div className="stack faq">
            {FAQ.map(([q, a]) => (
              <details key={q} className="surface">
                <summary>{q}</summary>
                <p className="dim">{a}</p>
              </details>
            ))}
          </div>
        </Section>

        <section className="wrap">
          <div className="surface surface-lift pad getit">
            <h2>Get ELauncher</h2>
            <div className="row cta">
              <a className="btn primary" href={release.setupUrl}>
                Download for Windows
              </a>
              <a className="btn ghost" href={release.portableUrl}>
                Portable .exe
              </a>
            </div>
            <p className="dim meta">
              Windows may show a SmartScreen warning on first run — choose <strong>More info → Run anyway</strong>.
              The build is unsigned because code-signing certificates cost more than this project makes.
            </p>
          </div>
        </section>
      </main>

      <footer className="wrap foot">
        <div className="row">
          <a href="https://github.com/Enderappsrepo/elauncher">Source on GitHub</a>
          <a href="https://github.com/Enderappsrepo/elauncher/issues">Report an issue</a>
          <span className="dim">MIT licensed</span>
        </div>
        <p className="dim small">
          ELauncher is a community project, not affiliated with Mojang, Microsoft, Modrinth, or
          Overwolf/CurseForge. Minecraft is a trademark of Mojang Synergies AB.
        </p>
      </footer>
    </div>
  )
}

function Section({
  kicker,
  title,
  children
}: {
  kicker: string
  title: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <section className="wrap sec">
      <p className="kicker">{kicker}</p>
      <h2 className="sec-title">{title}</h2>
      {children}
    </section>
  )
}
