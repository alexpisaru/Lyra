import type { View } from '../components/BottomNav'
import type { OrbFrame } from './orbScene'

/**
 * Where the orb lives on each screen, from the hero size in CSS pixels
 * (the orb canvas fills the hero frame, not the window). Proportions follow
 * the reference: Home orb large and slightly above centre; Chat orb medium
 * in the upper part; a small living mark on Brain/Activity.
 */
export function orbFrame(view: View, width: number, height: number): OrbFrame {
  const minSide = Math.max(1, Math.min(width, height))
  const phone = width < 720
  const landscapePhone = height < 520 && width > height

  const mark = (diameter: number): OrbFrame => {
    const r = diameter / 2
    return { size: diameter / minSide, x: -1 + (2 * (22 + r)) / width, y: 1 - (2 * (20 + r)) / height, presence: 0.9 }
  }

  switch (view) {
    case 'home':
      if (landscapePhone) return { size: 0.62, x: 0, y: 0.14, presence: 1 }
      return phone ? { size: 0.74, x: 0, y: 0.12, presence: 1 } : { size: 0.5, x: 0, y: 0.22, presence: 1 }
    case 'chat':
      if (landscapePhone) return { size: 0.36, x: -0.7, y: 0.25, presence: 1 }
      return phone ? { size: 0.52, x: 0, y: 0.6, presence: 1 } : { size: 0.4, x: 0, y: 0.5, presence: 1 }
    default:
      return mark(phone ? 40 : 46)
  }
}

/** Top (px) of the caption shown under the orb on Home. */
export function captionTop(frame: OrbFrame, width: number, height: number) {
  const minSide = Math.min(width, height)
  return height / 2 - (frame.y * height) / 2 + (frame.size * minSide) / 2 + 40
}
