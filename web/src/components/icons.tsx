import type { SVGProps } from 'react'

type IconProps = SVGProps<SVGSVGElement> & { size?: number }

function Icon({ size = 22, children, ...rest }: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.4}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {children}
    </svg>
  )
}

export const HomeIcon = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="7.5" />
    <path d="M6.2 14.2c2.4 1.4 8.8 1.2 11.6-1.2" opacity="0.55" />
  </Icon>
)

export const ChatIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M12 4.5c4.4 0 8 2.9 8 6.6s-3.6 6.6-8 6.6c-1 0-2-.1-2.9-.4L5 19l1.3-3.2C4.9 14.6 4 13 4 11.1 4 7.4 7.6 4.5 12 4.5Z" />
  </Icon>
)

export const BrainIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M12 6.5c-1.8-1.4-4.6-1.8-8-1.4v12.8c3.4-.4 6.2 0 8 1.4 1.8-1.4 4.6-1.8 8-1.4V5.1c-3.4-.4-6.2 0-8 1.4Z" />
    <path d="M12 6.5v12.8" />
  </Icon>
)

export const ActivityIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M3.5 12.5h3.6l2.3-6 3.4 12 2.6-8.2 1.3 2.2h3.8" />
  </Icon>
)

export const SendIcon = (p: IconProps) => (
  <Icon {...p} strokeWidth={1.8}>
    <path d="M5 19 19 5M10 5h9v9" />
  </Icon>
)

export const PlusIcon = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 8.5v7M8.5 12h7" />
  </Icon>
)

export const GlobeIcon = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M3.5 12h17M12 3.5c2.4 2.4 3.4 5.2 3.4 8.5s-1 6.1-3.4 8.5c-2.4-2.4-3.4-5.2-3.4-8.5s1-6.1 3.4-8.5Z" />
  </Icon>
)

export const ChipIcon = (p: IconProps) => (
  <Icon {...p}>
    <rect x="6.5" y="6.5" width="11" height="11" rx="2" />
    <path d="M9.5 3.5v3M14.5 3.5v3M9.5 17.5v3M14.5 17.5v3M3.5 9.5h3M3.5 14.5h3M17.5 9.5h3M17.5 14.5h3" />
  </Icon>
)

export const DatabaseIcon = (p: IconProps) => (
  <Icon {...p}>
    <ellipse cx="12" cy="6.5" rx="6.5" ry="2.5" />
    <path d="M5.5 6.5v11c0 1.4 2.9 2.5 6.5 2.5s6.5-1.1 6.5-2.5v-11M5.5 12c0 1.4 2.9 2.5 6.5 2.5s6.5-1.1 6.5-2.5" />
  </Icon>
)

export const LinkIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M4 12a8 8 0 0 1 16 0" />
    <path d="M7.5 12a4.5 4.5 0 0 1 9 0" />
    <circle cx="12" cy="12" r="1.2" />
  </Icon>
)

export const TagIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M4.5 12.5v-7a1 1 0 0 1 1-1h7l7 7-8 8-7-7Z" />
    <circle cx="8.5" cy="8.5" r="1.2" />
  </Icon>
)

export const SearchIcon = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="11" cy="11" r="6" />
    <path d="m20 20-4.6-4.6" />
  </Icon>
)

export const NoteIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M7 3.5h7l4 4v13H7a1 1 0 0 1-1-1v-15a1 1 0 0 1 1-1Z" />
    <path d="M14 3.5v4h4M9 12h6M9 15.5h6" />
  </Icon>
)

export const BackIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="m14.5 6-6 6 6 6" />
  </Icon>
)

export const ResetIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M5 12a7 7 0 1 0 2.1-5M5 4.5V9h4.5" />
  </Icon>
)
