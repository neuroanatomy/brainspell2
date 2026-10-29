# Repairing stored article text

`server/scripts/repair-encoding.js` cleans four defects in the `Articles` collection. It talks to
MongoDB directly (not through Parse). It is **safe by default**: with no arguments it only reports.

## The four transforms (applied per string, in this order)

| # | name | what | fields |
|---|---|---|---|
| 1 | `mojibake` | UTF-8 read as Latin-1/cp1252: `MÃ¼ller` -> `Müller`, `Donâ€™t` -> `Don’t`. Only when the whole string converts back to valid UTF-8. | Title, Authors, Abstract, Reference, Experiments[].title, Experiments[].caption, Experiments[].tags[].name, Metadata.meshHeadings[].name |
| 2 | `slashes` | PHP `stripslashes`, one pass, three sequences only: `\'` -> `'`, `\"` -> `"`, `\\` -> `\`. Any other backslash stays. | Title, Authors, Abstract, Reference |
| 3 | `orequals` | `<or=` -> `≤`, `>or=` -> `≥` | Title, Abstract, Reference |
| 4 | `whitespace` | Reference: collapse runs of spaces/tabs, trim, drop a comma before a year group (`RC,   (2007)` -> `RC (2007)`). Title, Authors, Abstract: trim only. | Title, Authors, Abstract, Reference |

`--only mojibake,slashes,orequals,whitespace` selects a subset (default: all four; the order is
always the one above). Nothing else is ever modified: other string fields that would change are
only listed in the report.

## Commands

Environment: `REPAIR_MONGO_URI` (default `mongodb://127.0.0.1:27017/parse`; the database name is
taken from it) and `REPAIR_SOLR_UPDATE_URL` (default `http://localhost:8983/solr/brainspell/update?commit=true`).
Run from `server/`.

```
mongodump --db parse --out ~/backups/before-repair           # first, always

node scripts/repair-encoding.js                              # dry run (same as --dry-run): report only
node scripts/repair-encoding.js --apply --audit-file ~/backups/repair-audit.jsonl
node scripts/repair-encoding.js --revert ~/backups/repair-audit.jsonl
node scripts/repair-encoding.js --solr-only --audit-file ~/backups/repair-audit.jsonl
```

Flags: `--no-solr` (skip the Solr update after `--apply`/`--revert`), `--only <list>`.

* **Dry run** prints one table (transform x field -> strings changed), the number of documents and
  strings that would change, 12 before/after samples per transform (PMID, path, a 40 character window
  around the change), the mojibake strings that could not be repaired, the backslash layouts that
  were skipped as ambiguous, the empty references `()`, and other fields with mojibake. It writes nothing.
* **Apply** needs `--audit-file`; it refuses to overwrite a non-empty file. The audit file (one JSON line
  per changed string: `objectId, pmid, path, before, after, applied, at`) is written and synced **before**
  MongoDB is touched. Updates are `$set` of only the changed paths plus `_updated_at`, in batches of 200,
  and each update only matches if the stored value is still the one that was read. A second `--apply` finds
  nothing to do.
* **Revert** puts back the `before` value of every audit line, only where the current value still equals `after`;
  the others are reported as skipped.
* **Solr**: after `--apply`/`--revert` the changed articles (Title, Authors or Abstract) are re-posted as
  `[{id, Title, Authors, Abstract}]` in batches of 200, with one retry. A Solr failure does not undo the MongoDB
  change: the script exits non-zero and prints the objectIds; `--solr-only --audit-file <file>` posts them again.

The exit code is non-zero on any failure. The MongoDB URI and Solr URL are never printed.

## Known limits

* Strings mixing mojibake with genuine accented text (`MÃ¼ller and Müller`), truncated sequences, or garbling
  that is not UTF-8-as-Latin-1 stay unchanged and are counted ("mixed" / "invalid").
* Ambiguous backslash layouts (two or more backslashes before a quote, or three in a row) are skipped by `slashes`
  and counted, so a deliberately escaped `\\'` is not touched.
* A string that is itself a legitimate `\'` (for example LaTeX) loses the backslash: `slashes` cannot tell.
* `slashes`, `orequals` and `whitespace` do not touch the experiment titles, captions, tag names or MeSH names.
* The audit file holds the full before/after text of every changed string: keep it private (mode 600 is used).
* Parse's own `_updated_at` is set, `updatedAt` seen by clients changes accordingly. Documents whose `_id` is not a string
  (Parse always uses strings) are not supported by `--revert`.
* Run it while the server is quiet; edits made between the scan and the update make that article be skipped (reported).
