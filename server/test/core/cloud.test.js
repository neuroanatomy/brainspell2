const test = require('node:test');
const assert = require('node:assert');
const {setup} = require('../helpers/env');

const ARTICLE = () => ({
  PMID: '111',
  Title: 'T',
  Experiments: [
    {id: 1, title: 'e1', markBadTable: {ok: 2, bad: 1}, tags: [
      {name: 'Memory', ontology: 'cognitive', agree: 3, disagree: 1},
      {name: 'Hidden', ontology: 'cognitive', agree: 0, disagree: 0}
    ]},
    {id: 2, title: 'e2', tags: []}
  ],
  Metadata: {meshHeadings: [{name: 'Brain', majorTopic: true}, {name: 'Humans'}], stereo: {MNI: 2, Talairach: 0}, nsubjects: 20}
});

async function withEnv(fn) {
  const env = await setup({'token-1': {id: 1, login: 'alice'}, 'token-2': {id: 2, login: 'bob'}});
  env.article = env.fake.addArticle(ARTICLE());
  env.alice = env.fake.addGithubUser(1);
  env.bob = env.fake.addGithubUser(2);
  env.fake.add('Concept', {name: 'Attention', ontology: 'cognitive'});
  env.fake.add('Concept', {name: 'Stroop task', ontology: 'tasks'});
  env.expectCode = async (promise, code) => {
    await assert.rejects(promise, (e) => e.code === code, `expected ${code}`);
  };
  try {
    await fn(env);
  } finally {
    await env.close();
  }
}

test('loader registers every function and the _User guard', () => withEnv((env) => {
  for (const n of ['me', 'getAnnotations', 'vote', 'setStereoSpace', 'setNSubjects', 'postComment', 'select']) {
    assert.ok(env.fake.functions.has(n), n);
  }
}));

test('beforeSave _User: creation without GitHub authData is refused', () => withEnv(async (env) => {
  const {Parse} = env.fake;
  const mk = (authData) => {
    const u = new Parse.User();
    if (authData !== undefined) {
      u.set('authData', authData);
    }

    return u.save(null, {useMasterKey: true});
  };
  await env.expectCode(mk(undefined), 119);
  await env.expectCode(mk({}), 119);
  await env.expectCode(mk({anonymous: {id: 'x'}}), 119);
  await env.expectCode(mk({github: null}), 119);
  await env.expectCode(mk({github: {}}), 119);
  await env.expectCode(mk({github: {id: ''}}), 119);
  const ok = await mk({github: {id: '77', access_token: 't'}});
  assert.ok(ok.id);
  // updates are not blocked by the guard
  ok.set('x', 1);
  await ok.save(null, {useMasterKey: true});
}));

test('me', () => withEnv(async (env) => {
  assert.strictEqual(await env.run('me', {}), null);
  assert.deepStrictEqual(await env.run('me', {}, env.alice), {id: env.alice.id, login: 'alice', githubId: 1});
  assert.strictEqual(env.fake.rows('UserProfile').length, 1);
  assert.deepStrictEqual(env.fake.rows('UserProfile')[0].acl, {});
  await env.expectCode(env.run('me', {login: 'root'}, env.alice), 142);
  // a user without GitHub data is not a GitHub user
  const pw = env.fake.addUser(undefined);
  assert.strictEqual(await env.run('me', {}, pw), null);
  // login rename is picked up (after the 1 minute cache)
  env.github.accounts['token-1'] = {id: 1, login: 'alice2'};
  assert.strictEqual((await env.run('me', {}, env.alice)).login, 'alice');
  env.lib('auth').reset();
  assert.strictEqual((await env.run('me', {}, env.alice)).login, 'alice2');
  assert.strictEqual(env.fake.rows('UserProfile').length, 1);
  // GitHub down: cached profile is served
  env.github.accounts['token-1'] = {status: 500};
  env.lib('auth').reset();
  assert.strictEqual((await env.run('me', {}, env.alice)).login, 'alice2');
}));

test('identity: GitHub account must match the authData id; token must be valid', () => withEnv(async (env) => {
  const liar = env.fake.addUser({github: {id: '999', access_token: 'token-1'}}); // token belongs to id 1
  await env.expectCode(env.run('vote', {pmid: '111', experimentId: 2, kind: 'tableOk', value: 1}, liar), 119);
  const stale = env.fake.addUser({github: {id: '5', access_token: 'revoked'}});
  await env.expectCode(env.run('postComment', {pmid: '111', text: 'x'}, stale), 119);
  const notGithub = env.fake.addUser({anonymous: {id: 'abc'}});
  await env.expectCode(env.run('postComment', {pmid: '111', text: 'x'}, notGithub), 119);
  const none = env.fake.addUser(undefined);
  await env.expectCode(env.run('postComment', {pmid: '111', text: 'x'}, none), 119);
  env.github.accounts['token-down'] = {status: 502};
  const down = env.fake.addUser({github: {id: '8', access_token: 'token-down'}});
  await env.expectCode(env.run('postComment', {pmid: '111', text: 'x'}, down), 1002);
  assert.strictEqual(env.fake.rows('Comment').length, 0);
  assert.strictEqual(env.fake.rows('UserProfile').length, 0);
}));

