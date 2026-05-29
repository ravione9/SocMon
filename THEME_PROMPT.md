# Theme Spec — "NOC/SOC Console"

> Paste this entire document as a prompt into an AI coding assistant when you
> want to recreate this project's visual theme in another codebase.
> Source: extracted from `client/tailwind.config.js`, `client/src/styles/globals.css`,
> `client/src/components/layout/*`, `client/src/pages/Login/LoginPage.jsx`,
> and `client/src/constants/themes.js`.

---

You are setting up the visual design system for this project. Match the spec
below exactly. Treat it as the source of truth for colors, typography, layout
density, components, and theming behavior. Do NOT invent new colors, sizes, or
component variants unless explicitly extending what's here.

## 1. Brand & Mood
- Dark-first, **enterprise NOC/SOC / monitoring console** vibe.
- Information-dense, slightly "terminal/Bloomberg" feeling, but modern and clean.
- Mono font is used aggressively for labels, badges, timestamps, KPI sub-text,
  table headers, and uppercase metadata. Sans font is used for body, buttons,
  KPI values, and titles.
- Subtle gradients only on the brand logo tile and primary CTA-adjacent
  accents. No heavy shadows, no neumorphism, no glassmorphism.

## 2. Theming System (CSS variables + `[data-theme="..."]`)
Use a CSS-variables-based theme system on the `<html>` element. The default
theme is `midnight`. Every UI surface must read from these tokens — never
hardcode hex values in components.

Required tokens (each theme defines all of these):

```
--bg --bg2 --bg3 --bg4
--border --border2
--accent --accent2
--green --red --amber --cyan
--text --text2 --text3
--mono --sans
--on-accent       (text color on filled accent buttons; default #fff)
--on-cyan         (#0a1620; text on bright cyan chips)
--placeholder     (only set on light themes)
```

Ship these themes (IDs must match `[data-theme="<id>"]`):
`midnight` (default), `ocean`, `forest`, `dawn`, `paper` (light),
`sand` (light), `ember`, `arctic`, `rose`, `slate`, `nebula`, `mono`, `ruby`.

Exact palette for the default `midnight` theme (and `:root`):

```css
--bg:#0a0c10; --bg2:#0f1117; --bg3:#151821; --bg4:#1c2030;
--border:rgba(99,120,200,0.18); --border2:rgba(99,120,200,0.32);
--accent:#4f7ef5; --accent2:#7c5cfc;
--green:#22d3a0; --red:#f5534f; --amber:#f5a623; --cyan:#22d3ee;
--text:#e8eaf2; --text2:#8b90aa; --text3:#555a72;
--mono:"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
--sans:"Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto,
       "Helvetica Neue", Arial, sans-serif;
```

Other themes follow the same token shape; if the user picks one, the entire UI
recolors with zero component changes. Light themes (`paper`, `sand`) must set
`color-scheme: light;` and a `--placeholder` color; dark themes inherit
`color-scheme: dark` via `html:not([data-theme="paper"]):not([data-theme="sand"])`.

### Full palette for every theme

