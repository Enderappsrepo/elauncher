// Static file server for docs/ — previewing the Pages site (panel, landing) locally.
import { createServer } from 'http'
import { readFile } from 'fs/promises'
import { extname, join, normalize } from 'path'

const ROOT = new URL('../docs/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const PORT = Number(process.env.PORT ?? 4173)
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json'
}

createServer(async (req, res) => {
  const url = decodeURIComponent((req.url ?? '/').split('?')[0])
  // normalize away any ../ before joining, so requests stay inside docs/
  let rel = normalize(url).replace(/^([/\\])+/, '')
  if (rel === '' || url.endsWith('/')) rel = join(rel, 'index.html')
  try {
    const body = await readFile(join(ROOT, rel))
    res.writeHead(200, { 'content-type': TYPES[extname(rel)] ?? 'application/octet-stream' })
    res.end(body)
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' })
    res.end('not found')
  }
}).listen(PORT, () => console.log(`docs/ served on http://localhost:${PORT}`))
