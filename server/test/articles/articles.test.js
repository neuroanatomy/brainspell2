const test = require('node:test');
const assert = require('node:assert');
const {withStubs} = require('./stubs');
const {record, EMPTY} = require('./sample-xml');

async function withEnv(fn, records) {
  const env = await withStubs(records || {'16373395': record({})});
  env.add = (params, user) => env.run('addArticle', params, user === undefined ? env.alice : user);
  try {
    await fn(env);
  } finally {
    await env.close();
  }
}

const articles = (env) => env.fake.rows('Articles');

test('addArticle creates the article from PubMed and indexes it in Solr', () => withEnv(async (env) => {
  const out = await env.add({pmid: '16373395', nTables: 2});
  assert.strictEqual(out.pmid, '16373395');
  assert.strictEqual(out.indexed, true);
  const a = articles(env)[0];
  assert.strictEqual(out.objectId, a.id);
  assert.strictEqual(a.PMID, '16373395');
  assert.strictEqual(a.Title, 'Mesial temporal lobe activity & memory');
  assert.strictEqual(a.Authors, 'Abe N,Suzuki M,Tsukiura T,Mori E,Yamaguchi K,Fujii T');
  assert.strictEqual(a.Reference, 'Abe N, Suzuki M, Tsukiura T, Mori E, Yamaguchi K et al. (2006) Cereb. Cortex 16(2):192-9');
  assert.strictEqual(a.DOI, '10.1093/cercor/bhi098');
  assert.strictEqual(a.Abstract, 'Plain abstract.');
  assert.match(a.Timestamp, /^\d{4}-\d{2}-\d{2}$/);
  assert.deepStrictEqual(a.Metadata, {meshHeadings: [{name: 'Brain', majorTopic: 'Y'}, {name: 'Humans', majorTopic: 'N'}]});
  assert.deepStrictEqual(a.Experiments, [
    {id: 1, title: '', caption: '', locations: [], tags: []},
    {id: 2, title: '', caption: '', locations: [], tags: []}
  ]);
  assert.strictEqual(a.rev, 0);
  assert.strictEqual(a.indexed, true);
  assert.deepStrictEqual(a.acl, {'*': {read: true}}, 'public read, no public write');
  assert.deepStrictEqual(env.solr.docs, [{
    id: a.id, Title: a.Title, Authors: a.Authors, Abstract: a.Abstract
  }]);
  assert.strictEqual(env.solr.calls[0].method, 'POST');
  assert.match(env.solr.calls[0].url, /commit=true/);
  assert.match(env.solr.calls[0].type, /json/);
  assert.deepStrictEqual(env.pubmed.calls[0].params, {db: 'pubmed', id: '16373395', retmode: 'xml', tool: 'brainspell'});
}));

test('nTables: default 1, 0 allowed, 50 allowed, 51 and non-integers refused', () => withEnv(async (env) => {
  await env.add({pmid: '1'});
  assert.strictEqual(articles(env)[0].Experiments.length, 1);
  await env.add({pmid: '2', nTables: 0});
  assert.deepStrictEqual(articles(env)[1].Experiments, []);
  await env.add({pmid: '3', nTables: 50});
  assert.strictEqual(articles(env)[2].Experiments.length, 50);
  for (const n of [51, -1, 1.5, '2', null]) {
    await env.expectCode(env.add({pmid: '4', nTables: n}), 142, /nTables/);
  }
  assert.strictEqual(articles(env).length, 3);
}, {1: record({pmid: '1'}), 2: record({pmid: '2'}), 3: record({pmid: '3'}), 4: record({pmid: '4'})}));

test('validation: pmid, unknown parameters', () => withEnv(async (env) => {
  for (const pmid of [undefined, 16373395, '', '1234567890', '12a', ' 12', '12\n', '../x', '1e5']) {
    await env.expectCode(env.add({pmid}), 142, /pmid/);
  }
  await env.expectCode(env.add({pmid: '16373395', title: 'x'}), 142, /title/);
  await env.expectCode(env.add({pmid: '16373395', Experiments: []}), 142);
  assert.strictEqual(env.pubmed.calls.length, 0);
  assert.strictEqual(articles(env).length, 0);
}));

test('anonymous 206, non-GitHub user 119', () => withEnv(async (env) => {
  await env.expectCode(env.add({pmid: '16373395'}, null), 206);
  await env.expectCode(env.add({pmid: '16373395'}, env.fake.addUser(undefined, {username: 'pw'})), 119);
  assert.strictEqual(env.pubmed.calls.length, 0);
}));

test('an existing PMID: 137, PubMed is not asked, nothing changes', () => withEnv(async (env) => {
  env.fake.addArticle({PMID: '16373395', Title: 'old', Experiments: []});
  await env.expectCode(env.add({pmid: '16373395'}), 137);
  assert.strictEqual(env.pubmed.calls.length, 0);
  assert.strictEqual(articles(env).length, 1);
  assert.strictEqual(articles(env)[0].Title, 'old');
}));

test('no PubMed record: 1002 and nothing is created', () => withEnv(async (env) => {
  await env.expectCode(env.add({pmid: '555'}), 1002, /no record/);
  assert.strictEqual(articles(env).length, 0);
  assert.strictEqual(env.solr.calls.length, 0);
}));

test('PubMed failures: 500, invalid XML, closed connection: 1002 and nothing is created', () => withEnv(async (env) => {
  for (const mode of ['error500', 'garbage', 'hang-up']) {
    env.pubmed.state.mode = mode;
    await env.expectCode(env.add({pmid: '16373395'}), 1002);
  }
  assert.strictEqual(articles(env).length, 0);
  assert.strictEqual(env.solr.calls.length, 0);
  env.pubmed.state.mode = 'ok';
  assert.strictEqual((await env.add({pmid: '16373395'})).indexed, true);
}));

