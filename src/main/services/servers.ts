import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { TagType, deserialize, serialize } from '@xmcl/nbt'
import type { ServerEntry } from '@shared/types'
import { instanceDir } from '../paths'

/**
 * servers.dat schema. Classes annotated via TagType so @xmcl/nbt knows how to
 * serialize plain fields (decorator functions invoked manually — no decorator
 * syntax needed).
 */
class ServerInfoTag {
  name = ''
  ip = ''
  icon = ''
  acceptTextures = 0
  hidden = 0
}
TagType(TagType.String)(ServerInfoTag.prototype, 'name')
TagType(TagType.String)(ServerInfoTag.prototype, 'ip')
TagType(TagType.String)(ServerInfoTag.prototype, 'icon')
TagType(TagType.Byte)(ServerInfoTag.prototype, 'acceptTextures')
TagType(TagType.Byte)(ServerInfoTag.prototype, 'hidden')

class ServersDataTag {
  servers: ServerInfoTag[] = []
}
TagType([ServerInfoTag])(ServersDataTag.prototype, 'servers')

function serversFile(instanceId: string): string {
  return join(instanceDir(instanceId), 'servers.dat')
}

export async function listServers(instanceId: string): Promise<ServerEntry[]> {
  const file = serversFile(instanceId)
  if (!existsSync(file)) return []
  try {
    const data = await deserialize<ServersDataTag>(readFileSync(file), { type: ServersDataTag })
    return (data.servers ?? []).map((s) => ({
      name: s.name || 'Minecraft Server',
      ip: s.ip,
      icon: s.icon || undefined
    }))
  } catch {
    return []
  }
}

/** Replaces the whole server list (Minecraft reads servers.dat as one uncompressed NBT compound). */
export async function saveServers(instanceId: string, servers: ServerEntry[]): Promise<ServerEntry[]> {
  const data = new ServersDataTag()
  data.servers = servers.map((s) => {
    const tag = new ServerInfoTag()
    tag.name = s.name || 'Minecraft Server'
    tag.ip = s.ip
    tag.icon = s.icon ?? ''
    return tag
  })
  const bytes = await serialize(data)
  writeFileSync(serversFile(instanceId), bytes)
  return listServers(instanceId)
}