```css
[data-theme="ocean"] {
  --bg:#061016; --bg2:#0a1820; --bg3:#0f2430; --bg4:#153040;
  --border:rgba(34,211,238,0.16); --border2:rgba(34,211,238,0.28);
  --accent:#22d3ee; --accent2:#06b6d4;
  --green:#2dd4bf; --red:#fb7185; --amber:#fbbf24; --cyan:#67e8f9;
  --text:#e0f2fe; --text2:#7dd3fc; --text3:#4a6f82;
  --on-accent:#041a20;
}
[data-theme="forest"] {
  --bg:#07110c; --bg2:#0c1812; --bg3:#12241c; --bg4:#183228;
  --border:rgba(52,211,153,0.18); --border2:rgba(52,211,153,0.3);
  --accent:#34d399; --accent2:#10b981;
  --green:#4ade80; --red:#f87171; --amber:#facc15; --cyan:#2dd4bf;
  --text:#ecfdf5; --text2:#86efac; --text3:#4d6b5c;
}
[data-theme="dawn"] {
  --bg:#100a14; --bg2:#180f1f; --bg3:#22162c; --bg4:#2d1f3a;
  --border:rgba(192,132,252,0.2); --border2:rgba(192,132,252,0.35);
  --accent:#c084fc; --accent2:#e879f9;
  --green:#4ade80; --red:#fb7185; --amber:#fcd34d; --cyan:#67e8f9;
  --text:#f5e8ff; --text2:#c4b5fd; --text3:#6b5f7a;
}
[data-theme="paper"] {
  color-scheme: light;
  --bg:#eef1f6; --bg2:#ffffff; --bg3:#ffffff; --bg4:#f1f5f9;
  --border:rgba(15,23,42,0.14); --border2:rgba(15,23,42,0.22);
  --accent:#2563eb; --accent2:#7c3aed;
  --green:#059669; --red:#dc2626; --amber:#d97706; --cyan:#0891b2;
  --text:#0a0a0a; --text2:#1e293b; --text3:#475569;
  --placeholder:#64748b; --on-accent:#ffffff; --on-cyan:#0a1620;
}
[data-theme="ember"] {
  --bg:#10090a; --bg2:#1a0f0e; --bg3:#241612; --bg4:#301c18;
  --border:rgba(251,113,133,0.14); --border2:rgba(251,113,133,0.28);
  --accent:#fb7185; --accent2:#f97316;
  --green:#4ade80; --red:#f87171; --amber:#fcd34d; --cyan:#fdba74;
  --text:#fff1f2; --text2:#fda4af; --text3:#8b5a5c;
}
[data-theme="arctic"] {
  --bg:#070b12; --bg2:#0c121c; --bg3:#121a28; --bg4:#1a2436;
  --border:rgba(147,197,253,0.14); --border2:rgba(147,197,253,0.26);
  --accent:#93c5fd; --accent2:#60a5fa;
  --green:#6ee7b7; --red:#fca5a5; --amber:#fde68a; --cyan:#a5f3fc;
  --text:#eff6ff; --text2:#93c5fd; --text3:#4b5e78;
  --on-accent:#070b12;
}
[data-theme="rose"] {
  --bg:#0f0a10; --bg2:#181018; --bg3:#221620; --bg4:#2d1d2a;
  --border:rgba(244,114,182,0.16); --border2:rgba(244,114,182,0.3);
  --accent:#f472b6; --accent2:#e879f9;
  --green:#86efac; --red:#fb7185; --amber:#fcd34d; --cyan:#f9a8d4;
  --text:#fdf2f8; --text2:#f9a8d4; --text3:#6b5a66;
}
[data-theme="slate"] {
  --bg:#0c0e12; --bg2:#13161c; --bg3:#1a1f28; --bg4:#232934;
  --border:rgba(148,163,184,0.16); --border2:rgba(148,163,184,0.28);
  --accent:#94a3b8; --accent2:#cbd5e1;
  --green:#86efac; --red:#f87171; --amber:#fcd34d; --cyan:#7dd3fc;
  --text:#f1f5f9; --text2:#94a3b8; --text3:#5c6570;
  --on-accent:#0c0e12;
}
[data-theme="nebula"] {
  --bg:#080616; --bg2:#100c22; --bg3:#18122e; --bg4:#221a3c;
  --border:rgba(129,140,248,0.18); --border2:rgba(167,139,250,0.32);
  --accent:#818cf8; --accent2:#a78bfa;
  --green:#5eead4; --red:#fb7185; --amber:#fde047; --cyan:#67e8f9;
  --text:#eef2ff; --text2:#a5b4fc; --text3:#5c5f7a;
}
[data-theme="mono"] {
  --bg:#090909; --bg2:#121212; --bg3:#1a1a1a; --bg4:#242424;
  --border:rgba(255,255,255,0.08); --border2:rgba(255,255,255,0.14);
  --accent:#e5e5e5; --accent2:#a3a3a3;
  --green:#a3e635; --red:#f87171; --amber:#fbbf24; --cyan:#d4d4d4;
  --text:#fafafa; --text2:#a3a3a3; --text3:#525252;
  --on-accent:#0a0a0a;
}
[data-theme="sand"] {
  color-scheme: light;
  --bg:#f5f0e8; --bg2:#fffcf7; --bg3:#ffffff; --bg4:#f0ebe3;
  --border:rgba(68,48,30,0.14); --border2:rgba(68,48,30,0.24);
  --accent:#b45309; --accent2:#92400e;
  --green:#15803d; --red:#b91c1c; --amber:#ca8a04; --cyan:#0e7490;
  --text:#0a0a0a; --text2:#1c1917; --text3:#44403c;
  --placeholder:#64748b; --on-accent:#ffffff; --on-cyan:#0a1620;
}
[data-theme="ruby"] {
  --bg:#0a0608; --bg2:#140a0e; --bg3:#1e0f16; --bg4:#2a1420;
  --border:rgba(225,29,72,0.18); --border2:rgba(244,63,94,0.32);
  --accent:#f43f5e; --accent2:#e11d48;
  --green:#4ade80; --red:#fb7185; --amber:#fbbf24; --cyan:#fda4af;
  --text:#fff1f2; --text2:#fda4af; --text3:#7a4a56;
}
```

