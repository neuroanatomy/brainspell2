# Manual tests: table editing, import, add article (WP5)

No browser was available when this was written; nothing below has been run in a browser. Serve `client/`
(`cd client && python3 -m http.server 8000`) and use `http://localhost:8000/article.html?pmid=12345&mock=1&as=alice`
(mock; the data lives in memory and a reload resets it). Part D repeats the key steps against a real server.
Keep the console open: a Content-Security-Policy violation shows in red. Mock parameters: `latency=1500` makes the
"Saving..." state visible; `fail=155` / `fail=142` make every write fail with that code. Fixture 12345: experiment 1 has
5 rows, experiment 2 has 2 rows, experiment 3 is empty.

## A. Anonymous (`?pmid=12345&mock=1`)

| # | Step | Expected |
|---|---|---|
| A1 | Open the page. | Tables, viewers, read-only as before. No "Edit title", "Import", "+", "-", "Split" anywhere. No "My collections" link in the header. |
| A2 | `?pmid=555&mock=1`. | "Article 555 is not in the database." and "This article is not in the database yet. Log in to add it." No form. |

## B. Logged in (`as=alice`)

| # | Step | Expected |
|---|---|---|
| B1 | Open the page. | Header shows "My collections" (links to collections.html). Each experiment (also the empty one) has the buttons Edit title, Edit caption, Import from text (Split here only with 2+ rows) and an editable table with X Y Z and "+" / "-". The old read-only table is hidden; the 3D viewer is still shown. |
| B2 | Click a coordinate row of experiment 1. | Row is highlighted and its cells become 3 inputs with Save/Cancel; the first input has focus. "Split here" becomes enabled. |
| B3 | Type `abc` in X, press Enter. | Message "Not accepted: x must be a number". Nothing changes. Type `250` in Y: "y must be between -200 and 200". |
| B4 | Type `1.23456`, `-5`, `6` and press Enter (or Tab from Z). Use `latency=1500` once. | While waiting: "Saving...", the table still shows the OLD value (no optimistic update). Then the row shows `1.235, -5, 6` and the viewer is redrawn with the sphere moved. |
| B5 | Edit a row and press Escape. | Row returns to its previous values, nothing sent. Editing without changing a value and pressing Enter sends nothing. |
| B6 | Click "+" on a row. | A new input row appears after it. Fill `9 8 7`, Enter: row inserted at that position; viewer has one more sphere. |
| B7 | Click "+" in the header. | New row at the end. |
| B8 | Click "-" on a row. | Row removed at once (no confirmation), viewer updated. |
| B9 | Experiment 2 (2 rows): delete both. | The second delete asks "Delete the last row? ..."; Cancel keeps it; OK leaves the empty prompt "This table has no coordinates." with "Add row" and "Import from text". |
| B10 | Empty experiment 3: "Add row", fill `3 4 5`, Enter. | Row appears and a 3D viewer is created next to the table. |
| B11 | Experiment 1: "Split here" with no row selected. | Button is disabled. Click row 3, then "Split here", cancel the confirm: nothing happens. Again, confirm: the page reloads and shows one more experiment: rows 3.. in the new one (same title and caption, no tags), the first keeps rows 1-2 and its tags. The first row cannot be a split point. |
| B12 | Edit title: type `New <b>title</b>`, Save. | Shown literally as text (no bold). 1001+ characters are refused before sending; same for a caption over 5000. Escape cancels. |
| B13 | Import from text: paste `x=-5.5; y: 2; z=3` / `bad line` / `1 2` / `10,20,30`, Preview. | "2 locations will replace the table", a table with line numbers, and the skipped lines "line 2: bad line", "line 3: 1 2". |
| B14 | Replace the text with `300,0,0`, Preview. | Error naming "line 1"; "Replace table" is disabled. |
| B15 | Valid text, Preview, edit the text, press "Replace table". | It does not send; it previews again. After a new Preview, "Replace table" replaces the rows and closes the dialog. |
| B16 | Do two edits in a row (e.g. B4 then B6). | Both succeed (the page tracks the new rev). No "changed meanwhile" message. |
| B17 | `fail=155`: edit a row. | "Too many actions, please wait. ..." next to the controls; table unchanged. `fail=142`: "Not accepted: ...". |
| B18 | Log out (header). | Editing controls disappear at once; the read-only table is back. |

## C. Add article (`?pmid=555&mock=1&as=alice`)

| # | Step | Expected |
|---|---|---|
| C1 | Open the page. | Form with PMID 555 (read-only) and "Number of stereotaxic tables" = 1. |
| C2 | Set 51, or `abc`, click "Add article". | "the number of tables must be a whole number between 0 and 50"; nothing sent. |
| C3 | Set 3, click (use `latency=1500`). | "Saving..." and the button is disabled; then the page reloads and shows the article with 3 empty tables (each with the add-row / import prompt). |
| C4 | `fail=155`, `fail=142`. | The error message appears next to the button; the form stays usable. |

## D. Against a real server (needs a logged-in GitHub user; riskiest steps first)

| # | Step | Expected |
|---|---|---|
| D1 | Two tabs on the same article, logged in. Edit a row in tab 1, then a row in tab 2. | Tab 2 shows "This article changed meanwhile; reloading" and reloads showing tab 1's change. (Riskiest: needs `getAnnotations` rev and `editExperiment` rev to agree.) |
| D2 | Edit a row, then immediately edit another without reloading. | Both work (rev returned by the server is reused). |
| D3 | Split an article table, reload manually. | Two experiments; the new one has the next free id, no tags; votes of the first are intact. |
| D4 | Import a pasted table copied from a PDF/web page (Unicode minus, tabs). | Preview and server agree on the rows (compare the number of rows). |
| D5 | Edit 31 times within a minute. | The 31st shows the retry message (155). |
| D6 | Add a PMID that is in PubMed but not in the database; one that does not exist (e.g. 999999999); one already there from another tab. | OK + reload; "PubMed has no record for this PMID or is unavailable"; "added meanwhile; reloading". |
| D7 | After D6, search for the new article. | It is found (Solr indexed) or `indexed:false` was stored (see server logs). |
| D8 | Reload, log out in another tab, edit. | Session-expired message; controls disappear. |

## Not testable without a browser (not verified by the unit tests)

* Real focus and Tab/Enter/Escape behaviour of the inputs, `maxlength`, `ev.stopPropagation` on the row buttons (the fake DOM has no bubbling).
* The CSS (layout of the editor next to the viewer, hiding the read-only table, dialog look, `[hidden]`).
* Rebuilding the TranslucentLocations viewer: the library has no update API, the editor clears the element and creates a new viewer, which creates a new WebGL context each time (old contexts are released only by garbage collection). Row-to-sphere highlighting is not implemented (the library has no support for it).
* `window.confirm` dialogs; the CSP (no inline script or handler was added); `DOMParser` entity decoding of legacy titles shown in the title inputs.
* The "My collections" link and the interplay with the collections page.
