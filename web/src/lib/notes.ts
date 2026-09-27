/** Obsidian-flavoured Markdown helpers for the read-only Brain view. */

export const WIKI_PREFIX = '#lyra-wiki:'

const FRONTMATTER = new RegExp('^(?:\\uFEFF)?---\\r?\\n[\\s\\S]*?\\r?\\n---[ \\t]*(?:\\r?\\n|$)')

export function stripFrontmatter(markdown: string): string {
  return markdown.replace(FRONTMATTER, '')
}

/** [[Note]] / [[Note|alias]] / [[Note#heading]] → a link the view turns into a search. */
export function wikiLinksToMarkdown(markdown: string): string {
  return markdown.replace(/(!?)\[\[([^\]|#\n]+)(#[^\]|\n]*)?(?:\|([^\]\n]+))?\]\]/g, (_m, embed, target, _h, alias) => {
    const label = (alias ?? target).trim()
    if (embed) return `*${label}*`
    return `[${label}](${WIKI_PREFIX}${encodeURIComponent(target.trim())})`
  })
}

export function prepareNote(markdown: string): string {
  return wikiLinksToMarkdown(stripFrontmatter(markdown))
}

export function fileTitle(path: string): string {
  const leaf = path.split('/').pop() ?? path
  return leaf.replace(/\.md$/i, '')
}

/** Leading level-1 heading, else the file name. */
export function noteTitle(path: string, markdown?: string): string {
  const heading = markdown ? stripFrontmatter(markdown).match(/^\s*#\s+([^\n]+?)\s*#*\s*(?:\r?\n|$)/) : null
  return heading ? heading[1] : fileTitle(path)
}

/** Body without the leading H1 when it is shown as the page title. */
export function withoutTitle(markdown: string): string {
  return markdown.replace(/^\s*#\s+.+\r?\n?/, '')
}

export function folderOf(path: string): string {
  const parts = path.split('/')
  return parts.length > 1 ? parts.slice(0, -1).join(' / ') : ''
}

/** Search excerpt as plain text, without Markdown syntax. */
export function excerptText(excerpt: string): string {
  // Search excerpts arrive with whitespace collapsed, so frontmatter is inline.
  return excerpt
    .replace(/^\s*---\s[\s\S]*?\s---(\s|$)/, '')
    .replace(/\[\[([^\]|]+)\|?([^\]]*)\]\]/g, (_m, target, alias) => alias || target)
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/`{1,3}/g, '')
    // `*`/`~~` only: underscores are common inside words (snake_case, file names).
    .replace(/(\*\*|\*|~~)(?=\S)|(?<=\S)(\*\*|\*|~~)/g, '')
    .replace(/(^|\s)#{1,6}\s+/g, '$1')
    .replace(/(^|\s)(?:[-*+]|\d+\.)\s+(?:\[[ xX]\]\s+)?/g, '$1')
    .replace(/(^|\s)>\s+/g, '$1')
    .replace(/\|/g, ' ')
    .replace(/-{3,}/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}
