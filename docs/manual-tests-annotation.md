# Manual tests: annotation UI (WP4)

No browser was available when this was written; nothing below has been run in a browser. Run
sections A to C with the mock, then D against a real server. Serve `client/` with any static
server (for the mock no `config.json` is needed), e.g. `cd client && python3 -m http.server 8000`
and open `http://localhost:8000/article.html?pmid=12345&mock=1`. Keep the browser console open;
a Content-Security-Policy violation appears there in red.

Mock URL parameters (see `annotation/api.js`): `mock=1` anonymous; `as=alice` logged in as alice;
`fail=155` (or 142, 206, ...) every write fails with that code; `latency=1500` slows answers so the
"Saving..." state is visible. The mock keeps its data in memory: reloading the page resets it.
Fixture articles: `12345` (legacy votes, 3 experiments, one empty, hostile strings) and `67890`
(plain). Search and the home page need a real server (the mock covers the article page only).

## UI round (read first): what changed in the steps below

The look was redone (see `client/css/README.md`). In the steps of this document:

* A MeSH heading or an ontology tag is a **chip** (a button showing only its name, a coloured band on its left for the balance of votes, and "+a -d" when it has votes). **There are no inline Agree / Disagree buttons**: click the chip (Enter or Space) and one small popup opens under it with the counts (▲ ▼), **Agree**, **Disagree**, **Retract** (disabled while you have no vote; the button matching your vote is pressed) and Close. Wherever a step says "click Agree next to X", open X's popup and click Agree there.
* The popup closes with Esc (focus goes back to the chip), with a click outside, with Close and when another chip is opened. Anonymous users see the counts and "Log in to vote".
* "Table is correct" is one segmented control `[✓ Yes n | ✗ No n]`; clicking the pressed half retracts. The space is `[MNI n | Talairach n]` with the same rule. There is no separate Retract button for them.
* "Add tag" is the dashed chip "+ Add tag".
* Checks to add: Tab reaches every chip, the focus ring is visible, the popup is not cut off at 390px wide (it becomes a sheet at the bottom), `?theme=light` gives the light theme and the choice is remembered on the next page.

## A. Anonymous visitor (`?pmid=12345&mock=1`)

| # | Step | Expected |
|---|---|---|
| A1 | Open the page. | Title "Sample <i>mock</i> article about working memory & attention" shown as plain text (the literal characters `<i>`, no italics). The abstract shows "not bold" literal markup characters and no text "window.__xss". The header says "Login with GitHub", underlined. |
| A2 | Console: type `window.__xss`. | `undefined`. No alert box appeared at any time. |
| A3 | Look at the MeSH section. | Four headings: Brain, Memory, Short-Term, Attention, and one whose name is the literal text `<img src=x onerror=alert(1)>`. Each shows "Agree 0 Disagree 0" as text; no buttons. No broken image icon. |
| A4 | Look at experiment 0. | "Table is correct: Yes 2 No 1" (text only). Tags: chip "working memory +3 -1" (not "Stroop task": 0 votes are not shown). 3D viewer and the five coordinate rows are shown as before. |
| A5 | Experiment 1 (no tags). | "Tags: none". Experiment with no coordinates ("Empty table") is not shown. |
| A6 | Click the chip "working memory". | A panel opens with the name, "Cognitive Atlas concepts", "Agree 3 Disagree 1" as text (no buttons) and a "Term page" link. Close button closes it. |
| A7 | "Study details". | "Stereotaxic space: MNI 2 Talairach 1", "Number of subjects: 20". No input, no buttons. |
| A8 | "Discussion". | "No comments yet". No text box and no Post button. |
| A9 | A "Log in to contribute" box is visible above the MeSH section. | Yes. |
| A10 | `?pmid=99999&mock=1`. | "Article 99999 is not in the database." and nothing else; no error in the console. |
| A11 | `article.html` without pmid. | "No article selected." |
| A12 | Network tab / console. | No request to the Parse server in mock mode (except `config.json`, a 404 is fine). |

## B. Logged-in user (`?pmid=12345&mock=1&as=alice`)

