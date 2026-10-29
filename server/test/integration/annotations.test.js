// Cloud functions through the real REST API: me, getAnnotations, vote, setStereoSpace,
// setNSubjects, postComment, and the hardened select.

const assert = require('assert');
const {test} = require('./helpers/mini');

const ARTICLE = {
  PMID: '424242',
  Title: 'Integration article',
  Experiments: [
    {id: 1, title: 'e1', caption: 'c', locations: ['1,2,3'], markBadTable: {ok: 2, bad: 1}, tags: [
      {name: 'Memory', ontology: 'cognitive', agree: 3, disagree: 1}
    ]},
    {id: 2, title: 'e2', caption: 'c', locations: [], tags: []}
  ],
  Metadata: {meshHeadings: [{name: 'Brain', majorTopic: true}, {name: 'Humans', majorTopic: false}], stereo: {MNI: 2, Talairach: 0}, nsubjects: 20}
};

const ok = (res, what) => {
  assert.strictEqual(res.status, 200, `${what}: ${res.status} ${res.text}`);

  return res.json.result;
};
const code = (res, c, what) => {
  assert.ok(res.status >= 400, `${what}: expected failure, got ${res.status}`);
  assert.strictEqual(res.json.code, c, `${what}: ${res.text}`);
};

test('annotations: setup (article, concept, users)', async (ctx) => {
  const art = await ctx.rest('POST', '/classes/Articles', {master: true, body: ARTICLE});
  assert.strictEqual(art.status, 201, art.text);
  const con = await ctx.rest('POST', '/classes/Concept', {master: true, body: {name: 'Attention', ontology: 'cognitive'}});
  assert.strictEqual(con.status, 201, con.text);
  ctx.ann = {alice: await ctx.signup('alice', 8001), bob: await ctx.signup('bob', 8002)};
});

test('me: anonymous gets null; a GitHub user gets the login that GitHub reports; profile is private', async (ctx) => {
  const {alice} = ctx.ann;
  assert.strictEqual(ok(await ctx.cloud('me', {}), 'me anonymous'), null);
  const me = ok(await ctx.cloud('me', {}, alice.session), 'me alice');
  assert.deepStrictEqual(me, {id: alice.id, login: 'alice', githubId: 8001});
  code(await ctx.cloud('me', {login: 'root'}, alice.session), 142, 'me with a login parameter');
  const profiles = (await ctx.rest('GET', '/classes/UserProfile', {master: true})).json.results;
  const mine = profiles.filter((p) => p.user === alice.id);
  assert.strictEqual(mine.length, 1);
  assert.strictEqual(mine[0].login, 'alice');
  assert.strictEqual(mine[0].githubId, 8001);
  assert.ok(!mine[0].ACL || !mine[0].ACL['*'], 'profile has a public ACL');
  assert.ok(ctx.githubCalls.length > 0, 'the stub GitHub was asked (GITHUB_API_URL)');
  code(await ctx.rest('GET', '/classes/UserProfile', {session: alice.session}), 119, 'user reads UserProfile');
  // calling me again does not duplicate the profile
  ok(await ctx.cloud('me', {}, alice.session), 'me again');
  const again = (await ctx.rest('GET', '/classes/UserProfile', {master: true})).json.results.filter((p) => p.user === alice.id);
  assert.strictEqual(again.length, 1);
});

test('identity: the login name cannot be forged, writes need login', async (ctx) => {
  const {alice} = ctx.ann;
  const p = {pmid: '424242', experimentId: 2, kind: 'tableOk', value: 1};
  code(await ctx.cloud('vote', p), 206, 'anonymous vote');
  code(await ctx.cloud('vote', Object.assign({login: 'bob'}, p), alice.session), 142, 'forged login');
  code(await ctx.cloud('vote', Object.assign({user: 'bob'}, p), alice.session), 142, 'forged user');
  code(await ctx.cloud('postComment', {pmid: '424242', text: 'x'}), 206, 'anonymous comment');
  code(await ctx.cloud('setStereoSpace', {pmid: '424242', space: 'MNI'}), 206, 'anonymous space');
  code(await ctx.cloud('setNSubjects', {pmid: '424242', n: 5}), 206, 'anonymous nsubjects');
  const rows = (await ctx.rest('GET', '/classes/Vote?where=' + encodeURIComponent(JSON.stringify({pmid: '424242'})), {master: true})).json.results;
  assert.strictEqual(rows.length, 0);
});

