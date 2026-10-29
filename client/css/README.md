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

* No page contains a `style=` attribute, a `<style>` element or a colour literal in inline SVG (use a class; see `.backdrop-a` in `layout.css`),
  and no script writes a style attribute (`setAttribute("style")`, `style:` in `el()`). Setting `element.style.x` from JavaScript is fine.
* Consequence: the CSP of the four pages has **no `'unsafe-inline'` in `style-src`** (`style-src 'self' https://fonts.googleapis.com`). It was
  verified in Chrome and Firefox (articles anonymous and logged in, both themes, collections, home, search; the 3D viewer renders in Firefox) with no
  violation reported. If a future third-party script needs inline styles, the browser console says "Applying inline style violates ..."; either fix the
  cause or re-add `'unsafe-inline'` for that page and document the script here. Currently none needs it.
* The header logo and icons are white SVGs: `--filter-header-icon` (`none` in dark, `invert(0.7)` in light, giving #4d4d4d = 7.25:1 on the cream bar)
  makes them follow the theme; the test computes this ratio.

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

## Smoke test (run it before every deployment)

`node client/test/tools/smoke.mjs <base-url>` (outside `node --test`; needs Chrome and Node >= 22). Serve `client/` with a `config.json` that points to a
real Parse server (gitignored), or give the address of the live site:

    cd client && python3 -m http.server 8000 --bind 127.0.0.1 &
    node client/test/tools/smoke.mjs http://127.0.0.1:8000 --shots=/tmp/shots     # dark and light; --theme=dark for one

It starts headless Chrome with software WebGL, loads home, `search.html?q=prosodic`, `article.html?pmid=18420426` and `collections.html`, and
**fails (exit 1)** on a JS exception, a CSP violation, a console error outside a short allow-list (three.js deprecations, GPU stall, favicon), a search page
without "N articles found" / result items / a non-zero #viewer and canvas, a visible link, button, input, heading, list item or table cell covered by
another element, or a wrong theme. It prints a PASS/FAIL table. (It would have caught both the covered results list and the 840x0 viewer.)

## Migration audit (commit 8216595: `style.css`, `annotation.css`, `table-edit.css`, `collections.css`, inline styles -> now)

Method: every selector of the four old files was looked up in the new `base/components/layout.css`, then the properties of the selectors that exist in both
were compared, then the page scripts were grepped for ids and classes they use. "Lost" = missing without a reason.

| Old rule | Now | Verdict |
|---|---|---|
| `* {font-size:14px; color:white; z-index:1}` | `html, body` in `base.css` (font, colour tokens) | intentionally removed; the `z-index:1` on everything is what hid the search results under the backdrop (see `--z-backdrop`) |
| `#viewer {width:800px; height:640px}` | `#viewer` in `layout.css`: `width:100%; max-width:var(--search-viewer-width); aspect-ratio:var(--search-viewer-ratio)` | **LOST, restored** (canvas was 840x0 and the brain disappeared) |
| `#viewer-info {position:absolute; top:5px; left:5px; pointer-events:none; z-index:10}` | `#viewer-info` in `layout.css` with tokens | **LOST, restored** |
| `#viewer-container {position:relative}` | `layout.css` | kept |
| `.linkNoULine {text-decoration:none; font-weight:lighter}` | `.site-footer a` (no underline) and `.linkNoULine` (weight) | weight **LOST, restored** |
| `#level`, `#levelValue`, `#paper-list`, `#num-found`, `#num-articles` | had no CSS in the old files (browser defaults) | unchanged; `#level` only gets `vertical-align` |
| `input#url, input#projectName {width, height:32px, border:0, padding:0, color:black}` | `layout.css` (size) + base input style (dark field, border, padding) | intentionally changed: the black text on a light field became a themed dark field |
| `#menu {float:right; margin-right; transition:top .5s, opacity .5s; font; background}` | `#menu` in `layout.css` (fixed bar, tokens) | float and margin were overridden by `position:fixed` in the old file too; the transition was never triggered (no script changes `top` or `opacity` of the menu): intentionally removed |
| `#MyLogin`, `#MyLogin.in`, `#MyLogin.in a` | `layout.css`; the link colour and underline come from `#menu a` and the default | kept |
| `img.button`, `img.button:hover`, `img.icon`, `.icon`, `img#small-logo`, `img#logo`, `#background` | `layout.css` (`img.icon` and `.icon` are used by no page: intentionally removed) | kept |
| `#footer {background:#000; z-index:2}` and inline `flex:0 0 100px; background-color:#000` | `.site-footer` (`--color-footer-bg`, `--footer-height`) | kept (dark in both themes) |
| `#article {text-align:justify; max-width:800px}`, `#article p {column-count:2}` | `#article` width token, left-aligned, single column | intentionally changed (readability: justified two-column abstract) |
| `.content`, `.content h2/p` | `layout.css` | kept |
| `.mesh`, `.experiments`, `.experiment {margin-left:calc(...); max-width}` | `layout.css` (grid, tokens) | intentionally changed |
| `.coords-table td/th`, `table th {background:#333}` | `base.css` (`th`), `components.css` (data-table) | kept |
| `#table-wrapper`, `#table-scroll`, `#table`, `#table-wrapper table thead th .text` | the ids no longer exist in the markup (`article.js` builds `.coords-scroll`, `.te-scroll`) | intentionally removed |
| `.noEmptyWithPlaceholder:empty:before` | `layout.css` (`::before`, muted token) | kept |
| `annotation.css`: `.tag` pill, `.bal-*` fills, `.mesh-item`, `.vote-controls`, `button.vote*`, `.tag-popup`, `.tag .counts` | `components.css`: chip (`button.tag.chip`), band colours, `.vote-popup`, `.segmented` | replaced by the redesign (inline Agree/Disagree buttons no longer exist) |
| `annotation.css`: `.tag-picker`, `.tag-ontologies`, `ul.tag-concepts`, `button.concept`, `input.tag-filter`, `input.nsubjects-input`, `.comments`, `li.comment`, `.comment-body`, `.comment-box textarea`, `.meta`, `.meta-row`, `.table-ok`, `.empty-table`, `.error`, `.muted`, `.ann-status`, `.login-hint` | `components.css` | kept (controls take their colours from `base.css`) |
| `table-edit.css`: `.te-*`, `.te-import*`, `.add-article`, `.add-ntables` | `components.css` (`.te-bar`/`.te-textform` replaced by the toolbar and in-place form; `.experiment.te-active` max-width replaced by the grid) | kept or replaced |
| `collections.css`: `[hidden]`, `#collections-link`, `.muted`, `.error`, `.col-*`, `.collection` | `base.css` / `layout.css` / `components.css` | kept (`.col-select` rewritten: aligned with the first line of the title) |
| inline styles of `index/search/article/collections.html` (39) and the `<style>` of `search.html` | named classes in `layout.css` (`.page*`, `.search-box`, `svg.backdrop-svg` ...) | kept; the search backdrop now has `z-index: var(--z-backdrop)` |
| `body`/`html` `-moz-font-smoothing`, `-webkit-transition` prefixes | -- | intentionally removed (obsolete) |
| ids/classes used by page scripts without CSS (`#level`, `#levelValue`, `#num-found`, `#num-articles`, `#paper-list`, `#selection-toolbar`, `#collections`, `#query-result`, `#data`) | none ever had CSS or are styled through their children | checked |

## References and DOI links

`annotation/reference.js` turns the stored reference ("Authors (YEAR) Journal vol(issue):pages") and the article's `DOI` into text plus one link
(`https://doi.org/<DOI>`, validated with `10.\d{4,9}/\S+`, percent-encoded, `target=_blank rel="noopener noreferrer"`). The article page shows the authors once (from `Authors`)
and the citation from the year on as a second muted line; lists (search, home) keep the one-line reference with the journal part linked. A missing or placeholder
DOI gives plain text. The class `.ref-link` is a normal link (no extra style).

## The search map legend

`#viewer-info` (overlay, top left of the map) says what is shown ("Map from 150 of 445 papers", then "Map from 445 papers"); `#levelValue` next to the slider gives the
absolute meaning ("50% = at least 124 overlapping peaks"); `#map-notice` (class `ann-status error`) reports partial data. They use `--font-size-xs/sm`, `--color-text-muted`,
`--space-*` and `--z-overlay`; nothing in them is hard-coded. See `docs/coactivation-map.md`.

`.export-row` (layout.css) holds the "Download 3D model (.glb)" button and its status (`#export-status`, class `ann-status`); see `docs/export-glb.md`.
