/**
 * Resolved CSS variable values for contexts that cannot use var() (e.g. Chart.js canvas).
 * Call after mount / when theme changes (subscribe to theme store).
 */
export function getThemeCssColors() {
  if (typeof document === 'undefined') {
    return {
      text: '#e8eaf2',
      text2: '#8b90aa',
      text3: '#555a72',
      bg2: '#0f1117',
      accent: '#4f7ef5',
      accent2: '#7c5cfc',
      green: '#22d3a0',
      red: '#f5534f',
      amber: '#f5a623',
      cyan: '#22d3ee',
      border: '#2a3142',
    }
  }
  const s = getComputedStyle(document.documentElement)
  const g = (k, fallback) => {
    const v = s.getPropertyValue(k).trim()
    return v || fallback
  }
  return {
    text: g('--text', '#e8eaf2'),
    text2: g('--text2', '#8b90aa'),
    text3: g('--text3', '#555a72'),
    bg2: g('--bg2', '#0f1117'),
    accent: g('--accent', '#4f7ef5'),
    accent2: g('--accent2', '#7c5cfc'),
    green: g('--green', '#22d3a0'),
    red: g('--red', '#f5534f'),
    amber: g('--amber', '#f5a623'),
    cyan: g('--cyan', '#22d3ee'),
    border: g('--border', '#2a3142'),
  }
}

/** Append alpha to #hex or rgb() for Chart.js canvas (cannot use var()). */
export function colorWithAlpha(color, alpha) {
  const c = String(color || '').trim()
  if (!c) return `rgba(128, 128, 128, ${alpha})`
  if (c.startsWith('rgba')) return c
  if (c.startsWith('rgb(')) {
    const inner = c.slice(4, -1)
    return `rgba(${inner}, ${alpha})`
  }
  let h = c.startsWith('#') ? c.slice(1) : c
  if (h.length === 3) h = [...h].map((ch) => ch + ch).join('')
  if (h.length !== 6) return c
  const n = parseInt(h, 16)
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`
}

/** Theme-safe funnel ring colors (resolved hex/rgba for canvas). */
export function getFunnelStageColors(tc) {
  const track = colorWithAlpha(tc.text3, 0.38)
  const trackMuted = colorWithAlpha(tc.text3, 0.22)
  return {
    sent: { fill: tc.accent, track, trackMuted },
    opened: { fill: tc.amber, track, trackMuted },
    clicked: { fill: tc.accent2, track, trackMuted },
    landing: { fill: tc.cyan || tc.accent2, track, trackMuted },
    submitted: { fill: tc.red, track, trackMuted },
  }
}

/**
 * Donut data with a visible full ring at 0% and clean arc at partial values.
 */
export function buildFunnelDonutDataset(pct, fill, track) {
  const p = Math.min(100, Math.max(0, Number(pct) || 0))
  if (p <= 0) {
    return {
      datasets: [
        {
          data: [100],
          backgroundColor: [track],
          borderWidth: 0,
          borderRadius: 0,
        },
      ],
    }
  }
  if (p >= 100) {
    return {
      datasets: [
        {
          data: [100],
          backgroundColor: [fill],
          borderWidth: 0,
          borderRadius: 0,
        },
      ],
    }
  }
  return {
    datasets: [
      {
        data: [p, 100 - p],
        backgroundColor: [fill, track],
        borderWidth: 0,
        borderRadius: 10,
        spacing: 1,
      },
    ],
  }
}
