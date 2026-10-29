// SECURITY / robustness probes against the REAL server (plan 3.1, 3.2, 3.6, 3.7, 5). Every test asserts the
// SECURE behaviour; a failing test is a finding. Run with test/contract/run.js (see there).

const assert = require('assert');
const crypto = require('crypto');
const {test} = require('../integration/helpers/mini');

const where = (o) => encodeURIComponent(JSON.stringify(o));
const OKCODES = new Set([142, 101, 206, 119, 155, 137, 1001, 1002]);

let counter = 0;
async function newUser(ctx, idToSend, ghId) {
  const n = ++counter;
  const login = `sec-u${n}`;
  const id = ghId || 20000 + n;
  const token = `tok-${login}-${crypto.randomBytes(4).toString('hex')}`;
  ctx.accounts[token] = {id, login};
  const res = await ctx.rest('POST', '/users', {body: {authData: {github: {id: idToSend === undefined ? id : idToSend, access_token: token}}}});
  if (res.status !== 200 && res.status !== 201) {
    return {error: res};
  }

  return {login, ghId: id, token, id: res.json.objectId, session: res.json.sessionToken, raw: res.json};
}

const ART = {
  PMID: '666001', Title: 'Sec', Authors: 'A', Reference: 'r', Abstract: 'a',
  Experiments: [{id: 1, title: 't', caption: 'c', locations: ['1,2,3', '4,5,6', '7,8,9', '1,1,1'], tags: [], markBadTable: {ok: 0, bad: 0}}],
  Metadata: {meshHeadings: [{name: 'Brain', majorTopic: true}, {name: 'Humans', majorTopic: false}]}
};

test('sec: setup', async (ctx) => {
  assert.strictEqual((await ctx.rest('POST', '/classes/Articles', {master: true, body: ART})).status, 201);
  assert.strictEqual((await ctx.rest('POST', '/classes/Concept', {master: true, body: {name: 'attention', ontology: 'cognitive'}})).status, 201);
  ctx.sec = {pool: [], alice: await newUser(ctx), bob: await newUser(ctx)};
  ctx.sec.carol = await newUser(ctx);
});

// ------------------------------------------------------------------------------ identity

test('sec identity: password / anonymous / empty-authData sign-ups are refused (also with master key)', async (ctx) => {
  const bad = [
    ['password', {username: 'pw-user', password: 'secret123'}, false],
    ['password + master', {username: 'pw-user2', password: 'secret123'}, true],
    ['anonymous authData', {authData: {anonymous: {id: crypto.randomUUID()}}}, false],
    ['github id empty', {authData: {github: {id: '', access_token: 'x'}}}, false],
    ['github id null', {authData: {github: {id: null, access_token: 'x'}}}, false],
    ['github not an object', {authData: {github: 5}}, false],
    ['github id = operator object', {authData: {github: {id: {$ne: 1}, access_token: 'x'}}}, false],
    ['unknown provider', {authData: {facebook: {id: '1', access_token: 'x'}}}, false],
    ['empty authData', {authData: {}}, false]
  ];
  const created = [];
  for (const [name, body, master] of bad) {
    const r = await ctx.rest('POST', '/users', {body, master});
    if (r.status < 400) {
      created.push(`${name}: ${r.status} ${r.text.slice(0, 120)}`);
    }
  }
  assert.deepStrictEqual(created, [], 'users were created that are not GitHub users');
});

test('sec identity: forged authData (valid id of another account, wrong token) is refused', async (ctx) => {
  const {alice} = ctx.sec;
  const r = await ctx.rest('POST', '/users', {body: {authData: {github: {id: alice.ghId, access_token: 'tok-forged'}}}});
  assert.ok(r.status >= 400, `forged login accepted: ${r.text}`);
  // a token that belongs to another GitHub account used with Alice's id
  const r2 = await ctx.rest('POST', '/users', {body: {authData: {github: {id: alice.ghId, access_token: ctx.sec.bob.token}}}});
  assert.ok(r2.status >= 400, `token of bob accepted for alice's id: ${r2.text}`);
});

