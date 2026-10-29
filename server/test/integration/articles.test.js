// addArticle through the real REST API, with stubs for PubMed and Solr's update handler,
// and scripts/reindex-article.js.

const assert = require('assert');
const {test} = require('./helpers/mini');
const {record} = require('../articles/sample-xml');

const ok = (res, what) => {
  assert.strictEqual(res.status, 200, `${what}: ${res.status} ${res.text}`);

  return res.json.result;
};
const code = (res, c, what) => {
  assert.ok(res.status >= 400, `${what}: expected failure, got ${res.status} ${res.text}`);
  assert.strictEqual(res.json.code, c, `${what}: ${res.text}`);
};
const where = (o) => encodeURIComponent(JSON.stringify(o));
const articlesOf = async (ctx, pmid) => (await ctx.rest('GET', `/classes/Articles?where=${where({PMID: pmid})}`, {master: true})).json.results;

test('addArticle: full flow (PubMed record, public read, Solr, annotations work)', async (ctx) => {
  const u = ctx.art = {alice: await ctx.signup('art-alice', 9101), bob: await ctx.signup('art-bob', 9102)};
  ctx.pubmed.records['7001'] = record({pmid: '7001'});
  code(await ctx.cloud('addArticle', {pmid: '7001'}), 206, 'anonymous');
  code(await ctx.cloud('addArticle', {pmid: '7001', Title: 'x'}, u.alice.session), 142, 'unknown parameter');
  code(await ctx.cloud('addArticle', {pmid: 7001}, u.alice.session), 142, 'pmid number');
  code(await ctx.cloud('addArticle', {pmid: '7001', nTables: 51}, u.alice.session), 142, 'nTables');
  assert.strictEqual(ctx.pubmed.calls.length, 0, 'nothing asked from PubMed for refused calls');
  const out = ok(await ctx.cloud('addArticle', {pmid: '7001', nTables: 2}, u.alice.session), 'addArticle');
  assert.strictEqual(out.pmid, '7001');
  assert.strictEqual(out.indexed, true);
  const rows = await articlesOf(ctx, '7001');
  assert.strictEqual(rows.length, 1);
  const a = rows[0];
  assert.strictEqual(a.objectId, out.objectId);
  assert.strictEqual(a.Title, 'Mesial temporal lobe activity & memory');
  assert.strictEqual(a.Reference, 'Abe N, Suzuki M, Tsukiura T, Mori E, Yamaguchi K et al. (2006) Cereb. Cortex 16(2):192-9');
  assert.strictEqual(a.DOI, '10.1093/cercor/bhi098');
  assert.strictEqual(a.rev, 0);
  assert.strictEqual(a.indexed, true);
  assert.strictEqual(a.Experiments.length, 2);
  assert.deepStrictEqual(a.Experiments[1], {id: 2, title: '', caption: '', locations: [], tags: []});
  assert.deepStrictEqual(a.Metadata.meshHeadings[0], {name: 'Brain', majorTopic: 'Y'});
  assert.deepStrictEqual(a.ACL, {'*': {read: true}});
  assert.deepStrictEqual(ctx.pubmed.calls[0], {db: 'pubmed', id: '7001', retmode: 'xml', tool: 'brainspell'});
  assert.strictEqual(ctx.solrUpdate.docs.length, 1);
  assert.deepStrictEqual(ctx.solrUpdate.docs[0], {id: out.objectId, Title: a.Title, Authors: a.Authors, Abstract: a.Abstract});
  // anyone can read it, nobody (but the master key) can write it
  const pub = await ctx.rest('GET', `/classes/Articles/${out.objectId}`);
  assert.strictEqual(pub.status, 200);
  for (const [who, opts] of [['anonymous', {}], ['alice', {session: u.alice.session}]]) {
    const upd = await ctx.rest('PUT', `/classes/Articles/${out.objectId}`, Object.assign({body: {Title: 'hacked'}}, opts));
    assert.ok(upd.status >= 400, `${who} updated the article`);
    const del = await ctx.rest('DELETE', `/classes/Articles/${out.objectId}`, opts);
    assert.ok(del.status >= 400, `${who} deleted the article`);
  }
  assert.strictEqual((await articlesOf(ctx, '7001'))[0].Title, a.Title);
  // the annotation functions work on the new article
  const ann = ok(await ctx.cloud('getAnnotations', {pmid: '7001'}), 'getAnnotations');
  assert.strictEqual(ann.rev, 0);
  assert.strictEqual(ok(await ctx.cloud('vote', {pmid: '7001', kind: 'mesh', tag: 'brain', value: 1}, u.bob.session), 'vote').agree, 1);
});

