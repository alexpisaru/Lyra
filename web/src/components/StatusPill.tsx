import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { ConnectionState } from '../lib/websocket'
import type { LyraStatus } from '../types/api'
import { BrainIcon, ChevronIcon, ChipIcon, DatabaseIcon, GlobeIcon } from './icons'

interface StatusPillProps {
  status: LyraStatus | null
  reachable: boolean | null
  connection: ConnectionState
  /** start collapsed and close on outside tap (views with their own panels) */
  compact?: boolean
}

type Tone = 'online' | 'degraded' | 'offline' | 'pending'

export function statusTone(status: LyraStatus | null, reachable: boolean | null, connection: ConnectionState): Tone {
  if (reachable === null && connection === 'connecting') return 'pending'
  if (reachable === false || !status) return 'offline'
  if (connection !== 'open' || !status.model.reachable) return 'degraded'
  return 'online'
}

const HEADLINE: Record<Tone, string> = {
  online: 'Lyra attiva',
  degraded: 'Lyra parzialmente attiva',
  offline: 'Lyra non raggiungibile',
  pending: 'Connessione…',
}

const FAMILIES: Record<string, string> = {
  minicpm: 'MiniCPM',
  qwen: 'Qwen',
  llama: 'Llama',
  gemma: 'Gemma',
  mistral: 'Mistral',
  phi: 'Phi',
}

/** "openbmb/minicpm5-2b:q8_0" -> "MiniCPM 2B" (the reference's short label). */
export function prettyModel(model: string): string {
  const name = (model.split('/').pop() ?? model).split(':')[0]
  const parts = name.split(/[-_]/)
  const family = parts[0].replace(/[\d.]+$/, '').toLowerCase()
  const size = parts.find((p) => /^\d+(\.\d+)?[bm]$/i.test(p))
  const label = FAMILIES[family]
  return label ? [label, size?.toUpperCase()].filter(Boolean).join(' ') : name
}

function wide() {
  return typeof window.matchMedia !== 'function' || window.matchMedia('(min-width: 720px)').matches
}

function Row({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <li className="status-row">
      <span className="status-row-icon">{icon}</span>
      <span>{children}</span>
    </li>
  )
}

/**
 * Status card in the top-right of the hero, as in the reference: open by
 * default on wide screens, collapsible with the chevron; a compact pill on
 * phones and on Brain/Activity (tap to open, tap outside or Esc to close).
 */
export function StatusPill({ status, reachable, connection, compact = false }: StatusPillProps) {
  const [open, setOpen] = useState(() => !compact && wide())
  const root = useRef<HTMLDivElement>(null)
  const tone = statusTone(status, reachable, connection)

  useEffect(() => {
    if (!open) return
    const onPointer = (event: PointerEvent) => {
      if ((compact || !wide()) && root.current && !root.current.contains(event.target as Node)) setOpen(false)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', onPointer)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onPointer)
      document.removeEventListener('keydown', onKey)
    }
  }, [open, compact])

  const provider = status?.model.provider === 'ollama' ? 'Ollama' : status?.model.provider
  const details = status
    ? `${status.model.model} · ${provider}${status.model.reachable ? '' : ' (modello non raggiungibile)'} · v${status.version} · ${
        connection === 'open' ? 'tempo reale' : 'riconnessione…'
      }`
    : HEADLINE[tone]

  return (
    <div ref={root} className="status" data-open={open} data-tone={tone}>
      <button
        type="button"
        className="status-head"
        aria-expanded={open}
        aria-controls="lyra-status-panel"
        aria-label={`${HEADLINE[tone]}. Dettagli stato`}
        title={details}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="status-dot" />
        <span className="status-name">{open ? HEADLINE[tone] : 'Lyra'}</span>
        <ChevronIcon size={15} className="status-chevron" />
      </button>
      <div id="lyra-status-panel" className="status-panel" role="region" aria-label="Stato di Lyra" aria-hidden={!open}>
        {status && reachable ? (
          <ul className="status-list">
            <Row icon={<ChipIcon size={16} />}>
              {prettyModel(status.model.model)} ({provider})
            </Row>
            <Row icon={<GlobeIcon size={16} />}>
              Browser: {status.browser.enabled ? (status.browser.backend === 'chromium' ? 'Chromium' : status.browser.backend) : 'disattivato'}
            </Row>
            <Row icon={<DatabaseIcon size={16} />}>Memoria: {status.memory.enabled ? 'attiva' : 'disattivata'}</Row>
            <Row icon={<BrainIcon size={16} />}>Knowledge: {status.knowledge.enabled ? 'attivo' : 'disattivato'}</Row>
          </ul>
        ) : (
          <p className="status-offline">Il servizio non risponde; l’interfaccia si ricollega da sola.</p>
        )}
      </div>
    </div>
  )
}