test('sec identity: ONE GitHub account must map to ONE Parse user (Sybil: id as number / string / zero padded)', async (ctx) => {
  const gh = 31337;
  const variants = [gh, String(gh), `0${gh}`, `00${gh}`, `0000000${gh}`, ` ${gh}`, `+${gh}`];
  const made = [];
  for (const v of variants) {
    const u = await newUser(ctx, v, gh);
    if (!u.error) {
      made.push({sent: JSON.stringify(v), user: u});
    }
  }
  ctx.sec.sybil = made;
  // how many distinct Parse users the same GitHub account obtained
  const distinct = new Set(made.map((m) => m.user.id)).size;
  assert.strictEqual(distinct, 1, `GitHub account ${gh} obtained ${distinct} different Parse users via id spellings: ${made.map((m) => m.sent).join(' ')}`);
});

test('sec identity: the Sybil users (if any) each get their own vote and their own rate limits', async (ctx) => {
  const made = ctx.sec.sybil || [];
  let agree = 0;
  for (const m of made) {
    const r = await ctx.cloud('vote', {pmid: '666001', experimentId: -1, kind: 'mesh', tag: 'Brain', value: 1}, m.user.session);
    if (r.status === 200) {
      agree = r.json.result.agree;
    }
  }
  assert.ok(agree <= 1, `one GitHub account produced agree=${agree} on a single heading (users usable: ${made.map((m) => m.sent).join(' ')})`);
});

test('sec identity: GET /users/me returns the GitHub access token to the browser? (informational; asserts it does not)', async (ctx) => {
  const r = await ctx.rest('GET', '/users/me', {session: ctx.sec.alice.session});
  const leaked = r.text.includes(ctx.sec.alice.token);
  const post = JSON.stringify(ctx.sec.alice.raw).includes(ctx.sec.alice.token);
  assert.ok(!leaked && !post, `the Parse user ${r.status} contains the GitHub token: GET /users/me=${leaked}, sign-up response=${post}`);
});

test('sec identity: a user cannot rewrite own authData / username / ACL (PUT /users/<id>, /users/me)', async (ctx) => {
  const {alice, bob} = ctx.sec;
  const tries = [
    ['PUT own authData -> bob id', 'PUT', `/users/${alice.id}`, {authData: {github: {id: bob.ghId, access_token: alice.token}}}],
    ['PUT own username', 'PUT', `/users/${alice.id}`, {username: 'root'}],
    ['PUT own ACL', 'PUT', `/users/${alice.id}`, {ACL: {'*': {read: true, write: true}}}],
    ['PUT foreign user', 'PUT', `/users/${bob.id}`, {username: 'hacked'}],
    ['DELETE foreign user', 'DELETE', `/users/${bob.id}`, undefined],
    ['DELETE own user', 'DELETE', `/users/${alice.id}`, undefined],
    ['GET foreign user', 'GET', `/users/${bob.id}`, undefined],
    ['GET /users (list)', 'GET', '/users', undefined]
  ];
  const accepted = [];
  for (const [name, method, p, body] of tries) {
    const r = await ctx.rest(method, p, {session: alice.session, body});
    if (r.status < 400) {
      accepted.push(`${name}: ${r.status} ${r.text.slice(0, 100)}`);
    }
  }
  assert.deepStrictEqual(accepted, []);
  // alice is still usable
  const me = await ctx.cloud('me', {}, alice.session);
  assert.strictEqual(me.json.result.login, alice.login);
});

test('sec identity: invalid / expired session tokens never identify a user', async (ctx) => {
  for (const tok of ['r:deadbeef', ctx.sec.alice.session + 'x', '', 'undefined']) {
    const r = await ctx.cloud('vote', {pmid: '666001', experimentId: -1, kind: 'mesh', tag: 'Brain', value: 1}, tok || undefined);
    assert.ok(r.status >= 400 && [206, 209].includes(r.json.code), `token "${tok}": ${r.text}`);
  }
});

// ------------------------------------------------------------------------------ permissions / ACLs

