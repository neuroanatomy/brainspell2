// Fix round: the GitHub token is not served back, restore-revision, caps, select throttle.

const assert = require('assert');
const {test} = require('./helpers/mini');

const where = (o) => encodeURIComponent(JSON.stringify(o));
const ok = (res, what) => {
  assert.strictEqual(res.status, 200, `${what}: ${res.status} ${res.text}`);

  return res.json.result;
};

test('authData (GitHub token) is not returned by /users/me, /users/<id> with the user\'s own session, /sessions/me; master still sees it', async (ctx) => {
  const u = await ctx.signup('fix-a', 9601);
  const me = await ctx.rest('GET', '/users/me', {session: u.session});
  assert.strictEqual(me.status, 200, me.text);
  assert.ok(!me.text.includes(u.token), '/users/me contains the token');
  assert.ok(!('authData' in me.json), '/users/me has authData');
  assert.strictEqual(me.json.sessionToken, u.session);
  const sm = await ctx.rest('GET', '/sessions/me', {session: u.session});
  assert.strictEqual(sm.status, 200, sm.text);
  assert.ok(!sm.text.includes(u.token), '/sessions/me contains the token');
  const again = await ctx.rest('POST', '/users', {body: {authData: {github: {id: String(u.githubId), access_token: u.token}}}});
  assert.ok(!again.text.includes(u.token), 'login answer contains the token');
  const master = await ctx.rest('GET', `/users/${u.id}`, {master: true});
  assert.ok(master.json.authData && master.json.authData.github.access_token === u.token, 'master must still read authData');
  // and the server side still works with it: write functions and me
  assert.strictEqual(ok(await ctx.cloud('me', {}, u.session), 'me').login, 'fix-a');
});

test('second Parse user for the same GitHub account is refused (number, string)', async (ctx) => {
  const u = await ctx.signup('fix-b', 9602);
  for (const id of [9602, '9602']) {
    const res = await ctx.rest('POST', '/users', {body: {authData: {github: {id, access_token: u.token}}}});
    // the same spelling logs in as the same user; the other spelling must not create a second user
    if (res.status < 400) {
      assert.strictEqual(res.json.objectId, u.id, `id ${JSON.stringify(id)} produced another user`);
    }
  }
  const users = await ctx.rest('GET', `/users?where=${where({objectId: {$exists: true}})}&limit=1000`, {master: true});
  assert.strictEqual(users.json.results.filter((x) => x.authData && x.authData.github && String(x.authData.github.id) === '9602').length, 1);
  for (const bad of ['09602', ' 9602', '+9602', 9602.5, '0009602']) {
    const res = await ctx.rest('POST', '/users', {body: {authData: {github: {id: bad, access_token: u.token}}}});
    assert.ok(res.status >= 400, `non canonical id ${JSON.stringify(bad)} accepted: ${res.text}`);
  }
});

test('revisions are applied; restore-revision (dry run, real, refusals) and caps', async (ctx) => {
  const art = await ctx.rest('POST', '/classes/Articles', {master: true, body: {
    PMID: '707070', Title: 'R', Experiments: [{id: 1, title: 'orig', caption: 'c', locations: ['1,1,1', '2,2,2,5'], tags: []}], Metadata: {}
  }});
  assert.strictEqual(art.status, 201, art.text);
  const u = await ctx.signup('fix-c', 9603);
  const edit = (rev, ops) => ctx.cloud('editExperiment', {pmid: '707070', experimentId: 1, rev, ops}, u.session);
  ok(await edit(0, [{op: 'setTitle', text: 'changed'}, {op: 'updateRow', index: 1, xyz: [9, 9, 9]}]), 'edit');
  const a = (await ctx.rest('GET', `/classes/Articles/${art.json.objectId}`, {master: true})).json;
  assert.deepStrictEqual(a.Experiments[0].locations, ['1,1,1', '9,9,9,5'], 'the 4th value of a legacy row is kept');
  const revs = (await ctx.rest('GET', `/classes/Revision?where=${where({pmid: '707070'})}`, {master: true})).json.results;
  assert.deepStrictEqual(revs.map((r) => r.applied), [true]);
  // caps
  const splits = Array.from({length: 21}, () => ({op: 'split', index: 1}));
  const capped = await edit(1, splits);
  assert.strictEqual(capped.json.code, 142, capped.text);
  const big = await edit(1, [1, 2, 3].map(() => ({op: 'replaceFromText', text: '1,2,3'.padEnd(400000, ' ')})));
  assert.strictEqual(big.json.code, 142, big.text);
  assert.strictEqual((await edit(undefined, [{op: 'setTitle', text: 'x'}])).json.code, 142);
  // dry run changes nothing
  let r = await ctx.runScript('restore-revision.js', ['--dry-run', '707070', '1']);
  assert.strictEqual(r.code, 0, r.stderr);
  assert.match(r.stdout, /restore 1 experiment/);
  assert.ok(!r.stdout.includes(ctx.masterKey) && !r.stderr.includes(ctx.masterKey));
  let now = (await ctx.rest('GET', `/classes/Articles/${art.json.objectId}`, {master: true})).json;
  assert.strictEqual(now.rev, 1);
  // refusals
  r = await ctx.runScript('restore-revision.js', ['707070', '7']);
  assert.notStrictEqual(r.code, 0);
  r = await ctx.runScript('restore-revision.js', ['707070', '1', '99']);
  assert.notStrictEqual(r.code, 0);
  // real restore
  r = await ctx.runScript('restore-revision.js', ['707070', '1']);
  assert.strictEqual(r.code, 0, r.stderr + r.stdout);
  now = (await ctx.rest('GET', `/classes/Articles/${art.json.objectId}`, {master: true})).json;
  assert.strictEqual(now.rev, 2);
  assert.strictEqual(now.Experiments[0].title, 'orig');
  assert.deepStrictEqual(now.Experiments[0].locations, ['1,1,1', '2,2,2,5']);
  const all = (await ctx.rest('GET', `/classes/Revision?where=${where({pmid: '707070'})}&order=rev`, {master: true})).json.results;
  assert.deepStrictEqual(all.map((x) => [x.rev, x.applied]), [[1, true], [2, true]]);
  assert.strictEqual(all[1].before[0].title, 'changed');
});

test('select: global throttle answers 155 (30 per second)', async (ctx) => {
  const codes = await Promise.all(Array.from({length: 45}, () => ctx.cloud('select', {q: 'memory'})));
  const limited = codes.filter((r) => r.json && r.json.code === 155).length;
  assert.ok(limited >= 1, `no request was throttled (${codes.map((r) => r.status).join(',')})`);
  assert.ok(codes.some((r) => r.status === 200));
  await new Promise((r) => setTimeout(r, 1200));
  assert.strictEqual((await ctx.cloud('select', {q: 'memory'})).status, 200);
  assert.strictEqual((await ctx.cloud('select', {q: 'x _val_:"y"'})).json.code, 142);
});
