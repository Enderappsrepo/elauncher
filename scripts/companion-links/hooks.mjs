// Resolves the web app's @web/ alias (extensionless .ts imports) and swaps react for fake-react.mjs.
import { registerHooks } from 'node:module'
import { existsSync } from 'node:fs'
import { pathToFileURL, fileURLToPath } from 'node:url'
const WEB = process.env.WEB_SRC ?? fileURLToPath(new URL('../../web/src', import.meta.url))
const FAKE = new URL('./fake-react.mjs', import.meta.url).href
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'react') return { url: FAKE, shortCircuit: true }
    if (specifier.startsWith('@web/')) {
      const base = `${WEB}/${specifier.slice(5)}`
      const file = [base, `${base}.ts`, `${base}.tsx`].find((f) => existsSync(f))
      return { url: pathToFileURL(file).href, format: 'module-typescript', shortCircuit: true }
    }
    return nextResolve(specifier, context)
  }
})
