# Integration tests (server)

These tests start the **real** `server/app.js` (Parse Server 4.10.2) on a throwaway MongoDB
database and throwaway ports, with a stub standing in for `api.github.com` and one standing
in for Solr. They could not be run where they were written (Parse 4.10.2 does not start on
Node 24/26), so they have never been executed: expect to fix small things on the first run.

## Requirements

* **Node 16** (the VM has 16.14.2; `node:test` does not exist there, so these tests use
  their own tiny runner, `helpers/mini.js`, and only Node 14+ APIs).
* A reachable **MongoDB** (3.4 on the VM; any version Parse 4.10.2's driver supports).
* `server/node_modules` installed (`mongodb` is used only to drop the throwaway database;
  if it cannot be loaded the database is left behind and its name is printed).
* No network access is needed. Nothing talks to GitHub, Solr or the live database.

## Run

From `server/`:

```
TEST_MONGO_URI=mongodb://127.0.0.1:27017 npm run test:integration
# or, one test group / one test (substring of the test name):
TEST_MONGO_URI=mongodb://127.0.0.1:27017 node test/integration/run.js "permissions: Vote"
```

Environment variables (all optional):

| Variable | Default | Meaning |
|---|---|---|
| `TEST_MONGO_URI` | `mongodb://127.0.0.1:27017` | MongoDB server, **without** a database name (the run refuses one). A random database `brainspell_it_<hex>` is created and dropped at the end. |
| `TEST_PARSE_PORT` | `18337` | Port of the Parse server under test |
| `TEST_LIVEQUERY_PORT` | `18080` | LiveQuery port of the server under test |

On the VM use a port and database that cannot collide with the live ones (the defaults do
not: live uses 1337, 8080 and the database `parse`). Keys (application id, master key,
client secret) are random per run and live in a temporary config file (mode 600) that is
deleted at the end. The run exits with status 1 if any test fails, and prints the tail of the
server's output when something failed.

## What happens

1. `helpers/harness.js` writes a test config (`allowClientClassCreation: false`,
   `enableAnonymousUsers: false`, `auth.github.module` = `helpers/github-adapter.js`, which
   validates GitHub authData against the stub instead of api.github.com), then spawns
   `node app.js` with `CONFIG`, `PORT`, `LIVEQUERY_PORT`, `GITHUB_API_URL` (stub, read by
   `lib/github.js` for the `me` function) and `SOLR_URL` (stub, read by `cloud/select.js`).
   This also tests the environment handling of `app.js` and the glob loader `cloud/main.js`.
2. It runs `scripts/apply-schema.js` once (credentials only through the environment).
3. The test files run in alphabetical order, in one process, sharing the server.

| File | Covers |
|---|---|
| `annotations.test.js` | `me`, identity cannot be forged, vote / retract / revote through REST, `setStereoSpace`, `setNSubjects`, concurrent votes by one user (exactly one row), `postComment`, rate limit 155, `select` hardening |
| `login.test.js` | GitHub login (create, login again, `/users/me`, `/sessions/me`, logout) with the closed `_User` CLP; password / anonymous / empty / forged authData signups refused |
| `permissions.test.js` | find, get, count, create, update, delete, addField as anonymous, user A and user B on **every** class of `schema.js` plus `_Session`; schema endpoints; batch; new class creation |
| `schema.test.js` | `apply-schema` run again twice changes nothing, drifted CLP is restored, `--dry-run`, `dedupe-votes.js` |

## What the orchestrator must check

* **`_User` CLP (plan 3.2).** The matrix expects `_User` find/get/count/update/delete/addField
  refused for others and `create` open. `login.test.js` has one INFORMATIONAL test that
  prints (does not assert) whether `GET /users/<own id>` and `PUT /users/<own id>` (what
  `Parse.User.current().fetch()` and `_linkWith` use) work with the closed CLP. If the real
  browser login breaks, apply the smallest CLP change (probably `get` for the owner) and
  record it in `server/schema.js` and the plan.
* **authData on the server side.** `lib/auth.js` reads `authData.github` of `request.user`
  after fetching the user with the master key. If every write function answers 119
  ("A GitHub account is required") for a correctly logged in user, that read is the cause
  (the tests `me`, `vote ...` in `annotations.test.js` show it first).
* **`beforeSave` on `_User`** (`cloud/auth.js`) must not break login of existing users;
  `login.test.js` covers create and login-again.
* **Indexes.** Parse 4.10.2 indexes the literal field name `createdAt` for
  `Comment(pmid, createdAt)`, not Mongo's `_created_at`; only the `pmid` prefix helps. Not
  an error, just a known limitation.
* The `_Session` rows of the **same** user stay visible to him (the SDK needs it); the test
  only requires that nobody can see, change or delete somebody else's.
* `GET /installations`, `/roles` and `/users` for non-master callers are expected to be
  refused; if a Parse default differs, the failing assertion names the endpoint.
* `package.json` lists `mongodb` as a devDependency (it was only transitive); the lock
  file was not regenerated (no network). Run `npm install` once on a connected machine.
