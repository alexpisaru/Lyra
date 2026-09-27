import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { ConnectionState } from '../lib/websocket'
import type { LyraStatus } from '../types/api'
import { BrainIcon, ChipIcon, DatabaseIcon, GlobeIcon, LinkIcon, TagIcon } from './icons'

interface StatusPillProps {
  status: LyraStatus | null
  reachable: boolean | null
  connection: ConnectionState
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
  degraded: 'Lyra parzialmente disponibile',
  offline: 'Lyra non raggiungibile',
  pending: 'Connessione a Lyra…',
}

function canHover() {
  return typeof window.matchMedia === 'function' && window.matchMedia('(hover: hover) and (pointer: fine)').matches
}

function Row({ icon, label, value }: { icon: ReactNode; label: string; value: string }) {
  return (
    <li className="status-row">
      <span className="status-row-icon">{icon}</span>
      <span className="status-row-label">{label}</span>
      <span className="status-row-value">{value}</span>
    </li>
  )
}

/**
 * Collapsed "● Lyra" pill in the top-right corner. Hover expands it on desktop,
 * tap toggles it on touch screens; tap outside or Esc closes it.
 */
export function StatusPill({ status, reachable, connection }: StatusPillProps) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const tone = statusTone(status, reachable, connection)

  useEffect(() => {
    if (!open) return
    const onPointer = (event: PointerEvent) => {
      if (root.current && !root.current.contains(event.target as Node)) setOpen(false)
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
  }, [open])

  const on = (flag: boolean | undefined) => (flag ? 'attiva' : 'disattivata')
  const connectionText =
    connection === 'open' ? 'Tempo reale' : connection === 'connecting' ? 'Connessione…' : 'Riconnessione…'

  return (
    <div
      ref={root}
      className="status"
      data-open={open}
      data-tone={tone}
      onMouseEnter={() => canHover() && setOpen(true)}
      onMouseLeave={() => canHover() && setOpen(false)}
    >
      <button
        type="button"
        className="status-pill"
        aria-expanded={open}
        aria-controls="lyra-status-panel"
        aria-label={`${HEADLINE[tone]}. Dettagli stato`}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="status-dot" />
        <span className="status-name">Lyra</span>
      </button>
      <div id="lyra-status-panel" className="status-panel" role="region" aria-label="Stato di Lyra" aria-hidden={!open}>
        <p className="status-headline">
          <span className="status-dot" />
          {HEADLINE[tone]}
        </p>
        {status && reachable ? (
          <ul className="status-list">
            <Row icon={<ChipIcon size={16} />} label="Modello" value={status.model.model} />
            <Row
              icon={<LinkIcon size={16} />}
              label="Provider"
              value={`${status.model.provider === 'ollama' ? 'Ollama' : status.model.provider}${status.model.reachable ? '' : ' · non raggiungibile'}`}
            />
            <Row
              icon={<GlobeIcon size={16} />}
              label="Browser"
              value={status.browser.enabled ? `${status.browser.backend === 'chromium' ? 'Chromium' : status.browser.backend}` : 'disattivato'}
            />
            <Row icon={<DatabaseIcon size={16} />} label="Memoria" value={on(status.memory.enabled)} />
            <Row icon={<BrainIcon size={16} />} label="Knowledge" value={status.knowledge.enabled ? 'attivo' : 'disattivato'} />
            <Row icon={<LinkIcon size={16} />} label="Connessione" value={connectionText} />
            <Row icon={<TagIcon size={16} />} label="Versione" value={status.version} />
          </ul>
        ) : (
          <p className="status-offline">
            Il servizio Lyra non risponde. L’interfaccia resta disponibile e si ricollega da sola.
          </p>
        )}
      </div>
    </div>
  )
}