test('vote / retract / revote through REST', async (ctx) => {
  const {alice, bob} = ctx.ann;
  const v = (value, who, extra) => ctx.cloud('vote', Object.assign({pmid: '424242', experimentId: 1, kind: 'tag', ontology: 'cognitive', tag: 'memory', value}, extra), who.session);
  assert.deepStrictEqual(ok(await v(1, alice), 'first'), {kind: 'tag', experimentId: 1, ontology: 'cognitive', tag: 'Memory', agree: 4, disagree: 1, mine: 1});
  assert.strictEqual(ok(await v(1, alice), 'double').agree, 4);
  assert.deepStrictEqual(ok(await v(-1, alice), 'flip').mine, -1);
  assert.strictEqual(ok(await v(-1, bob), 'bob').disagree, 3);
  const ann = ok(await ctx.cloud('getAnnotations', {pmid: '424242'}, alice.session), 'getAnnotations');
  const mem = ann.votes.find((x) => x.tag === 'Memory');
  assert.deepStrictEqual([mem.agree, mem.disagree, mem.mine], [3, 3, -1]);
  assert.strictEqual(ok(await ctx.cloud('getAnnotations', {pmid: '424242'}), 'anon').votes.find((x) => x.tag === 'Memory').mine, 0);
  assert.strictEqual(ok(await v(0, alice), 'retract').mine, 0);
  assert.strictEqual(ok(await v(0, alice), 'retract again').mine, 0);
  assert.strictEqual(ok(await v(1, alice), 'revote').agree, 4);
  // a tag from Concept, a table vote, mesh vote
  assert.strictEqual(ok(await v(1, alice, {experimentId: 2, tag: 'ATTENTION'}), 'concept tag').tag, 'Attention');
  code(await v(1, alice, {tag: 'Not a term'}), 142, 'unknown term');
  assert.strictEqual(ok(await ctx.cloud('vote', {pmid: '424242', kind: 'mesh', tag: 'brain', value: -1}, alice.session), 'mesh').disagree, 1);
  assert.strictEqual(ok(await ctx.cloud('vote', {pmid: '424242', experimentId: 1, kind: 'tableOk', value: 1}, bob.session), 'tableOk').agree, 3);
  // storage: one row per key, private ACL, owner and login set by the server
  const where = encodeURIComponent(JSON.stringify({pmid: '424242', user: alice.id, kind: 'tag', experimentId: 1}));
  const rows = (await ctx.rest('GET', '/classes/Vote?where=' + where, {master: true})).json.results;
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].login, 'alice');
  assert.ok(!rows[0].ACL || !rows[0].ACL['*'], 'Vote has a public ACL');
  // nobody reads or writes Vote directly
  for (const who of [undefined, alice.session, bob.session]) {
    assert.ok((await ctx.rest('GET', '/classes/Vote', {session: who})).status >= 400);
    assert.ok((await ctx.rest('PUT', '/classes/Vote/' + rows[0].objectId, {session: who, body: {value: 1}})).status >= 400);
    assert.ok((await ctx.rest('DELETE', '/classes/Vote/' + rows[0].objectId, {session: who})).status >= 400);
  }
});

test('setStereoSpace and setNSubjects through REST', async (ctx) => {
  const {alice, bob} = ctx.ann;
  assert.deepStrictEqual(ok(await ctx.cloud('setStereoSpace', {pmid: '424242', space: 'Talairach'}, alice.session), 's1'), {MNI: 2, Talairach: 1, mine: 'Talairach'});
  assert.deepStrictEqual(ok(await ctx.cloud('setStereoSpace', {pmid: '424242', space: 'MNI'}, alice.session), 's2'), {MNI: 3, Talairach: 0, mine: 'MNI'});
  assert.deepStrictEqual(ok(await ctx.cloud('setStereoSpace', {pmid: '424242', space: null}, alice.session), 's3'), {MNI: 2, Talairach: 0, mine: null});
  code(await ctx.cloud('setStereoSpace', {pmid: '424242', space: 'mni'}, alice.session), 142, 'bad space');
  assert.strictEqual(ok(await ctx.cloud('setNSubjects', {pmid: '424242', n: 12}, alice.session), 'n1').value, 12);
  assert.strictEqual(ok(await ctx.cloud('setNSubjects', {pmid: '424242', n: 15}, alice.session), 'n2').mine, 15);
  const r = ok(await ctx.cloud('setNSubjects', {pmid: '424242', n: 15}, bob.session), 'n3');
  assert.deepStrictEqual(r.values, [{n: 15, count: 2}]);
  code(await ctx.cloud('setNSubjects', {pmid: '424242', n: 0}, alice.session), 142, 'n=0');
  code(await ctx.cloud('setNSubjects', {pmid: '424242', n: '12'}, alice.session), 142, 'n as string');
  const rows = (await ctx.rest('GET', '/classes/Vote?where=' + encodeURIComponent(JSON.stringify({user: alice.id, kind: 'nsubjects'})), {master: true})).json.results;
  assert.strictEqual(rows.length, 1);
});

