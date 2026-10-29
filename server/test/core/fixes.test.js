// Fix round: canonical GitHub ids, one user per GitHub account, rate limits keyed on the
// GitHub id, authData stripping, caps, unapplied revisions, select throttle.

const test = require('node:test');
const assert = require('node:assert');
const {setup} = require('../helpers/env');
const {stripAuthData} = require('../../lib/strip-auth-data');

async function withEnv(fn) {
  const accounts = {};
  for (let i = 1; i <= 6; i++) {
    accounts[`token-${i}`] = {id: i, login: `user${i}`};
  }
  const env = await setup(accounts);
  env.article = env.fake.addArticle({
    PMID: '111', Title: 'T', rev: 0,
    Experiments: [{id: 1, title: 'e1', locations: ['1,2,3', '4,5,6'], tags: []}],
    Metadata: {meshHeadings: Array.from({length: 310}, (_, i) => ({name: `H${i}`}))}
  });
  env.expectCode = (p, code) => assert.rejects(p, (e) => e.code === code, `expected ${code}`);
  try {
    await fn(env);
  } finally {
    await env.close();
  }
}

test('toGithubId accepts only canonical ids', () => withEnv((env) => {
  const {toGithubId} = env.lib('auth');
  assert.strictEqual(toGithubId(31337), 31337);
  assert.strictEqual(toGithubId('31337'), 31337);
  for (const bad of ['031337', '0031337', ' 31337', '+31337', '31337 ', '3.1e4', '31337.0', 31337.5, 0, '0', -1, '-1', null, undefined, {}, [31337], true,
    '1234567890123456', 2 ** 60]) {
    assert.strictEqual(toGithubId(bad), null, String(bad));
  }
}));

test('_User beforeSave: canonical id only, and one Parse user per GitHub account', () => withEnv(async (env) => {
  const {Parse} = env.fake;
  const mk = (id) => {
    const u = new Parse.User();
    u.set('authData', {github: {id, access_token: 't'}});

    return u.save(null, {useMasterKey: true});
  };
  await mk(31337);
  for (const again of [31337, '31337']) {
    await env.expectCode(mk(again), 119);
  }
  for (const bad of ['031337', '000000031337', ' 31337', '+31337']) {
    await env.expectCode(mk(bad), 119);
  }
  await mk('555');
  await env.expectCode(mk(555), 119);
  assert.strictEqual(env.fake.rows('_User').length, 2);
}));

test('a second Parse user with the same GitHub id cannot act (profile check)', () => withEnv(async (env) => {
  const first = env.fake.addUser({github: {id: '1', access_token: 'token-1'}});
  const sybil = env.fake.addUser({github: {id: 1, access_token: 'token-1'}}); // created behind the guard
  const p = {pmid: '111', text: 'hi'};
  await env.run('postComment', p, first);
  await env.expectCode(env.run('postComment', p, sybil), 119);
  assert.strictEqual(env.fake.rows('UserProfile').length, 1);
}));

test('rate limits and locks are keyed on the GitHub id', () => withEnv(async (env) => {
  // two Parse users that share one GitHub account (should not exist, but if they do) share the limit
  const a = env.fake.addUser({github: {id: '2', access_token: 'token-2'}});
  const b = env.fake.addUser({github: {id: '2', access_token: 'token-2'}});
  const rl = env.lib('rate-limit');
  let n = 0;
  rl.setClock(() => 1e9 + (n++));
  // the sybil check would refuse b; the limit is shown at the library level
  rl.check('2', 'vote');
  for (let i = 0; i < 59; i++) {
    rl.check('2', 'vote');
  }
  assert.throws(() => rl.check('2', 'vote'), (e) => e.code === 155);
  await env.expectCode(env.run('vote', {pmid: '111', kind: 'mesh', tag: 'H1', value: 1}, a), 155);
  assert.ok(b);
}));

test('authData is removed from HTTP answers unless the master key is used', () => {
  const run = (header, body) => {
    const res = {json(b) {
      this.sent = b;

      return this;
    }};
    const req = {get: (h) => (h === 'X-Parse-Master-Key' ? header : undefined)};
    stripAuthData('MK')(req, res, () => {});
    res.json(JSON.parse(JSON.stringify(body)));

    return res.sent;
  };
  const user = {objectId: 'u', authData: {github: {id: '1', access_token: 'secret'}}, sessionToken: 'r:x'};
  assert.ok(!JSON.stringify(run(undefined, user)).includes('secret'));
  assert.ok(!JSON.stringify(run('wrong', {results: [user]})).includes('secret'));
  assert.ok(!JSON.stringify(run(undefined, {user: user})).includes('secret'));
  assert.strictEqual(run(undefined, user).sessionToken, 'r:x');
  assert.ok(JSON.stringify(run('MK', user)).includes('secret'));
});

