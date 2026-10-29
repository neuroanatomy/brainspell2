# Manual tests: annotation UI

Steps marked **(RISK)** are the ones most likely to break and cannot be checked by the unit tests. Serve `client/` with any static
server (for the mock no `config.json` is needed), e.g. `cd client && python3 -m http.server 8000`, and open
`http://localhost:8000/article.html?pmid=12345&mock=1`. Keep the browser console open: a Content-Security-Policy violation is a red
"Refused to ..." message (there should be none; `style-src` no longer allows inline styles). Sections A to C use the mock, D a real server.

Mock URL parameters: `mock=1` anonymous; `as=alice` logged in as alice; `fail=155` (or 142, 206, ...) every write fails with that code;
`latency=1500` slows answers so the "Saving..." state is visible; `theme=light` / `theme=dark` the theme (remembered). The mock keeps
its data in memory: a reload resets it. Fixture articles: `12345` (legacy votes, 3 experiments, one empty, hostile strings) and `67890`
(plain). Search and the home page need a real server (the mock covers the article page only).

How the controls look now:

* A MeSH heading or an ontology tag is a **chip**: a button with its name, a coloured band on its left (green: more agree, amber: tie, red:
  more disagree, grey: no votes) and "+a −d" after the name when it has votes. Clicking it (or Enter / Space) opens ONE popup under it with
  the counts (▲ agree, ▼ disagree, "including you"), the buttons **Agree**, **Disagree**, **Retract** and **Close**, and for tags the term link.
* "Table is correct" and the space are **segmented controls**: `[✓ Yes n | ✗ No n]`, `[MNI n | Talairach n]`. The pressed half is yours;
  clicking it again retracts. "+ Add tag" is the dashed chip.

## A. Anonymous visitor (`?pmid=12345&mock=1`)

| # | Step | Expected |
|---|---|---|
| A1 | Open the page. | Title "Sample <i>mock</i> article about working memory & attention" shown as plain text (the literal characters `<i>`, no italics). The abstract shows "not bold" literal markup characters and no text "window.__xss". Header: "Login with GitHub", underlined; no "My collections". Dark page, all text readable. |
| A2 | Console: type `window.__xss`. | `undefined`. No alert box appeared at any time. |
| A3 | Medical Subject Headings. | Four chips in one wrapping row: Brain, Memory, Short-Term, Attention and one whose name is the literal text `<img src=x onerror=alert(1)>`. Grey band, no counts (no votes), no Agree / Disagree buttons. No broken image icon. |
| A4 | Experiment 0 header area. | "0. Task > baseline", caption (literal `<b>` characters), "Table is correct: [✓ Yes 2 \| ✗ No 1]" as plain text, no buttons; tags: chip "working memory +3 −1" with a green band (not "Stroop task": 0 votes are not shown). No pencil icons. |
| A5 | Experiment 1 (no tags). | "Tags: none". The experiment without coordinates ("Empty table") is not shown. |
| A6 | Click the chip "working memory". | A popup opens under the chip: "working memory Cognitive Atlas concepts", "▲ 3 agree  ▼ 1 disagree", "Log in to vote", a "Term page" link, Close. No Agree / Disagree buttons. |
| A7 | Press Esc. | Popup closes; the keyboard focus (visible ring) is back on the chip. Open it again and click on empty page: closes. Open another chip: the first closes (only one popup at a time). |
| A8 | "Study details". | "Stereotaxic space: MNI 2 Talairach 1", "Number of subjects: 20". No input, no buttons. |
| A9 | "Discussion". | "No comments yet". No text box and no Post button. |
| A10 | A "Log in to contribute" box is visible above the MeSH section. | Yes. |
| A11 | `?pmid=99999&mock=1`. | "Article 99999 is not in the database." then "This article is not in the database yet. Log in to add it."; no console error. |
| A12 | `article.html` without pmid. | "No article selected." |
| A13 | Network tab / console. | No request to the Parse server in mock mode (except `config.json`, a 404 is fine). |

## B. Logged-in user (`?pmid=12345&mock=1&as=alice`)

