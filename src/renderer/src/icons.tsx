interface IconProps {
  size?: number
}

function base(size: number | undefined): {
  width: number
  height: number
  viewBox: string
  fill: string
  stroke: string
  strokeWidth: number
  strokeLinecap: 'round'
  strokeLinejoin: 'round'
} {
  return {
    width: size ?? 17,
    height: size ?? 17,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 2,
    strokeLinecap: 'round',
    strokeLinejoin: 'round'
  }
}

export const IconGrid = ({ size }: IconProps): React.JSX.Element => (
  <svg {...base(size)}>
    <rect x="3" y="3" width="7" height="7" rx="1.5" />
    <rect x="14" y="3" width="7" height="7" rx="1.5" />
    <rect x="3" y="14" width="7" height="7" rx="1.5" />
    <rect x="14" y="14" width="7" height="7" rx="1.5" />
  </svg>
)

export const IconBox = ({ size }: IconProps): React.JSX.Element => (
  <svg {...base(size)}>
    <path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z" />
    <path d="m3.3 7 8.7 5 8.7-5" />
    <path d="M12 22V12" />
  </svg>
)

export const IconSettings = ({ size }: IconProps): React.JSX.Element => (
  <svg {...base(size)}>
    <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
    <circle cx="12" cy="12" r="3" />
  </svg>
)

export const IconImport = ({ size }: IconProps): React.JSX.Element => (
  <svg {...base(size)}>
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
    <path d="m7 10 5 5 5-5" />
    <path d="M12 15V3" />
  </svg>
)

export const IconPlus = ({ size }: IconProps): React.JSX.Element => (
  <svg {...base(size)}>
    <path d="M5 12h14" />
    <path d="M12 5v14" />
  </svg>
)

export const IconPlay = ({ size }: IconProps): React.JSX.Element => (
  <svg {...base(size)} fill="currentColor" stroke="none">
    <path d="M8 5.5a1 1 0 0 1 1.5-.87l11 6.5a1 1 0 0 1 0 1.74l-11 6.5A1 1 0 0 1 8 18.5Z" transform="translate(-2 0)" />
  </svg>
)

export const IconStop = ({ size }: IconProps): React.JSX.Element => (
  <svg {...base(size)} fill="currentColor" stroke="none">
    <rect x="6" y="6" width="12" height="12" rx="2" />
  </svg>
)

export const IconFolder = ({ size }: IconProps): React.JSX.Element => (
  <svg {...base(size)}>
    <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
  </svg>
)

export const IconCopy = ({ size }: IconProps): React.JSX.Element => (
  <svg {...base(size)}>
    <rect width="14" height="14" x="8" y="8" rx="2" />
    <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
  </svg>
)

export const IconTrash = ({ size }: IconProps): React.JSX.Element => (
  <svg {...base(size)}>
    <path d="M3 6h18" />
    <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
    <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
  </svg>
)

export const IconExport = ({ size }: IconProps): React.JSX.Element => (
  <svg {...base(size)}>
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
    <path d="m17 8-5-5-5 5" />
    <path d="M12 3v12" />
  </svg>
)

export const IconExternal = ({ size }: IconProps): React.JSX.Element => (
  <svg {...base(size)}>
    <path d="M15 3h6v6" />
    <path d="M10 14 21 3" />
    <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
  </svg>
)

export const IconSearch = ({ size }: IconProps): React.JSX.Element => (
  <svg {...base(size)}>
    <circle cx="11" cy="11" r="8" />
    <path d="m21 21-4.3-4.3" />
  </svg>
)

export const IconRefresh = ({ size }: IconProps): React.JSX.Element => (
  <svg {...base(size)}>
    <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
    <path d="M21 3v5h-5" />
    <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
    <path d="M3 21v-5h5" />
  </svg>
)

export const IconX = ({ size }: IconProps): React.JSX.Element => (
  <svg {...base(size)}>
    <path d="M18 6 6 18" />
    <path d="m6 6 12 12" />
  </svg>
)

export const IconChevronDown = ({ size }: IconProps): React.JSX.Element => (
  <svg {...base(size)}>
    <path d="m6 9 6 6 6-6" />
  </svg>
)

export const IconCheck = ({ size }: IconProps): React.JSX.Element => (
  <svg {...base(size)}>
    <path d="M20 6 9 17l-5-5" />
  </svg>
)