test('editExperiment: rev required; revision is applied; caps give 142', () => withEnv(async (env) => {
  const edit = (p, u) => env.run('editExperiment', Object.assign({pmid: '111', experimentId: 1, rev: 0}, p), u || env.fake.addGithubUser(1));
  const alice = env.fake.addGithubUser(1);
  const e = (p) => env.run('editExperiment', Object.assign({pmid: '111', experimentId: 1, rev: 0}, p), alice);
  await env.expectCode(e({rev: undefined, ops: [{op: 'setTitle', text: 'x'}]}), 142);
  await env.expectCode(e({ops: Array.from({length: 21}, () => ({op: 'split', index: 0}))}), 142);
  await env.expectCode(e({ops: [{op: 'setCaption', text: 'x'.repeat(5000)}].concat(
    Array.from({length: 3}, () => ({op: 'replaceFromText', text: '1,2,3'.padEnd(400000, ' ')})))}), 142);
  assert.strictEqual(env.fake.rows('Revision').length, 0);
  const r = await e({ops: [{op: 'setTitle', text: 'x'}]});
  assert.strictEqual(r.rev, 1);
  assert.deepStrictEqual(env.fake.rows('Revision').map((x) => x.applied), [true]);
  assert.ok(edit);
}));

test('a crash between Revision and Articles leaves an unapplied revision; the retry replaces it', () => withEnv(async (env) => {
  const alice = env.fake.addGithubUser(1);
  const proto = env.fake.Parse.Object.prototype;
  const save = proto.save;
  let boom = true;
  proto.save = function(a, o) {
    if (this.className === 'Articles' && boom) {
      boom = false;
      throw new Error('crash');
    }

    return save.call(this, a, o);
  };
  const p = {pmid: '111', experimentId: 1, rev: 0, ops: [{op: 'setTitle', text: 'x'}]};
  await assert.rejects(env.run('editExperiment', p, alice));
  assert.deepStrictEqual(env.fake.rows('Revision').map((x) => x.applied), [false]);
  await env.run('editExperiment', p, alice);
  assert.deepStrictEqual(env.fake.rows('Revision').map((x) => [x.rev, x.applied]), [[1, true]]);
  proto.save = save;
}));

test('votes: at most 300 different votes per user and article; truncated is false normally', () => withEnv(async (env) => {
  const alice = env.fake.addGithubUser(1);
  for (let i = 0; i < 300; i++) {
    env.fake.add('Vote', {user: alice.id, login: 'x', pmid: '111', experimentId: -1, kind: 'mesh', ontology: null, tag: `H${i}`, value: 1, number: null});
  }
  await env.expectCode(env.run('vote', {pmid: '111', kind: 'mesh', tag: 'H305', value: 1}, alice), 142);
  // changing an existing vote is still allowed, and so are space / nsubjects
  await env.run('vote', {pmid: '111', kind: 'mesh', tag: 'H1', value: -1}, alice);
  await env.run('setStereoSpace', {pmid: '111', space: 'MNI'}, alice);
  assert.strictEqual((await env.run('getAnnotations', {pmid: '111'})).truncated, false);
}));

test('select: _val_ refused; global throttle 30 per second answers 155', () => withEnv(async (env) => {
  await env.expectCode(env.run('select', {q: 'x _val_:"foo"'}), 142);
  await env.expectCode(env.run('select', {q: '_VAL_:1'}), 142);
  process.env.SOLR_URL = 'http://127.0.0.1:1/x';
  const rl = env.lib('rate-limit');
  let now = 5e9;
  rl.setClock(() => now);
  for (let i = 0; i < 30; i++) {
    await assert.rejects(env.run('select', {q: 'x'}), (e) => e.code === 1002);
  }
  await env.expectCode(env.run('select', {q: 'x'}), 155);
  now += 1100;
  await assert.rejects(env.run('select', {q: 'x'}), (e) => e.code === 1002);
  delete process.env.SOLR_URL;
}));