| # | Step | Expected |
|---|---|---|
| B1 | Open the page. | Header: "My collections" and "alice (Log Out)"; "alice" links to https://github.com/alice (new tab); only "Log Out" logs out. The "Log in to contribute" box is hidden. |
| B2 | Experiment "2. Empty table". | Now visible with "This table has no coordinates." (add-row and import prompt) and the same Table correct / Tags controls. |
| B3 | Click the chip "Brain", then **Agree** in its popup (use `latency=1500`). | While waiting the popup buttons are disabled and "Saving…" shows; the chip does not change before the answer. Then the popup shows "▲ 1 agree … including you", Agree is highlighted and pressed, Retract is enabled, and the chip gets a green band and "+1 −0". Focus stays on the Agree button. |
| B4 | **Disagree**. | "0 agree / 1 disagree", Disagree pressed, chip band red, "+0 −1". Click **Retract**: back to 0 / 0, grey band, no count on the chip, Retract disabled. |
| B5 | Click the pressed **Agree** again. | It retracts (back to 0). |
| B6 | Table correct, experiment 0: click "✓ Yes". | "✓ Yes 3", the half is highlighted (pressed). Click "✗ No": "Yes 2, No 2" and the other half is pressed. Click the pressed half again: back to "No 1" (retracted). |
| B7 | Tags, experiment 1: click "+ Add tag". | A picker opens with three buttons (Cognitive Atlas concepts, Cognitive Atlas tasks, BrainMap behavioural domains), a filter box and the term list ("Loading…" first). The "+ Add tag" button is marked expanded. |
| B8 | Type "att" in the filter. | Only matching terms (case-insensitive), e.g. "attention", and in the behavioural list "Cognition.Attention". Clear it: all terms again. A term whose parent equals its own name shows no "(parent)". |
| B9 | Click "attention". | Picker closes, chip "attention +1 −0" appears with a green band. Click the chip, then Retract: the chip disappears and the popup closes. |
| B10 | Picker: select "Cognitive Atlas tasks", click "n-back task". | Chip appears. Switch to behavioural domains: the list changes. |
| B11 | Stereotaxic space: click "Talairach". | "Talairach 2" highlighted (pressed); MNI unchanged. Click "MNI": MNI 3, Talairach 1. Click the pressed one again: retracted. |
| B12 | Number of subjects: leave the box empty or type `abc`, click Save (the blue/orange button). | "Not accepted: enter a whole number between 1 and 100000", nothing sent. Type 18, Save: "18", the votes list shows "18 (1)", a "Retract my vote" button appears; click it: back to 20. |
| B13 | Comments: type `<script>alert(1)</script> hello`, "Post comment". | The comment appears with the exact text, "alice" as link, a date; the box empties; "Discussion (1)". No alert. The text box is dark with readable text. |
| B14 | Post an empty comment. | Message about 1 to 5000 characters; nothing sent. |
| B15 | Post 6 comments in a minute. | The 6th shows "Too many actions, please wait. ..." and the text stays in the box. |
| B16 | Click "Log Out". | Header: "Login with GitHub"; every write control disappears at once; an open popup turns read-only; the hint appears; the empty experiment is hidden; your votes are no longer marked (counts stay). |
| B17 | Click "Login with GitHub" (the mock logs in as "mockuser"). | Header "mockuser (Log Out)"; controls back, nothing marked for the new user. |

## C. Error states (mock)

| # | Step | Expected |
|---|---|---|
| C1 | `...&as=alice&fail=155`: open a chip popup and click Agree. | Red "Too many actions, please wait. ..." in the popup; counts unchanged; buttons enabled again. Same for "✓ Yes" (message beside the segmented control). |
| C2 | `fail=142`. | "Not accepted: Mock failure 142". |
| C3 | `fail=206`. | "Your session has expired. Please log in again." (the mock does not log you out; a real server does, see D8). |
| C4 | Same for picking a tag, the space control, the number of subjects and Post comment. | Same messages; nothing changes in the lists; a posted comment's text stays in the box. |
| C5 | Real server, network offline (D). | "Annotations could not be loaded: Cannot reach the server." with Retry; the article text is still shown. A server that does not answer for 30 s gives "The server did not answer. Please try again." |

## H. Things only a human can check (mock is enough)

