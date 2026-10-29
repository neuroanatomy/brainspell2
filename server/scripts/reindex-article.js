#!/usr/bin/env node
// Re-post articles to Solr.   node scripts/reindex-article.js [--dry-run] <PMID | --all>
//   <PMID>   re-index that article
//   --all    re-index every article with indexed=false
//   --dry-run  list what would be posted, change nothing
// Parse credentials come from PARSE_URL, PARSE_APP_ID and PARSE_MASTER_KEY, and the Solr
// update URL from SOLR_UPDATE_URL (default: the local core). Nothing secret is printed.

const {request} = require('../lib/rest');
const solr = require('../lib/solr');

const FIELDS = 'objectId,PMID,Title,Authors,Abstract,indexed';

async function fetchPage(where) {
  const q = `where=${encodeURIComponent(JSON.stringify(where))}&keys=${FIELDS}&order=objectId&limit=100`;
  const res = await request('GET', `/classes/Articles?${q}`);
  if (res.status !== 200 || !res.json || !Array.isArray(res.json.results)) {
    throw new Error(`Parse answered ${res.status} when reading articles`);
  }

  return res.json.results;
}

async function reindex(a, dryRun) {
  const label = `${a.PMID} (${a.objectId})`;
  if (dryRun) {
    console.log(`would index ${label}`);

    return true;
  }
  const ok = await solr.index({
    id: a.objectId, Title: a.Title || '', Authors: a.Authors || '', Abstract: a.Abstract || ''
  });
  if (!ok) {
    console.log(`FAILED  ${label}: Solr did not accept the document`);

    return false;
  }
  const res = await request('PUT', `/classes/Articles/${a.objectId}`, {indexed: true});
  if (res.status !== 200) {
    console.log(`indexed but could not set indexed=true for ${label} (Parse answered ${res.status})`);

    return false;
  }
  console.log(`indexed ${label}`);

  return true;
}

async function main(argv) {
  const dryRun = argv.includes('--dry-run');
  const rest = argv.filter((a) => a !== '--dry-run');
  const all = rest.includes('--all');
  const pmids = rest.filter((a) => a !== '--all');
  if ((all && pmids.length) || (!all && pmids.length !== 1) || pmids.some((p) => !/^[0-9]{1,9}$/.test(p))) {
    console.log('usage: reindex-article.js [--dry-run] <PMID | --all>');

    return 2;
  }
  let done = 0;
  let failed = 0;
  if (!all) {
    const list = await fetchPage({PMID: pmids[0]});
    if (!list.length) {
      console.log(`no article with PMID ${pmids[0]}`);

      return 1;
    }
    (await reindex(list[0], dryRun)) ? done++ : failed++;
  } else {
    let last = '';
    for (;;) {
      const where = last ? {indexed: false, objectId: {$gt: last}} : {indexed: false};
      const list = await fetchPage(where);
      if (!list.length) {
        break;
      }
      for (const a of list) {
        (await reindex(a, dryRun)) ? done++ : failed++;
        last = a.objectId;
      }
    }
  }
  console.log(`${dryRun ? 'would index' : 'indexed'}: ${done}, failed: ${failed}`);

  return failed ? 1 : 0;
}

main(process.argv.slice(2)).then((code) => process.exit(code), (e) => {
  console.log(`error: ${e.message}`);
  process.exit(1);
});
