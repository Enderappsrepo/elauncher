import { useState } from 'react'
import { Button, Spinner } from '@web/ui'
import type { GameCandidate } from '../../../shared/types'
import { SOURCE_LABEL, api, message } from '../format'
import { Notice, StepTitle } from '../ui'

/** Prefer the copy NV:MP actually runs (nvmp_launcher.exe beside it), then any supported one. */
export function bestGame(games: GameCandidate[]): GameCandidate | null {
  return games.find((g) => g.supported && g.hasNvmpLauncher) ?? games.find((g) => g.supported) ?? games[0] ?? null
}

/** Detection labels end with the folder, which the card already shows on its own line. */
function title(game: GameCandidate): string {
  const trimmed = game.label.endsWith(game.root) ? game.label.slice(0, -game.root.length).replace(/[\s-]+$/, '') : game.label
  return trimmed || SOURCE_LABEL[game.source] || game.label
}

export interface GamesView {
  list: GameCandidate[]
  loading: boolean
  error: string
}

export function GameStep({
  games,
  selected,
  onSelect,
  onAdd,
  onContinue
}: {
  games: GamesView
  selected: GameCandidate | null
  onSelect: (game: GameCandidate) => void
  onAdd: (game: GameCandidate) => void
  onContinue: () => void
}): React.JSX.Element {
  const [choosing, setChoosing] = useState(false)
  const [error, setError] = useState('')

  async function choose(): Promise<void> {
    setChoosing(true)
    setError('')
    try {
      const game = await api.chooseFolder()
      if (game) onAdd(game)
    } catch (err) {
      setError(message(err))
    } finally {
      setChoosing(false)
    }
  }

  return (
    <section className="page">
      <StepTitle>Your game</StepTitle>
      <p className="lede">
        The companion uploads the <b>Data</b> folder of the Fallout: New Vegas you play NV:MP with. Every player must use matching DLCs,
        mods and load order.
      </p>

      {games.loading && <Spinner label="Looking for Fallout: New Vegas on this PC…" />}
      {games.error && <Notice tone="error">{games.error}</Notice>}
      {!games.loading && !games.error && games.list.length === 0 && (
        <Notice tone="warn">Fallout: New Vegas was not found automatically. Choose the folder that contains FalloutNV.exe.</Notice>
      )}

      {games.list.length > 0 && (
        <ul className="choices" aria-label="Fallout: New Vegas installs found">
          {games.list.map((game) => (
            <li key={game.id}>
              <button type="button" className="choice" aria-pressed={selected?.id === game.id} onClick={() => onSelect(game)}>
                <span className="choice-head">
                  <span className="choice-title">{title(game)}</span>
                  {game.hasNvmpLauncher && <span className="badge good">NV:MP installed</span>}
                  {!game.supported && <span className="badge bad">Not supported</span>}
                </span>
                <span className="path">{game.root}</span>
                {game.mo2 && (
                  <span className="dim small">
                    Mod Organizer 2 profile <b>{game.mo2.profile}</b>: your mods are uploaded the way MO2 shows them to the game.
                  </span>
                )}
                {game.warnings.length > 0 && (
                  <ul className="warnlist">
                    {game.warnings.map((w) => (
                      <li key={w}>{w}</li>
                    ))}
                  </ul>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}

      {error && <Notice tone="error">{error}</Notice>}
      {selected && !selected.supported && (
        <Notice tone="warn">NV:MP does not support this edition of the game. Choose a supported install, such as Steam or GOG.</Notice>
      )}

      <div className="actions">
        <Button variant="primary" disabled={!selected || !selected.supported || games.loading} onClick={onContinue}>
          Continue
        </Button>
        <Button disabled={choosing} onClick={() => void choose()}>
          {choosing ? 'Choosing…' : 'Choose a folder…'}
        </Button>
      </div>
    </section>
  )
}
