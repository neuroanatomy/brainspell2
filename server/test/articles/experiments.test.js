const test = require('node:test');
const assert = require('node:assert');
const {withStubs} = require('./stubs');

const ARTICLE = (extra) => Object.assign({
  PMID: '111',
  Title: 'T',
  Experiments: [
    {id: 1, title: 'e1', caption: 'c1', locations: ['1,2,3', '4,5,6', '7,8,9,0.5'], markBadTable: {ok: 2, bad: 1}, tags: [
      {name: 'Memory', ontology: 'cognitive', agree: 3, disagree: 1}
    ]},
    {id: 2, title: 'e2', locations: [], tags: []}
  ],
  Metadata: {meshHeadings: [{name: 'Brain', majorTopic: true}]}
}, extra);

async function withEnv(fn, extra) {
  const env = await withStubs();
  env.article = env.fake.addArticle(ARTICLE(extra));
  env.edit = (params, user) => env.run('editExperiment', params, user === undefined ? env.alice : user);
  env.stored = () => env.fake.rows('Articles').find((a) => a.PMID === '111');
  try {
    await fn(env);
  } finally {
    await env.close();
  }
}

const title = (text, extra) => Object.assign({pmid: '111', experimentId: 1, rev: 0, ops: [{op: 'setTitle', text}]}, extra);

test('editExperiment is registered', () => withEnv((env) => {
  assert.ok(env.fake.functions.has('editExperiment'));
}));

test('anonymous is refused (206), a non-GitHub user too (119)', () => withEnv(async (env) => {
  await env.expectCode(env.edit(title('x'), null), 206);
  const plain = env.fake.addUser(undefined, {username: 'pw'});
  await env.expectCode(env.edit(title('x'), plain), 119);
  assert.strictEqual(env.fake.rows('Revision').length, 0);
  assert.strictEqual(env.stored().Experiments[0].title, 'e1');
}));

test('unknown parameters, missing and wrong-typed parameters are refused (142)', () => withEnv(async (env) => {
  await env.expectCode(env.edit(title('x', {login: 'bob'})), 142, /login/);
  await env.expectCode(env.edit(title('x', {user: 'bob'})), 142);
  await env.expectCode(env.edit({experimentId: 1, ops: [{op: 'setTitle', text: 'x'}]}), 142, /pmid/);
  await env.expectCode(env.edit(title('x', {pmid: 111})), 142);
  await env.expectCode(env.edit(title('x', {pmid: '1; drop'})), 142);
  await env.expectCode(env.edit(title('x', {experimentId: '1'})), 142);
  await env.expectCode(env.edit(title('x', {experimentId: 1.5})), 142);
  await env.expectCode(env.edit(title('x', {experimentId: undefined})), 142);
  await env.expectCode(env.edit(title('x', {rev: '0'})), 142);
  await env.expectCode(env.edit(title('x', {rev: -1})), 142);
  await env.expectCode(env.edit(title('x', {ops: []})), 142);
  await env.expectCode(env.edit(title('x', {ops: [{op: 'setTitle', text: 'x', extra: 1}]})), 142);
  assert.strictEqual(env.fake.rows('Revision').length, 0);
  assert.strictEqual(env.stored().rev, undefined);
}));

test('unknown article or experiment: 101', () => withEnv(async (env) => {
  await env.expectCode(env.edit(title('x', {pmid: '999'})), 101);
  await env.expectCode(env.edit(title('x', {experimentId: 77})), 101);
  assert.strictEqual(env.fake.rows('Revision').length, 0);
}));

test('success writes a Revision and bumps rev; other data untouched', () => withEnv(async (env) => {
  const params = {pmid: '111', experimentId: 1, rev: 0, ops: [{op: 'updateRow', index: 0, xyz: [9, 9, 9]}, {op: 'setTitle', text: 'new'}]};
  const out = await env.edit(params);
  assert.strictEqual(out.rev, 1);
  assert.strictEqual(out.experiments.length, 1);
  assert.strictEqual(out.experiments[0].title, 'new');
  assert.deepStrictEqual(out.experiments[0].locations, ['9,9,9', '4,5,6', '7,8,9,0.5']);
  const a = env.stored();
  assert.strictEqual(a.rev, 1);
  assert.deepStrictEqual(a.Experiments[0], out.experiments[0]);
  assert.deepStrictEqual(a.Experiments[0].tags, [{name: 'Memory', ontology: 'cognitive', agree: 3, disagree: 1}]);
  assert.deepStrictEqual(a.Experiments[0].markBadTable, {ok: 2, bad: 1});
  assert.deepStrictEqual(a.Experiments[1], ARTICLE().Experiments[1]);
  assert.deepStrictEqual(a.Metadata, ARTICLE().Metadata);
  const revs = env.fake.rows('Revision');
  assert.strictEqual(revs.length, 1);
  assert.strictEqual(revs[0].pmid, '111');
  assert.strictEqual(revs[0].rev, 1);
  assert.strictEqual(revs[0].user, env.alice.id);
  assert.strictEqual(revs[0].login, 'alice');
  assert.deepStrictEqual(revs[0].ops, params.ops);
  assert.strictEqual(revs[0].applied, true);
  assert.strictEqual(revs[0].before.length, 1);
  assert.strictEqual(revs[0].before[0].title, 'e1');
  assert.deepStrictEqual(revs[0].before[0].locations, ARTICLE().Experiments[0].locations);
  assert.deepStrictEqual(revs[0].acl, {}, 'no public access');
}));