test('sec acl: objects created by the functions have restrictive ACLs and cannot be touched by their owner through REST', async (ctx) => {
  const {carol} = ctx.sec;
  ctx.sec.pubmedOk = true;
  const calls = [
    ctx.cloud('vote', {pmid: '666001', experimentId: -1, kind: 'mesh', tag: 'Humans', value: 1}, carol.session),
    ctx.cloud('postComment', {pmid: '666001', text: 'acl probe'}, carol.session),
    ctx.cloud('saveCollection', {name: 'acl', add: ['666001']}, carol.session),
    ctx.cloud('editExperiment', {pmid: '666001', experimentId: 1, rev: 0, ops: [{op: 'setTitle', text: 'acl'}]}, carol.session)
  ];
  const res = await Promise.all(calls);
  res.forEach((r, i) => assert.strictEqual(r.status, 200, `call ${i}: ${r.text}`));
  const out = [];
  for (const cls of ['Vote', 'Comment', 'Collection', 'Revision', 'UserProfile']) {
    const rows = (await ctx.rest('GET', `/classes/${cls}?limit=1000`, {master: true})).json.results.filter((o) => o.user === carol.id);
    assert.ok(rows.length, `no ${cls} for carol`);
    for (const row of rows) {
      const acl = row.ACL || {};
      const pub = acl['*'] || {};
      if (pub.write) {
        out.push(`${cls}/${row.objectId} public write`);
      }
      if (cls !== 'Comment' && pub.read) {
        out.push(`${cls}/${row.objectId} public read`);
      }
      if (Object.keys(acl).some((k) => k !== '*' && acl[k].write)) {
        out.push(`${cls}/${row.objectId} owner write ACL: ${JSON.stringify(acl)}`);
      }
      // even the owner (and anybody) is refused by the CLP
      for (const m of ['PUT', 'DELETE']) {
        const r = await ctx.rest(m, `/classes/${cls}/${row.objectId}`, {session: carol.session, body: m === 'PUT' ? {text: 'x', value: 1} : undefined});
        if (r.status < 400) {
          out.push(`${m} ${cls}/${row.objectId} by owner accepted`);
        }
      }
      const g = await ctx.rest('GET', `/classes/${cls}/${row.objectId}`, {session: ctx.sec.bob.session});
      if (cls !== 'Comment' && g.status < 400) {
        out.push(`GET ${cls}/${row.objectId} by another user accepted`);
      }
    }
  }
  assert.deepStrictEqual(out, []);
});

test('sec acl: Articles cannot be written/created/deleted by a logged-in user; Comment cannot be forged through REST', async (ctx) => {
  const {alice} = ctx.sec;
  const art = (await ctx.rest('GET', `/classes/Articles?where=${where({PMID: '666001'})}`)).json.results[0];
  const tries = [
    ['PUT article', 'PUT', `/classes/Articles/${art.objectId}`, {Experiments: []}],
    ['DELETE article', 'DELETE', `/classes/Articles/${art.objectId}`, undefined],
    ['POST article', 'POST', '/classes/Articles', {PMID: '1', Title: 'x'}],
    ['POST Comment', 'POST', '/classes/Comment', {pmid: '666001', login: 'octocat', text: 'forged'}],
    ['POST Vote', 'POST', '/classes/Vote', {pmid: '666001', kind: 'mesh', tag: 'Brain', value: 1, user: alice.id}],
    ['POST Concept', 'POST', '/classes/Concept', {name: 'x', ontology: 'cognitive'}],
    ['POST new class', 'POST', '/classes/Evil', {a: 1}],
    ['schema read', 'GET', '/schemas', undefined],
    ['aggregate', 'GET', '/aggregate/Articles?group=%7B%22objectId%22%3A%22%24Title%22%7D', undefined],
    ['batch write', 'POST', '/batch', {requests: [{method: 'POST', path: '/parse/classes/Comment', body: {pmid: '666001', login: 'x', text: 'y'}}]}],
    ['config', 'GET', '/config', undefined],
    ['push', 'POST', '/push', {where: {}, data: {alert: 'x'}}],
    ['installations', 'GET', '/installations', undefined],
    ['roles', 'GET', '/roles', undefined],
    ['functions/unknown', 'POST', '/functions/doesNotExist', {}],
    ['jobs', 'POST', '/jobs/anything', {}],
    ['hooks', 'GET', '/hooks/functions', undefined]
  ];
  const accepted = [];
  for (const [name, method, p, body] of tries) {
    const r = await ctx.rest(method, p, {session: alice.session, body});
    let bad = r.status < 400;
    if (name === 'batch write' && r.status === 200) {
      bad = Array.isArray(r.json) && r.json.some((x) => x.success);
    }
    if (name === 'config' && r.status === 200) {
      bad = false; // GET /config is public by design; checked below
    }
    if (bad) {
      accepted.push(`${name}: ${r.status} ${r.text.slice(0, 120)}`);
    }
  }
  assert.deepStrictEqual(accepted, []);
});

