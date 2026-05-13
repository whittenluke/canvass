# Typography

This app uses a single sans stack and shared **CSS variables** defined in `src/index.css`. Headings (`h1`–`h6`) inherit the body font, use one weight (**700**), and share line-height / letter-spacing so panels, sheets, and admin views stay visually aligned.

## Tokens (`:root`)

| Token | Typical use |
|--------|----------------|
| `--font-sans` | Body and all UI text (Inter first, then system UI fonts). |
| `--font-weight-heading` | **700** — all semantic headings and primary surface titles. |
| `--line-height-heading` | **1.22** — default heading line height. |
| `--letter-spacing-heading` | **-0.02em** — slight tightening for titles at UI sizes. |
| `--heading-panel` | **1.0625rem** — panel `h3`, sheet titles, admin section `h2`, auth card title, geofence detail title, mobile strip titles, confirm dialogs. |
| `--heading-app-bar` | **1.125rem** — main app top bar title (desktop). |
| `--heading-doc-page` | **clamp(1.28rem, 2.4vw, 1.52rem)** — support guide page `h1`. |
| `--text-ui-label-size` | **0.875rem** — field labels (“Area name”), metric row labels (“Canvassed”), same visual tier. |
| `--text-ui-label-weight` | **600** — label weight (not full heading **700**). |
| `--text-ui-label-tracking` | **0.02em** — slight positive tracking on UI labels. |
| `--text-field-value-size` | **0.9375rem** — text inputs, selects, assignee trigger, listbox options, helper lines under metrics. |
| `--text-field-value-weight` | **500** — value / body-in-control typography. |

On narrow viewports, the top bar title may use `--heading-panel` for space (see `App.css` `@media (max-width: 640px)`).

## Rules for new UI

1. **Do not** introduce a second sans font for headings; use `font-family: inherit` or the stack via `var(--font-sans)` if you need to repeat it.
2. **Primary title** in a card, panel, sheet, or admin block: `font-size: var(--heading-panel)` and rely on global `h*` weight, or set `font-weight: var(--font-weight-heading)` on a `div` that acts as a title.
3. **Eyebrows / labels** (uppercase section labels, table column labels): smaller sizes and optional `letter-spacing` are fine; keep **weight ≤ 700** unless the design system later adds an explicit “display numeric” token.
4. **Doc / marketing hero** titles only: use `--heading-doc-page`, not ad-hoc `clamp()` values in feature CSS.
5. **Form labels and inline metric labels** share `--text-ui-label-*`. **Inputs, triggers, and captions** use `--text-field-value-*` and `font-family: var(--font-sans)` so they never pick up a different face from the browser default control styling.

Implementation reference: `src/index.css` (tokens + base `h1–h6` rules), `src/App.css` (surface-specific selectors consuming the tokens).

## Optional: self-host Inter

The stack lists **Inter** first; if the user’s system has no Inter installed, the browser falls back to system fonts (still consistent). To guarantee Inter metrics everywhere, add a self-hosted or `@font-face` Inter build and keep `--font-sans` first family name aligned with that face.
