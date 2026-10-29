const test = require('node:test');
const assert = require('node:assert');
const {withStubs} = require('./stubs');

async function withEnv(fn) {
  const env = await withStubs();
  env.save = (p, user) => env.run('saveCollection', p, user === undefined ? env.alice : user);
  env.list = (user) => env.run('listCollections', {}, user === undefined ? env.alice : user);
  env.del = (p, user) => env.run('deleteCollection', p, user === undefined ? env.alice : user);
  try {
    await fn(env);
  } finally {
    await env.close();
  }
}

test('create, list, rename, add, remove, delete', () => withEnv(async (env) => {
  const c = await env.save({name: '  My   papers ', add: ['3', '1', '3']});
  assert.strictEqual(c.name, 'My papers');
  assert.deepStrictEqual(c.pmids, ['3', '1']);
  assert.match(c.updatedAt, /^\d{4}-/);
  const row = env.fake.rows('Collection')[0];
  assert.strictEqual(row.user, env.alice.id);
  assert.deepStrictEqual(row.acl, {}, 'restrictive ACL');

  const c2 = await env.save({id: c.id, name: 'Renamed', add: ['2', '1'], remove: ['3', '99']});
  assert.deepStrictEqual(c2, Object.assign({}, c2, {id: c.id, name: 'Renamed', pmids: ['1', '2']}));
  const c3 = await env.save({id: c.id, name: 'Renamed', remove: ['1', '2']});
  assert.deepStrictEqual(c3.pmids, []);
  assert.strictEqual((await env.list()).length, 1);
  assert.deepStrictEqual(await env.del({id: c.id}), {id: c.id});
  assert.deepStrictEqual(await env.list(), []);
  assert.strictEqual(env.fake.rows('Collection').length, 0);
}));

test('remove is applied before add: a PMID in both ends up last', () => withEnv(async (env) => {
  const c = await env.save({name: 'x', add: ['1', '2', '3']});
  const r = await env.save({id: c.id, name: 'x', add: ['1', '4'], remove: ['1']});
  assert.deepStrictEqual(r.pmids, ['2', '3', '1', '4']);
}));

test('on update the name is optional and kept', () => withEnv(async (env) => {
  const c = await env.save({name: 'keep', add: ['1']});
  const r = await env.save({id: c.id, add: ['2']});
  assert.strictEqual(r.name, 'keep');
  assert.deepStrictEqual(r.pmids, ['1', '2']);
  await env.expectCode(env.save({add: ['2']}), 142, /name/);
}));

test('listCollections returns only the caller\'s collections, oldest first', () => withEnv(async (env) => {
  await env.save({name: 'a'});
  await env.save({name: 'b'}, env.bob);
  await env.save({name: 'c'});
  assert.deepStrictEqual((await env.list()).map((c) => c.name), ['a', 'c']);
  assert.deepStrictEqual((await env.list(env.bob)).map((c) => c.name), ['b']);
}));

test('another user\'s collection: 119 for save and delete; unknown id: 101', () => withEnv(async (env) => {
  const c = await env.save({name: 'mine', add: ['1']});
  await env.expectCode(env.save({id: c.id, name: 'stolen', add: ['2']}, env.bob), 119);
  await env.expectCode(env.del({id: c.id}, env.bob), 119);
  await env.expectCode(env.save({id: 'nope', name: 'x'}), 101);
  await env.expectCode(env.del({id: 'nope'}), 101);
  const row = env.fake.rows('Collection')[0];
  assert.strictEqual(row.name, 'mine');
  assert.deepStrictEqual(row.pmids, ['1']);
}));

test('an object id of another class is not a collection', () => withEnv(async (env) => {
  const art = env.fake.addArticle({PMID: '5'});
  await env.expectCode(env.del({id: art.id}), 101);
  assert.strictEqual(env.fake.rows('Articles').length, 1);
}));

test('anonymous 206, non-GitHub user 119, on every function', () => withEnv(async (env) => {
  const pw = env.fake.addUser(undefined, {username: 'pw'});
  for (const user of [null, pw]) {
    const c = user === null ? 206 : 119;
    await env.expectCode(env.list(user), c);
    await env.expectCode(env.save({name: 'x'}, user), c);
    await env.expectCode(env.del({id: 'x'}, user), c);
  }
  assert.strictEqual(env.fake.rows('Collection').length, 0);
}));