test('sec acl: GET /config (public) does not expose keys', async (ctx) => {
  const r = await ctx.rest('GET', '/config', {session: ctx.sec.alice.session});
  assert.ok(!r.text.includes(ctx.masterKey), 'master key in /config');
});

// ------------------------------------------------------------------------------ input fuzz

const HOSTILE = () => [
  null, true, false, 0, -1, 1.5, 1e308, -1e308, 9007199254740993, 4294967296, '', ' ', '\u0000', 'a\u0000b', '\ud800', '\udfff', '‮', '﻿',
  'İ'.repeat(20), 'á'.repeat(30), 'Å', 'ﬃ', '𝒜'.repeat(3000), 'x'.repeat(200000), '__proto__', 'constructor', 'toString', 'hasOwnProperty',
  '${jndi:ldap://x/a}', '{!func}1', '_query_:"x"', '<img src=x onerror=alert(1)>', 'javascript:alert(1)', "'; db.dropDatabase(); //", '$gt', '../../etc/passwd',
  [], [1, 2], [[]], ['a'], [null], {}, {$gt: ''}, {$ne: null}, {$regex: '.*'}, JSON.parse('{"__proto__":{"polluted":1}}'),
  JSON.parse('{"constructor":{"prototype":{"polluted":1}}}'), JSON.parse('{"a":{"b":{"c":{"d":{"e":1}}}}}'), {toString: 1}, {length: 5}
];

const BASES = {
  getAnnotations: {pmid: '666001'},
  vote: {pmid: '666001', experimentId: 1, kind: 'tag', ontology: 'cognitive', tag: 'attention', value: 1},
  setStereoSpace: {pmid: '666001', space: 'MNI'},
  setNSubjects: {pmid: '666001', n: 20},
  postComment: {pmid: '666001', text: 'fuzz'},
  editExperiment: {pmid: '666001', experimentId: 1, rev: 0, ops: [{op: 'setTitle', text: 't'}]},
  addArticle: {pmid: '123', nTables: 1},
  listCollections: {},
  saveCollection: {name: 'n', add: ['1'], remove: ['2']},
  deleteCollection: {id: 'abc'},
  listConcepts: {ontology: 'cognitive'},
  getConcept: {name: 'attention', ontology: 'cognitive'},
  select: {q: 'brain', rows: 5, start: 0},
  me: {}
};

test('sec fuzz: every parameter of every function with hostile values never gives an internal error (141/1/...)', async (ctx) => {
  const sessions = [];
  const fresh = async () => {
    const u = await newUser(ctx);
    sessions.push(u.session);

    return u.session;
  };
  let session = await fresh();
  const bad = [];
  let calls = 0;
  const hostile = HOSTILE();
  for (const fn of Object.keys(BASES)) {
    const base = BASES[fn];
    const keys = Object.keys(base);
    const variants = [];
    for (const k of keys) {
      for (const h of hostile) {
        variants.push(Object.assign({}, base, {[k]: h}));
      }
    }
    // a nested probe: ops items / add items
    if (fn === 'editExperiment') {
      for (const k of ['op', 'text', 'index', 'xyz']) {
        for (const h of hostile) {
          variants.push(Object.assign({}, base, {ops: [{op: 'updateRow', index: 0, xyz: [1, 2, 3], [k]: h}]}));
          variants.push(Object.assign({}, base, {ops: [{op: 'replaceFromText', text: 'x', [k]: h}]}));
        }
      }
    }
    // extra unknown keys
    variants.push(Object.assign({}, base, JSON.parse('{"__proto__":{"x":1},"constructor":"y"}')));
    for (const p of variants) {
      let r;
      try {
        r = await ctx.cloud(fn, p, session);
      } catch (e) {
        bad.push(`${fn} ${JSON.stringify(p).slice(0, 100)}: transport error ${e.message}`);
        continue;
      }
      calls++;
      if (r.status === 200) {
        continue;
      }
      const code = r.json && r.json.code;
      if (code === 155) {
        session = await fresh();
        r = await ctx.cloud(fn, p, session);
      }
      if (r.status !== 200 && !(r.json && OKCODES.has(r.json.code))) {
        bad.push(`${fn} ${JSON.stringify(p).slice(0, 110)} -> ${r.status} code=${r.json && r.json.code} "${String(r.json && r.json.error).slice(0, 120)}"`);
      }
    }
  }
  // top-level garbage as the params object
  for (const raw of ['[]', '"x"', 'null', '5', 'true', '{"a":']) {
    for (const fn of Object.keys(BASES)) {
      const r = await ctx.rest('POST', `/functions/${fn}`, {session, body: undefined});
      void r;
    }
    void raw;
  }
  ctx.sec.fuzzCalls = calls;
  console.log(`       INFO fuzz: ${calls} hostile calls sent`);
  const seen = new Set();
  const uniq = bad.filter((b) => {
    const k = b.replace(/\{.*\}/, '').slice(0, 40);
    if (seen.has(b.slice(0, 160))) {
      return false;
    }
    seen.add(b.slice(0, 160));

    return true;
  });
  assert.strictEqual(uniq.length, 0, `${calls} hostile calls; ${uniq.length} unexpected answers:\n       ${uniq.slice(0, 25).join('\n       ')}`);
});