## 3. Typography
- Load Inter (400–800) and JetBrains Mono (400–600) from Google Fonts in
  `index.html` via `<link rel="preconnect">` + a single stylesheet `<link>`.
- Body: `font-family: var(--sans); font-size: 14px; line-height: 1.45;`
- Enable: `font-feature-settings:"cv11","ss01","ss03","kern","calt";
  font-variant-ligatures: common-ligatures; text-rendering: optimizeLegibility;
  -webkit-font-smoothing: antialiased;`
- Use `var(--mono)` for: KPI labels, badges, timestamps, ID/tech values,
  field labels (uppercase, letterSpacing 1, fontSize 10–11), table column
  headers, sidebar logo monogram, login form field labels.

## 4. Global Layout & Density
- Apply `zoom: var(--app-zoom)` with `--app-zoom: 0.9` on `<html>` so dense
  pages fit a 1080p window. Define `--app-vh: calc(100vh / 0.9)` and use
  `min-height: var(--app-vh)` on `body`. App shells size against
  `var(--app-vh, 100vh)` instead of `100vh`.
- App shell: 64px-wide left **icon-only sidebar** + top **Topbar** + a
  scrollable `<main>` content area. Sidebar `background: var(--bg2)`,
  right border `1px solid var(--border)`. Main padding `16px 20px`.

## 5. Sidebar (icon rail)
- Width 64px, vertical stack, gap 4px.
- Top: 36×36 brand tile, `border-radius: 9px`,
  `background: linear-gradient(135deg, var(--accent), var(--accent2))`,
  mono 14px/800, color `var(--on-accent)`. Holds 2-letter monogram.
- Nav items: 44×44, `border-radius: 10px`, 18px icon (emoji is fine for v1).
  Active state: `background: var(--bg4)` + `1px solid var(--border2)`.
  Hover: subtle bg lift, no scale.
- Logout button at bottom (pushed via `flex:1` spacer).

## 6. Topbar
- 10px / 20px padding, `background: var(--bg2)`, bottom border
  `1px solid var(--border)`.
- Left: page title `font-size:15; font-weight:700; color: var(--text)`.
- Right cluster: Theme picker button → LIVE pill → clock → user avatar tile.
- LIVE pill: mono 11px, color `var(--green)`,
  `background: color-mix(in srgb, var(--green) 10%, transparent)`,
  border `1px solid color-mix(in srgb, var(--green) 28%, transparent)`,
  `border-radius:20px`. Inside: 6×6 green dot pulsing every 2s.
- Clock: mono 11px, `var(--text3)`, locale string with weekday/date/time/tz.
- Avatar: 30×30, `border-radius:8px`, `background: var(--bg4)`,
  `1px solid var(--border)`, mono 12/600, color `var(--accent)`.

## 7. Theme Picker (in Topbar)
- Small button `padding:6px 10px; border-radius:8px;
  background: var(--bg3); border:1px solid var(--border);
  color: var(--text2); font: 11px var(--mono);` labeled "Theme".
- Opens a 300px popover (`var(--bg2)`, 12px radius, soft shadow
  `0 12px 40px rgba(0,0,0,0.35)`) listing themes as radio rows. Selected
  row gets `border: 1px solid var(--accent)` + `background: var(--bg4)`.
- Include a "Save theme to my profile" checkbox at the bottom separated by a
  top border.

## 8. Core Components
All built from the same token system. Use these utility class names:

### `.card`
```css
background: var(--bg2);
border: 1px solid var(--border);
border-radius: 12px;
overflow: hidden;
transition: box-shadow 0.2s ease;
```
`:hover { box-shadow: 0 2px 12px rgba(0,0,0,0.12); }`