test('write functions require login (206) and never take a username', () => withEnv(async (env) => {
  const calls = [
    ['vote', {pmid: '111', experimentId: 2, kind: 'tableOk', value: 1}],
    ['setStereoSpace', {pmid: '111', space: 'MNI'}],
    ['setNSubjects', {pmid: '111', n: 3}],
    ['postComment', {pmid: '111', text: 'x'}]
  ];
  for (const [n, p] of calls) {
    await env.expectCode(env.run(n, p), 206);
    await env.expectCode(env.run(n, Object.assign({login: 'alice', user: 'x'}, p), env.alice), 142);
  }
  assert.strictEqual(env.fake.rows('Vote').length, 0);
}));

test('getAnnotations: legacy baseline, display rules, anonymous', () => withEnv(async (env) => {
  const r = await env.run('getAnnotations', {pmid: '111'});
  assert.strictEqual(r.pmid, '111');
  assert.strictEqual(r.rev, 0);
  assert.deepStrictEqual(r.votes.map((v) => [v.kind, v.experimentId, v.tag, v.agree, v.disagree, v.mine]), [
    ['mesh', -1, 'Brain', 0, 0, 0],
    ['mesh', -1, 'Humans', 0, 0, 0],
    ['tableOk', 1, 'ok', 2, 1, 0],
    ['tag', 1, 'Memory', 3, 1, 0],
    ['tableOk', 2, 'ok', 0, 0, 0]
  ]);
  assert.deepStrictEqual(r.stereo, {MNI: 2, Talairach: 0, mine: null});
  assert.deepStrictEqual(r.nsubjects, {value: 20, values: [], mine: null});
  assert.deepStrictEqual(r.comments, []);
  assert.strictEqual(r.commentCount, 0);
  await env.expectCode(env.run('getAnnotations', {pmid: '999'}), 101);
  await env.expectCode(env.run('getAnnotations', {pmid: 111}), 142);
  await env.expectCode(env.run('getAnnotations', {pmid: '111', extra: 1}), 142);
}));

test('vote: first vote, double submit, flip, retract, retract without vote, revote', () => withEnv(async (env) => {
  const v = (value, user = env.alice, extra = {}) => env.run('vote', Object.assign(
    {pmid: '111', experimentId: 1, kind: 'tag', ontology: 'cognitive', tag: 'memory', value}, extra), user);
  let r = await v(1);
  assert.deepStrictEqual(r, {kind: 'tag', experimentId: 1, ontology: 'cognitive', tag: 'Memory', agree: 4, disagree: 1, mine: 1});
  assert.strictEqual(env.fake.rows('Vote').length, 1);
  assert.deepStrictEqual(env.fake.rows('Vote')[0].acl, {});
  assert.strictEqual(env.fake.rows('Vote')[0].user, env.alice.id);
  assert.strictEqual(env.fake.rows('Vote')[0].login, 'alice');
  r = await v(1);
  assert.deepStrictEqual([r.agree, r.disagree, r.mine], [4, 1, 1]);
  assert.strictEqual(env.fake.rows('Vote').length, 1);
  r = await v(-1);
  assert.deepStrictEqual([r.agree, r.disagree, r.mine], [3, 2, -1]);
  assert.strictEqual(env.fake.rows('Vote').length, 1);
  r = await v(-1, env.bob);
  assert.deepStrictEqual([r.agree, r.disagree, r.mine], [3, 3, -1]);
  r = await v(0);
  assert.deepStrictEqual([r.agree, r.disagree, r.mine], [3, 2, 0]);
  assert.strictEqual(env.fake.rows('Vote').length, 1);
  r = await v(0);
  assert.deepStrictEqual([r.agree, r.disagree, r.mine], [3, 2, 0]);
  r = await v(1);
  assert.deepStrictEqual([r.agree, r.disagree, r.mine], [4, 2, 1]);
  const ann = await env.run('getAnnotations', {pmid: '111'}, env.alice);
  assert.strictEqual(ann.votes.find((x) => x.tag === 'Memory').mine, 1);
  assert.strictEqual((await env.run('getAnnotations', {pmid: '111'}, env.bob)).votes.find((x) => x.tag === 'Memory').mine, -1);
  assert.strictEqual((await env.run('getAnnotations', {pmid: '111'})).votes.find((x) => x.tag === 'Memory').mine, 0);
}));