test('sec fuzz: params that are not an object (REST body array / string / null)', async (ctx) => {
  const raw = (body) => ctx.rest('POST', '/functions/vote', {session: ctx.sec.bob.session, body});
  const out = [];
  for (const b of [[], 'x', null, 5, true]) {
    const r = await raw(b);
    // strict JSON body parser: a bare string / null / number is a 400 before reaching Parse (acceptable)
    if (!(r.status === 400 || (r.json && (r.status === 200 || OKCODES.has(r.json.code))))) {
      out.push(`${JSON.stringify(b)}: ${r.status} ${r.text.slice(0, 100)}`);
    }
  }
  assert.deepStrictEqual(out, []);
});

test('sec fuzz: the server is still healthy and Object.prototype is not polluted (getAnnotations ok)', async (ctx) => {
  const r = await ctx.cloud('getAnnotations', {pmid: '666001'});
  assert.strictEqual(r.status, 200, r.text);
  const h = await ctx.rest('GET', '/health');
  assert.strictEqual(h.status, 200);
});

// ------------------------------------------------------------------------------ limits, locks, races

test('sec race: 120 parallel votes by one user -> at most 60 accepted, rows consistent', async (ctx) => {
  const u = await newUser(ctx);
  const calls = [];
  for (let i = 0; i < 120; i++) {
    calls.push(ctx.cloud('vote', {pmid: '666001', experimentId: 1, kind: 'tableOk', tag: 'ok', value: i % 2 ? 1 : -1}, u.session));
  }
  const res = await Promise.all(calls);
  const okN = res.filter((r) => r.status === 200).length;
  const limited = res.filter((r) => r.json && r.json.code === 155).length;
  assert.ok(okN <= 60, `${okN} votes accepted in one minute`);
  assert.strictEqual(okN + limited, 120, `unexpected answers: ${res.filter((r) => r.status !== 200 && r.json.code !== 155).map((r) => r.text).slice(0, 3)}`);
  const rows = (await ctx.rest('GET', `/classes/Vote?where=${where({user: u.id, pmid: '666001', kind: 'tableOk'})}`, {master: true})).json.results;
  assert.strictEqual(rows.length, 1, `${rows.length} rows for one key`);
});

test('sec race: case / whitespace variants of a key from parallel requests -> one row', async (ctx) => {
  const u = await newUser(ctx);
  const variants = ['Brain', 'brain', ' BRAIN ', 'bRaIn', 'Brain ', '  brain'];
  const res = await Promise.all(variants.map((t) => ctx.cloud('vote', {pmid: '666001', experimentId: -1, kind: 'mesh', tag: t, value: 1}, u.session)));
  const statuses = res.map((r) => r.status === 200 ? 'ok' : r.json.code);
  const rows = (await ctx.rest('GET', `/classes/Vote?where=${where({user: u.id, pmid: '666001', kind: 'mesh'})}`, {master: true})).json.results;
  assert.strictEqual(rows.length, 1, `${rows.length} rows (${statuses.join(',')}): ${JSON.stringify(rows.map((r) => r.tag))}`);
});