test('the login stored is the verified one even if the profile is renamed on GitHub', () => withEnv(async (env) => {
  await env.edit(title('a'));
  assert.strictEqual(env.fake.rows('Revision')[0].login, 'alice');
  const bobOut = await env.edit(title('b', {rev: 1}), env.bob);
  assert.strictEqual(bobOut.rev, 2);
  assert.strictEqual(env.fake.rows('Revision')[1].login, 'bob');
}));

test('conflict: stale rev gives 1001 with the current rev; nothing is written', () => withEnv(async (env) => {
  await env.edit(title('a'));
  await env.expectCode(env.edit(title('b', {rev: 0})), 1001, /rev 1/);
  await env.expectCode(env.edit(title('b', {rev: undefined})), 142, /rev/);
  await env.expectCode(env.edit(title('b', {rev: 2})), 1001, /rev 1/);
  assert.strictEqual(env.stored().Experiments[0].title, 'a');
  assert.strictEqual(env.fake.rows('Revision').length, 1);
  const ok = await env.edit(title('c', {rev: 1}));
  assert.strictEqual(ok.rev, 2);
}), {});

test('an article with a rev reads it', () => withEnv(async (env) => {
  await env.expectCode(env.edit(title('b', {rev: 0})), 1001, /rev 7/);
  assert.strictEqual((await env.edit(title('b', {rev: 7}))).rev, 8);
}, {rev: 7}));

test('the Revision is written BEFORE the article is updated', () => withEnv(async (env) => {
  const order = [];
  const proto = env.fake.Parse.Object.prototype;
  const save = proto.save;
  proto.save = function (...args) {
    order.push(this.className);

    return save.apply(this, args);
  };
  await env.edit(title('x'));
  proto.save = save;
  const i = order.indexOf('Revision');
  const j = order.lastIndexOf('Articles');
  assert.ok(i >= 0 && j > i, `order was ${order.join(',')}`);
}));

test('if the Revision cannot be written, the article is not touched', () => withEnv(async (env) => {
  const proto = env.fake.Parse.Object.prototype;
  const save = proto.save;
  proto.save = function (...args) {
    if (this.className === 'Revision') {
      return Promise.reject(new env.fake.Parse.Error(1, 'disk full'));
    }

    return save.apply(this, args);
  };
  await assert.rejects(env.edit(title('x')));
  proto.save = save;
  assert.strictEqual(env.stored().Experiments[0].title, 'e1');
  assert.strictEqual(env.stored().rev, undefined);
  assert.strictEqual((await env.edit(title('x'))).rev, 1, 'still at rev 0 and editable');
}));

test('a failed article update leaves an orphan Revision and the same rev', () => withEnv(async (env) => {
  const proto = env.fake.Parse.Object.prototype;
  const save = proto.save;
  proto.save = function (...args) {
    if (this.className === 'Articles') {
      return Promise.reject(new env.fake.Parse.Error(1, 'db down'));
    }

    return save.apply(this, args);
  };
  await assert.rejects(env.edit(title('x')));
  proto.save = save;
  assert.strictEqual(env.fake.rows('Revision').length, 1);
  assert.strictEqual(env.stored().rev, undefined);
  assert.strictEqual((await env.edit(title('y'))).rev, 1);
}));

test('invalid ops write nothing', () => withEnv(async (env) => {
  await env.expectCode(env.edit(title('x', {ops: [{op: 'setTitle', text: 'x'}, {op: 'deleteRow', index: 50}]})), 142, /ops\[1\]/);
  await env.expectCode(env.edit(title('x', {ops: [{op: 'addRow', xyz: [1, 2, 999]}]})), 142);
  assert.strictEqual(env.fake.rows('Revision').length, 0);
  assert.strictEqual(env.stored().rev, undefined);
}));

