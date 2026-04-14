/** Visual themes — IDs must match [data-theme] in globals.css and server auth PATCH allow-list. */
export const THEMES = [
  { id: 'midnight', label: 'Midnight', hint: 'Default deep slate' },
  { id: 'ocean', label: 'Ocean', hint: 'Teal & cyan' },
  { id: 'forest', label: 'Forest', hint: 'Emerald dark' },
  { id: 'dawn', label: 'Dawn', hint: 'Warm violet' },
  { id: 'paper', label: 'Paper', hint: 'Light cool gray' },
  { id: 'sand', label: 'Sand', hint: 'Warm light sepia' },
  { id: 'ember', label: 'Ember', hint: 'Rose & coral heat' },
  { id: 'arctic', label: 'Arctic', hint: 'Ice blue steel' },
  { id: 'rose', label: 'Rose', hint: 'Pink magenta dark' },
  { id: 'slate', label: 'Slate', hint: 'Neutral steel NOC' },
  { id: 'nebula', label: 'Nebula', hint: 'Indigo & violet space' },
  { id: 'mono', label: 'Mono', hint: 'High-contrast grayscale' },
  { id: 'ruby', label: 'Ruby', hint: 'Deep crimson accent' },
]

export const THEME_IDS = THEMES.map((t) => t.id)

export const DEFAULT_THEME = 'midnight'
