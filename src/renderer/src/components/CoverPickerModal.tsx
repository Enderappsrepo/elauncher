import { useState } from 'react'
import type { Instance } from '@shared/types'
import { useToast } from '../toast'
import { CURATED_COVERS, tileGradient } from '../fmt'
import { IconImage, IconX } from '../icons'

interface Props {
  instance: Instance
  onClose: () => void
  onChanged: () => void
}

/** Pick a curated gradient cover or a custom image for an instance. */
export default function CoverPickerModal({ instance, onClose, onChanged }: Props): React.JSX.Element {
  const toast = useToast()
  const [busy, setBusy] = useState(false)
  const selected = instance.icon

  const pickCover = async (icon: string | undefined): Promise<void> => {
    setBusy(true)
    try {
      await window.elauncher.instances.setIcon(instance.id, icon)
      onChanged()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
      setBusy(false)
    }
  }

  const pickImage = async (): Promise<void> => {
    setBusy(true)
    try {
      const updated = await window.elauncher.instances.pickIcon(instance.id)
      if (updated) {
        toast.success('Cover image set')
        onChanged()
      } else {
        setBusy(false)
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
      setBusy(false)
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" style={{ width: 520 }} onClick={(e) => e.stopPropagation()}>
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <h2>Cover for “{instance.name}”</h2>
          <button className="icon-btn" onClick={onClose}>
            <IconX size={16} />
          </button>
        </div>
        <div className="field">
          <label>Curated covers</label>
          <div className="cover-grid">
            <button
              className={`cover-option${!selected ? ' selected' : ''}`}
              disabled={busy}
              onClick={() => void pickCover(undefined)}
              title="Automatic gradient based on the instance"
            >
              <span className="cover-fill" style={{ background: tileGradient(instance.id) }} />
              <span className="cover-name">Auto</span>
            </button>
            {CURATED_COVERS.map((c) => (
              <button
                key={c.id}
                className={`cover-option${selected === `cover:${c.id}` ? ' selected' : ''}`}
                disabled={busy}
                onClick={() => void pickCover(`cover:${c.id}`)}
              >
                <span className="cover-fill" style={{ background: c.css }} />
                <span className="cover-name">{c.name}</span>
              </button>
            ))}
          </div>
        </div>
        <div className="field">
          <label>Custom image</label>
          <div className="row">
            <button className="ghost" disabled={busy} onClick={() => void pickImage()}>
              <IconImage size={15} /> Choose an image…
            </button>
            <span className="small faint">PNG, JPG, WebP or GIF — shown as the card and banner art.</span>
          </div>
        </div>
      </div>
    </div>
  )
}
