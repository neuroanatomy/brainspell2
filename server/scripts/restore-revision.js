#!/usr/bin/env node
// Restore experiments of an article from a Revision's `before` image.
//
//   node scripts/restore-revision.js [--dry-run] <PMID> <rev> [<experimentId>]
//
//   <rev>           the Revision to undo: its `before` image is put back
//   <experimentId>  restore only that experiment (default: every experiment in the image)
//
// Experiments in the image replace the ones with the same id; experiments that were created
// by the revision (split halves) are left alone. The article gets rev + 1 and a new, applied
// Revision describing the restore. Only applied Revisions can be restored.
// Credentials: PARSE_URL, PARSE_APP_ID, PARSE_MASTER_KEY (environment only, never printed).
// Run it while the server is quiet: the article is read and written without the server's lock.

const {request} = require('../lib/rest');

const enc = encodeURIComponent;

async function main(argv) {
  const dry = argv.includes('--dry-run');
  const args = argv.filter((a) => a !== '--dry-run');
  if (args.length < 2 || args.length > 3 || !/^[0-9]{1,9}$/.test(args[0]) || !/^[0-9]{1,9}$/.test(args[1]) ||
    (args[2] !== undefined && !/^[0-9]{1,9}$/.test(args[2]))) {
    throw new Error('usage: restore-revision.js [--dry-run] <PMID> <rev> [<experimentId>]');
  }
  const [pmid, revText, expText] = args;
  const rev = Number(revText);
  const only = expText === undefined ? null : Number(expText);

  const rq = await request('GET', `/classes/Revision?where=${enc(JSON.stringify({pmid, rev}))}&limit=20`);
  if (rq.status !== 200 || !rq.json) {
    throw new Error(`Parse answered ${rq.status} when reading the revision`);
  }
  const applied = rq.json.results.filter((r) => r.applied !== false);
  if (applied.length !== 1) {
    throw new Error(`expected exactly one applied revision ${rev} of article ${pmid}, found ${applied.length}`);
  }
  const revision = applied[0];
  const image = (Array.isArray(revision.before) ? revision.before : []).filter((e) => only === null || Number(e.id) === only);
  if (!image.length) {
    throw new Error(only === null ? 'the revision has no before image' : `experiment ${only} is not in the before image`);
  }

  const aq = await request('GET', `/classes/Articles?where=${enc(JSON.stringify({PMID: pmid}))}&limit=2`);
  if (aq.status !== 200 || !aq.json || aq.json.results.length !== 1) {
    throw new Error('article not found (or not unique)');
  }
  const article = aq.json.results[0];
  const current = Array.isArray(article.Experiments) ? article.Experiments : [];
  const beforeNow = [];
  const next = current.slice();
  image.forEach((exp) => {
    const at = next.findIndex((e) => e && Number(e.id) === Number(exp.id));
    if (at >= 0) {
      beforeNow.push(current[at]);
      next[at] = exp;
    } else {
      beforeNow.push({id: exp.id, missing: true});
      next.push(exp);
    }
  });
  const newRev = (typeof article.rev === 'number' ? article.rev : 0) + 1;
  console.log(`article ${pmid}: restore ${image.length} experiment(s) [${image.map((e) => e.id).join(', ')}] from revision ${rev}; ` +
    `article rev ${newRev - 1} -> ${newRev}`);
  if (dry) {
    console.log('Dry run: nothing was written.');

    return;
  }

  const created = await request('POST', '/classes/Revision', {
    pmid, rev: newRev, user: 'restore-script', login: 'restore-script',
    ops: [{op: 'restore', fromRev: rev}], before: beforeNow, applied: false, ACL: {}
  });
  if (created.status !== 201) {
    throw new Error(`could not write the revision (${created.status})`);
  }
  const upd = await request('PUT', `/classes/Articles/${enc(article.objectId)}`, {Experiments: next, rev: newRev});
  if (upd.status !== 200) {
    throw new Error(`could not update the article (${upd.status}); the new revision stays unapplied`);
  }
  const done = await request('PUT', `/classes/Revision/${enc(created.json.objectId)}`, {applied: true});
  if (done.status !== 200) {
    throw new Error(`article restored, but marking the revision applied answered ${done.status}`);
  }
  console.log('Restored.');
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(e.message);
    process.exitCode = 1;
  });
}

module.exports = {main};
