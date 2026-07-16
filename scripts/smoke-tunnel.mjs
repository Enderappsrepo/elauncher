// Smoke test for the native bore tunnel client: expose a local echo server
// through the public bore.pub relay and round-trip data over the tunnel.
// Mirrors the protocol implementation in src/main/services/hosting.ts.
// Usage: node scripts/smoke-tunnel.mjs
import net from 'net'

const BORE_HOST = 'bore.pub'
const CONTROL_PORT = 7835
const LOCAL_PORT = 25599

const sendFrame = (sock, msg) => sock.write(JSON.stringify(msg) + '\0')
const onFrames = (sock, handler) => {
  let buf = Buffer.alloc(0)
  sock.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk])
    let end
    while ((end = buf.indexOf(0)) !== -1) {
      const frame = buf.subarray(0, end).toString('utf8')
      buf = buf.subarray(end + 1)
      if (frame) handler(JSON.parse(frame))
    }
  })
}

// 1. local "minecraft server" stand-in: echoes everything back
const echo = net.createServer((sock) => sock.pipe(sock))
await new Promise((r) => echo.listen(LOCAL_PORT, '127.0.0.1', r))
console.log('echo server on 127.0.0.1:' + LOCAL_PORT)

// 2. control connection: Hello(0) -> Hello(publicPort), then answer Connection offers
const control = net.connect(CONTROL_PORT, BORE_HOST)
control.on('connect', () => sendFrame(control, { Hello: 0 }))
const publicPort = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('relay did not answer within 20s')), 20_000)
  onFrames(control, (msg) => {
    if (typeof msg !== 'object' || msg === null) return // Heartbeat
    if ('Hello' in msg) {
      clearTimeout(timer)
      resolve(msg.Hello)
    }
    if ('Connection' in msg) {
      const remote = net.connect(CONTROL_PORT, BORE_HOST)
      const local = net.connect(LOCAL_PORT, '127.0.0.1')
      remote.on('connect', () => {
        sendFrame(remote, { Accept: msg.Connection })
        remote.pipe(local)
        local.pipe(remote)
      })
      for (const s of [remote, local])
        s.on('error', () => {
          remote.destroy()
          local.destroy()
        })
    }
    if ('Error' in msg) {
      clearTimeout(timer)
      reject(new Error('relay error: ' + msg.Error))
    }
  })
  control.on('error', (e) => {
    clearTimeout(timer)
    reject(e)
  })
})
console.log(`tunnel up: ${BORE_HOST}:${publicPort} -> 127.0.0.1:${LOCAL_PORT}`)

// 3. round-trip through the public address: a small hello and a >4 KiB payload
for (const payload of ['hello elauncher', 'x'.repeat(4096)]) {
  const got = await new Promise((resolve, reject) => {
    const visitor = net.connect(publicPort, BORE_HOST)
    const chunks = []
    const timer = setTimeout(() => reject(new Error('no echo within 15s')), 15_000)
    visitor.on('connect', () => visitor.write(payload))
    visitor.on('data', (d) => {
      chunks.push(d)
      if (Buffer.concat(chunks).length >= payload.length) {
        clearTimeout(timer)
        visitor.destroy()
        resolve(Buffer.concat(chunks).toString('utf8'))
      }
    })
    visitor.on('error', (e) => {
      clearTimeout(timer)
      reject(e)
    })
  })
  if (got !== payload) throw new Error(`echo mismatch (${got.length} bytes back)`)
  console.log(`round-trip ok (${payload.length} bytes)`)
}

control.destroy()
echo.close()
console.log('tunnel smoke test passed')
