// Builds build/icon.ico (multi-size) from build/icon.png.
// Usage: node scripts/make-ico.mjs
import { Jimp } from 'jimp'
import pngToIco from 'png-to-ico'
import { writeFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const source = join(root, 'build', 'icon.png')
const out = join(root, 'build', 'icon.ico')

const sizes = [256, 128, 64, 48, 32, 16]
const pngs = []
for (const size of sizes) {
  const img = await Jimp.read(source)
  img.resize({ w: size, h: size })
  pngs.push(await img.getBuffer('image/png'))
}
writeFileSync(out, await pngToIco(pngs))
console.log(`Wrote ${out} (${sizes.join(', ')} px)`)
