import '@web/panel/App.css'

/**
 * Marketing page. A placeholder shell for now — it exists so the two-page build
 * is wired end to end; the real rewrite is its own pass.
 */
export function App(): React.JSX.Element {
  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand">
          <span className="mark" aria-hidden />
          <span className="wordmark">ELauncher</span>
        </div>
      </header>
      <main className="stage">
        <section className="card rise">
          <h1>Play and host, from one app.</h1>
          <p className="dim">Landing page rewrite pending.</p>
        </section>
      </main>
    </div>
  )
}
