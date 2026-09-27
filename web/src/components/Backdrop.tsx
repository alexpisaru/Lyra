/**
 * Static nebula of the reference: soft luminous blue waves and faint streaks
 * behind the orb. Drawn once (SVG + blur), no animation cost.
 */
export function Backdrop() {
  return (
    <div className="backdrop" aria-hidden="true">
      <svg className="backdrop-waves" viewBox="0 0 1200 700" preserveAspectRatio="xMidYMid slice">
        <defs>
          <filter id="lyra-blur-lg" filterUnits="userSpaceOnUse" x="-300" y="-300" width="1800" height="1300">
            <feGaussianBlur stdDeviation="28" />
          </filter>
          <filter id="lyra-blur-sm" filterUnits="userSpaceOnUse" x="-300" y="-300" width="1800" height="1300">
            <feGaussianBlur stdDeviation="3" />
          </filter>
          <linearGradient id="lyra-wave" x1="0" x2="1" y1="0" y2="0">
            <stop offset="0" stopColor="#1b5cff" stopOpacity="0" />
            <stop offset="0.35" stopColor="#2a6dff" stopOpacity="0.55" />
            <stop offset="0.7" stopColor="#1f58e8" stopOpacity="0.35" />
            <stop offset="1" stopColor="#1b5cff" stopOpacity="0" />
          </linearGradient>
        </defs>
        <g filter="url(#lyra-blur-lg)" opacity="0.55">
          <path d="M-60 560 C 200 470, 380 600, 620 540 S 1000 450, 1260 520" stroke="url(#lyra-wave)" strokeWidth="70" fill="none" />
          <path d="M-60 640 C 260 590, 520 690, 780 630 S 1100 570, 1260 610" stroke="url(#lyra-wave)" strokeWidth="46" fill="none" opacity="0.7" />
          <path d="M-60 250 C 180 300, 300 200, 520 260" stroke="url(#lyra-wave)" strokeWidth="40" fill="none" opacity="0.35" />
          <path d="M760 300 C 900 240, 1050 330, 1260 270" stroke="url(#lyra-wave)" strokeWidth="44" fill="none" opacity="0.35" />
        </g>
        <g filter="url(#lyra-blur-sm)" opacity="0.5">
          <path d="M-40 585 C 220 505, 400 625, 640 560 S 1010 470, 1240 540" stroke="#3f82ff" strokeWidth="1.6" fill="none" opacity="0.6" />
          <path d="M-40 620 C 240 560, 520 660, 790 610 S 1090 560, 1240 590" stroke="#3d78ff" strokeWidth="1.2" fill="none" opacity="0.45" />
          <path d="M60 470 C 260 430, 420 500, 560 470" stroke="#5a8dff" strokeWidth="1" fill="none" opacity="0.35" />
        </g>
      </svg>
    </div>
  )
}
