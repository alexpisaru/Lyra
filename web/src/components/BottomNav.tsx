import type { ComponentType } from 'react'
import { ActivityIcon, BrainIcon, ChatIcon, HomeIcon } from './icons'

export type View = 'home' | 'chat' | 'brain' | 'activity'

const ITEMS: { view: View; label: string; Icon: ComponentType<{ size?: number }> }[] = [
  { view: 'home', label: 'Home', Icon: HomeIcon },
  { view: 'chat', label: 'Chat', Icon: ChatIcon },
  { view: 'brain', label: 'Brain', Icon: BrainIcon },
  { view: 'activity', label: 'Activity', Icon: ActivityIcon },
]

interface BottomNavProps {
  view: View
  onChange: (view: View) => void
  activityBadge?: boolean
}

export function BottomNav({ view, onChange, activityBadge }: BottomNavProps) {
  return (
    <nav className="nav" aria-label="Navigazione principale">
      <div className="nav-inner">
        {ITEMS.map(({ view: item, label, Icon }) => (
          <button
            key={item}
            type="button"
            className="nav-item"
            aria-label={label}
            aria-current={view === item ? 'page' : undefined}
            onClick={() => onChange(item)}
          >
            <span className="nav-icon">
              <Icon size={22} />
              {item === 'activity' && activityBadge && view !== 'activity' ? <span className="nav-badge" /> : null}
            </span>
            <span className="nav-label" aria-hidden="true">
              {label}
            </span>
          </button>
        ))}
      </div>
    </nav>
  )
}
