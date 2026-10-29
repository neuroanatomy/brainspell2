# Manual tests: collections (WP6, F8)

Serve `client/`
with a static server (`cd client && python3 -m http.server 8000`), keep the console open (a
Content-Security-Policy violation shows in red). Mock parameters as in `docs/manual-tests-annotation.md`
(`mock=1`, `as=alice`, `fail=155`, `latency=1500`). The mock keeps data in memory: a reload resets it, and
navigating between pages (search to collections) also resets it, so in mock mode only one page at a time can be
checked. Search itself (Solr, `select`) needs a real server, so sections A and B are real-server tests; the
mock covers the collections page (section C, with the collections created through the console, see C0).

**Run this first:** `node client/test/tools/smoke.mjs <base-url>` (see `client/css/README.md`, "Smoke test"). It loads home, search (`?q=prosodic`), an article and the collections page
in headless Chrome with WebGL, in both themes, and fails on JS exceptions, CSP violations, console errors, a search page without results or with an empty 3D viewer, and any element
covered by another. Only continue with the manual steps below when it prints PASS.

Renaming a collection is not available (not in the frozen API, plan 4); do not look for it.

## A. Search results (real server, logged in with GitHub), riskiest first

| # | Step | Expected |
|---|---|---|
| A1 | Open `search.html?q=memory`, scroll until more than 40 results are loaded. Tick a few boxes in the first batch, keep scrolling so the next 20 are appended. | Every item, including appended ones, has a checkbox; the ticks made earlier are still ticked; the counter ("3 articles selected") is right. |
| A2 **(RISK)** | `search.html?q=%22cognition%22` (445 papers), watch the 3D map and the list. | The first 20 results appear within about a second, the map appears and grows while "Map from n of 445 papers" counts up, then "Map from 445 papers" (a few seconds in all). Beside the slider: "50% = at least N overlapping peaks"; moving the slider changes the map smoothly and N. `&smooth=0` shows the plain, unsmoothed map at once. Try a query with no results ("zzzqqq": "0 articles found", "Map from 0 papers"), one with quotes or `&`, and "working memory" (1753 papers, about 4 s, no error notice). Scroll the list: 20 more at a time. Checkboxes do not move or hide anything. |
| A2b **(RISK)** | On a finished search ("cognition") click "Download 3D model (.glb)". While the map loads, and for a query with no result, it is disabled with the tooltip "Available when the map is complete". | "Preparing…" then "Downloaded (0.4 MB)" and a file `brainspell-cognition-445papers.glb`. Open it in Blender / Sketchfab / a three.js viewer / model-viewer: a translucent brain with red blobs at three nested levels; top view = the page's view (anterior up); frontal poles face you in the front view; check dark and light themes for the button. See `docs/export-glb.md`. |
| A3 | "Select all". | All loaded items are ticked (not results not yet loaded). Scroll: newly appended items are not ticked until selected again. "Select none" clears all. |
| A4 | Tick 3, "Add to collection (3)", "Create new collection...", press Create with an empty name. | Message "The name must have 1 to 100 characters"; nothing sent (Network tab). |
| A5 | Type a name, press Enter (or Create). | "Added 3 articles to <name>"; ticks are cleared; the menu closed. |
| A6 | Tick 2 (one already in the collection), open the menu, choose the collection. | Menu lists it with its size; result "Added 1 article to <name> (1 already in it)". |
| A7 | Press Create/choose 31 times within a minute (or until rate limited). | Message "Too many actions, please wait. ..." with seconds; ticks kept; button usable again. |
| A8 | Select 2001+ articles (only possible with a huge result set loaded). | Opening the menu says "You selected N articles; at most 2000 can be added at once", no request is sent. |
| A9 | Have 50 collections, open the menu. | "Create new collection..." is disabled. |
| A10 | Name a collection `<img src=x onerror=alert(1)>`. Reopen the menu. | Shown as literal text; no alert. |
| A11 | Log out (header) while ticks exist. | Checkboxes and toolbar disappear immediately; log in again: boxes return, unticked state per earlier selection kept in the page. |
| A12 | Expire the session (delete the session in Parse dashboard), press Add. | Message "Your session has expired. Please log in again." and the login state returns to "Login with GitHub". |
| A13 | Anonymous visitor on `search.html?q=memory`. | No checkboxes, no toolbar, no "My collections" link. |
| A14 | Open `index.html` and `search.html` logged in. | Header shows "My collections" (link to `collections.html`); hidden when logged out. |

