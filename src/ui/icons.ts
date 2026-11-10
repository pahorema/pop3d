const svg = (body: string, extra = "") =>
  `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" ${extra}>${body}</svg>`;

/** Line icons drawn on a 24px grid. */
export const icons = {
  search: svg('<circle cx="11" cy="11" r="6.5"/><path d="m16 16 4.5 4.5"/>'),
  close: svg('<path d="M6 6l12 12M18 6 6 18"/>'),
  locate: svg(
    '<circle cx="12" cy="12" r="3.2"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3"/><circle cx="12" cy="12" r="7"/>',
  ),
  area: svg(
    '<path d="M4 8V5.5A1.5 1.5 0 0 1 5.5 4H8M16 4h2.5A1.5 1.5 0 0 1 20 5.5V8M20 16v2.5a1.5 1.5 0 0 1-1.5 1.5H16M8 20H5.5A1.5 1.5 0 0 1 4 18.5V16"/><circle cx="12" cy="12" r="2.4"/>',
  ),
  style: svg(
    '<path d="M12 3.5a8.5 8.5 0 1 0 0 17c1.2 0 1.9-.9 1.9-1.9 0-.5-.2-.9-.5-1.3-.3-.3-.5-.8-.5-1.2 0-1 .8-1.8 1.8-1.8h2.1a3.7 3.7 0 0 0 3.7-3.7c0-3.9-3.8-7.1-8.5-7.1Z"/><circle cx="7.8" cy="11.5" r=".9" fill="currentColor"/><circle cx="10.4" cy="7.6" r=".9" fill="currentColor"/><circle cx="15" cy="7.8" r=".9" fill="currentColor"/>',
  ),
  layers: svg(
    '<path d="m12 3.5 8.5 4.6-8.5 4.6-8.5-4.6L12 3.5Z"/><path d="m3.5 12.4 8.5 4.6 8.5-4.6"/><path d="m3.5 16.4 8.5 4.6 8.5-4.6"/>',
  ),
  light: svg(
    '<circle cx="12" cy="12" r="3.8"/><path d="M12 2.8v2.4M12 18.8v2.4M2.8 12h2.4M18.8 12h2.4M5.5 5.5l1.7 1.7M16.8 16.8l1.7 1.7M5.5 18.5l1.7-1.7M16.8 7.2l1.7-1.7"/>',
  ),
  export: svg(
    '<path d="M12 3.5v11"/><path d="m7.5 10.5 4.5 4.5 4.5-4.5"/><path d="M4.5 16.5v2a1.5 1.5 0 0 0 1.5 1.5h12a1.5 1.5 0 0 0 1.5-1.5v-2"/>',
  ),
  plus: svg('<path d="M12 5.5v13M5.5 12h13"/>'),
  minus: svg('<path d="M5.5 12h13"/>'),
  home: svg('<path d="m4 11 8-6.5 8 6.5"/><path d="M6.5 9.5V19a.5.5 0 0 0 .5.5h10a.5.5 0 0 0 .5-.5V9.5"/>'),
  top: svg('<rect x="5" y="5" width="14" height="14" rx="2"/><path d="M5 12h14M12 5v14"/>'),
  rotate: svg('<path d="M20 12a8 8 0 1 1-2.6-5.9"/><path d="M20.3 3.8v4.4h-4.4"/>'),
  fullscreen: svg(
    '<path d="M4.5 9V5.5a1 1 0 0 1 1-1H9M15 4.5h3.5a1 1 0 0 1 1 1V9M19.5 15v3.5a1 1 0 0 1-1 1H15M9 19.5H5.5a1 1 0 0 1-1-1V15"/>',
  ),
  eye: svg(
    '<path d="M2.8 12s3.3-6.2 9.2-6.2 9.2 6.2 9.2 6.2-3.3 6.2-9.2 6.2S2.8 12 2.8 12Z"/><circle cx="12" cy="12" r="2.7"/>',
  ),
  eyeOff: svg(
    '<path d="M4 4l16 16"/><path d="M9.9 6.1A8.800000000000001 8.8 0 0 1 12 5.8c5.900000000000002 0 9.2 6.2 9.2 6.2a15 15 0 0 1-2.4 3.2M6.2 7.900000000000002A15.200000000000001 15.2 0 0 0 2.8 12s3.3 6.2 9.2 6.2c1.3 0 2.5-.3 3.6-.8"/><path d="M9.800000000000002 10.2a2.7 2.7 0 0 0 3.8000000000000003 3.8000000000000003"/>',
  ),
  solo: svg('<circle cx="12" cy="12" r="7.5"/><circle cx="12" cy="12" r="2.2" fill="currentColor"/>'),
  chevron: svg('<path d="m8 10 4 4 4-4"/>'),
  check: svg('<path d="m5.5 12.5 4.2 4.2 8.8-9.2"/>'),
  reset: svg('<path d="M4 12a8 8 0 1 0 2.6-5.9"/><path d="M3.7 3.8v4.4h4.400000000000001"/>'),
  image: svg(
    '<rect x="3.5" y="5" width="17" height="14" rx="2"/><circle cx="8.5" cy="10" r="1.6"/><path d="m4.5 17.5 5-4.5 3.5 3 2.5-2 4 3.5"/>',
  ),
  cube: svg(
    '<path d="m12 3.5 7.5 4.2v8.6L12 20.5l-7.5-4.2V7.7L12 3.5Z"/><path d="M4.5 7.7 12 12l7.5-4.3M12 12v8.5"/>',
  ),
  printer: svg(
    '<path d="M7 8.5v-4h10v4"/><rect x="3.5" y="8.5" width="17" height="8" rx="1.8"/><path d="M7 14h10v6H7z"/>',
  ),
  link: svg(
    '<path d="M10 14a4 4 0 0 0 5.700000000000001 0l3-3a4 4 0 0 0-5.700000000000001-5.700000000000001l-1 1"/><path d="M14 10a4 4 0 0 0-5.700000000000001 0l-3 3a4 4 0 0 0 5.700000000000001 5.700000000000001l1-1"/>',
  ),
  pin: svg(
    '<path d="M12 21s6.5-5.600000000000001 6.5-10.5a6.5 6.5 0 0 0-13 0C5.5 15.4 12 21 12 21Z"/><circle cx="12" cy="10.5" r="2.3"/>',
  ),
  building: svg(
    '<path d="M5 20.5V6.5l7-3v17M12 9.5l7 2.5v8.5M3.5 20.5h17"/><path d="M8 9v.01M8 12.5v.01M8 16v.01M15.5 14.5v.01M15.5 17.5v.01"/>',
  ),
  globe: svg(
    '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.5 2.6 3.5 5.400000000000001 3.5 8.5s-1 5.900000000000002-3.5 8.5c-2.5-2.6-3.5-5.400000000000001-3.5-8.5s1-5.900000000000002 3.5-8.5Z"/>',
  ),
  hide: svg('<path d="M4 7.5h16M4 12h10M4 16.5h6"/>'),
  expand: svg('<path d="M14 4.5h5.5V10M19.5 4.5 13 11M10 19.5H4.5V14M4.5 19.5 11 13"/>'),
  shapeCircle: svg('<circle cx="12" cy="12" r="7.5"/>'),
  shapeSquare: svg('<rect x="5" y="5" width="14" height="14" rx="1"/>'),
  shapeRounded: svg('<rect x="4.5" y="4.5" width="15" height="15" rx="5"/>'),
  shapeHexagon: svg('<path d="M7.5 4.5h9l4.5 7.5-4.5 7.5h-9L3 12l4.5-7.5Z"/>'),
} as const;

export type IconName = keyof typeof icons;

/** The pop3d mark: a little isometric block. */
export const logoMark = `<svg viewBox="0 0 32 32" width="26" height="26" aria-hidden="true"><path d="M16 3.2 27 9.4v13.2L16 28.8 5 22.6V9.400000000000002L16 3.2Z" fill="var(--mark-side)"/><path d="M16 3.2 27 9.4 16 15.6 5 9.400000000000002 16 3.2Z" fill="var(--mark-top)"/><path d="M16 15.6V28.8L5 22.6V9.400000000000002L16 15.6Z" fill="var(--mark-left)"/><path d="M16 9.200000000000001l5.5 3.1v6.2L16 21.6V9.200000000000001Z" fill="var(--mark-top)" opacity=".0"/></svg>`;
