// Test the java runtime resolution for the version the user actually created (26.2)
import { Version } from '@xmcl/core'
import { fetchJavaRuntimeManifest } from '@xmcl/installer'
import { join } from 'path'

const shared = join(process.env.APPDATA, 'elauncher-data', 'shared')
const resolved = await Version.parse(shared, '26.2')
console.log('javaVersion:', JSON.stringify(resolved.javaVersion))

const component = resolved.javaVersion?.component ?? 'jre-legacy'
console.log('fetching java runtime manifest for', component, '...')
const manifest = await fetchJavaRuntimeManifest({ target: component })
console.log('manifest target:', manifest.target, '| version:', manifest.version?.name, '| files:', Object.keys(manifest.files ?? {}).length)
