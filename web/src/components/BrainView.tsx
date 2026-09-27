import { useEffect, useMemo, useRef, useState } from 'react'
import { api, ApiError, describeError } from '../lib/api'
import { excerptText, fileTitle, noteTitle, prepareNote, withoutTitle } from '../lib/notes'
import type { NoteResponse, NoteSummary, SearchResult } from '../types/api'
import { BackIcon, NoteIcon, SearchIcon } from './icons'
import { NoteMarkdown } from './NoteMarkdown'

export const SEARCH_DEBOUNCE_MS = 280

interface BrainViewProps {
  knowledgeEnabled: boolean | null
}

export interface BrainRow {
  path: string
  title: string
  excerpt?: string
}

/** Local title/path filter first, then full-text hits from the vault search. */
export function mergeRows(notes: NoteSummary[], query: string, hits: SearchResult[]): BrainRow[] {
  const q = query.trim().toLocaleLowerCase('it')
  if (!q) return notes
  const titles = new Map(notes.map((n) => [n.path, n.title]))
  const excerpts = new Map(hits.map((h) => [h.path, excerptText(h.excerpt)]))
  const rows: BrainRow[] = notes
    .filter((n) => n.title.toLocaleLowerCase('it').includes(q) || n.path.toLocaleLowerCase('it').includes(q))
    .map((n) => ({ ...n, excerpt: excerpts.get(n.path) }))
  const seen = new Set(rows.map((r) => r.path))
  for (const hit of hits) {
    if (!seen.has(hit.path)) {
      rows.push({ path: hit.path, title: titles.get(hit.path) ?? fileTitle(hit.path), excerpt: excerpts.get(hit.path) })
    }
  }
  return rows
}

/** Read-only window on the Obsidian vault: all notes on the left, the note on the right. */
export function BrainView({ knowledgeEnabled }: BrainViewProps) {
  const [notes, setNotes] = useState<NoteSummary[] | null>(null)
  const [listError, setListError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<SearchResult[]>([])
  const [searching, setSearching] = useState(false)
  const [note, setNote] = useState<NoteResponse | null>(null)
  const [noteError, setNoteError] = useState<string | null>(null)
  const [loadingPath, setLoadingPath] = useState<string | null>(null)
  const searchInput = useRef<HTMLInputElement>(null)

  // Every note in the vault as soon as Brain opens; search only narrows it.
  useEffect(() => {
    const controller = new AbortController()
    api.listNotes(controller.signal).then(
      (response) => {
        setNotes(response.notes)
        setListError(null)
      },
      (error) => {
        if (controller.signal.aborted) return
        setNotes([])
        if (error instanceof ApiError && error.kind === 'not_found') {
          // The API says "Knowledge vault is disabled"; any other 404 is an older
          // Lyra Core without the list endpoint, where search still works.
          setListError(
            /disabled/i.test(error.message)
              ? 'Knowledge non è attivo su Lyra'
              : 'Elenco note non disponibile: aggiorna Lyra Core sul server. La ricerca funziona.',
          )
        } else {
          setListError(describeError(error))
        }
      },
    )
    return () => controller.abort()
  }, [])

  useEffect(() => {
    const q = query.trim()
    if (!q) return
    const controller = new AbortController()
    const timer = setTimeout(() => {
      setSearching(true)
      api.searchNotes(q, controller.signal).then(
        (response) => {
          setHits(response.results)
          setSearching(false)
        },
        () => {
          // Full-text search is an extra: the title/path filter keeps working.
          if (controller.signal.aborted) return
          setHits([])
          setSearching(false)
        },
      )
    }, SEARCH_DEBOUNCE_MS)
    return () => {
      controller.abort()
      clearTimeout(timer)
    }
  }, [query])

  const q = query.trim()
  const rows = useMemo(() => mergeRows(notes ?? [], q, q ? hits : []), [notes, q, hits])

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

  const markdown = note ? prepareNote(note.content) : ''
  const title = note ? noteTitle(note.path, note.content) : ''

  let listBody
  if (knowledgeEnabled === false) {
    listBody = <p className="brain-hint">Knowledge non è attivo su Lyra.</p>
  } else if (listError && !q) {
    listBody = (
      <p className="brain-hint" data-tone="error">
        {listError}
      </p>
    )
  } else if (notes === null) {
    listBody = <p className="brain-hint">Caricamento delle note…</p>
  } else if (rows.length === 0) {
    listBody = <p className="brain-hint">{q ? `Nessuna nota trovata per «${q}».` : 'Il vault non contiene ancora note.'}</p>
  } else {
    listBody = (
      <ul className="brain-results" aria-busy={searching} aria-label="Note del vault">
        {rows.map((row) => (
          <li key={row.path}>
            <button
              type="button"
              className="brain-result"
              aria-current={note?.path === row.path ? 'true' : undefined}
              onClick={() => void open(row.path)}
              disabled={loadingPath === row.path}
            >
              <NoteIcon size={18} />
              <span className="brain-result-text">
                <span className="brain-result-title">{row.title}</span>
                {row.excerpt ? <span className="brain-result-excerpt">{row.excerpt}</span> : null}
                <span className="brain-result-path">{row.path}</span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    )
  }

  return (
    <section className="view brain-view" data-note-open={Boolean(note || noteError)} aria-label="Brain">
      <div className="brain-list panel">
        <label className="brain-search">
          <SearchIcon size={18} />
          <span className="sr-only">Cerca nelle note</span>
          <input
            ref={searchInput}
            type="search"
            placeholder="Cerca nelle note…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            autoComplete="off"
            enterKeyHint="search"
            maxLength={300}
          />
        </label>
        {notes && notes.length > 0 && !q ? <p className="brain-count">{notes.length} note</p> : null}
        {listBody}
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
            <small>Il vault è la fonte di verità: le modifiche fatte in Obsidian compaiono qui.</small>
          </div>
        )}
      </div>
    </section>
  )
}