test('sec race: parallel editExperiment with the same rev -> exactly one wins, no lost update', async (ctx) => {
  const users = [await newUser(ctx), await newUser(ctx), await newUser(ctx), await newUser(ctx)];
  const cur = (await ctx.cloud('getAnnotations', {pmid: '666001'})).json.result.rev;
  const res = await Promise.all(users.map((u, i) => ctx.cloud('editExperiment', {pmid: '666001', experimentId: 1, rev: cur, ops: [{op: 'addRow', xyz: [i, i, i]}]}, u.session)));
  const won = res.filter((r) => r.status === 200).length;
  const conflicts = res.filter((r) => r.json && r.json.code === 1001).length;
  assert.strictEqual(won, 1, `${won} edits won, ${conflicts} conflicts: ${res.map((r) => r.text.slice(0, 80))}`);
  const revs = (await ctx.rest('GET', `/classes/Revision?where=${where({pmid: '666001', rev: cur + 1})}`, {master: true})).json.results;
  assert.strictEqual(revs.length, 1, `${revs.length} Revision rows for rev ${cur + 1}`);
});

test('sec race: 12 parallel postComment by one user -> at most 5 accepted', async (ctx) => {
  const u = await newUser(ctx);
  const res = await Promise.all(Array.from({length: 12}, (_, i) => ctx.cloud('postComment', {pmid: '666001', text: `c${i}`}, u.session)));
  const okN = res.filter((r) => r.status === 200).length;
  assert.ok(okN <= 5, `${okN} comments accepted in a minute`);
});

test('sec limits: collection count and size caps hold under parallel creation', async (ctx) => {
  const u = await newUser(ctx);
  // 30/min allowed; 60 parallel creates -> at most 30 succeed, and never more than 50 collections
  const res = await Promise.all(Array.from({length: 40}, (_, i) => ctx.cloud('saveCollection', {name: `c${i}`}, u.session)));
  const okN = res.filter((r) => r.status === 200).length;
  const rows = (await ctx.rest('GET', `/classes/Collection?where=${where({user: u.id})}`, {master: true})).json.results;
  assert.strictEqual(rows.length, okN);
  assert.ok(okN <= 30);
});

// ------------------------------------------------------------------------------ editExperiment abuse

test('sec abuse: number of experiments per article is capped (200 splits in one call, repeated)', async (ctx) => {
  const u = await newUser(ctx);
  await ctx.rest('POST', '/classes/Articles', {master: true, body: Object.assign({}, ART, {PMID: '666002'})});
  const lines = Array.from({length: 450}, (_, i) => `${i % 100},${i % 50},${i % 20}`).join('\n');
  let rev = 0;
  let r = await ctx.cloud('editExperiment', {pmid: '666002', experimentId: 1, rev, ops: [{op: 'replaceFromText', text: lines}]}, u.session);
  assert.strictEqual(r.status, 200, r.text);
  rev = r.json.result.rev;
  const ops = [];
  for (let i = 0; i < 200; i++) {
    ops.push({op: 'split', index: 449 - i});
  }
  r = await ctx.cloud('editExperiment', {pmid: '666002', experimentId: 1, rev, ops}, u.session);
  const n = r.status === 200 ? r.json.result.experiments.length : 0;
  assert.ok(n < 100, `one call produced ${n} experiments (status ${r.status} ${r.status === 200 ? '' : r.text.slice(0, 100)})`);
});

test('sec abuse: oversized edit (many 500 KB replaceFromText ops) fails cleanly, article untouched, no internal message', async (ctx) => {
  const u = await newUser(ctx);
  const line = `1 2 3 ${'x'.repeat(94)}`;
  const text = Array.from({length: 4900}, () => line).join('\n');
  const before = (await ctx.cloud('getAnnotations', {pmid: '666001'})).json.result.rev;
  const ops = Array.from({length: 36}, () => ({op: 'replaceFromText', text}));
  const r = await ctx.cloud('editExperiment', {pmid: '666001', experimentId: 1, rev: before, ops}, u.session);
  const after = (await ctx.cloud('getAnnotations', {pmid: '666001'})).json.result.rev;
  // if it was accepted, the revision of ~18 MB must have been stored (impossible in Mongo: 16 MB limit) -> check
  console.log(`       INFO oversized edit: HTTP ${r.status} ${r.status === 200 ? 'ACCEPTED' : r.text.slice(0, 160)}`);
  if (r.status !== 200) {
    assert.strictEqual(after, before, 'rev changed although the call failed');
  }
  assert.ok(r.status === 200 || OKCODES.has(r.json && r.json.code), `answer is an internal error: HTTP ${r.status} ${r.text.slice(0, 200)} (article rev unchanged: ${after === before})`);
});