test('vote: tags from Concept, hidden legacy tag, retract of a tag that is not valid any more', () => withEnv(async (env) => {
  const v = (p, user = env.alice) => env.run('vote', Object.assign({pmid: '111', experimentId: 2, kind: 'tag', ontology: 'cognitive', value: 1}, p), user);
  let r = await v({tag: '  ATTENTION '});
  assert.deepStrictEqual([r.tag, r.agree, r.disagree, r.mine], ['Attention', 1, 0, 1]);
  assert.ok((await env.run('getAnnotations', {pmid: '111'})).votes.find((x) => x.tag === 'Attention' && x.experimentId === 2));
  r = await v({tag: 'Attention', value: 0});
  assert.deepStrictEqual([r.agree, r.disagree, r.mine], [0, 0, 0]);
  assert.ok(!(await env.run('getAnnotations', {pmid: '111'})).votes.find((x) => x.tag === 'Attention'));
  // legacy tag with zero counts becomes visible once voted
  r = await v({experimentId: 1, tag: 'hidden', value: -1});
  assert.deepStrictEqual([r.tag, r.agree, r.disagree], ['Hidden', 0, 1]);
  // same name in another ontology is not the same tag
  await env.expectCode(v({tag: 'Stroop task'}), 142);
  r = await v({tag: 'Stroop task', ontology: 'tasks'});
  assert.strictEqual(r.ontology, 'tasks');
  await env.expectCode(v({tag: 'Nonexistent'}), 142);
  // the term is removed from Concept: the vote can still be retracted
  const fake = env.fake;
  const rows = fake.rows('Concept');
  const q = new fake.Parse.Query('Concept');
  q.equalTo('name', 'Stroop task');
  await (await q.first({useMasterKey: true})).destroy({useMasterKey: true});
  assert.strictEqual(rows.length, 2);
  await env.expectCode(v({tag: 'Stroop task', ontology: 'tasks'}), 142);
  r = await v({tag: 'Stroop task', ontology: 'tasks', value: 0});
  assert.strictEqual(r.agree, 0);
  assert.ok(!env.fake.rows('Vote').find((x) => x.tag === 'Stroop task'));
}));

test('vote: mesh and tableOk', () => withEnv(async (env) => {
  let r = await env.run('vote', {pmid: '111', experimentId: -1, kind: 'mesh', tag: 'brain', value: 1}, env.alice);
  assert.deepStrictEqual(r, {kind: 'mesh', experimentId: -1, ontology: null, tag: 'Brain', agree: 1, disagree: 0, mine: 1});
  r = await env.run('vote', {pmid: '111', kind: 'mesh', tag: 'Humans', value: -1}, env.alice);
  assert.strictEqual(r.disagree, 1);
  await env.expectCode(env.run('vote', {pmid: '111', kind: 'mesh', tag: 'Cats', value: 1}, env.alice), 142);
  await env.expectCode(env.run('vote', {pmid: '111', experimentId: 1, kind: 'mesh', tag: 'Brain', value: 1}, env.alice), 142);
  await env.expectCode(env.run('vote', {pmid: '111', kind: 'mesh', ontology: 'tasks', tag: 'Brain', value: 1}, env.alice), 142);
  r = await env.run('vote', {pmid: '111', experimentId: 1, kind: 'tableOk', value: 1}, env.alice);
  assert.deepStrictEqual(r, {kind: 'tableOk', experimentId: 1, ontology: null, tag: 'ok', agree: 3, disagree: 1, mine: 1});
  r = await env.run('vote', {pmid: '111', experimentId: 1, kind: 'tableOk', tag: 'ok', value: -1}, env.bob);
  assert.deepStrictEqual([r.agree, r.disagree, r.mine], [3, 2, -1]);
  await env.expectCode(env.run('vote', {pmid: '111', experimentId: 1, kind: 'tableOk', tag: 'bad', value: 1}, env.alice), 142);
  await env.expectCode(env.run('vote', {pmid: '111', experimentId: 7, kind: 'tableOk', value: 1}, env.alice), 142);
}));

