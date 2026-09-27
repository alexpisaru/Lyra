import type { View } from '../components/BottomNav'
import type { OrbFrame } from './orbScene'

/** Where the orb lives on each screen, from the viewport size in CSS pixels. */
export function orbFrame(view: View, width: number, height: number): OrbFrame {
  const minSide = Math.max(1, Math.min(width, height))
  const phone = width < 720
  const landscapePhone = height < 520 && width > height

  // A small living mark top-left on Brain/Activity, where the wordmark sat in the reference.
  const mark = (diameter: number): OrbFrame => {
    const r = diameter / 2
    return { size: diameter / minSide, x: -1 + (2 * (22 + r)) / width, y: 1 - (2 * (20 + r)) / height, presence: 0.9 }
  }

  switch (view) {
    case 'home':
      if (landscapePhone) return { size: 0.66, x: 0, y: 0.12, presence: 1 }
      return phone ? { size: 0.72, x: 0, y: 0.1, presence: 1 } : { size: 0.58, x: 0, y: 0.07, presence: 1 }
    case 'chat':
      if (landscapePhone) return { size: 0.3, x: -0.72, y: 0.3, presence: 0.9 }
      return phone ? { size: 0.44, x: 0, y: 0.64, presence: 0.95 } : { size: 0.3, x: 0, y: 0.54, presence: 0.95 }
    default:
      return mark(phone ? 40 : 46)
  }
}

/** Top (px) of the caption shown under the orb on Home. */
export function captionTop(frame: OrbFrame, width: number, height: number) {
  const minSide = Math.min(width, height)
  return height / 2 - (frame.y * height) / 2 + (frame.size * minSide) / 2 + 28
}
