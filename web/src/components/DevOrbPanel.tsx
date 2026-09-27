import './DevOrbPanel.css'
import { FUTURE_ORB_STATES, LIVE_ORB_STATES, type OrbPulse, type OrbState } from '../lib/orbState'

interface DevOrbPanelProps {
  forced: OrbState | null
  live: OrbState
  onForce: (state: OrbState | null) => void
  onPulse: (pulse: OrbPulse) => void
}

/**
 * Development-only orb inspector (never in production builds: App loads it
 * lazily behind import.meta.env.DEV). Forces a state or fires a one-shot event
 * to compare them visually; "live" returns control to the real /ws stream.
 */
export default function DevOrbPanel({ forced, live, onForce, onPulse }: DevOrbPanelProps) {
  return (
    <aside className="dev-orb" aria-label="Orb dev panel">
      <p>
        orb <b>{forced ?? live}</b> {forced ? '(forced)' : '(live)'}
      </p>
      <div>
        <button type="button" aria-pressed={forced === null} onClick={() => onForce(null)}>
          live
        </button>
        {LIVE_ORB_STATES.map((state) => (
          <button key={state} type="button" aria-pressed={forced === state} onClick={() => onForce(state)}>
            {state}
          </button>
        ))}
      </div>
      <div title="Preview only: the live runtime never produces voice states">
        {FUTURE_ORB_STATES.map((state) => (
          <button key={state} type="button" aria-pressed={forced === state} onClick={() => onForce(state)}>
            {state}
          </button>
        ))}
      </div>
      <div>
        {(['tool_started', 'tool_finished', 'response'] as const).map((pulse) => (
          <button key={pulse} type="button" onClick={() => onPulse(pulse)}>
            ⚡ {pulse}
          </button>
        ))}
      </div>
    </aside>
  )
}
