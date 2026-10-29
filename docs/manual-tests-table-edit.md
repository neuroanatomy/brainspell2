# Manual tests: table editing, import, add article

Steps marked **(RISK)** are the likeliest to break and cannot be covered by unit tests. Serve `client/` (`cd client && python3 -m http.server 8000`)
and open `http://localhost:8000/article.html?pmid=12345&mock=1&as=alice` (mock; data lives in memory, a reload resets it). Part D repeats the key
steps against a real server. Keep the console open: no "Refused to ..." CSP message should appear (there are no inline styles any more). Mock
parameters: `latency=1500` makes the "Saving…" state visible; `fail=155` / `fail=142` make every write fail with that code; `theme=light`.
Fixture 12345: experiment 0 has 5 rows, experiment 1 has 2 rows, experiment 2 is empty.

What the editor looks like (logged in): under the title there is a small **pencil icon** (✎, "Edit title") and one next to the caption
("Edit caption"). Beside the 3D viewer the coordinate table has columns X Y Z and, in the header, a round **"+" (Add row)**; each row has a round
**"+" (Add row after this row)** and a round **"−" (Delete this row)** that appear when the row is hovered, focused or selected (always visible on
touch screens). Below the table a toolbar holds the secondary buttons **Import from text** and **Split here**. Click a row to select it and edit
its three numbers (✓ saves, ✕ cancels, Enter / Tab on Z saves, Esc cancels).

## A. Anonymous (`?pmid=12345&mock=1`)

| # | Step | Expected |
|---|---|---|
| A1 | Open the page. | Tables and viewers read-only: no pencil, no "+", "−", Import or Split anywhere. Clicking the title or a row does nothing. |
| A2 | `?pmid=555&mock=1`. | "Article 555 is not in the database." and "This article is not in the database yet. Log in to add it." No form. |

## B. Logged in (`as=alice`)

| # | Step | Expected |
|---|---|---|
| B1 | Open the page. | Header shows "My collections". Every experiment (also the empty one) has pencil icons next to title and caption, an editable table with the round header "+", and the toolbar below it (the empty one has "Add row" and "Import from text" in its prompt). The old read-only table is replaced by the editable one. **The 3D viewer is on the left of the table** at 900 px window width or more, and the table is only as tall as its rows (no big empty box). |
| B2 | Hover a row with the mouse (**RISK**). | The row's round "+" and "−" appear (fade in) and the row is shaded; they vanish when you leave (unless the row is selected). Tab into the row: they appear too. |
| B3 | Click a coordinate row of experiment 0. | Row highlighted, its cells become three inputs with ✓ and ✕ icons; the first input has focus. "Split here" becomes enabled. |
| B4 | Type `abc` in X, Enter. | "Not accepted: x must be a number". Nothing changes. `250` in Y: "y must be between -200 and 200". |
| B5 | Type `1.23456`, `-5`, `6` and Enter (or Tab from Z). Use `latency=1500` once. | While waiting "Saving…" and the table still shows the OLD value (no optimistic update); then the row shows `1.235, -5, 6`. |
| B6 | Edit a row and press Esc or click ✕. | Previous values back, nothing sent. Pressing Enter without changing anything sends nothing. |
| B7 | Click the round "+" on a row. | A new input row appears after it (green tint). Fill `9 8 7`, Enter: row inserted there. |
| B8 | Click the header "+". | New row at the end. |
| B9 | Click "−" on a row. | Row removed at once (no confirmation). |
| B10 | Experiment 1: delete both rows. | The second delete asks "Delete the last row? ..."; Cancel keeps it; OK leaves the empty prompt "This table has no coordinates." with "Add row" and "Import from text". |
| B11 | Empty experiment 2: "Add row", fill `3 4 5`, Enter. | Row appears and a 3D viewer is created next to the table. |
| B12 | Experiment 0: hover "Split here" before selecting a row. | It is disabled and its tooltip says to select a row after the first. Select the 3rd row, "Split here", Cancel the confirm: nothing. Again and OK: the page reloads with one more experiment (rows 3.. in the new one, same title and caption, no tags); the first keeps rows 1-2 and its tags. The first row can never be the split point. |
| B13 | Title: click the pencil (or the title text). | The title becomes an input (focused) with Save / Cancel and a hint "plain text, at most 1000 characters". Type `New <b>title</b>`, Enter: shown literally as text. Esc or Cancel on another edit restores the text. A caption: pencil, Enter adds a line, Ctrl+Enter or Save saves; over 5000 characters is refused before sending. |
| B14 | Title `Faces<Houses contrast`, caption `A &amp; B`; save; reload; open the pencil again. | Shown exactly as typed before and after the reload; the edit box starts with the same text. |
| B15 | "Import from text": paste `x=-5.5; y: 2; z=3` / `bad line` / `1 2` / `10,20,30`, Preview. | "2 locations will replace the table", a table with line numbers, skipped lines "line 2: bad line", "line 3: 1 2". |
| B16 | Text `300,0,0`, Preview. | Error naming "line 1"; "Replace table" disabled. |
| B17 | Valid text, Preview, change the text, press "Replace table". | It does not send; it previews again. After a new Preview "Replace table" replaces the rows and the dialog closes. Importing the same rows again changes nothing visible, no reload. |
| B18 | Two edits in a row (e.g. B5 then B7). | Both succeed; no "changed meanwhile". |
| B19 | `fail=155`, edit a row; `fail=142`. | "Too many actions, please wait. ..." / "Not accepted: ..." next to the controls; table unchanged. |
| B20 | Log out (header). | Pencils, row icons and toolbar disappear at once; the read-only table is back. Log in: they return. |
| B21 | A table with a legacy 4-value row (real data). | Header "Extra" only for tables with such a row; the row has 3 inputs, the extra value stays after an edit. |
| B22 | Real server not answering for 30 s. | "The server did not answer. Please try again." |

