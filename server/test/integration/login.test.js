// Login through GitHub authData must keep working with the closed _User CLP, and users
// that are not GitHub users cannot be created.

const assert = require('assert');
const {test} = require('./helpers/mini');

test('login: new GitHub user is created and gets a session', async (ctx) => {
  const u = await ctx.signup('login-a', 6001);
  assert.ok(u.id && u.session && u.session.startsWith('r:'), 'session token');
  ctx.login = {a: u};
});

test('login: logging in again returns the same user (200) with a session', async (ctx) => {
  const u = ctx.login.a;
  const res = await ctx.rest('POST', '/users', {body: {authData: {github: {id: String(u.githubId), access_token: u.token}}}});
  assert.strictEqual(res.status, 200, res.text);
  assert.strictEqual(res.json.objectId, u.id);
  assert.ok(res.json.sessionToken);
});

test('login: GET /users/me and GET /sessions/me work with the session', async (ctx) => {
  const u = ctx.login.a;
  const me = await ctx.rest('GET', '/users/me', {session: u.session});
  assert.strictEqual(me.status, 200, me.text);
  assert.strictEqual(me.json.objectId, u.id);
  const s = await ctx.rest('GET', '/sessions/me', {session: u.session});
  assert.strictEqual(s.status, 200, s.text);
});

test('login: logout works and kills the session', async (ctx) => {
  const u = await ctx.signup('login-b', 6002);
  const out = await ctx.rest('POST', '/logout', {session: u.session});
  assert.strictEqual(out.status, 200, out.text);
  const me = await ctx.rest('GET', '/users/me', {session: u.session});
  assert.ok(me.status >= 400);
});

test('login: INFORMATIONAL - own-row fetch and link, which the JS SDK uses (plan 3.2, to be verified)', async (ctx) => {
  const u = ctx.login.a;
  const get = await ctx.rest('GET', `/users/${u.id}`, {session: u.session});
  const put = await ctx.rest('PUT', `/users/${u.id}`, {session: u.session, body: {authData: {github: {id: String(u.githubId), access_token: u.token}}}});
  console.log(`       info: GET /users/<own id> -> ${get.status} ${get.status >= 400 ? get.text.slice(0, 120) : ''}`);
  console.log(`       info: PUT /users/<own id> (authData relink) -> ${put.status} ${put.status >= 400 ? put.text.slice(0, 120) : ''}`);
  // Not asserted: the plan says to record the minimum CLP change that restores login if
  // the SDK needs these. The assertions above (login, me, logout) are the hard requirement.
});

test('login: the stored _User row has no login name and no password; users cannot read authData of others', async (ctx) => {
  const row = await ctx.rest('GET', `/users/${ctx.login.a.id}`, {master: true});
  assert.strictEqual(row.status, 200);
  assert.ok(row.json.authData && row.json.authData.github, 'authData is stored');
  assert.ok(!('login' in row.json) && !('password' in row.json) && !('_hashed_password' in row.json));
  const b = await ctx.signup('login-c', 6003);
  const peek = await ctx.rest('GET', `/users/${ctx.login.a.id}`, {session: b.session});
  assert.ok(peek.status >= 400, peek.text);
  assert.ok(!peek.text.includes(ctx.login.a.token));
});

test('login: refused - bad token, token of another account, password signup, anonymous, no authData', async (ctx) => {
  const t = 'tok-real-' + Date.now();
  ctx.accounts[t] = {id: 7001, login: 'real'};
  const cases = [
    ['unknown token', {authData: {github: {id: '7001', access_token: 'nope'}}}],
    ['token of another account', {authData: {github: {id: '7002', access_token: t}}}],
    ['password signup', {username: 'pw-user', password: 'pw-pass-123'}],
    ['anonymous', {authData: {anonymous: {id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'}}}],
    ['empty authData', {authData: {}}],
    ['null github', {authData: {github: null}}],
    ['github without id', {authData: {github: {access_token: t}}}],
    ['nothing', {}]
  ];
  for (const [name, body] of cases) {
    const res = await ctx.rest('POST', '/users', {body});
    assert.ok(res.status >= 400, `${name}: ${res.status} ${res.text}`);
  }
  const users = await ctx.rest('GET', '/users', {master: true, });
  assert.ok(!users.json.results.some((u) => u.username === 'pw-user'), 'password user was created');
  assert.ok(users.json.results.every((u) => u.authData && u.authData.github), 'a user without GitHub authData exists');
});