test('a no-op edit writes nothing and keeps the rev', () => withEnv(async (env) => {
  const out = await env.edit(title('e1'));
  assert.deepStrictEqual(out, {rev: 0, experiments: []});
  assert.strictEqual(env.fake.rows('Revision').length, 0);
}));

test('split returns both halves in order; the original keeps id and tags', () => withEnv(async (env) => {
  const out = await env.edit({pmid: '111', experimentId: 1, rev: 0, ops: [{op: 'split', index: 1}]});
  assert.strictEqual(out.rev, 1);
  assert.deepStrictEqual(out.experiments.map((e) => e.id), [1, 3]);
  assert.deepStrictEqual(out.experiments[1], {id: 3, title: 'e1', caption: 'c1', locations: ['4,5,6', '7,8,9,0.5'], tags: []});
  const a = env.stored();
  assert.deepStrictEqual(a.Experiments.map((e) => e.id), [1, 3, 2]);
  assert.strictEqual(a.Experiments[0].tags.length, 1);
  assert.deepStrictEqual(env.fake.rows('Revision')[0].before.map((e) => e.id), [1]);
}));

test('replaceFromText and delete down to an empty experiment', () => withEnv(async (env) => {
  const out = await env.edit({pmid: '111', experimentId: 1, rev: 0, ops: [{op: 'replaceFromText', text: '1.50,2.000,.5'}]});
  assert.deepStrictEqual(out.experiments[0].locations, ['1.5,2,0.5']);
  const out2 = await env.edit({pmid: '111', experimentId: 1, rev: 1, ops: [{op: 'deleteRow', index: 0}]});
  assert.deepStrictEqual(out2.experiments[0].locations, []);
  assert.strictEqual(out2.rev, 2);
}));

test('legacy article: 4-value rows survive an edit of another row', () => withEnv(async (env) => {
  const out = await env.edit({pmid: '111', experimentId: 1, rev: 0, ops: [{op: 'updateRow', index: 1, xyz: [0, 0, 0]}]});
  assert.deepStrictEqual(out.experiments[0].locations, ['1,2,3', '0,0,0', '7,8,9,0.5']);
}));

test('rate limit: 30 per minute per user (155), another user is not affected', () => withEnv(async (env) => {
  for (let i = 0; i < 30; i++) {
    await env.edit(title(`t${i}`, {rev: i}));
  }
  await env.expectCode(env.edit(title('over', {rev: 30})), 155, /retry/);
  assert.strictEqual(env.stored().rev, 30);
  assert.strictEqual((await env.edit(title('bob', {rev: 30}), env.bob)).rev, 31);
}));

test('concurrent edits with the same rev: exactly one wins, no lost update', () => withEnv(async (env) => {
  const results = await Promise.allSettled([
    env.edit({pmid: '111', experimentId: 1, rev: 0, ops: [{op: 'addRow', xyz: [1, 1, 1]}]}),
    env.edit({pmid: '111', experimentId: 1, rev: 0, ops: [{op: 'addRow', xyz: [2, 2, 2]}]}, env.bob),
    env.edit({pmid: '111', experimentId: 2, rev: 0, ops: [{op: 'setTitle', text: 'other'}]})
  ]);
  const won = results.filter((r) => r.status === 'fulfilled');
  const lost = results.filter((r) => r.status === 'rejected');
  assert.strictEqual(won.length, 1);
  assert.strictEqual(lost.length, 2);
  lost.forEach((r) => assert.strictEqual(r.reason.code, 1001));
  assert.strictEqual(env.stored().rev, 1);
  assert.strictEqual(env.fake.rows('Revision').length, 1);
}));

test('concurrent edits chained by rev all apply', () => withEnv(async (env) => {
  const first = await env.edit(title('a'));
  const results = await Promise.all([
    env.edit({pmid: '111', experimentId: 1, rev: first.rev, ops: [{op: 'addRow', xyz: [1, 1, 1]}]}).catch((e) => e),
    env.edit({pmid: '111', experimentId: 1, rev: first.rev, ops: [{op: 'addRow', xyz: [2, 2, 2]}]}, env.bob).catch((e) => e)
  ]);
  assert.strictEqual(results.filter((r) => r.rev).length, 1);
  assert.strictEqual(results.filter((r) => r.code === 1001).length, 1);
  assert.strictEqual(env.stored().Experiments[0].locations.length, 4);
}));
