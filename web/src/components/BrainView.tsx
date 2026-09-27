import { useEffect, useRef, useState } from 'react'
import { api, ApiError, describeError } from '../lib/api'
import { excerptText, fileTitle, folderOf, noteTitle, prepareNote, withoutTitle } from '../lib/notes'
import type { NoteResponse, SearchResult } from '../types/api'
import { BackIcon, NoteIcon, SearchIcon } from './icons'
import { NoteMarkdown } from './NoteMarkdown'

export const SEARCH_DEBOUNCE_MS = 280

interface BrainViewProps {
  knowledgeEnabled: boolean | null
}

/** Read-only window on the Obsidian vault: search on the left, note on the right. */
export function BrainView({ knowledgeEnabled }: BrainViewProps) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SearchResult[]>([])
  const [searched, setSearched] = useState('')
  const [searchError, setSearchError] = useState<string | null>(null)
  const [searching, setSearching] = useState(false)
  const [note, setNote] = useState<NoteResponse | null>(null)
  const [noteError, setNoteError] = useState<string | null>(null)
  const [loadingPath, setLoadingPath] = useState<string | null>(null)
  const searchInput = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const q = query.trim()
    if (!q) return
    const controller = new AbortController()
    const timer = setTimeout(async () => {
      setSearching(true)
      try {
        const response = await api.searchNotes(q, controller.signal)
        setResults(response.results)
        setSearchError(null)
        setSearched(q)
      } catch (error) {
        if (controller.signal.aborted) return
        setResults([])
        setSearched(q)
        setSearchError(
          error instanceof ApiError && error.kind === 'not_found'
            ? 'Knowledge non è attivo su Lyra'
            : describeError(error),
        )
      } finally {
        if (!controller.signal.aborted) setSearching(false)
      }
    }, SEARCH_DEBOUNCE_MS)
    return () => {
      controller.abort()
      clearTimeout(timer)
    }
  }, [query])

  const open = async (path: string) => {
    setLoadingPath(path)
    setNoteError(null)
    try {
      setNote(await api.readNote(path))
    } catch (error) {
      setNote(null)
      setNoteError(error instanceof ApiError && error.kind === 'not_found' ? 'Nota non trovata' : describeError(error))
    } finally {
      setLoadingPath(null)
    }
  }

  const searchFor = (target: string) => {
    setQuery(target)
    setNote(null)
    searchInput.current?.focus()
  }

  const hasQuery = query.trim().length > 0
  const markdown = note ? prepareNote(note.content) : ''
  const title = note ? noteTitle(note.path, note.content) : ''

  return (
    <section className="view brain-view" data-note-open={Boolean(note || noteError)} aria-label="Brain">
      <div className="brain-list panel">
        <label className="brain-search">
          <SearchIcon size={18} />
          <span className="sr-only">Cerca nel vault</span>
          <input
            ref={searchInput}
            type="search"
            placeholder="Cerca nel tuo vault…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            autoComplete="off"
            enterKeyHint="search"
            maxLength={300}
          />
        </label>
        {knowledgeEnabled === false ? (
          <p className="brain-hint">Knowledge non è attivo su Lyra.</p>
        ) : !hasQuery ? (
          <p className="brain-hint">Scrivi per cercare tra le note del vault Obsidian.</p>
        ) : searchError ? (
          <p className="brain-hint" data-tone="error">
            {searchError}
          </p>
        ) : searched === query.trim() && results.length === 0 && !searching ? (
          <p className="brain-hint">Nessuna nota trovata per «{searched}».</p>
        ) : (
          <ul className="brain-results" aria-busy={searching}>
            {(hasQuery ? results : []).map((result) => (
              <li key={result.path}>
                <button
                  type="button"
                  className="brain-result"
                  aria-current={note?.path === result.path ? 'true' : undefined}
                  onClick={() => void open(result.path)}
                  disabled={loadingPath === result.path}
                >
                  <NoteIcon size={18} />
                  <span className="brain-result-text">
                    <span className="brain-result-title">{fileTitle(result.path)}</span>
                    <span className="brain-result-excerpt">{excerptText(result.excerpt)}</span>
                    {folderOf(result.path) ? <span className="brain-result-path">{folderOf(result.path)}</span> : null}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="brain-note panel" aria-live="polite">
        {note ? (
          <article>
            <button type="button" className="brain-back" onClick={() => setNote(null)}>
              <BackIcon size={18} /> Note
            </button>
            <header className="note-header">
              <h1>{title}</h1>
              <p className="note-path">{note.path}</p>
            </header>
            <NoteMarkdown markdown={title === fileTitle(note.path) ? markdown : withoutTitle(markdown)} onWikiLink={searchFor} />
          </article>
        ) : noteError ? (
          <div className="brain-empty">
            <button type="button" className="brain-back" onClick={() => setNoteError(null)}>
              <BackIcon size={18} /> Note
            </button>
            <p>{noteError}</p>
          </div>
        ) : (
          <div className="brain-empty">
            <p>Seleziona una nota per leggerla.</p>
            <small>Il vault è la fonte di verità: le modifiche fatte in Obsidian appaiono alla ricerca successiva.</small>
          </div>
        )}
      </div>
    </section>
  )
}
