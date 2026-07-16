import dgram from 'dgram'
import os from 'os'
import { app } from 'electron'

/**
 * Minimal native UPnP-IGD client (SSDP discovery + SOAP port mapping).
 * Used to expose UDP game servers (Palworld etc.) that the TCP-only bore
 * relay can't carry. Implemented over plain sockets/fetch — same
 * no-helper-binaries rule as the bore client in hosting.ts.
 */

const SSDP_ADDR = '239.255.255.250'
const SSDP_PORT = 1900
// some routers only answer rootdevice/ssdp:all probes, so cast a wide net
const SEARCH_TARGETS = [
  'urn:schemas-upnp-org:device:InternetGatewayDevice:1',
  'urn:schemas-upnp-org:device:InternetGatewayDevice:2',
  'upnp:rootdevice',
  'ssdp:all'
]
const WAN_SERVICES = [
  'urn:schemas-upnp-org:service:WANIPConnection:1',
  'urn:schemas-upnp-org:service:WANIPConnection:2',
  'urn:schemas-upnp-org:service:WANPPPConnection:1'
]

interface Gateway {
  controlUrl: string
  serviceType: string
  /** LAN address of this machine on the interface that reaches the gateway */
  localIp: string
}

export interface PortMapping {
  externalIp: string
  port: number
  protocol: 'UDP' | 'TCP'
  /** set when the external IP looks like CGNAT/private — reachability is unlikely */
  warning?: string
}

let cachedGateway: Gateway | null = null
const mappings = new Map<string, PortMapping>()

const mapKey = (port: number, protocol: string): string => `${protocol}:${port}`

/** M-SEARCH from one local interface address, collecting LOCATION headers. */
function ssdpSearchOn(localAddress: string | undefined, timeoutMs: number): Promise<string[]> {
  return new Promise((resolve) => {
    const sock = dgram.createSocket('udp4')
    const locations = new Set<string>()
    const finish = (): void => {
      try {
        sock.close()
      } catch {
        // already closed
      }
      resolve([...locations])
    }
    const timer = setTimeout(finish, timeoutMs)
    sock.on('error', () => {
      clearTimeout(timer)
      finish()
    })
    sock.on('message', (msg) => {
      const m = msg.toString('utf8').match(/^location:\s*(.+)$/im)
      if (m) locations.add(m[1].trim())
    })
    const sendProbes = (): void => {
      for (const st of SEARCH_TARGETS) {
        const probe = Buffer.from(
          `M-SEARCH * HTTP/1.1\r\nHOST: ${SSDP_ADDR}:${SSDP_PORT}\r\nMAN: "ssdp:discover"\r\nMX: 2\r\nST: ${st}\r\n\r\n`
        )
        sock.send(probe, SSDP_PORT, SSDP_ADDR)
      }
    }
    sock.bind({ address: localAddress }, () => {
      if (localAddress) {
        try {
          sock.setMulticastInterface(localAddress)
        } catch {
          // interface went away — the probe still goes out the default route
        }
      }
      sendProbes()
      // SSDP is lossy UDP; a second round catches slow or deaf-first-time routers
      setTimeout(() => {
        try {
          sendProbes()
        } catch {
          // socket already closed
        }
      }, 700)
    })
  })
}

/** SSDP M-SEARCH on every IPv4 interface (Windows multicast often picks the wrong NIC). */
async function ssdpSearch(timeoutMs = 3000): Promise<string[]> {
  const addresses = Object.values(os.networkInterfaces())
    .flatMap((infos) => infos ?? [])
    .filter((i) => i.family === 'IPv4' && !i.internal)
    .map((i) => i.address)
  const searches = [ssdpSearchOn(undefined, timeoutMs), ...addresses.map((a) => ssdpSearchOn(a, timeoutMs))]
  const results = await Promise.all(searches)
  return [...new Set(results.flat())]
}

/** The local IPv4 the OS routes toward `host`, so the router maps to the right machine. */
function localIpToward(host: string): Promise<string> {
  return new Promise((resolve) => {
    const sock = dgram.createSocket('udp4')
    const fallback = (): void => {
      try {
        sock.close()
      } catch {
        // already closed
      }
      for (const infos of Object.values(os.networkInterfaces())) {
        for (const info of infos ?? []) {
          if (info.family === 'IPv4' && !info.internal) return resolve(info.address)
        }
      }
      resolve('127.0.0.1')
    }
    try {
      sock.connect(9, host, () => {
        const address = sock.address().address
        sock.close()
        resolve(address)
      })
      sock.on('error', fallback)
    } catch {
      fallback()
    }
  })
}

/** Parse the device description XML for a WAN connection service's control URL. */
function findWanService(xml: string, baseUrl: string): { controlUrl: string; serviceType: string } | null {
  for (const block of xml.split(/<service>/i).slice(1)) {
    const type = block.match(/<serviceType>([^<]+)<\/serviceType>/i)?.[1]?.trim()
    const control = block.match(/<controlURL>([^<]+)<\/controlURL>/i)?.[1]?.trim()
    if (type && control && WAN_SERVICES.includes(type)) {
      return { controlUrl: new URL(control, baseUrl).toString(), serviceType: type }
    }
  }
  return null
}