export const IconAlert = ({ size }: IconProps): React.JSX.Element => (
  <svg {...base(size)}>
    <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" />
    <path d="M12 9v4" />
    <path d="M12 17h.01" />
  </svg>
)

export const IconDots = ({ size }: IconProps): React.JSX.Element => (
  <svg {...base(size)} fill="currentColor" stroke="none">
    <circle cx="12" cy="5" r="2" />
    <circle cx="12" cy="12" r="2" />
    <circle cx="12" cy="19" r="2" />
  </svg>
)

export const IconLogout = ({ size }: IconProps): React.JSX.Element => (
  <svg {...base(size)}>
    <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
    <path d="m16 17 5-5-5-5" />
    <path d="M21 12H9" />
  </svg>
)

export const IconShield = ({ size }: IconProps): React.JSX.Element => (
  <svg {...base(size)}>
    <path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" />
  </svg>
)

export const IconCloud = ({ size }: IconProps): React.JSX.Element => (
  <svg {...base(size)}>
    <path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z" />
  </svg>
)

export const IconLink = ({ size }: IconProps): React.JSX.Element => (
  <svg {...base(size)}>
    <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
    <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
  </svg>
)

export const IconDownload = ({ size }: IconProps): React.JSX.Element => (
  <svg {...base(size)}>
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
    <path d="m7 10 5 5 5-5" />
    <path d="M12 15V3" />
  </svg>
)

export const IconHome = ({ size }: IconProps): React.JSX.Element => (
  <svg {...base(size)}>
    <path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    <path d="M9 22V12h6v10" />
  </svg>
)

export const IconUser = ({ size }: IconProps): React.JSX.Element => (
  <svg {...base(size)}>
    <path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2" />
    <circle cx="12" cy="7" r="4" />
  </svg>
)

export const IconClock = ({ size }: IconProps): React.JSX.Element => (
  <svg {...base(size)}>
    <circle cx="12" cy="12" r="10" />
    <path d="M12 6v6l4 2" />
  </svg>
)

export const IconImage = ({ size }: IconProps): React.JSX.Element => (
  <svg {...base(size)}>
    <rect x="3" y="3" width="18" height="18" rx="2" />
    <circle cx="9" cy="9" r="2" />
    <path d="m21 15-3.09-3.09a2 2 0 0 0-2.82 0L6 21" />
  </svg>
)

export const IconGlobe = ({ size }: IconProps): React.JSX.Element => (
  <svg {...base(size)}>
    <circle cx="12" cy="12" r="10" />
    <path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20" />
    <path d="M2 12h20" />
  </svg>
)

export const IconServer = ({ size }: IconProps): React.JSX.Element => (
  <svg {...base(size)}>
    <rect x="2" y="3" width="20" height="8" rx="2" />
    <rect x="2" y="13" width="20" height="8" rx="2" />
    <path d="M6 7h.01" />
    <path d="M6 17h.01" />
  </svg>
)

export const IconSliders = ({ size }: IconProps): React.JSX.Element => (
  <svg {...base(size)}>
    <path d="M4 21v-7" />
    <path d="M4 10V3" />
    <path d="M12 21v-9" />
    <path d="M12 8V3" />
    <path d="M20 21v-5" />
    <path d="M20 12V3" />
    <path d="M2 14h4" />
    <path d="M10 8h4" />
    <path d="M18 16h4" />
  </svg>
)

export const IconLayers = ({ size }: IconProps): React.JSX.Element => (
  <svg {...base(size)}>
    <path d="m12 2 8.5 4.5-8.5 4.5L3.5 6.5Z" />
    <path d="m3.5 12 8.5 4.5 8.5-4.5" />
    <path d="m3.5 17 8.5 4.5 8.5-4.5" />
  </svg>
)

export const IconSparkles = ({ size }: IconProps): React.JSX.Element => (
  <svg {...base(size)}>
    <path d="m12 3-1.9 5.8a2 2 0 0 1-1.3 1.3L3 12l5.8 1.9a2 2 0 0 1 1.3 1.3L12 21l1.9-5.8a2 2 0 0 1 1.3-1.3L21 12l-5.8-1.9a2 2 0 0 1-1.3-1.3Z" />
    <path d="M5 3v4" />
    <path d="M19 17v4" />
    <path d="M3 5h4" />
    <path d="M17 19h4" />
  </svg>
)

export const IconVolume = ({ size }: IconProps): React.JSX.Element => (
  <svg {...base(size)}>
    <path d="M11 5 6 9H2v6h4l5 4z" />
    <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
    <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
  </svg>
)