## C. Add article (`?pmid=555&mock=1&as=alice`)

| # | Step | Expected |
|---|---|---|
| C1 | Open the page. | Form with PMID 555 (read-only) and "Number of stereotaxic tables" = 1; dark inputs, readable. |
| C2 | Set 51, or `abc`, click "Add article". | "the number of tables must be a whole number between 0 and 50"; nothing sent. |
| C3 | Set 3, click (`latency=1500`). | "Saving..." and the button disabled; then the page reloads with 3 empty tables (each with the add-row / import prompt). |
| C4 | `fail=155`, `fail=142`. | The error appears next to the button; the form stays usable. |
| C5 | Real server with Solr down (or mock with indexed=false). | "Article added, but search indexing is pending; ..." with OK; the page reloads on OK or after 4 s. |

## H. Things only a human can check

| # | Step | Expected |
|---|---|---|
| H1 **(RISK)** | Touch device (or browser touch emulation). | Row "+" and "−" are always visible and at least about 36 px wide; chips, pencils and Save buttons are easy to hit; no hover is needed anywhere. |
| H2 **(RISK)** | Narrow window (about 390 px). | The viewer is above the table; the table scrolls inside its box if tall; the toolbar buttons wrap; the editing row (three inputs and ✓ ✕) fits without cutting off. |
| H3 | Keyboard only. | Tab reaches the pencils, rows (focus shows the row buttons), the header "+", Import and Split; Enter / Esc work in all inputs and the import dialog; focus is visible. |
| H4 | `?theme=light`. | Light theme: table header tan, selected row pale orange, icons visible; same layout. |
| H5 | Firefox, Safari, Chrome. | Same layout and behaviour; the editing inputs are not clipped. |
| H6 (real WebGL) | Edit a coordinate with the viewer visible. | The viewer is redrawn with the changed peak (it is rebuilt each time; many edits create many WebGL contexts, the browser may warn after about 16: report it). |

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

## Not covered by any automatic test

* Real focus, hover and Tab order, `ev.stopPropagation` on row buttons (the fake DOM has no bubbling), `window.confirm` dialogs, real CSS rendering.
* The 3D viewer rebuild (no update API in the library) and highlighting a clicked row in the viewer (not implemented).