test('concurrent votes by the same user leave exactly one row', async (ctx) => {
  const carol = await ctx.signup('carol', 8003);
  const call = (value) => ctx.cloud('vote', {pmid: '424242', experimentId: 2, kind: 'tableOk', value}, carol.session);
  const values = [1, -1, 1, 1, -1, 0, 1, 1, -1, 1, 1, 1, 0, 1, -1, 1, 1, -1, 1, 1];
  const results = await Promise.all(values.map(call));
  results.forEach((r, i) => assert.strictEqual(r.status, 200, `call ${i}: ${r.text}`));
  const where = encodeURIComponent(JSON.stringify({pmid: '424242', user: carol.id, kind: 'tableOk', experimentId: 2}));
  const rows = (await ctx.rest('GET', '/classes/Vote?where=' + where, {master: true})).json.results;
  assert.strictEqual(rows.length, 1, `rows: ${JSON.stringify(rows)}`);
  assert.strictEqual(rows[0].value, 1);
  const ns = await Promise.all([3, 4, 5, 3, 4, 5, 6, 7].map((n) => ctx.cloud('setNSubjects', {pmid: '424242', n}, carol.session)));
  ns.forEach((r) => assert.strictEqual(r.status, 200, r.text));
  const nrows = (await ctx.rest('GET', '/classes/Vote?where=' + encodeURIComponent(JSON.stringify({user: carol.id, kind: 'nsubjects'})), {master: true})).json.results;
  assert.strictEqual(nrows.length, 1);
  assert.strictEqual(nrows[0].number, 7);
  const sp = await Promise.all(['MNI', 'Talairach', null, 'MNI', 'Talairach'].map((space) => ctx.cloud('setStereoSpace', {pmid: '424242', space}, carol.session)));
  sp.forEach((r) => assert.strictEqual(r.status, 200, r.text));
  const srows = (await ctx.rest('GET', '/classes/Vote?where=' + encodeURIComponent(JSON.stringify({user: carol.id, kind: 'space'})), {master: true})).json.results;
  assert.strictEqual(srows.length, 1);
  assert.strictEqual(srows[0].tag, 'Talairach');
});

test('postComment through REST; comments are public to read, not to write', async (ctx) => {
  const {alice} = ctx.ann;
  const c = ok(await ctx.cloud('postComment', {pmid: '424242', text: 'Nice <b>paper</b>'}, alice.session), 'postComment');
  assert.strictEqual(c.login, 'alice');
  assert.strictEqual(c.text, 'Nice <b>paper</b>');
  const ann = ok(await ctx.cloud('getAnnotations', {pmid: '424242'}), 'anon getAnnotations');
  assert.strictEqual(ann.commentCount, 1);
  assert.strictEqual(ann.comments[0].login, 'alice');
  const pub = await ctx.rest('GET', '/classes/Comment');
  assert.strictEqual(pub.status, 200, pub.text);
  assert.strictEqual(pub.json.results.length, 1);
  assert.ok(!('user' in pub.json.results[0]) || typeof pub.json.results[0].user === 'string');
  assert.ok((await ctx.rest('POST', '/classes/Comment', {session: alice.session, body: {pmid: '424242', text: 'direct', login: 'bob'}})).status >= 400);
  code(await ctx.cloud('postComment', {pmid: '424242', text: ''}, alice.session), 142, 'empty');
  code(await ctx.cloud('postComment', {pmid: '999999999', text: 'x'}, alice.session), 101, 'unknown article');
});

test('rate limit: the 61st vote in a minute is refused with 155', async (ctx) => {
  const dave = await ctx.signup('dave', 8004);
  let last;
  for (let i = 0; i < 61; i++) {
    last = await ctx.cloud('vote', {pmid: '424242', experimentId: 2, kind: 'tableOk', value: i % 2 ? 1 : -1}, dave.session);
    if (i < 60) {
      assert.strictEqual(last.status, 200, `vote ${i}: ${last.text}`);
    }
  }
  code(last, 155, '61st vote');
  assert.match(last.json.error, /retry in \d+ seconds/);
});

test('select hardening through REST (stub Solr)', async (ctx) => {
  ctx.solrCalls.length = 0;
  const good = ok(await ctx.cloud('select', {q: 'memory', defType: 'edismax', qf: 'Abstract Title', fl: '* score', 'q.op': 'OR', start: 0, rows: 10}), 'select');
  assert.strictEqual(good.numFound, 1);
  assert.strictEqual(ctx.solrCalls.length, 1);
  const bad = [
    {q: '{!func}1'}, {q: 'x _query_:"{!func}1"'}, {q: 'x', rows: 1000}, {q: 'x', start: 100001}, {q: 'x', defType: 'lucene'},
    {q: 'x', qf: 'password'}, {q: 'x', fl: 'password'}, {q: 'x', wt: 'xml'}, {q: 'x', stream: 'x'}, {}
  ];
  for (const p of bad) {
    code(await ctx.cloud('select', p), 142, JSON.stringify(p));
  }
  assert.strictEqual(ctx.solrCalls.length, 1, 'refused queries must not reach Solr');
});

test('_User guard: a GitHub login still works after all of the above, and the closed classes stay closed', async (ctx) => {
  const again = await ctx.signup('erin', 8005);
  assert.ok(again.session);
  assert.ok((await ctx.rest('GET', '/classes/Collection', {session: again.session})).status >= 400);
  assert.ok((await ctx.rest('GET', '/classes/Revision', {session: again.session})).status >= 400);
});