export const IconMonitor = ({ size }: IconProps): React.JSX.Element => (
  <svg {...base(size)}>
    <rect x="2" y="3" width="20" height="14" rx="2" />
    <path d="M8 21h8" />
    <path d="M12 17v4" />
  </svg>
)

export const IconEdit = ({ size }: IconProps): React.JSX.Element => (
  <svg {...base(size)}>
    <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
    <path d="m15 5 4 4" />
  </svg>
)

export const IconArrowUp = ({ size }: IconProps): React.JSX.Element => (
  <svg {...base(size)}>
    <path d="m5 12 7-7 7 7" />
    <path d="M12 19V5" />
  </svg>
)

export const IconArrowDown = ({ size }: IconProps): React.JSX.Element => (
  <svg {...base(size)}>
    <path d="M12 5v14" />
    <path d="m19 12-7 7-7-7" />
  </svg>
)

export const IconNews = ({ size }: IconProps): React.JSX.Element => (
  <svg {...base(size)}>
    <path d="M4 22h16a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2H8a2 2 0 0 0-2 2v16a2 2 0 0 1-2 2Zm0 0a2 2 0 0 1-2-2v-9c0-1.1.9-2 2-2h2" />
    <path d="M18 14h-8" />
    <path d="M15 18h-5" />
    <path d="M10 6h8v4h-8V6Z" />
  </svg>
)

export const IconArchive = ({ size }: IconProps): React.JSX.Element => (
  <svg {...base(size)}>
    <rect x="2" y="3" width="20" height="5" rx="1" />
    <path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8" />
    <path d="M10 12h4" />
  </svg>
)

export const IconUpload = ({ size }: IconProps): React.JSX.Element => (
  <svg {...base(size)}>
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
    <path d="m17 8-5-5-5 5" />
    <path d="M12 3v12" />
  </svg>
)

export const IconSwords = ({ size }: IconProps): React.JSX.Element => (
  <svg {...base(size)}>
    <path d="M14.5 17.5 3 6V3h3l11.5 11.5" />
    <path d="M13 19l6-6" />
    <path d="M16 16l4 4" />
    <path d="M19 21l2-2" />
  </svg>
)

export const IconZap = ({ size }: IconProps): React.JSX.Element => (
  <svg {...base(size)} fill="currentColor" stroke="none">
    <path d="M13 2 4.1 12.7a.8.8 0 0 0 .6 1.3H11l-1 8 8.9-10.7a.8.8 0 0 0-.6-1.3H12z" />
  </svg>
)

export const IconGauge = ({ size }: IconProps): React.JSX.Element => (
  <svg {...base(size)}>
    <path d="M12 14 8.5 9.5" />
    <circle cx="12" cy="14" r="1.5" fill="currentColor" stroke="none" />
    <path d="M3.5 18a10 10 0 1 1 17 0" />
  </svg>
)

export const IconRocket = ({ size }: IconProps): React.JSX.Element => (
  <svg {...base(size)}>
    <path d="M4.5 16.5c-1.5 1.3-2 5-2 5s3.7-.5 5-2c.7-.8.7-2 0-2.8a2 2 0 0 0-3 0z" />
    <path d="M12 15 9 12a11 11 0 0 1 6-9c3.5 0 5 1.5 5 5a11 11 0 0 1-9 6z" />
    <path d="M15 9a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z" />
  </svg>
)

export const IconSun = ({ size }: IconProps): React.JSX.Element => (
  <svg {...base(size)}>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
  </svg>
)

export const IconMoon = ({ size }: IconProps): React.JSX.Element => (
  <svg {...base(size)}>
    <path d="M12 3a6.5 6.5 0 0 0 9 9 9 9 0 1 1-9-9z" />
  </svg>
)

export const IconWifi = ({ size }: IconProps): React.JSX.Element => (
  <svg {...base(size)}>
    <path d="M5 12.55a11 11 0 0 1 14 0" />
    <path d="M1.42 9a16 16 0 0 1 21.16 0" />
    <path d="M8.53 16.11a6 6 0 0 1 6.95 0" />
    <path d="M12 20h.01" />
  </svg>
)

export const IconUsers = ({ size }: IconProps): React.JSX.Element => (
  <svg {...base(size)}>
    <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
    <circle cx="9" cy="7" r="4" />
    <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
    <path d="M16 3.13a4 4 0 0 1 0 7.75" />
  </svg>
)