test('addArticle: existing PMID is 137; PubMed without record or failing is 1002 and creates nothing', async (ctx) => {
  const {alice, bob} = ctx.art;
  code(await ctx.cloud('addArticle', {pmid: '7001'}, bob.session), 137, 'exists');
  code(await ctx.cloud('addArticle', {pmid: '7002'}, alice.session), 1002, 'no record');
  assert.strictEqual((await articlesOf(ctx, '7002')).length, 0);
  ctx.pubmed.records['7003'] = record({pmid: '7003'});
  ctx.pubmed.mode = 'error500';
  code(await ctx.cloud('addArticle', {pmid: '7003'}, alice.session), 1002, 'PubMed 500');
  ctx.pubmed.mode = 'ok';
  assert.strictEqual((await articlesOf(ctx, '7003')).length, 0);
  const docs = ctx.solrUpdate.docs.length;
  assert.strictEqual(docs, 1, 'nothing was posted to Solr for the failures');
  // the PubMed failure left no lock behind: the same PMID works now
  assert.strictEqual(ok(await ctx.cloud('addArticle', {pmid: '7003', nTables: 0}, alice.session), 'retry').indexed, true);
  assert.deepStrictEqual((await articlesOf(ctx, '7003'))[0].Experiments, []);
});

test('addArticle: concurrent calls for one PMID create exactly one article', async (ctx) => {
  const u = {a: await ctx.signup('art-c1', 9111), b: await ctx.signup('art-c2', 9112), c: await ctx.signup('art-c3', 9113)};
  ctx.pubmed.records['7010'] = record({pmid: '7010'});
  ctx.pubmed.delayMs = 150;
  const before = ctx.pubmed.calls.length;
  const res = await Promise.all([u.a, u.b, u.c, u.a].map((x) => ctx.cloud('addArticle', {pmid: '7010'}, x.session)));
  ctx.pubmed.delayMs = 0;
  const good = res.filter((r) => r.status === 200);
  const bad = res.filter((r) => r.status !== 200);
  assert.strictEqual(good.length, 1, res.map((r) => r.text).join(' | '));
  bad.forEach((r) => assert.strictEqual(r.json.code, 137));
  assert.strictEqual((await articlesOf(ctx, '7010')).length, 1);
  assert.strictEqual(ctx.pubmed.calls.length - before, 1, 'PubMed was asked once');
  assert.strictEqual(ctx.solrUpdate.docs.filter((d) => d.id === good[0].json.result.objectId).length, 1);
});

test('addArticle: Solr failure keeps indexed=false, the call succeeds; reindex-article.js repairs it', async (ctx) => {
  const {alice} = ctx.art;
  ctx.pubmed.records['7020'] = record({pmid: '7020', title: 'Needs reindexing'});
  ctx.solrUpdate.failures = 2;
  const out = ok(await ctx.cloud('addArticle', {pmid: '7020'}, alice.session), 'addArticle with Solr down');
  assert.strictEqual(out.indexed, false);
  assert.strictEqual((await articlesOf(ctx, '7020'))[0].indexed, false);
  assert.ok(!ctx.solrUpdate.docs.some((d) => d.id === out.objectId));
  // dry run: lists it, changes nothing
  const dry = await ctx.runScript('reindex-article.js', ['--dry-run', '--all']);
  assert.strictEqual(dry.code, 0, dry.stdout + dry.stderr);
  assert.ok(dry.stdout.includes('would index 7020'), dry.stdout);
  assert.strictEqual((await articlesOf(ctx, '7020'))[0].indexed, false);
  assert.ok(!ctx.solrUpdate.docs.some((d) => d.id === out.objectId));
  // the secrets are not printed
  assert.ok(!(dry.stdout + dry.stderr).includes(ctx.masterKey));
  // real run for one article
  const bad = await ctx.runScript('reindex-article.js', ['12x']);
  assert.notStrictEqual(bad.code, 0);
  const run = await ctx.runScript('reindex-article.js', ['7020']);
  assert.strictEqual(run.code, 0, run.stdout + run.stderr);
  assert.strictEqual((await articlesOf(ctx, '7020'))[0].indexed, true);
  const doc = ctx.solrUpdate.docs.find((d) => d.id === out.objectId);
  assert.strictEqual(doc.Title, 'Needs reindexing');
  // --all with nothing left to do
  const all = await ctx.runScript('reindex-article.js', ['--all']);
  assert.strictEqual(all.code, 0, all.stdout);
  assert.ok(all.stdout.includes('indexed: 0'), all.stdout);
});

test('addArticle: 5 per hour per user (155)', async (ctx) => {
  const u = await ctx.signup('art-rate', 9120);
  for (let i = 0; i < 5; i++) {
    ctx.pubmed.records[`71${i}0`] = record({pmid: `71${i}0`});
    ok(await ctx.cloud('addArticle', {pmid: `71${i}0`}, u.session), `add ${i}`);
  }
  ctx.pubmed.records['7160'] = record({pmid: '7160'});
  code(await ctx.cloud('addArticle', {pmid: '7160'}, u.session), 155, 'sixth');
  assert.strictEqual((await articlesOf(ctx, '7160')).length, 0);
});