### `.card-header`
```css
display:flex; align-items:center; justify-content:space-between;
padding:12px 16px;
border-bottom:1px solid var(--border);
background: var(--bg3);
```

### `.card-title`
`font: 600 12px/1 var(--mono); letter-spacing:0.5px; color: var(--text);`

### `.badge` (pill labels)
`font: 500 10px var(--mono); padding:2px 8px; border-radius:20px;`

Variants — each uses tinted bg + matching border + colored text:

- `.badge-red    { bg:rgba(245,83,79,0.15); color:var(--red); border:rgba(245,83,79,0.3); }`
- `.badge-green  { bg:rgba(34,211,160,0.1); color:var(--green); border:rgba(34,211,160,0.2); }`
- `.badge-blue   { bg:rgba(79,126,245,0.12); color:var(--accent); border:rgba(79,126,245,0.25); }`
- `.badge-amber  { bg:rgba(245,166,35,0.12); color:var(--amber); border:rgba(245,166,35,0.25); }`
- `.badge-cyan   { bg:rgba(34,211,238,0.1); color:var(--cyan); border:rgba(34,211,238,0.2); }`
- `.badge-purple { bg:rgba(124,92,252,0.12); color:var(--accent2); border:rgba(124,92,252,0.25); }`
- `.badge-teal   { bg:rgba(20,184,166,0.12); color:#2dd4bf; border:rgba(20,184,166,0.28); }`

### `.kpi` (stat tile)
```css
background: var(--bg2);
border: 1px solid var(--border);
border-radius: 10px;
padding: 14px 16px;
position: relative;
overflow: hidden;
```
Top accent bar via `::before { height:2px; top:0; left:0; right:0; }` with
color variants `.kpi.blue|red|green|amber|cyan|purple|teal|orange|indigo`.
Clickable KPIs: `.kpi-clickable` adds cursor pointer, hover lift
(`translateY(-1px)`), and a focus ring of `var(--accent)`.

Internal KPI layout:
- Label: mono 10/600, uppercase, letterSpacing 1, `var(--text3)`.
- Value: sans 24/700, color matches variant accent (blue→`var(--accent)`,
  red→`var(--red)`, etc.).
- Sub line: mono 10, `var(--text3)`.

### Buttons
- Primary: `background: var(--accent); color: var(--on-accent);
  border:none; border-radius:8px; padding:11px; font:600 13px var(--sans);`
  Disabled → `background: var(--bg4); cursor: not-allowed;`
- Secondary/ghost: `background: var(--bg3); color: var(--text2);
  border:1px solid var(--border); border-radius:8px; font:11px var(--mono);`

### Inputs
```css
background: var(--bg3);
border:1px solid var(--border);
border-radius:8px;
padding:10px 12px;
color: var(--text);
font: 13px var(--mono);
outline: none;
```
Field labels above input: mono 11, uppercase, letterSpacing 1, `var(--text3)`.

### Scrollbars
```css
::-webkit-scrollbar { width:6px; height:6px; }
::-webkit-scrollbar-track { background: var(--bg2); }
::-webkit-scrollbar-thumb { background: var(--bg4); border-radius:3px; }
::-webkit-scrollbar-thumb:hover { background: var(--accent); }
```

### Animations
- `@keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.3} }`
- `@keyframes fadeIn { from{opacity:0; transform: translateY(4px)} to{opacity:1; transform: translateY(0)} }`
- Spinner: 18×18 circle, `border:2px solid var(--border);
  border-top-color: var(--accent); border-radius:50%;
  animation: np-spin 0.65s linear infinite;`

## 9. Login Page Pattern
Centered 380px card on `var(--bg)`. Card uses `var(--bg2)`,
`1px solid var(--border)`, `border-radius:16px`, `padding:40px`.
Header: 48×48 gradient brand tile (same gradient as sidebar logo), product
name in sans 20/700, tagline in mono 12/`var(--text3)` uppercase.
Form fields and primary button use the styles above. Footer disclaimer in
mono 11 `var(--text3)`.

## 10. Tailwind Config (mirror the tokens)

