import Markdown, { defaultUrlTransform } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { WIKI_PREFIX } from '../lib/notes'

interface NoteMarkdownProps {
  markdown: string
  /** Without a handler (e.g. in Chat) wikilinks render as plain styled text. */
  onWikiLink?: (target: string) => void
  className?: string
}

/**
 * Renders vault Markdown. Raw HTML in notes is never executed (react-markdown
 * default), unsafe URLs are dropped, vault-relative images are not fetched and
 * [[wikilinks]] become in-app searches.
 */
export function NoteMarkdown({ markdown, onWikiLink, className = 'markdown' }: NoteMarkdownProps) {
  return (
    <div className={className}>
      <Markdown
        remarkPlugins={[remarkGfm]}
        urlTransform={(url) => (url.startsWith(WIKI_PREFIX) ? url : defaultUrlTransform(url))}
        components={{
          a({ href, children }) {
            if (href?.startsWith(WIKI_PREFIX)) {
              const target = decodeURIComponent(href.slice(WIKI_PREFIX.length))
              if (!onWikiLink) return <span className="wikilink-text">{children}</span>
              return (
                <button type="button" className="wikilink" onClick={() => onWikiLink(target)}>
                  {children}
                </button>
              )
            }
            if (href && /^https?:\/\//i.test(href)) {
              return (
                <a href={href} target="_blank" rel="noopener noreferrer">
                  {children}
                </a>
              )
            }
            return <span className="dead-link">{children}</span>
          },
          img({ alt, src }) {
            return /^https?:\/\//i.test(src ?? '') ? (
              <img src={src} alt={alt ?? ''} loading="lazy" referrerPolicy="no-referrer" />
            ) : (
              <span className="embed-placeholder">{alt || 'immagine del vault'}</span>
            )
          },
        }}
      >
        {markdown}
      </Markdown>
    </div>
  )
}
