// Renders the Lyra orb mark into PWA PNG icons with no image dependencies.
// Usage: npm run icons   (writes into public/)
import { writeFileSync } from 'node:fs'
import { deflateSync } from 'node:zlib'

const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})

function crc32(buffer) {
  let c = 0xffffffff
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([length, body, crc])
}

function png(size, pixel) {
  const raw = Buffer.alloc((size * 4 + 1) * size)
  for (let y = 0; y < size; y += 1) {
    raw[y * (size * 4 + 1)] = 0
    for (let x = 0; x < size; x += 1) {
      const [r, g, b] = pixel((x + 0.5) / size, (y + 0.5) / size)
      const i = y * (size * 4 + 1) + 1 + x * 4
      raw[i] = r
      raw[i + 1] = g
      raw[i + 2] = b
      raw[i + 3] = 255
    }
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(size, 0)
  header.writeUInt32BE(size, 4)
  header[8] = 8
  header[9] = 6
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

// Deterministic pseudo-noise for the particle speckle.
function hash(x, y) {
  const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453
  return s - Math.floor(s)
}

function orb(ringRadius) {
  return (u, v) => {
    const dx = u - 0.5
    const dy = v - 0.5
    const d = Math.hypot(dx, dy)
    const bg = [2, 4, 10]
    const ring = Math.exp(-(((d - ringRadius) / (ringRadius * 0.07)) ** 2))
    const glow = Math.exp(-(((d - ringRadius) / (ringRadius * 0.32)) ** 2)) * 0.45
    const inner = d < ringRadius ? 0.08 * (1 - d / ringRadius) : 0
    const angle = Math.atan2(dy, dx)
    const violet = Math.max(0, Math.sin(angle * 2 + 0.6)) ** 3
    const speckle = hash(Math.round(u * 400), Math.round(v * 400)) > 0.985 && d < ringRadius * 1.25 ? 0.5 : 0
    const k = ring + glow + inner + speckle * (1 - Math.abs(d - ringRadius) / ringRadius)
    const r = bg[0] + 255 * k * (0.25 + 0.3 * violet) + 180 * ring * 0.5
    const g = bg[1] + 255 * k * (0.55 - 0.2 * violet) + 200 * ring * 0.45
    const b = bg[2] + 255 * k * 1.0 + 60 * ring
    return [Math.min(255, r), Math.min(255, g), Math.min(255, b)].map(Math.round)
  }
}

const out = new URL('../public/', import.meta.url)
const icons = [
  ['pwa-192.png', 192, 0.33],
  ['pwa-512.png', 512, 0.33],
  // Maskable: everything important inside the central 80% safe zone.
  ['pwa-maskable-512.png', 512, 0.25],
  ['apple-touch-icon.png', 180, 0.31],
]
for (const [name, size, radius] of icons) {
  writeFileSync(new URL(name, out), png(size, orb(radius)))
  console.log(`wrote public/${name} (${size}x${size})`)
}
