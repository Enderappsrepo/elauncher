import '@web/styles/ui.css'
import '@web/panel/App.css'

/**
 * Marketing page. Still a placeholder — it renders on the shared design system
 * so the two pages can't drift, but the real rewrite is its own pass.
 */
export function App(): React.JSX.Element {
  return (
    <div className="shell">
      <header className="topbar">
        <div className="wrap row">
          <span className="brand">
            <span className="mark" aria-hidden />
            <span className="wordmark">ELauncher</span>
          </span>
        </div>
      </header>
      <main className="wrap page">
        <section className="surface surface-lift rise auth">
          <h1>Play and host, from one app.</h1>
          <p className="dim">Landing page rewrite pending.</p>
        </section>
      </main>
    </div>
  )
}