| # | Step | Expected |
|---|---|---|
| H1 **(RISK)** | Keyboard only (no mouse): Tab through the page. | Every chip, segmented half, button and field is reached in reading order with a visible focus ring. Enter or Space on a chip opens its popup and moves focus into it; Tab goes through Agree, Disagree, Retract, Close; Enter/Space on Agree votes; Esc closes the popup and returns focus to the chip. |
| H2 **(RISK)** | Narrow window (about 390 px, or the browser's responsive mode). | Chips wrap in several rows without horizontal scrolling. Opening a chip shows the popup as a **sheet at the bottom** of the screen, fully visible, with all buttons reachable; Close and Esc close it. Controls are comfortably tappable. |
| H3 | Chip near the right edge on a wide window. | The popup is not cut off (it may extend to the left of the chip's row; report if part of it is outside the window). |
| H4 | `?theme=light`, then open the page again without the parameter. | Light theme (white page, dark grey text); the choice is remembered. The header logo and the three icons (?, bug, GitHub) are clearly visible dark grey on the cream bar. `?theme=dark` returns to dark. Check chips, popup and segmented controls in both themes. |
| H5 | Firefox and Safari (and Chrome). | Same layout; segmented controls and chips look the same; the focus ring is visible; no console error besides the WebGL / THREE warnings. |
| H6 | Zoom the page to 200 %. | Nothing overlaps; text stays readable. |
| H7 | Press the browser's "reduce motion" setting (OS accessibility), reload. | No transitions on hover/focus. |

## D. Real server (needs the server work packages deployed)

Use a throw-away GitHub account. Open `article.html?pmid=<a PMID in the database>` with no `mock`.

| # | Step | Expected |
|---|---|---|
| D1 | Anonymous: repeat A1 to A9 on a real article (HTML in titles/abstracts, if any, appears as text). | Same as A. Counts include the legacy data (tags, "Table is correct", stereo, number of subjects) when the article has any. |
| D2 | Console: `Object.keys(localStorage)`. | Nothing with a token while anonymous. |
| D3 | Click "Login with GitHub", authorise. | Back on the page: "<login> (Log Out)" where login is your GitHub name (from the server's `me`). |
| D4 | After D3, in the console: `JSON.parse(localStorage.getItem(Object.keys(localStorage).find(k => /currentUser$/.test(k)))).authData`. | `undefined` (token removed from the SDK's stored user). Also `localStorage.getItem("hello")` has no `github` access_token (hello.js session was cleared). Report if either still contains the token. |
| D5 | Reload the page (F5). | Still logged in with the same name (session restored by `Parse.User.current()` + `me`), without going through GitHub. After the reload repeat D4: no `authData`. |
| D6 | Repeat B3 to B15 against the real server. | Same behaviour; reload after each kind of action: your votes, tags, the space, the number of subjects and your comment are still there, highlighted as yours. |
| D7 | Two browsers, two accounts: vote differently on the same MeSH heading. | Counts add up; each browser highlights only its own vote. |
| D8 | In the console run `Parse.User.current().get("sessionToken")` just to confirm there is a user, then invalidate the session on the server (delete the `_Session` row) and press a vote button. | "Your session has expired. Please log in again." and the header goes to "Login with GitHub". Reload: logged out. |
| D9 | Invalidate the session as in D8, then reload instead of pressing a button. | Logged-out UI at load (error 209 from `me`), and `Parse/<appId>/currentUser` is gone from localStorage. |
| D10 | Stop the server (or block it) and reload. | Logged-out UI with the article from cache or an error message "The article could not be loaded"; after restarting the server, reload: logged in again (a network error does not delete the stored session). |
| D11 | Click "Log Out". | "Login with GitHub"; `localStorage` has no `Parse/.../currentUser` with a session and no `hello` github entry; reload: still logged out. |
| D12 | Search for a word on the home page and open results; open the home page. | Home: article count and 5 random articles. Search: results appear, the 3D coactivation map renders and updates; titles with HTML characters appear as plain text. Pressing Enter in the search box navigates to `search.html?q=...` (also with `&` and quotes in the query). |
| D13 | Open an experiment with coordinates. | 3D brain viewer renders (WebGL) with the peaks, as before the change. |
| D14 | Open an article that is not in the database (e.g. `?pmid=1`), logged in. | "Article 1 is not in the database." and the add-article form (see manual-tests-table-edit.md, section C). |

## E. Content-Security-Policy and page checks

| # | Step | Expected |
|---|---|---|
| E1 **(RISK)** | On each page (home, search, article, collections) with the console open, logged out and logged in, dark and light. | No "Refused to ..." CSP messages. If one appears, note the blocked URL or "inline style": the policy in the `<meta>` tag (no `unsafe-inline` for styles) needs a fix. |
| E2 | Login popup (real server). | GitHub login works (the popup is a separate window, not governed by the policy). |
| E3 | `grep -n innerHTML client/*.js client/annotation/*.js client/src/login.js` | Only `dom.js` (comment and the forbidden-attribute list). |

## Riskiest steps

1. E1/D13: the Content-Security-Policy. The pages now have no inline script or inline event
   handler, and scripts are limited to the site plus npmcdn.com, unpkg.com (npmcdn redirects
   there), cdnjs.cloudflare.com, cdn.jsdelivr.net and cdn.rawgit.com (the 3D viewer loads three.js,
   pako, struct.js and mri.js from these at run time). The viewer worker is loaded from the site.
   If the 3D viewer or the Parse SDK breaks, check the console first.
2. D4/D5: removal of the GitHub token from `localStorage`. It rests on the key name pattern
   `Parse/<appId>/currentUser` of SDK 1.9.2 (the SDK source could not be read here) and on the SDK
   still working after `authData` is removed from the stored copy.
3. D3/D5: login and session restore on the real server (needs the `me` cloud function).
4. D12/D13: search and viewers, rewritten from innerHTML to DOM nodes.
