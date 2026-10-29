# Style sheets

The look and feel of every page lives in **five small files**, layered. The order in which an HTML page links
them is fixed:

| # | File | What it is | May contain |
|---|------|-----------|-------------|
| 1 | `theme.css` | **the only place that defines look and feel values**: colours, fonts, sizes, spacing, radii, shadows, z-indexes, durations, `color-scheme` | custom properties on `:root`, nothing else |
| 2 | `base.css` | defaults for elements: `html`, `body`, headings, links, tables, `button`/`input`/`textarea`/`select` and the button variants `.btn-primary`, `.btn-quiet`, focus ring, disabled, `[hidden]` | rules built from tokens |
| 3 | `components.css` | reusable pieces, one commented section each: status messages, tag chip, vote popup, segmented control, data table, icon button, toolbar, dialog, comments, collections | rules built from tokens and base classes |
| 4 | `layout.css` | where things are: header, page column, experiment grid (viewer next to table), home/search backdrop | rules built from tokens |
| 5 | `theme-light.css` | an alternative theme: **overrides tokens only**, under `:root[data-theme="light"]` | nothing but `--tokens` and `color-scheme` |

`annotation/theme.js` (loaded by every page) sets the `data-theme` attribute: `?theme=light` switches to the light
theme and remembers it in `localStorage` (inside try/catch; it works without storage), `?theme=dark` goes back to the
default (dark). Without a parameter the remembered choice is used.

## Rules (enforced by `client/test/css-architecture.test.js`)

* `base.css`, `components.css`, `layout.css` contain **no colour literal** (hex, `rgb()`, `hsl()`, named colours; `transparent`,
  `currentColor`, `inherit` are fine) and **no literal font size or spacing** (`font-size`, `margin*`, `padding*`, `gap`,
  `top/right/bottom/left`): use `var(--...)`. Allowed: `0`, `1px`, percentages and `calc()/min()/max()` built from tokens.
* Every `var(--x)` used anywhere is defined in `theme.css`; `theme-light.css` only overrides tokens that exist there.
* No `!important` except in the `[hidden]` rule of `base.css`.
* Every HTML page links `theme.css`, `base.css`, `components.css`, `layout.css`, `theme-light.css` in this order and
  loads `annotation/theme.js` in `<head>`.
* The contrast of the colour tokens is computed for both themes: text pairs >= 4.5:1, UI parts (control borders, focus ring,
  vote colours) >= 3:1. `CSS_REPORT=1 node --test test/css-architecture.test.js` prints every ratio.

Run it with `cd client && node --test test/css-architecture.test.js`.

## Naming

* **Tokens** are named by role: `--color-<role>` (`--color-surface`, `--color-text-muted`, `--color-border-control`,
  `--color-vote-agree`), `--font-size-<step>`, `--space-<n>` (8px base: 1=4px, 2=8px, ... `--space-1-5` = 6px chip gap),
  `--radius`, `--control-min-height`, `--hit-area`, `--z-<layer>`, `--duration-fast`. Never name a token after its value.
* **Classes**: components use a short noun (`chip`, `vote-popup`, `segmented`, `te-toolbar`); state is an extra class or an ARIA
  attribute (`.pressed` with `aria-pressed`, `aria-expanded`); variants of buttons are `.btn-primary`, `.btn-quiet`, `.icon-btn`.
  `te-*` belongs to the table editor, `col-*` to collections, `exp-*` to the experiment layout, `bal-*` to the balance of votes.

## Where to change what

| I want to... | Edit |
|---|---|
| change the accent colour | `--color-accent`, `--color-focus-ring`, `--color-link`, `--color-primary-bg` in `theme.css` (then run the architecture test: contrast is checked) |
| change the agree / disagree / tie colours | `--color-vote-agree`, `--color-vote-disagree`, `--color-vote-tie` |
| make everything a bit larger or tighter | `--font-size-*`, `--space-*`, `--control-min-height` |
| change the font | `--font-family-base`, `--font-family-heading` |
| make the 3D viewer or the table taller | `--viewer-size`, `--table-max-height` |
| add a theme | copy `theme-light.css` to `theme-<name>.css`, change `:root[data-theme="light"]` to your name, change the values, link it after `layout.css` in the four pages, add the name to `THEMES` in `annotation/theme.js`, run the architecture test |
| style a new component | add a section to `components.css` (a header comment, rules from tokens and base classes). Missing a value? Add a token to `theme.css` first (and a light override). Page-specific position goes to `layout.css` |

## Token reference (dark values; `theme-light.css` overrides the colours)

| Token | Role |
|---|---|
| `--color-bg`, `--color-surface`, `--color-surface-raised`, `--color-header-bg`, `--color-field-bg` | page, cards/popups, table headers/hover, top bar, text inputs |
| `--color-selected-bg`, `--color-new-row-bg` | selected/pressed, row being added |
| `--color-text`, `--color-text-muted`, `--color-text-on-accent`, `--color-link` | text roles |
| `--color-border` (decorative), `--color-border-control` (>= 3:1), `--color-accent`, `--color-focus-ring` | edges and focus |
| `--color-control-bg`, `--color-control-bg-hover`, `--color-primary-bg`, `--color-primary-bg-hover` | buttons |
| `--color-vote-agree`, `--color-vote-tie`, `--color-vote-disagree`, `--color-danger`, `--color-success` | meaning |
| `--filter-header-icon`, `--backdrop-filter` | treatment of the (white) header icons and the home page photo |
| `--font-family-*`, `--font-size-xs..title`, `--font-weight-*`, `--line-height-*` | typography (smallest text is 13px) |
| `--space-1..7`, `--space-1-5` | spacing |
| `--radius`, `--radius-round`, `--border-width`, `--border-width-band`, `--focus-ring-*`, `--shadow-popup` | shape |
| `--control-min-height`, `--hit-area`, `--hit-area-touch`, `--content-max-width`, `--viewer-size`, `--table-max-height`, `--popup-width`, `--menu-width`, `--coord-col-width` | sizes |
| `--z-base`, `--z-header`, `--z-popup`, `--duration-fast` | layers and motion (0 for `prefers-reduced-motion`) |