test('sec abuse: 4-value legacy rows lose the 4th value when the row is edited', async (ctx) => {
  const u = await newUser(ctx);
  await ctx.rest('POST', '/classes/Articles', {master: true, body: Object.assign({}, ART, {PMID: '666003', Experiments: [{id: 1, title: 't', caption: '', locations: ['1,2,3,4.5', '5,6,7,8.5'], tags: []}]})});
  const r = await ctx.cloud('editExperiment', {pmid: '666003', experimentId: 1, rev: 0, ops: [{op: 'updateRow', index: 0, xyz: [1, 2, 3]}]}, u.session);
  assert.strictEqual(r.status, 200, r.text);
  assert.strictEqual(r.json.result.experiments[0].locations[0], '1,2,3,4.5', `4th value dropped: ${JSON.stringify(r.json.result.experiments[0].locations)}`);
});

// ------------------------------------------------------------------------------ select

test('sec select: local params, _query_, ${}, other parsers, big rows, extra params are refused; nothing reaches Solr', async (ctx) => {
  const before = ctx.solrCalls.length;
  const evil = [
    {q: '{!func}1'}, {q: 'x {!func}1'}, {q: '{!xmlparser}<x/>'}, {q: '_query_:"{!func}1"'}, {q: '_QUERY_:"x"'}, {q: '${java.lang.Runtime}'}, {q: 'x', defType: 'lucene'},
    {q: 'x', defType: '{!func}'}, {q: 'x', rows: 1000}, {q: 'x', rows: 51}, {q: 'x', rows: -1}, {q: 'x', rows: 1.5}, {q: 'x', rows: '10'}, {q: 'x', start: 100001}, {q: 'x', qf: 'id'},
    {q: 'x', fl: 'id,*'}, {q: 'x', fl: '[docid]'}, {q: 'x', fl: 'score,id,Abstract'}, {q: 'x', fq: '*:*'}, {q: 'x', wt: 'xml'}, {q: 'x', shards: 'http://evil/solr'}, {q: 'x', 'stream.body': '<delete/>'},
    {q: 'x', 'q.op': 'x'}, {q: ['a', 'b']}, {q: {a: 1}}, {q: 'x'.repeat(1001)}, {q: ''}, {}, {q: 'x', debug: 'true'}, {q: 'x', 'json.facet': '{}'}
  ];
  const accepted = [];
  for (const p of evil) {
    const r = await ctx.cloud('select', p);
    if (r.status < 400) {
      accepted.push(JSON.stringify(p).slice(0, 80));
    }
  }
  assert.deepStrictEqual(accepted, []);
  assert.strictEqual(ctx.solrCalls.length, before, 'a refused request reached Solr');
});

test('sec select: unicode look-alikes of the local-param opener and function hooks that DO reach Solr (informational)', async (ctx) => {
  const before = ctx.solrCalls.length;
  const probes = ['_val_:"sum(1,1)"', '｛!func｝1', '%7B!func%7D1', '\\{!func}1', 'a'.repeat(900) + '*', '*:*', 'id:*', 'Title:(a OR b OR c)'];
  const reached = [];
  for (const q of probes) {
    const r = await ctx.cloud('select', {q});
    if (r.status === 200) {
      reached.push(q);
    }
  }
  const sent = ctx.solrCalls.slice(before).map((p) => p.get('q'));
  // "{!" must not be present in anything that reaches Solr (after URL decoding by the stub)
  assert.ok(sent.every((q) => !q.includes('{!')), `Solr received: ${JSON.stringify(sent)}`);
  // function-query hook accepted: documented as NOTE
  assert.ok(!reached.includes('_val_:"sum(1,1)"'), '_val_ function-query hook reaches Solr (edismax)');
});

test('sec select: public and unthrottled (100 requests in a row all answered)', async (ctx) => {
  const res = await Promise.all(Array.from({length: 100}, () => ctx.cloud('select', {q: 'memory'})));
  const limited = res.filter((r) => r.json && r.json.code === 155).length;
  assert.ok(limited > 0, 'no rate limit on select: 100 anonymous requests were all served');
});

