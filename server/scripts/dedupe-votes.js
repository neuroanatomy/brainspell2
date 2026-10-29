#!/usr/bin/env node
// Remove duplicate Vote rows (same user, article and key), keeping the newest one.
// Reading already ignores the older rows; this only cleans the database.
//
//   PARSE_URL=... PARSE_APP_ID=... PARSE_MASTER_KEY=... node scripts/dedupe-votes.js          (report only)
//   PARSE_URL=... PARSE_APP_ID=... PARSE_MASTER_KEY=... node scripts/dedupe-votes.js --apply  (delete)
//
// Run it while the server is quiet, or accept that a vote made meanwhile may be seen late.

const {latestPerKey} = require('../lib/votes-logic');

async function loadAll(rest) {
  const rows = [];
  const limit = 1000;
  for (let skip = 0; ; skip += limit) {
    const res = await rest.request('GET', `/classes/Vote?limit=${limit}&skip=${skip}&order=objectId`);
    if (res.status !== 200 || !res.json || !Array.isArray(res.json.results)) {
      throw new Error(`GET /classes/Vote answered ${res.status}`);
    }
    for (const o of res.json.results) {
      rows.push({
        id: o.objectId, pmid: o.pmid, user: o.user, experimentId: o.experimentId, kind: o.kind,
        ontology: o.ontology || null, tag: typeof o.tag === 'string' ? o.tag : '',
        updatedAt: Date.parse(o.updatedAt || o.createdAt) || 0
      });
    }
    if (res.json.results.length < limit) {
      return rows;
    }
  }
}

/**
 * Ids of the rows to delete.
 * @param {Object[]} rows Plain Vote rows of all articles
 * @returns {string[]} Object ids of the older duplicates
 */
function findDuplicates(rows) {
  const byPmid = new Map();
  for (const r of rows) {
    if (!byPmid.has(r.pmid)) {
      byPmid.set(r.pmid, []);
    }
    byPmid.get(r.pmid).push(r);
  }
  const doomed = [];
  for (const list of byPmid.values()) {
    const keep = new Set(latestPerKey(list).map((r) => r.id));
    list.forEach((r) => {
      if (!keep.has(r.id)) {
        doomed.push(r.id);
      }
    });
  }

  return doomed;
}

async function main() {
  const rest = require('../lib/rest');
  rest.config();
  const apply = process.argv.includes('--apply');
  const rows = await loadAll(rest);
  const doomed = findDuplicates(rows);
  console.log(`${rows.length} votes, ${doomed.length} duplicates`);
  if (!apply) {
    console.log('Report only. Use --apply to delete them.');

    return 0;
  }
  for (const id of doomed) {
    const res = await rest.request('DELETE', `/classes/Vote/${encodeURIComponent(id)}`);
    if (res.status !== 200) {
      throw new Error(`DELETE of ${id} answered ${res.status}`);
    }
  }
  console.log(`${doomed.length} deleted.`);

  return 0;
}

if (require.main === module) {
  main().then((code) => {
    process.exitCode = code;
  }, (e) => {
    console.error(e.message);
    process.exitCode = 1;
  });
}

module.exports = {findDuplicates};