test('vote: validation of every parameter', () => withEnv(async (env) => {
  const base = {pmid: '111', experimentId: 1, kind: 'tag', ontology: 'cognitive', tag: 'Memory', value: 1};
  const bads = [
    {pmid: 111}, {pmid: '11a'}, {pmid: undefined}, {kind: 'space'}, {kind: 'nsubjects'}, {kind: 'x'}, {kind: undefined},
    {value: 2}, {value: '1'}, {value: undefined}, {value: true}, {experimentId: '1'}, {experimentId: 1.5}, {experimentId: -1},
    {experimentId: undefined}, {ontology: 'other'}, {ontology: undefined}, {ontology: null}, {tag: ''}, {tag: '   '}, {tag: 5},
    {tag: 'a'.repeat(501)}, {tag: 'a\u0000'}, {tag: undefined}, {extra: 1}, {login: 'bob'}, {user: 'x'}, {username: 'bob'}
  ];
  for (const b of bads) {
    await env.expectCode(env.run('vote', Object.assign({}, base, b), env.alice), 142);
  }
  await env.expectCode(env.run('vote', 'not an object', env.alice), 142);
  await env.expectCode(env.run('vote', null, env.alice), 142);
  await env.expectCode(env.run('vote', Object.assign({}, base, {pmid: '424242'}), env.alice), 101);
  assert.strictEqual(env.fake.rows('Vote').length, 0);
}));

test('vote: rate limit 60 per minute per user', () => withEnv(async (env) => {
  const p = {pmid: '111', experimentId: 1, kind: 'tableOk', value: 1};
  for (let i = 0; i < 60; i++) {
    await env.run('vote', p, env.alice);
  }
  await env.expectCode(env.run('vote', p, env.alice), 155);
  await env.run('vote', p, env.bob);
}));

test('vote: concurrent calls by one user leave one row and the right count', () => withEnv(async (env) => {
  const p = (value) => ({pmid: '111', experimentId: 2, kind: 'tableOk', value});
  const results = await Promise.all([1, 1, -1, 1, 0, 1, -1, 1].map((v) => env.run('vote', p(v), env.alice)));
  assert.strictEqual(env.fake.rows('Vote').length, 1);
  assert.strictEqual(env.fake.rows('Vote')[0].value, 1);
  assert.strictEqual(results[7].mine, 1);
  const many = await Promise.all(Array.from({length: 10}, () => env.run('vote', p(1), env.bob)));
  assert.strictEqual(env.fake.rows('Vote').filter((r) => r.user === env.bob.id).length, 1);
  assert.strictEqual(many[9].agree, 2);
}));

test('vote: a duplicate row (crash) is healed by the next write and ignored on read', () => withEnv(async (env) => {
  const dup = (value) => env.fake.add('Vote', {
    user: env.alice.id, login: 'alice', pmid: '111', experimentId: 2, kind: 'tableOk', ontology: null, tag: 'ok', value, number: null
  });
  dup(1);
  dup(-1); // newer
  let ann = await env.run('getAnnotations', {pmid: '111'}, env.alice);
  let t = ann.votes.find((x) => x.kind === 'tableOk' && x.experimentId === 2);
  assert.deepStrictEqual([t.agree, t.disagree, t.mine], [0, 1, -1]);
  await env.run('vote', {pmid: '111', experimentId: 2, kind: 'tableOk', value: -1}, env.alice);
  assert.strictEqual(env.fake.rows('Vote').length, 1);
  assert.strictEqual(env.fake.rows('Vote')[0].value, -1);
  ann = await env.run('getAnnotations', {pmid: '111'}, env.alice);
  t = ann.votes.find((x) => x.kind === 'tableOk' && x.experimentId === 2);
  assert.deepStrictEqual([t.agree, t.disagree], [0, 1]);
}));

test('getAnnotations reads at most 5000 vote rows, keeping the newest', () => withEnv(async (env) => {
  for (let i = 0; i < 5003; i++) {
    env.fake.add('Vote', {
      user: `u${i}`, login: 'x', pmid: '111', experimentId: 2, kind: 'tableOk', ontology: null, tag: 'ok', value: i < 3 ? -1 : 1, number: null
    });
  }
  const ann = await env.run('getAnnotations', {pmid: '111'});
  const t = ann.votes.find((x) => x.kind === 'tableOk' && x.experimentId === 2);
  assert.deepStrictEqual([t.agree, t.disagree], [5000, 0]);
}));

