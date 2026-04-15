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
  }
}
