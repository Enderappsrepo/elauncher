/** Valve KeyValues text (libraryfolders.vdf, appmanifest_*.acf). Steam treats keys case-insensitively. */
export interface Vdf { [key: string]: string | Vdf }

interface Token { kind: 'string' | '{' | '}'; value: string; quoted: boolean }

export function parseVdf(text: string): Vdf {
  let i = 0
  const next = (): Token | null => {
    for (;;) {
      while (i < text.length && /\s/.test(text[i])) i++
      if (!text.startsWith('//', i)) break
      while (i < text.length && text[i] !== '\n') i++
    }
    if (i >= text.length) return null
    const c = text[i]
    if (c === '{' || c === '}') { i++; return { kind: c, value: c, quoted: false } }
    let value = ''
    if (c === '"') {
      for (i++; i < text.length && text[i] !== '"'; i++) {
        if (text[i] === '\\' && i + 1 < text.length) {
          const e = text[++i]
          value += e === 'n' ? '\n' : e === 't' ? '\t' : e
        } else value += text[i]
      }
      i++
      return { kind: 'string', value, quoted: true }
    }
    while (i < text.length && !/[\s{}"]/.test(text[i])) value += text[i++]
    return { kind: 'string', value, quoted: false }
  }
  // Platform conditionals ("key" "value" [$WIN32]) follow a value; they never change these files' meaning.
  const skipConditional = (): void => {
    const at = i, token = next()
    if (!token || token.quoted || !token.value.startsWith('[')) i = at
  }
  const block = (): Vdf => {
    const out: Vdf = {}
    for (;;) {
      const key = next()
      if (!key || key.kind === '}') return out
      if (key.kind !== 'string') continue
      const value = next()
      if (!value || value.kind === '}') return out
      out[key.value] = value.kind === '{' ? block() : value.value
      skipConditional()
    }
  }
  return block()
}

export function vdfGet(node: Vdf | string | undefined, ...keys: string[]): Vdf | string | undefined {
  let current: Vdf | string | undefined = node
  for (const key of keys) {
    if (!current || typeof current === 'string') return undefined
    const lower = key.toLowerCase()
    const match: string | undefined = Object.keys(current).find((k) => k.toLowerCase() === lower)
    current = match === undefined ? undefined : current[match]
  }
  return current
}

export function vdfString(node: Vdf | string | undefined, ...keys: string[]): string | undefined {
  const value = vdfGet(node, ...keys)
  return typeof value === 'string' ? value : undefined
}
