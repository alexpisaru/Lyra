// Builds every Lyra icon from the brand logo (brand/lyra-logo.png, transparent).
// Usage: npm run icons   (needs ffmpeg on PATH; writes into public/)
//
// Home-screen icons get the dark app background (iOS fills transparency with
// black anyway); the logo is inset so its glow is not clipped, and the maskable
// icon keeps it inside the 80% safe circle Android crops to.
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const logo = `${root}brand/lyra-logo.png`
const out = (name) => `${root}public/${name}`
const BACKGROUND = '0x02040a'

// [file, canvas px, logo share of the canvas, background]
const ICONS = [
  ['pwa-512.png', 512, 0.9, BACKGROUND],
  ['pwa-192.png', 192, 0.9, BACKGROUND],
  ['pwa-maskable-512.png', 512, 0.66, BACKGROUND],
  ['apple-touch-icon.png', 180, 0.86, BACKGROUND],
  // browser tab: transparent, as large as possible
  ['favicon-32.png', 32, 1, null],
  ['favicon-192.png', 192, 1, null],
  // the logo itself, for use in the app (kept small: the PWA precaches it)
  ['lyra-logo.png', 512, 1, null],
]

function ffmpeg(args) {
  execFileSync('ffmpeg', ['-loglevel', 'error', '-y', ...args], { stdio: 'inherit' })
}

for (const [name, size, share, background] of ICONS) {
  const inner = Math.round(size * share)
  const scale = `scale=${inner}:${inner}:flags=lanczos,format=rgba`
  if (background) {
    ffmpeg([
      '-f', 'lavfi', '-i', `color=c=${background}:s=${size}x${size}`,
      '-i', logo,
      '-filter_complex', `[1]${scale}[l];[0][l]overlay=(W-w)/2:(H-h)/2:format=auto,format=rgb24`,
      '-frames:v', '1', out(name),
    ])
  } else {
    ffmpeg(['-i', logo, '-vf', `${scale},pad=${size}:${size}:(ow-iw)/2:(oh-ih)/2:color=0x00000000`, out(name)])
  }
}
console.log('icons written to public/')
