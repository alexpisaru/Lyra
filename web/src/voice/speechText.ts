/**
 * Turns a chat reply (light Markdown) into short spoken chunks. Short chunks
 * give a low time-to-first-audio: the first sentence plays while the next one
 * is synthesized.
 */

export const MAX_CHUNK_CHARS = 280

export function toSpeech(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+[.)])\s+/gm, '')
    .replace(/(\*\*|__|\*|_|~~)(.+?)\1/g, '$2')
    .replace(/\|/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .trim()
}

export function chunkSpeech(text: string, max = MAX_CHUNK_CHARS): string[] {
  const sentences = text
    .split(/(?<=[.!?…:;])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => /[\p{L}\p{N}]/u.test(s))
  const chunks: string[] = []
  for (const sentence of sentences) {
    let rest = sentence
    while (rest.length > max) {
      const window = rest.slice(0, max)
      const cut = Math.max(window.lastIndexOf(', '), window.lastIndexOf(' '))
      const at = cut > max / 3 ? cut + 1 : max
      chunks.push(rest.slice(0, at).trim())
      rest = rest.slice(at).trim()
    }
    if (rest) chunks.push(rest)
  }
  return chunks
}