## B. Original-behaviour regression

| # | Step | Expected |
|---|---|---|
| B1 | Search, click a result title. | Opens `article.html?pmid=...` as before. |
| B2 | Change the query in the box and press Enter. | New search loads. |

## C. Collections page

C0 (mock only): the mock starts with no collections. Open `collections.html?mock=1&as=alice`, then in the console:
`const m = await (await import("./annotation/api.js")).getMockBackend(); await m.call("saveCollection", {name: "Memory", add: ["12345", "67890"]}); await m.call("saveCollection", {name: "<img src=x onerror=alert(1)>"});` and reload is NOT needed: log out and in again from the header (mock login link) to redraw.
Against a real server, create collections from section A instead.

| # | Step | Expected |
|---|---|---|
| C1 | `collections.html` anonymous (`?mock=1`). | "Log in to see your collections". No error in console. |
| C2 | Logged in, no collections. | "You have no collections yet..." |
| C3 | With collections: look at the list. | Each has name, "2 articles", ", updated YYYY-MM-DD". Hostile name is literal text. Titles are not fetched until expanded (Network tab). |
| C4 | Click a collection name. | Expands: numbered list with titles (HTML entities decoded, markup shown as text), "PMID n", "remove" button, title links to `article.html?pmid=n`. Click again collapses. Mock: titles "Sample <i>mock</i> article..." for 12345. Real server: titles come from one Parse query per 100 PMIDs on `Articles`; PMIDs not in the database show "PMID n". |
| C5 | A collection with more than 100 articles (real server). | All titles load (Network: one query per 100). |
| C6 | "remove" on an article. | The row disappears, the count drops, "updated" date changes; reloading confirms. |
| C7 | "Delete collection". | Asks `Delete "X"?` with "Yes, delete" / "Cancel"; Cancel leaves it; Yes deletes (nothing happens at the first click). |
| C8 | `?mock=1&as=alice&fail=155`, try remove and delete. | Error text next to the collection; nothing removed. |
| C9 | Header "My collections" link on the page. | Shown when logged in, hidden after Log Out (page switches to "Log in to see your collections"). |
| C10 | Another user's collection ids | Cannot be reached from the UI; the server answers 101 or 119. |

## H. Things only a human can check

| # | Step | Expected |
|---|---|---|
| H1 | Look at the toolbar and the "Add to collection" menu on search results, and the collections page, in dark and with `?theme=light`. | Buttons, inputs and the menu are readable in both themes (no light grey boxes on dark); the menu floats above the list with a border and shadow. |
| H2 | Narrow window (about 390 px). | The toolbar wraps; the menu stays inside the window; each row's checkbox is easy to tap. |
| H3 | Keyboard only: Tab to a result's checkbox (Space ticks it), to "Add to collection", Enter opens the menu, Tab through its entries, Esc/Enter as the page allows. | Everything reachable with a visible focus ring. |
| H4 | Firefox, Safari, Chrome. | Same look. |
| H5 | Real server: the "My collections" header link while logged in, and logging out. | Link shown only when logged in; on the collections page logging out shows "Log in to see your collections". |

The unit tests (`node --test test/collections.test.js`) cover helpers, selection, menu actions, errors, appends and the page logic on the fake DOM and the mock. Not checked by anything automatic: real layout, DOMParser decoding, the real Parse queries for titles, the OAuth flow.