```js
// tailwind.config.js
export default {
  content: ['./index.html', './src/**/*.{js,jsx,ts,tsx}'],
  theme: {
    extend: {
      colors: {
        bg:'#0a0c10', bg2:'#0f1117', bg3:'#151821', bg4:'#1c2030',
        accent:'#4f7ef5', accent2:'#7c5cfc',
        success:'#22d3a0', danger:'#f5534f', warning:'#f5a623', info:'#22d3ee',
      },
      fontFamily: {
        mono: ['JetBrains Mono','ui-monospace','SFMono-Regular','Menlo','Consolas','monospace'],
        sans: ['Inter','-apple-system','BlinkMacSystemFont','Segoe UI','Roboto','Helvetica Neue','Arial','sans-serif'],
      },
    },
  },
  plugins: [],
}
```

## 11. Theme List (for the picker)

```js
// constants/themes.js
export const THEMES = [
  { id:'midnight', label:'Midnight', hint:'Default deep slate' },
  { id:'ocean',    label:'Ocean',    hint:'Teal & cyan' },
  { id:'forest',   label:'Forest',   hint:'Emerald dark' },
  { id:'dawn',     label:'Dawn',     hint:'Warm violet' },
  { id:'paper',    label:'Paper',    hint:'Light cool gray' },
  { id:'sand',     label:'Sand',     hint:'Warm light sepia' },
  { id:'ember',    label:'Ember',    hint:'Rose & coral heat' },
  { id:'arctic',   label:'Arctic',   hint:'Ice blue steel' },
  { id:'rose',     label:'Rose',     hint:'Pink magenta dark' },
  { id:'slate',    label:'Slate',    hint:'Neutral steel NOC' },
  { id:'nebula',   label:'Nebula',   hint:'Indigo & violet space' },
  { id:'mono',     label:'Mono',     hint:'High-contrast grayscale' },
  { id:'ruby',     label:'Ruby',     hint:'Deep crimson accent' },
]
export const DEFAULT_THEME = 'midnight'
```

## 12. Rules for the AI Implementing This
1. Wire `<html data-theme="midnight">` and a theme-store that:
   - persists the chosen theme in `localStorage`,
   - optionally syncs to user profile,
   - exposes `setTheme(id)` and applies it via
     `document.documentElement.dataset.theme = id`.
2. Never read hardcoded hex in components. Always reference `var(--accent)`,
   `var(--text)`, etc., so switching themes recolors the whole app.
3. Reuse `.card / .card-header / .card-title / .badge-* / .kpi / .kpi.<color>`
   instead of inventing new wrappers.
4. Keep mono font for ALL: labels, IDs, IPs, timestamps, table headers,
   badges, KPI sublines, sidebar monogram, login field labels.
5. Use **emoji icons** in the sidebar for v1 (replaceable later with lucide).
6. Respect density: 14px base, generous use of `var(--text2)` and
   `var(--text3)` for hierarchy, 1px borders, 8–12px radii.
7. Pages must fit a 1080p window — keep the `--app-zoom: 0.9` trick and use
   `var(--app-vh, 100vh)` instead of `100vh` for full-height shells.
8. On dark themes, keep `color-scheme: dark` so native controls (selects,
   scrollbars) match. On `paper` and `sand`, force `color-scheme: light` and
   style `select option` explicitly.
9. Provide a Topbar with: page title, theme picker, pulsing LIVE pill,
   live-updating clock, and an avatar tile — even if some are stubs.

## 13. Deliverables

- `tailwind.config.js` (per §10)
- `index.html` with two Google Fonts links and `<html data-theme="midnight">`
- `globals.css` containing every theme block in §2 + the utility classes in §8
- `Layout` (sidebar + topbar + outlet)
- `Sidebar` (per §5)
- `Topbar` with a `ThemePicker` (per §6, §7)
- `LoginPage` (per §9)
- `themeStore` with localStorage persistence + optional profile sync
- `constants/themes.js` (per §11)

Default theme = `midnight`.

---

### Customization tips
- Swap the brand: change the `LK` monogram, the product name in Login/Topbar,
  and `--accent` / `--accent2` if you want a different brand hue. Don't touch
  components.
- Change the default mood: promote a different theme to `:root` (e.g.
  duplicate `[data-theme="nebula"]` values into `:root`). Every component
  follows automatically.
- Non-React stack: prepend a one-line note to this prompt (e.g.
  *"Implement this in Next.js App Router + Tailwind"* or *"Vue 3 + Pinia"*) —
  the spec itself is framework-agnostic.
