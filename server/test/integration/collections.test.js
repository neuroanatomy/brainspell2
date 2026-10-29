// Collections through the real REST API.

const assert = require('assert');
const {test} = require('./helpers/mini');

const ok = (res, what) => {
  assert.strictEqual(res.status, 200, `${what}: ${res.status} ${res.text}`);

  return res.json.result;
};
const code = (res, c, what) => {
  assert.ok(res.status >= 400, `${what}: expected failure, got ${res.status} ${res.text}`);
  assert.strictEqual(res.json.code, c, `${what}: ${res.text}`);
};

test('collections: full flow and ownership', async (ctx) => {
  const alice = await ctx.signup('col-alice', 9201);
  const bob = await ctx.signup('col-bob', 9202);
  code(await ctx.cloud('listCollections', {}), 206, 'anonymous list');
  code(await ctx.cloud('saveCollection', {name: 'x'}), 206, 'anonymous save');
  code(await ctx.cloud('deleteCollection', {id: 'abc'}), 206, 'anonymous delete');
  code(await ctx.cloud('saveCollection', {name: 'x', user: bob.id}, alice.session), 142, 'user parameter');
  code(await ctx.cloud('saveCollection', {name: 'x', add: ['1', 'a']}, alice.session), 142, 'bad pmid');

  const c = ok(await ctx.cloud('saveCollection', {name: 'Reading list', add: ['3', '1', '3']}, alice.session), 'create');
  assert.strictEqual(c.name, 'Reading list');
  assert.deepStrictEqual(c.pmids, ['3', '1']);
  assert.ok(c.id && c.updatedAt);
  const c2 = ok(await ctx.cloud('saveCollection', {id: c.id, name: 'Renamed', add: ['2'], remove: ['3']}, alice.session), 'update');
  assert.deepStrictEqual(c2.pmids, ['1', '2']);
  assert.strictEqual(c2.name, 'Renamed');
  assert.deepStrictEqual(ok(await ctx.cloud('listCollections', {}, alice.session), 'list').map((x) => [x.id, x.name, x.pmids]), [[c.id, 'Renamed', ['1', '2']]]);
  assert.deepStrictEqual(ok(await ctx.cloud('listCollections', {}, bob.session), 'list bob'), []);

  // bob cannot touch it
  code(await ctx.cloud('saveCollection', {id: c.id, name: 'mine now'}, bob.session), 119, 'bob save');
  code(await ctx.cloud('deleteCollection', {id: c.id}, bob.session), 119, 'bob delete');
  code(await ctx.cloud('saveCollection', {id: 'doesNotExist1', name: 'x'}, alice.session), 101, 'unknown id');
  code(await ctx.cloud('deleteCollection', {id: 'doesNotExist1'}, alice.session), 101, 'unknown id delete');

  // the objects are invisible and untouchable for clients
  const stored = (await ctx.rest('GET', `/classes/Collection/${c.id}`, {master: true})).json;
  assert.strictEqual(stored.user, alice.id);
  assert.ok(!stored.ACL || !stored.ACL['*'], `public ACL: ${JSON.stringify(stored.ACL)}`);
  for (const [who, session] of [['anonymous', undefined], ['alice', alice.session], ['bob', bob.session]]) {
    const find = await ctx.rest('GET', '/classes/Collection', {session});
    assert.ok(find.status >= 400, `${who} listed Collection: ${find.text}`);
    const get = await ctx.rest('GET', `/classes/Collection/${c.id}`, {session});
    assert.ok(get.status >= 400, `${who} read the collection: ${get.text}`);
    const put = await ctx.rest('PUT', `/classes/Collection/${c.id}`, {session, body: {name: 'hacked'}});
    assert.ok(put.status >= 400, `${who} updated the collection`);
    const post = await ctx.rest('POST', '/classes/Collection', {session, body: {user: bob.id, name: 'forged', pmids: []}});
    assert.ok(post.status >= 400, `${who} created a collection`);
    const del = await ctx.rest('DELETE', `/classes/Collection/${c.id}`, {session});
    assert.ok(del.status >= 400, `${who} deleted the collection`);
  }
  assert.strictEqual((await ctx.rest('GET', `/classes/Collection/${c.id}`, {master: true})).json.name, 'Renamed');

  assert.deepStrictEqual(ok(await ctx.cloud('deleteCollection', {id: c.id}, alice.session), 'delete'), {id: c.id});
  assert.deepStrictEqual(ok(await ctx.cloud('listCollections', {}, alice.session), 'list after'), []);
  assert.strictEqual((await ctx.rest('GET', `/classes/Collection/${c.id}`, {master: true})).status, 404);
});

test('collections: limits and concurrent saves', async (ctx) => {
  const u = await ctx.signup('col-limits', 9203);
  const many = Array.from({length: 2001}, (_, i) => String(i + 1));
  code(await ctx.cloud('saveCollection', {name: 'big', add: many}, u.session), 142, '2001 in one call');
  const c = ok(await ctx.cloud('saveCollection', {name: 'big', add: many.slice(0, 2000)}, u.session), '2000');
  assert.strictEqual(c.pmids.length, 2000);
  code(await ctx.cloud('saveCollection', {id: c.id, name: 'big', add: ['99999']}, u.session), 142, '2001 in collection');
  const res = await Promise.all(['1', '2', '3', '4'].map((p) => ctx.cloud('saveCollection', {id: c.id, add: [p], remove: [String(Number(p) + 10)]}, u.session)));
  res.forEach((r) => assert.strictEqual(r.status, 200, r.text));
  const final = ok(await ctx.cloud('listCollections', {}, u.session), 'list')[0];
  assert.strictEqual(final.pmids.length, 1996);
  assert.deepStrictEqual(final.pmids.slice(0, 2), ['1', '2'], 'present PMIDs keep their place');
  ['11', '12', '13', '14'].forEach((p) => assert.ok(!final.pmids.includes(p), `${p} was removed`));
  assert.ok(final.pmids.includes('15'));
});

test('collections: at most 50 per user, rate limit 30 per minute', async (ctx) => {
  const u = await ctx.signup('col-fifty', 9204);
  let created = 0;
  let res;
  for (; created < 30; created++) {
    res = await ctx.cloud('saveCollection', {name: `c${created}`}, u.session);
    assert.strictEqual(res.status, 200, res.text);
  }
  code(await ctx.cloud('saveCollection', {name: 'over the rate'}, u.session), 155, '31st call in a minute');
  const w = await ctx.signup('col-fifty2', 9205);
  for (let i = 0; i < 30; i++) {
    ok(await ctx.cloud('saveCollection', {name: `d${i}`}, w.session), 'w create');
  }
  // 50 collections: use a user whose calls were spread (rate limit is per minute, so go through the master key)
  const x = await ctx.signup('col-fifty3', 9206);
  for (let i = 0; i < 50; i++) {
    const r = await ctx.rest('POST', '/classes/Collection', {master: true, body: {user: x.id, name: `m${i}`, pmids: [], ACL: {}}});
    assert.strictEqual(r.status, 201, r.text);
  }
  code(await ctx.cloud('saveCollection', {name: 'fifty-first'}, x.session), 142, 'over 50');
});