async function discoverGateway(): Promise<Gateway> {
  if (cachedGateway) return cachedGateway
  const locations = await ssdpSearch()
  if (locations.length === 0) {
    throw new Error('No UPnP router found. Enable UPnP in your router settings, or forward the port manually.')
  }
  for (const location of locations.slice(0, 12)) {
    try {
      const res = await fetch(location, { signal: AbortSignal.timeout(5000) })
      if (!res.ok) continue
      const service = findWanService(await res.text(), location)
      if (service) {
        cachedGateway = { ...service, localIp: await localIpToward(new URL(location).hostname) }
        return cachedGateway
      }
    } catch {
      // dead or malformed device — try the next one
    }
  }
  throw new Error('Your router answered UPnP discovery but offers no port-mapping service.')
}

const esc = (v: string): string =>
  v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

async function soap(gateway: Gateway, action: string, args: Record<string, string | number>): Promise<string> {
  const argXml = Object.entries(args)
    .map(([k, v]) => `<${k}>${esc(String(v))}</${k}>`)
    .join('')
  const body =
    '<?xml version="1.0"?>' +
    '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">' +
    `<s:Body><u:${action} xmlns:u="${gateway.serviceType}">${argXml}</u:${action}></s:Body></s:Envelope>`
  const res = await fetch(gateway.controlUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'text/xml; charset="utf-8"',
      SOAPAction: `"${gateway.serviceType}#${action}"`
    },
    body,
    signal: AbortSignal.timeout(8000)
  })
  const text = await res.text()
  if (!res.ok) {
    const code = text.match(/<errorCode>(\d+)<\/errorCode>/i)?.[1]
    const desc = text.match(/<errorDescription>([^<]*)<\/errorDescription>/i)?.[1]
    throw new Error(`Router refused ${action}${code ? ` (${code}${desc ? ` ${desc}` : ''})` : ''}.`)
  }
  return text
}

/** RFC1918 + CGNAT (100.64/10) ranges — an "external" IP here won't be reachable from the internet. */
function isPrivateIp(ip: string): boolean {
  const [a, b] = ip.split('.').map(Number)
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)
}

export async function getExternalIp(): Promise<string> {
  const gateway = await discoverGateway()
  const xml = await soap(gateway, 'GetExternalIPAddress', {})
  const ip = xml.match(/<NewExternalIPAddress>([^<]+)<\/NewExternalIPAddress>/i)?.[1]
  if (!ip) throw new Error('Router did not report an external IP.')
  return ip
}

/**
 * Map `port` on the router to this machine and return the public address.
 * Tries a permanent lease first, falling back to 24h for routers that
 * reject infinite leases.
 */
export async function openPort(port: number, protocol: 'UDP' | 'TCP', description = 'ELauncher'): Promise<PortMapping> {
  const existing = mappings.get(mapKey(port, protocol))
  if (existing) return existing
  let gateway: Gateway
  try {
    gateway = await discoverGateway()
  } catch (e) {
    // no automatic mapping available — tell the user exactly what to forward where
    const lan = await getLanIp()
    const reason = e instanceof Error ? e.message : String(e)
    throw new Error(
      `${reason} To share anyway: in your router settings, forward ${protocol} port ${port} to this PC (${lan}), then give friends your public IP.`
    )
  }
  const args = (lease: number): Record<string, string | number> => ({
    NewRemoteHost: '',
    NewExternalPort: port,
    NewProtocol: protocol,
    NewInternalPort: port,
    NewInternalClient: gateway.localIp,
    NewEnabled: 1,
    NewPortMappingDescription: description,
    NewLeaseDuration: lease
  })
  try {
    await soap(gateway, 'AddPortMapping', args(0))
  } catch {
    await soap(gateway, 'AddPortMapping', args(86400))
  }
  const externalIp = await getExternalIp()
  const mapping: PortMapping = {
    externalIp,
    port,
    protocol,
    warning: isPrivateIp(externalIp)
      ? 'Your ISP appears to use carrier-grade NAT — this address may not be reachable from outside. Friends on the same network can still join.'
      : undefined
  }
  mappings.set(mapKey(port, protocol), mapping)
  return mapping
}

export async function closePort(port: number, protocol: 'UDP' | 'TCP'): Promise<void> {
  const key = mapKey(port, protocol)
  if (!mappings.delete(key)) return
  try {
    const gateway = await discoverGateway()
    await soap(gateway, 'DeletePortMapping', { NewRemoteHost: '', NewExternalPort: port, NewProtocol: protocol })
  } catch {
    // router gone or mapping already expired — nothing to do
  }
}

/** Public address for a mapped port, if one is active. */
export function getMappedAddress(port: number, protocol: 'UDP' | 'TCP' = 'UDP'): string | null {
  const m = mappings.get(mapKey(port, protocol))
  return m ? `${m.externalIp}:${m.port}` : null
}

export function getMappingWarning(port: number, protocol: 'UDP' | 'TCP' = 'UDP'): string | undefined {
  return mappings.get(mapKey(port, protocol))?.warning
}

/** This machine's LAN IPv4, for the "same network" invite line. */
export async function getLanIp(): Promise<string> {
  return localIpToward(SSDP_ADDR)
}

// best-effort: release mappings when the launcher quits
app.on('before-quit', () => {
  for (const m of mappings.values()) void closePort(m.port, m.protocol)
})
