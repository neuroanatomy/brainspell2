const test = require('node:test');
const assert = require('node:assert');
const {setup} = require('../helpers/env');

async function withEnv(fn, accounts) {
  const env = await setup(accounts);
  try {
    await fn(env);
  } finally {
    await env.close();
  }
}

const throwsCode = (fn, code) => assert.throws(fn, (e) => e.code === code, `expected code ${code}`);

test('normalize.tagKey', () => withEnv((env) => {
  const {tagKey} = env.lib('normalize');
  assert.strictEqual(tagKey('  Working   MEMORY\t'), 'working memory');
  assert.strictEqual(tagKey('é'), tagKey('é'));
  assert.throws(() => tagKey(5), TypeError);
}));

test('validate.str', () => withEnv((env) => {
  const v = env.lib('validate');
  assert.strictEqual(v.str('abc', 'f', {min: 1, max: 3}), 'abc');
  throwsCode(() => v.str('', 'f', {min: 1, max: 3}), 142);
  throwsCode(() => v.str('abcd', 'f', {min: 1, max: 3}), 142);
  throwsCode(() => v.str(5, 'f'), 142);
  throwsCode(() => v.str('a\u0000b', 'f'), 142);
  throwsCode(() => v.str('a\nb', 'f'), 142);
  assert.strictEqual(v.str('a\nb', 'f', {multiline: true}), 'a\nb');
  throwsCode(() => v.str('a\u0007b', 'f', {multiline: true}), 142);
  // code points, not UTF-16 units
  assert.strictEqual(v.str('\u{1F600}\u{1F600}', 'f', {max: 2}), '\u{1F600}\u{1F600}');
  assert.throws(() => v.str('x', 'myField', {min: 2}), /myField/);
}));

test('validate.int, pmid, oneOf, noUnknown', () => withEnv((env) => {
  const v = env.lib('validate');
  assert.strictEqual(v.int(5, 'n', {min: 1, max: 5}), 5);
  for (const bad of ['5', 5.5, NaN, Infinity, null, undefined, 0, 6, true]) {
    throwsCode(() => v.int(bad, 'n', {min: 1, max: 5}), 142);
  }
  assert.strictEqual(v.pmid('123456789'), '123456789');
  for (const bad of [123, '', '1234567890', '12a', '-1', '1.5', ' 1', null, undefined, ['1']]) {
    throwsCode(() => v.pmid(bad), 142);
  }
  assert.strictEqual(v.oneOf(1, 'v', [1, -1, 0]), 1);
  throwsCode(() => v.oneOf('1', 'v', [1, -1, 0]), 142);
  throwsCode(() => v.oneOf(undefined, 'v', ['a']), 142);
  assert.deepStrictEqual(v.noUnknown(undefined, ['a']), {});
  assert.deepStrictEqual(v.noUnknown({a: 1}, ['a']), {a: 1});
  throwsCode(() => v.noUnknown({a: 1, b: 2}, ['a']), 142);
  throwsCode(() => v.noUnknown([], ['a']), 142);
  throwsCode(() => v.noUnknown('x', ['a']), 142);
  throwsCode(() => v.noUnknown(JSON.parse('{"__proto__": 1}'), ['a']), 142);
}));

test('locks: FIFO per key, parallel across keys, released on error', () => withEnv(async (env) => {
  const {withLock, size} = env.lib('locks');
  const log = [];
  const slow = (name, ms) => withLock('k', async () => {
    log.push(`start ${name}`);
    await new Promise((r) => setTimeout(r, ms));
    log.push(`end ${name}`);
  });
  await Promise.all([slow('a', 30), slow('b', 1), slow('c', 1)]);
  assert.deepStrictEqual(log, ['start a', 'end a', 'start b', 'end b', 'start c', 'end c']);
  await assert.rejects(withLock('k', async () => {
    throw new Error('boom');
  }), /boom/);
  assert.strictEqual(await withLock('k', async () => 7), 7);
  const order = [];
  await Promise.all([
    withLock('x', async () => {
      await new Promise((r) => setTimeout(r, 20));
      order.push('x');
    }),
    withLock('y', async () => order.push('y'))
  ]);
  assert.deepStrictEqual(order, ['y', 'x']);
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(size(), 0);
}));

test('rate-limit: window, per user, per name, 155 with retry seconds, eviction, refused not counted', () => withEnv((env) => {
  const rl = env.lib('rate-limit');
  let now = 1000000;
  rl.setClock(() => now);
  for (let i = 0; i < 60; i++) {
    rl.check('u1', 'vote');
  }
  assert.throws(() => rl.check('u1', 'vote'), (e) => e.code === 155 && /retry in 60 seconds/.test(e.message));
  rl.check('u2', 'vote');
  now += 30000;
  assert.throws(() => rl.check('u1', 'vote'), (e) => e.code === 155 && /retry in 30 seconds/.test(e.message));
  now += 30001;
  rl.check('u1', 'vote');
  // postComment: 5/min and 20/day
  for (let i = 0; i < 5; i++) {
    rl.check('u3', 'postComment');
  }
  assert.throws(() => rl.check('u3', 'postComment'), (e) => e.code === 155);
  for (let round = 0; round < 3; round++) {
    now += 61000;
    for (let i = 0; i < 5; i++) {
      rl.check('u3', 'postComment');
    }
  }
  now += 61000;
  assert.throws(() => rl.check('u3', 'postComment'), (e) => e.code === 155 && /retry/.test(e.message));
  now += 25 * 3600 * 1000;
  rl.check('u3', 'postComment');
  assert.throws(() => rl.check('u1', 'nope'), /unknown name/);
  rl.reset();
  assert.strictEqual(rl.size(), 0);
}));

test('rate-limit: old keys are evicted by the sweep', () => withEnv((env) => {
  const rl = env.lib('rate-limit');
  let now = 0;
  rl.setClock(() => now);
  for (let i = 0; i < 100; i++) {
    rl.check(`user${i}`, 'vote');
  }
  assert.strictEqual(rl.size(), 100);
  now += 2 * 60 * 1000;
  for (let i = 0; i < 1000; i++) {
    rl.check('same', 'vote' );
    now += 10;
    if (i % 50 === 49) {
      now += 61000;
    }
  }
  assert.ok(rl.size() < 100, `size ${rl.size()}`);
}));

test('github.fetchUser: success and failures', () => withEnv(async (env) => {
  const {fetchUser} = env.lib('github');
  env.github.accounts.good = {id: 42, login: 'alice'};
  env.github.accounts.down = {status: 503};
  env.github.accounts.weird = {id: '42', login: 'alice'};
  env.github.accounts.badlogin = {id: 5, login: 'a b<script>'};
  assert.deepStrictEqual(await fetchUser('good'), {id: 42, login: 'alice'});
  await assert.rejects(fetchUser('revoked'), (e) => e.code === 119);
  await assert.rejects(fetchUser('down'), (e) => e.code === 1002);
  await assert.rejects(fetchUser('weird'), (e) => e.code === 1002);
  await assert.rejects(fetchUser('badlogin'), (e) => e.code === 1002);
  await assert.rejects(fetchUser(undefined), (e) => e.code === 119);
  await assert.rejects(fetchUser('a\r\nX: y'), (e) => e.code === 119);
  assert.strictEqual(env.github.calls[0].auth, 'token good');
  process.env.GITHUB_API_URL = 'http://127.0.0.1:1';
  await assert.rejects(fetchUser('good'), (e) => e.code === 1002);
}));
