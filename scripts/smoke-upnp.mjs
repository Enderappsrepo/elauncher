// Smoke test for the native UPnP client: discover the router via SSDP, read
// the external IP, then add + delete a UDP port mapping — the exact calls
// src/main/services/upnp.ts makes for Palworld's public address.
// Usage: node scripts/smoke-upnp.mjs
import dgram from 'dgram'

const SSDP_ADDR = '239.255.255.250'
const SSDP_PORT = 1900
const TEST_PORT = 28311
const WAN_SERVICES = [
  'urn:schemas-upnp-org:service:WANIPConnection:1',
  'urn:schemas-upnp-org:service:WANIPConnection:2',
  'urn:schemas-upnp-org:service:WANPPPConnection:1'
]

import os from 'os'

const TARGETS = [
  'urn:schemas-upnp-org:device:InternetGatewayDevice:1',
  'urn:schemas-upnp-org:device:InternetGatewayDevice:2',
  'upnp:rootdevice',
  'ssdp:all'
]

function searchOn(localAddress, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const sock = dgram.createSocket('udp4')
    const found = new Set()
    const finish = () => {
      try {
        sock.close()
      } catch {}
      resolve([...found])
    }
    setTimeout(finish, timeoutMs)
    sock.on('error', finish)
    sock.on('message', (msg) => {
      const m = msg.toString('utf8').match(/^location:\s*(.+)$/im)
      if (m) found.add(m[1].trim())
    })
    const probes = () => {
      for (const st of TARGETS)
        sock.send(
          Buffer.from(`M-SEARCH * HTTP/1.1\r\nHOST: ${SSDP_ADDR}:${SSDP_PORT}\r\nMAN: "ssdp:discover"\r\nMX: 2\r\nST: ${st}\r\n\r\n`),
          SSDP_PORT,
          SSDP_ADDR
        )
    }
    sock.bind({ address: localAddress }, () => {
      if (localAddress) {
        try {
          sock.setMulticastInterface(localAddress)
        } catch {}
      }
      probes()
      setTimeout(() => {
        try {
          probes()
        } catch {}
      }, 700)
    })
  })
}

const ifaces = Object.values(os.networkInterfaces())
  .flat()
  .filter((i) => i && i.family === 'IPv4' && !i.internal)
  .map((i) => i.address)
console.log('probing from interfaces:', ['default', ...ifaces].join(', '))
const results = await Promise.all([searchOn(undefined), ...ifaces.map((a) => searchOn(a))])
const locations = [...new Set(results.flat())]
if (locations.length === 0) throw new Error('no UPnP gateway answered (router UPnP disabled?)')
console.log('gateway descriptions:', locations)

let gateway = null
for (const location of locations) {
  const xml = await (await fetch(location, { signal: AbortSignal.timeout(5000) })).text()
  for (const block of xml.split(/<service>/i).slice(1)) {
    const type = block.match(/<serviceType>([^<]+)<\/serviceType>/i)?.[1]?.trim()
    const control = block.match(/<controlURL>([^<]+)<\/controlURL>/i)?.[1]?.trim()
    if (type && control && WAN_SERVICES.includes(type)) {
      gateway = { serviceType: type, controlUrl: new URL(control, location).toString(), host: new URL(location).hostname }
      break
    }
  }
  if (gateway) break
}
if (!gateway) throw new Error('gateway offers no WAN(IP|PPP)Connection service')
console.log('control url:', gateway.controlUrl, '| service:', gateway.serviceType)

const localIp = await new Promise((resolve) => {
  const s = dgram.createSocket('udp4')
  s.connect(9, gateway.host, () => {
    const a = s.address().address
    s.close()
    resolve(a)
  })
})
console.log('local ip toward gateway:', localIp)

async function soap(action, args) {
  const argXml = Object.entries(args)
    .map(([k, v]) => `<${k}>${v}</${k}>`)
    .join('')
  const body =
    '<?xml version="1.0"?>' +
    '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">' +
    `<s:Body><u:${action} xmlns:u="${gateway.serviceType}">${argXml}</u:${action}></s:Body></s:Envelope>`
  const res = await fetch(gateway.controlUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'text/xml; charset="utf-8"', SOAPAction: `"${gateway.serviceType}#${action}"` },
    body,
    signal: AbortSignal.timeout(8000)
  })
  const text = await res.text()
  if (!res.ok) {
    const code = text.match(/<errorCode>(\d+)<\/errorCode>/i)?.[1]
    throw new Error(`${action} refused (${code ?? res.status})`)
  }
  return text
}

const ipXml = await soap('GetExternalIPAddress', {})
const externalIp = ipXml.match(/<NewExternalIPAddress>([^<]+)<\/NewExternalIPAddress>/i)?.[1]
console.log('external ip:', externalIp)

const mapArgs = (lease) => ({
  NewRemoteHost: '',
  NewExternalPort: TEST_PORT,
  NewProtocol: 'UDP',
  NewInternalPort: TEST_PORT,
  NewInternalClient: localIp,
  NewEnabled: 1,
  NewPortMappingDescription: 'ELauncher smoke test',
  NewLeaseDuration: lease
})
try {
  await soap('AddPortMapping', mapArgs(0))
} catch {
  await soap('AddPortMapping', mapArgs(86400))
}
console.log(`mapped UDP ${TEST_PORT} -> ${localIp}:${TEST_PORT} (public ${externalIp}:${TEST_PORT})`)

await soap('DeletePortMapping', { NewRemoteHost: '', NewExternalPort: TEST_PORT, NewProtocol: 'UDP' })
console.log('mapping deleted — upnp smoke test passed')
