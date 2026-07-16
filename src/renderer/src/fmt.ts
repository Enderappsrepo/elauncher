export function formatCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${bytes} B`
}

export function timeAgo(ts?: number): string {
  if (!ts) return 'Never played'
  const s = Math.floor((Date.now() - ts) / 1000)
  if (s < 60) return 'Just now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  if (s < 604800) return `${Math.floor(s / 86400)}d ago`
  return new Date(ts).toLocaleDateString()
}

/** Formats accumulated playtime, e.g. "3h 24m" or "12m". */
export function formatPlaytime(ms?: number): string {
  if (!ms || ms < 60_000) return ms && ms > 0 ? '<1m' : '0m'
  const minutes = Math.floor(ms / 60_000)
  const hours = Math.floor(minutes / 60)
  if (hours >= 100) return `${hours}h`
  if (hours > 0) return `${hours}h ${minutes % 60}m`
  return `${minutes}m`
}

export function formatDate(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

const TILE_GRADIENTS = [
  'linear-gradient(135deg, #34d399, #0e9f6e)',
  'linear-gradient(135deg, #5b8cff, #7c5bff)',
  'linear-gradient(135deg, #f59e0b, #ef4444)',
  'linear-gradient(135deg, #06b6d4, #3b82f6)',
  'linear-gradient(135deg, #ec4899, #8b5cf6)',
  'linear-gradient(135deg, #84cc16, #10b981)',
  'linear-gradient(135deg, #f97316, #db2777)',
  'linear-gradient(135deg, #14b8a6, #6366f1)'
]

/** Stable gradient per instance id so each instance gets a recognizable color. */
export function tileGradient(id: string): string {
  let h = 0
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0
  return TILE_GRADIENTS[h % TILE_GRADIENTS.length]
}

/** Curated cover art the user can pick for an instance ("cover:<id>"). */
export const CURATED_COVERS: { id: string; name: string; css: string }[] = [
  { id: 'emerald', name: 'Emerald', css: 'linear-gradient(135deg, #10b981 0%, #065f46 60%, #022c22 100%)' },
  { id: 'aurora', name: 'Aurora', css: 'linear-gradient(120deg, #8b5cf6 0%, #d946ef 45%, #0ea5e9 100%)' },
  { id: 'nether', name: 'Nether', css: 'linear-gradient(135deg, #f97316 0%, #b91c1c 55%, #450a0a 100%)' },
  { id: 'ocean', name: 'Ocean', css: 'linear-gradient(140deg, #06b6d4 0%, #1d4ed8 60%, #172554 100%)' },
  { id: 'end', name: 'The End', css: 'linear-gradient(135deg, #a78bfa 0%, #4c1d95 50%, #1e1033 100%)' },
  { id: 'sunset', name: 'Sunset', css: 'linear-gradient(135deg, #fbbf24 0%, #f97316 45%, #be185d 100%)' },
  { id: 'ice', name: 'Ice', css: 'linear-gradient(135deg, #e0f2fe 0%, #38bdf8 50%, #1e40af 100%)' },
  { id: 'slime', name: 'Slime', css: 'linear-gradient(135deg, #a3e635 0%, #16a34a 55%, #14532d 100%)' },
  { id: 'redstone', name: 'Redstone', css: 'linear-gradient(135deg, #f87171 0%, #dc2626 50%, #450a0a 100%)' },
  { id: 'amethyst', name: 'Amethyst', css: 'linear-gradient(135deg, #c084fc 0%, #7c3aed 55%, #2e1065 100%)' },
  { id: 'midnight', name: 'Midnight', css: 'linear-gradient(135deg, #334155 0%, #0f172a 60%, #020617 100%)' },
  { id: 'honey', name: 'Honey', css: 'linear-gradient(135deg, #fde047 0%, #f59e0b 55%, #92400e 100%)' }
]

/** Resolves the CSS gradient for an instance's cover (curated pick or stable auto gradient). */
export function coverGradient(instanceId: string, icon?: string): string {
  if (icon?.startsWith('cover:')) {
    const cover = CURATED_COVERS.find((c) => c.id === icon.slice('cover:'.length))
    if (cover) return cover.css
  }
  return tileGradient(instanceId)
}