test('setStereoSpace', () => withEnv(async (env) => {
  const s = (space, user = env.alice) => env.run('setStereoSpace', {pmid: '111', space}, user);
  assert.deepStrictEqual(await s('MNI'), {MNI: 3, Talairach: 0, mine: 'MNI'});
  assert.deepStrictEqual(await s('MNI'), {MNI: 3, Talairach: 0, mine: 'MNI'});
  assert.deepStrictEqual(await s('Talairach'), {MNI: 2, Talairach: 1, mine: 'Talairach'});
  assert.deepStrictEqual(await s('Talairach', env.bob), {MNI: 2, Talairach: 2, mine: 'Talairach'});
  assert.deepStrictEqual(await s(null), {MNI: 2, Talairach: 1, mine: null});
  assert.deepStrictEqual(await s(null), {MNI: 2, Talairach: 1, mine: null});
  assert.strictEqual(env.fake.rows('Vote').length, 1);
  await s('MNI');
  assert.strictEqual((await env.run('getAnnotations', {pmid: '111'}, env.alice)).stereo.mine, 'MNI');
  for (const bad of ['mni', 'Other', 1, undefined, '', []]) {
    await env.expectCode(s(bad), 142);
  }
  await env.expectCode(env.run('setStereoSpace', {pmid: '111'}, env.alice), 142);
  await env.expectCode(env.run('setStereoSpace', {pmid: '999', space: 'MNI'}, env.alice), 101);
}));

test('setNSubjects', () => withEnv(async (env) => {
  const s = (n, user = env.alice) => env.run('setNSubjects', {pmid: '111', n}, user);
  assert.deepStrictEqual(await s(12), {value: 12, values: [{n: 12, count: 1}], mine: 12});
  assert.deepStrictEqual(await s(12), {value: 12, values: [{n: 12, count: 1}], mine: 12});
  await s(30, env.bob);
  assert.deepStrictEqual(await s(30), {value: 30, values: [{n: 30, count: 2}], mine: 30});
  assert.strictEqual(env.fake.rows('Vote').filter((r) => r.user === env.alice.id).length, 1);
  assert.deepStrictEqual(await s(null), {value: 30, values: [{n: 30, count: 1}], mine: null});
  await s(null, env.bob);
  assert.deepStrictEqual(await s(null), {value: 20, values: [], mine: null});
  for (const bad of [0, -1, 100001, 1.5, '12', undefined, true]) {
    await env.expectCode(s(bad), 142);
  }
  assert.strictEqual((await s(100000)).value, 100000);
}));

test('postComment', () => withEnv(async (env) => {
  const r = await env.run('postComment', {pmid: '111', text: '  hello <b>world</b>  '}, env.alice);
  assert.strictEqual(r.login, 'alice');
  assert.strictEqual(r.text, 'hello <b>world</b>');
  assert.match(r.createdAt, /^\d{4}-\d\d-\d\dT/);
  assert.deepStrictEqual(env.fake.rows('Comment')[0].acl, {'*': {read: true}});
  assert.strictEqual(env.fake.rows('Comment')[0].user, env.alice.id);
  await env.run('postComment', {pmid: '111', text: 'second\nline'}, env.bob);
  const ann = await env.run('getAnnotations', {pmid: '111'});
  assert.deepStrictEqual(ann.comments.map((c) => c.login), ['alice', 'bob']);
  assert.strictEqual(ann.commentCount, 2);
  assert.deepStrictEqual(Object.keys(ann.comments[0]).sort(), ['createdAt', 'id', 'login', 'text']);
  for (const bad of ['', '   ', 'a'.repeat(5001), 5, null, undefined, 'x\u0000y']) {
    await env.expectCode(env.run('postComment', {pmid: '111', text: bad}, env.alice), 142);
  }
  await env.expectCode(env.run('postComment', {pmid: '999', text: 'x'}, env.alice), 101);
  assert.strictEqual((await env.run('postComment', {pmid: '111', text: 'a'.repeat(5000)}, env.alice)).text.length, 5000);
}));

test('postComment: 5 per minute, 20 per day; getAnnotations returns the newest 200 oldest first', () => withEnv(async (env) => {
  const rl = env.lib('rate-limit');
  let now = 5e9;
  rl.setClock(() => now);
  for (let i = 0; i < 5; i++) {
    await env.run('postComment', {pmid: '111', text: `c${i}`}, env.alice);
  }
  await env.expectCode(env.run('postComment', {pmid: '111', text: 'c'}, env.alice), 155);
  for (let i = 0; i < 205; i++) {
    env.fake.add('Comment', {user: 'z', login: 'z', pmid: '111', text: `bulk${i}`});
  }
  const ann = await env.run('getAnnotations', {pmid: '111'});
  assert.strictEqual(ann.comments.length, 200);
  assert.strictEqual(ann.commentCount, 210);
  assert.strictEqual(ann.comments[199].text, 'bulk204');
  assert.strictEqual(ann.comments[0].text, 'bulk5');
}));