| # | Step | Expected |
|---|---|---|
| B1 | Open the page. | Header: "alice (Log Out)"; "alice" is a link to https://github.com/alice (opens in a new tab); clicking "Log Out" logs out, the rest of the text does nothing. The "Log in to contribute" box is hidden. |
| B2 | The empty experiment "2. Empty table" is now visible with "This table has no coordinates." and the same Table correct / Tags controls. | Yes (it was hidden for anonymous). |
| B3 | Click "Agree" next to Brain. | While waiting (use `latency=1500`) the buttons are disabled and "Saving..." appears; counts do not change before the answer. Then "Agree 1", the button is highlighted, a "Retract" button appears and the tag becomes green. |
| B4 | Click "Disagree" on Brain. | "Agree 0 Disagree 1", tag turns red. Click "Retract": back to 0/0, grey, Retract disappears. |
| B5 | Click the highlighted "Agree" again. | It retracts (back to 0). |
| B6 | Table correct, experiment 0: click "Yes". | "Yes 3 No 1". Click "No": "Yes 2 No 2". Retract: "Yes 2 No 1". |
| B7 | Tags, experiment 1: click "Add tag". | A picker opens with three buttons (Cognitive Atlas concepts, Cognitive Atlas tasks, BrainMap behavioural domains) and a filter box; the list shows the terms ("Loading..." first). |
| B8 | Type "att" in the filter. | Only "attention" and "Cognition.Attention" if that ontology is selected; case-insensitive. Clear the filter: all terms again. |
| B9 | Click "attention". | Picker closes, chip "attention +1 -0" appears. Click the chip: panel with Agree/Disagree/Retract. Retract: the chip disappears. |
| B10 | Select "Cognitive Atlas tasks" in the picker, click "n-back task". | Chip appears with the task. Switch to behavioural domains: the list changes. |
| B11 | Stereotaxic space: click "Talairach". | "Talairach 2", button highlighted; MNI unchanged (2). Click "MNI": MNI 3, Talairach 1. Click the highlighted one again: it is retracted. |
| B12 | Number of subjects: type `abc` (or leave empty) and Save. | Message "Not accepted: enter a whole number between 1 and 100000", nothing sent. Type 18 and Save: value shows 18 and "votes: 18 (1)", a Retract button appears. Retract: back to 20. |
| B13 | Comments: type `<script>alert(1)</script> hello` and Post. | The comment appears with the exact text, "alice" as link, a date; the box is emptied; "Discussion (1)". No alert. |
| B14 | Post an empty comment. | Message about 1 to 5000 characters; nothing sent. |
| B15 | Post 5 comments quickly (more than 5 in a minute). | The 6th shows "Too many actions, please wait. Rate limit exceeded, retry in N s" and the text stays in the box. |
| B16 | Click "Log Out". | Header returns to "Login with GitHub"; write controls disappear at once; the log-in hint appears; the empty experiment is hidden; your highlighted votes are no longer marked (counts stay). |
| B17 | Click "Login with GitHub" (in mock mode it logs in as "mockuser" without GitHub). | Header "mockuser (Log Out)"; controls back, nothing highlighted for the new user. |

## C. Error states (mock)

| # | Step | Expected |
|---|---|---|
| C1 | `...&as=alice&fail=155`, click any vote button. | Red text "Too many actions, please wait. Mock failure 155" next to the buttons; counts unchanged; buttons enabled again. |
| C2 | `fail=142`. | "Not accepted: Mock failure 142". |
| C3 | `fail=206`. | "Your session has expired. Please log in again." Also in the mock this does not log you out (real servers do; see D8). |
| C4 | Same for picking a tag, the stereo buttons, number of subjects and Post comment. | Same messages, nothing changes in the lists, a posted comment's text stays in the box. |
| C5 | Console `fetch`-level: open the page with the network offline (real server, D). | "Annotations could not be loaded: Cannot reach the server." with a Retry button; the article text is still shown. |

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
| D14 | Open an article that is not in the database (e.g. `?pmid=1`). | "Article 1 is not in the database." Nothing else (the add-article flow arrives with a later work package). |

## E. Content-Security-Policy and page checks

| # | Step | Expected |
|---|---|---|
| E1 | On each of the three pages (home, search, article) with the console open. | No "Refused to ..." CSP messages. If one appears, note the blocked URL: the policy in the `<meta>` tag needs that host (riskiest part, see below). |
| E2 | Login popup (real server). | GitHub login works (the popup is a separate window, not governed by the policy). |
| E3 | `grep -n innerHTML client/*.js client/annotation/*.js client/src/login.js` | Only `dom.js` (comment and the forbidden-attribute list). |

## Riskiest steps (not testable without a browser)

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