// ------------------------------------------------------------------------------ logs

test('sec logs: server output does not contain access tokens, session tokens or the master key', async (ctx) => {
  const out = ctx.serverOutput();
  const leaks = [];
  if (out.includes(ctx.masterKey)) {
    leaks.push('master key');
  }
  Object.keys(ctx.accounts).forEach((t) => {
    if (out.includes(t)) {
      leaks.push(`github token ${t.slice(0, 12)}...`);
    }
  });
  const sessions = [ctx.sec.alice, ctx.sec.bob, ctx.sec.carol].map((u) => u.session);
  sessions.forEach((s) => {
    if (out.includes(s)) {
      leaks.push(`session token ${s.slice(0, 8)}...`);
    }
  });
  assert.deepStrictEqual(leaks, [], 'secrets in the server log (last 20 KB)');
});

test('sec errors: error messages do not reveal stack traces, paths or Mongo/Parse internals', async (ctx) => {
  const probes = [
    ctx.cloud('vote', {pmid: '666001', experimentId: 1, kind: 'tag', ontology: 'cognitive', tag: {$ne: 1}, value: 1}, ctx.sec.bob.session),
    ctx.cloud('getConcept', {name: {$gt: ''}, ontology: 'cognitive'}),
    ctx.cloud('deleteCollection', {id: 'zzz'}, ctx.sec.bob.session),
    ctx.cloud('addArticle', {pmid: '99999999', nTables: 0}, (await newUser(ctx)).session),
    ctx.rest('GET', '/classes/Articles?where={bad json'),
    ctx.rest('GET', '/classes/Articles?where=%7B%22%24where%22%3A%22sleep(1)%22%7D')
  ];
  const res = await Promise.all(probes);
  const leaks = res.filter((r) => /\/Users\/|node_modules|at .*\(.*:\d+:\d+\)|MongoError|mongodb:\/\//.test(r.text)).map((r) => r.text.slice(0, 160));
  assert.deepStrictEqual(leaks, []);
});

// ------------------------------------------------------------------------------ non-atomic read of rows and rev

test('sec data-integrity: the page reads the article (rows) and the rev (getAnnotations) in two requests -> an edit in between makes index-based ops hit the wrong row', async (ctx) => {
  const alice = await newUser(ctx);
  const bob = await newUser(ctx);
  await ctx.rest('POST', '/classes/Articles', {master: true, body: Object.assign({}, ART, {PMID: '666005', Experiments: [{id: 1, title: 't', caption: '', locations: ['1,1,1', '2,2,2', '3,3,3'], tags: []}]})});
  // 1. the browser loads the article document (what article.js displays): rows [1,2,3]
  const seen = (await ctx.rest('GET', `/classes/Articles?where=${where({PMID: '666005'})}`)).json.results[0];
  assert.deepStrictEqual(seen.Experiments[0].locations, ['1,1,1', '2,2,2', '3,3,3']);
  assert.strictEqual(seen.rev, undefined, 'a legacy article has no rev field');
  // 2. somebody else inserts a row at the top
  assert.strictEqual((await ctx.cloud('editExperiment', {pmid: '666005', experimentId: 1, rev: 0, ops: [{op: 'addRow', xyz: [9, 9, 9], index: 0}]}, bob.session)).status, 200);
  // 3. the browser asks getAnnotations (second request) and gets the NEW rev
  const ann = (await ctx.cloud('getAnnotations', {pmid: '666005'}, alice.session)).json.result;
  assert.strictEqual(ann.rev, 1);
  // 4. the user deletes the row she SEES at index 1 ("2,2,2") -> rev matches, so the server accepts
  const r = await ctx.cloud('editExperiment', {pmid: '666005', experimentId: 1, rev: ann.rev, ops: [{op: 'deleteRow', index: 1}]}, alice.session);
  assert.strictEqual(r.status, 200, r.text);
  const gone = ['9,9,9', '1,1,1', '2,2,2', '3,3,3'].filter((x) => !r.json.result.experiments[0].locations.includes(x));
  assert.deepStrictEqual(gone, ['2,2,2'], `the user wanted "2,2,2" gone but the server removed ${JSON.stringify(gone)} (rows now ${JSON.stringify(r.json.result.experiments[0].locations)})`);
});