test('a record for another PMID or without title is refused', () => withEnv(async (env) => {
  await env.expectCode(env.add({pmid: '16373395'}), 1002);
  await env.expectCode(env.add({pmid: '7'}), 1002);
  assert.strictEqual(articles(env).length, 0);
}, {16373395: record({pmid: '999'}), 7: record({pmid: '7', title: '  '})}));

test('Solr: one retry; two failures leave indexed false and the call still succeeds', () => withEnv(async (env) => {
  env.solr.state.failures = 1;
  const a = await env.add({pmid: '1'});
  assert.strictEqual(a.indexed, true);
  assert.strictEqual(env.solr.calls.length, 2);
  env.solr.state.failures = 2;
  const b = await env.add({pmid: '2'});
  assert.strictEqual(b.indexed, false);
  assert.strictEqual(typeof b.objectId, 'string');
  const rows = articles(env);
  assert.strictEqual(rows.find((r) => r.PMID === '1').indexed, true);
  assert.strictEqual(rows.find((r) => r.PMID === '2').indexed, false);
  assert.strictEqual(env.solr.calls.length, 4);
}, {1: record({pmid: '1'}), 2: record({pmid: '2'})}));

test('Solr unreachable (connection refused): indexed false', () => withEnv(async (env) => {
  process.env.SOLR_UPDATE_URL = 'http://127.0.0.1:1/solr/brainspell/update';
  const out = await env.add({pmid: '16373395'});
  assert.strictEqual(out.indexed, false);
  assert.strictEqual(articles(env)[0].indexed, false);
}));

test('rate limit: 5 per hour per user', () => withEnv(async (env) => {
  for (let i = 1; i <= 5; i++) {
    await env.add({pmid: String(i)});
  }
  await env.expectCode(env.add({pmid: '6'}), 155);
  assert.strictEqual(articles(env).length, 5);
  assert.strictEqual((await env.add({pmid: '6'}, env.bob)).pmid, '6');
}, Object.fromEntries([1, 2, 3, 4, 5, 6].map((i) => [String(i), record({pmid: String(i)})]))));

test('concurrent addArticle of the same PMID: exactly one article', () => withEnv(async (env) => {
  env.pubmed.state.delayMs = 30;
  const results = await Promise.allSettled([
    env.add({pmid: '16373395'}), env.add({pmid: '16373395'}, env.bob), env.add({pmid: '16373395'})
  ]);
  assert.strictEqual(results.filter((r) => r.status === 'fulfilled').length, 1);
  results.filter((r) => r.status === 'rejected').forEach((r) => assert.strictEqual(r.reason.code, 137));
  assert.strictEqual(articles(env).length, 1);
  assert.strictEqual(env.solr.docs.length, 1);
  assert.strictEqual(env.pubmed.calls.length, 1);
}));

test('PubMed text is stored as plain text: markup is dropped, control characters removed', () => withEnv(async (env) => {
  await env.add({pmid: '9'});
  const a = articles(env)[0];
  assert.strictEqual(a.Title, 'Alert(1) done');
  assert.ok(!/[<>]/.test(a.Title));
  assert.strictEqual(typeof a.Experiments[0].title, 'string');
}, {9: record({pmid: '9', title: '<script>Alert(1)</script> done\u0001'.replace('<script>', '<b>').replace('</script>', '</b>')})}));

test('the global PubMed limiter spaces requests', () => withEnv(async (env) => {
  env.lib('pubmed').setMinGap(120);
  await Promise.all([env.add({pmid: '1'}), env.add({pmid: '2'}), env.add({pmid: '3'}, env.bob)]);
  const t = env.pubmed.calls.map((c) => c.time).sort((a, b) => a - b);
  assert.ok(t[1] - t[0] >= 100 && t[2] - t[1] >= 100, `gaps ${t[1] - t[0]}, ${t[2] - t[1]}`);
}, {1: record({pmid: '1'}), 2: record({pmid: '2'}), 3: record({pmid: '3'})}));

test('pubmed.parseRecord: structured abstract, collective author, few authors, MedlineDate, no DOI', async () => {
  const env = await withStubs();
  try {
    const p = env.lib('pubmed');
    const r = await p.parseRecord(record({
      pmid: '5', abstract: [['BACKGROUND', 'Why.'], ['RESULTS', 'What <i>it</i> found.']],
      authors: [['Smith', 'J'], ['Doe', 'A']], issue: '', volume: '3', doi: 'not a doi', mesh: []
    }).replace('<PubDate><Year>2006</Year></PubDate>', '<PubDate><MedlineDate>2004 Jul-Aug</MedlineDate></PubDate>')
      .replace('<Author><LastName>Smith', '<Author><CollectiveName>The Group</CollectiveName></Author><Author><LastName>Smith'), '5');
    assert.strictEqual(r.Abstract, 'BACKGROUND: Why. RESULTS: What it found.');
    assert.strictEqual(r.Authors, 'The Group,Smith J,Doe A');
    assert.strictEqual(r.Reference, 'The Group, Smith J, Doe A (2004) Cereb. Cortex 3:192-9');
    assert.strictEqual(r.DOI, '');
    assert.deepStrictEqual(r.meshHeadings, []);
    assert.strictEqual(await p.parseRecord(EMPTY, '5'), null);
  } finally {
    await env.close();
  }
});
