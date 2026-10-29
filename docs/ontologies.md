# Ontologies (Concept class)

## Provenance

* Repository: https://github.com/r03ert0/brainspell, commit `8822716e630ce163400f7d0c2742ef17ab39aff0`.
* Files: `templates/cogatlas-cognitive.html`, `templates/brainmap-behavioural.html`, `templates/cogatlas-tasks.html`.
* The templates were read as text only (the `var classes=new Array(...)` literal is parsed with regular expressions; nothing is executed).

## Counts (`server/data/ontologies.json`, 950 terms)

| ontology | terms | notes |
|---|---|---|
| `cognitive` (Cognitive Atlas concepts) | 444 | 10 group headings, used as `parent` |
| `behavioural` (BrainMap behavioural domains) | 55 | 6 domains, 15 sub-subdomains |
| `tasks` (Cognitive Atlas tasks) | 451 | flat list |

No duplicates were found inside any ontology (comparison is case-insensitive after trimming and collapsing spaces).

## Format

`ontologies.json` is an array of `{ "ontology": "cognitive"|"behavioural"|"tasks", "name": string, "parent": string|null }`, ordered cognitive, behavioural, tasks, and inside each in template order.

How the original templates mark structure (checked in each template's `configureOntologyModal`):

* **cognitive**: `{superClass:"1",name:G}` is a heading only (not a clickable tag, so it is not a term). The following plain `{name:T}` items are tags. `parent` = the heading G. A term equal to its heading (e.g. `Action` under `Action`) is kept.
* **behavioural**: `{superClass:"1"}` is a top-level domain and is itself a tag (`parent` null). A plain item is a tag whose name is `Domain:Subdomain`; a `{minorClass:"1"}` item is a tag named `Domain:Subdomain:Item`. These composite strings are exactly the tag names the original stored, so legacy tags match. `parent` = the enclosing tag name (`Action`, `Action:Execution`). The composite form also keeps `Action:Execution:Speech` and `Cognition:Language:Speech` apart.
* **tasks**: flat list; the initial-letter headings are only display, so `parent` is null.

## Regenerate and import

```
node server/scripts/extract-ontologies.js <cogatlas-cognitive.html> <brainmap-behavioural.html> <cogatlas-tasks.html> server/data/ontologies.json
PARSE_SERVER_URL=http://localhost:1337/parse PARSE_APP_ID=... PARSE_MASTER_KEY=... node server/scripts/import-ontologies.js
node server/scripts/import-ontologies.js --dry-run     # counts only, no network, no environment needed
```

The import reads all existing `Concept` rows, then creates missing (ontology, name) pairs and updates `parent`/`url` (and `definition`, only if the data has a non-empty one) of existing rows through `POST /batch` (50 per request). Running it twice changes nothing. A stored definition is never replaced by an empty one. The `--dry-run` does no network access, so it cannot know the existing rows and reports every term as a create. The server URL must include the mount path (`/parse`), which is used for the batch sub-requests. Credentials come from the environment only and are never printed.

## `url`

* **Cognitive Atlas (`cognitive`, `tasks`)**: the templates contain no Cognitive Atlas ids and no per-term links (the only URL in them is the site home `http://cognitiveatlas.org`). The stored `url` is therefore a search URL, `https://www.cognitiveatlas.org/search?q=<name>` (name percent-encoded). **UNVERIFIED**: this form was not checked against the live site (no web access was used) and the site may have changed. A real per-term URL needs the Cognitive Atlas ids, which are not in the data.
* **BrainMap (`behavioural`)**: nothing known; the templates only link the home page `http://brainmap.org`. `url` is left empty.

## Known gaps

* No definitions: the templates contain only names, so `definition` is empty for all 950 rows. (The 2015 `Concepts` table of the original had definitions, but it is not available.)
* The original's ~10,300 `Concepts` rows are not reproduced; only what the three templates list.
* The term lists are a 2015 snapshot of the ontologies.

## Cloud functions (`server/cloud/concepts.js`)

`listConcepts({ontology})` -> `[{name, parent}]` and `getConcept({name, ontology})` -> `{name, ontology, definition, url}` (plan 4.3). `name` matching in `getConcept` is normalised (NFC, trim, collapse spaces, case-insensitive) and the canonical name is returned. Errors: 142 validation (unknown parameter, bad ontology, name empty or longer than 200), 101 not found. The per-ontology list is read with the master key and cached in memory for one hour (so a re-import shows up after at most an hour or a server restart). The module is loaded with `require('./concepts')` from `cloud/main.js` (not wired by this work package).

## Tests

`node --test server/test/concepts/`
