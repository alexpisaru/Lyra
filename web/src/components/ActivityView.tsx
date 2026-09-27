import { useEffect, useRef } from 'react'
import { formatClock, type ActivityEntry } from '../lib/activity'
import type { ConnectionState } from '../lib/websocket'

interface ActivityViewProps {
  entries: ActivityEntry[]
  connection: ConnectionState
  onClear: () => void
}

/** Real-time timeline of /ws events: states, tools, outcomes, time. Not a console. */
export function ActivityView({ entries, connection, onClear }: ActivityViewProps) {
  const end = useRef<HTMLLIElement>(null)

  useEffect(() => {
    end.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [entries.length])

  return (
    <section className="view activity-view" aria-label="Activity">
      <div className="panel activity-panel">
        <header className="activity-header">
          <p className="activity-live" data-connection={connection}>
            <span className="status-dot" />
            {connection === 'open' ? 'In tempo reale' : connection === 'connecting' ? 'Connessione…' : 'Riconnessione…'}
          </p>
          {entries.length > 0 ? (
            <button type="button" className="text-button" onClick={onClear}>
              Pulisci
            </button>
          ) : null}
        </header>
        {entries.length === 0 ? (
          <p className="activity-empty">Nessuna attività. Gli eventi di Lyra appariranno qui mentre lavora.</p>
        ) : (
          <ol className="timeline">
            {entries.map((entry, index) => (
              <li
                key={entry.id}
                ref={index === entries.length - 1 ? end : undefined}
                className="timeline-item"
                data-kind={entry.kind}
                data-ok={entry.success === undefined ? undefined : String(entry.success)}
              >
                <span className="timeline-dot" aria-hidden="true" />
                <div className="timeline-body">
                  <p className="timeline-title">
                    {entry.title}
                    {entry.kind === 'tool' || entry.kind === 'tool_done' ? (
                      <span className="timeline-tool">{entry.detail}</span>
                    ) : null}
                  </p>
                  {entry.detail && entry.kind !== 'tool' && entry.kind !== 'tool_done' ? (
                    <p className="timeline-detail">{entry.detail}</p>
                  ) : null}
                </div>
                <time className="timeline-time" dateTime={new Date(entry.at).toISOString()}>
                  {formatClock(entry.at)}
                </time>
              </li>
            ))}
          </ol>
        )}
      </div>
    </section>
  )
}