test('validation of parameters', () => withEnv(async (env) => {
  const c = await env.save({name: 'ok'});
  const bad = (p, re) => env.expectCode(env.save(p), 142, re);
  await bad({name: ''}, /name/);
  await bad({name: '   '}, /name/);
  await bad({name: 'x'.repeat(101)}, /name/);
  await bad({name: 5}, /name/);
  await bad({name: 'a\nb'}, /name/);
  await bad({name: 'a', user: 'bob'}, /user/);
  await bad({name: 'a', pmids: ['1']}, /pmids/);
  await bad({name: 'a', add: '1'}, /add/);
  await bad({name: 'a', add: [1]}, /add\[0\]/);
  await bad({name: 'a', add: ['1', 'x1']}, /add\[1\]/);
  await bad({name: 'a', add: ['1234567890']}, /add/);
  await bad({name: 'a', remove: [' 1']}, /remove/);
  await bad({name: 'a', remove: null}, /remove/);
  await bad({id: 5, name: 'a'}, /id/);
  await bad({id: '', name: 'a'}, /id/);
  await bad({id: 'a b', name: 'a'}, /id/);
  await bad({id: c.id, name: 'x'.repeat(100) + 'y'}, /name/);
  assert.strictEqual((await env.save({name: 'x'.repeat(100)})).name.length, 100);
  await env.expectCode(env.del({}), 142, /id/);
  await env.expectCode(env.del({id: c.id, x: 1}), 142);
  await env.expectCode(env.run('listCollections', {x: 1}, env.alice), 142);
  assert.strictEqual(env.fake.rows('Collection').length, 2);
}));

test('limits: 2000 PMIDs per call, 2000 per collection, 50 collections', () => withEnv(async (env) => {
  const many = (from, n) => Array.from({length: n}, (_, i) => String(from + i));
  await env.expectCode(env.save({name: 'big', add: many(1, 2001)}), 142, /2000/);
  assert.strictEqual(env.fake.rows('Collection').length, 0);
  const c = await env.save({name: 'big', add: many(1, 2000)});
  assert.strictEqual(c.pmids.length, 2000);
  await env.expectCode(env.save({id: c.id, name: 'big', add: ['5000']}), 142, /2000/);
  assert.strictEqual((await env.save({id: c.id, name: 'big', add: ['5000'], remove: ['1']})).pmids.length, 2000);
  assert.strictEqual((await env.save({id: c.id, name: 'big', add: ['5']})).pmids.length, 2000);
  await env.expectCode(env.save({id: c.id, name: 'big', remove: many(1, 2001)}), 142);
}));

test('at most 50 collections per user', () => withEnv(async (env) => {
  const lib = env.lib('rate-limit');
  for (let i = 0; i < 50; i++) {
    await env.save({name: `c${i}`});
    lib.reset();
  }
  await env.expectCode(env.save({name: 'one too many'}), 142, /50/);
  assert.strictEqual((await env.save({name: 'bob'}, env.bob)).name, 'bob');
  const first = (await env.list())[0];
  await env.del({id: first.id});
  assert.strictEqual((await env.save({name: 'again'})).name, 'again');
}));

test('rate limit on saveCollection: 30 per minute', () => withEnv(async (env) => {
  const c = await env.save({name: 'x'});
  for (let i = 0; i < 29; i++) {
    await env.save({id: c.id, name: 'x', add: [String(i)]});
  }
  await env.expectCode(env.save({id: c.id, name: 'x'}), 155);
  assert.strictEqual((await env.save({name: 'y'}, env.bob)).name, 'y');
}));

test('concurrent saves of one collection do not lose updates', () => withEnv(async (env) => {
  const c = await env.save({name: 'x'});
  await Promise.all(['1', '2', '3', '4', '5'].map((p) => env.save({id: c.id, name: 'x', add: [p]})));
  assert.deepStrictEqual(env.fake.rows('Collection')[0].pmids.slice().sort(), ['1', '2', '3', '4', '5']);
}));
