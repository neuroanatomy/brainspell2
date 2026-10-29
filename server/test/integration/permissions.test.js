// Permission matrix (plan, section 3.2 and 6): find, get, count, create, update, delete and
// addField on EVERY class, as anonymous and as two different users.

const assert = require('assert');
const {test} = require('./helpers/mini');
const {CLASSES} = require('../../schema');

const READ_PUBLIC = new Set(['Articles', 'Concept', 'Comment']);
const SEED = {
  Articles: {PMID: '111', Title: 'T', Experiments: [], Metadata: {}},
  Vote: {user: 'x', pmid: '111', experimentId: 1, kind: 'tableOk', tag: 'ok', value: 1},
  Comment: {user: 'x', login: 'x', pmid: '111', text: 'hello', ACL: {'*': {read: true}}},
  Collection: {user: 'x', name: 'c', pmids: []},
  Revision: {pmid: '111', rev: 1, user: 'x', login: 'x', ops: [], before: []},
  Concept: {name: 'Attention', ontology: 'cognitive'},
  UserProfile: {user: 'x', login: 'x', githubId: 1},
  GameScore: {score: 1}
};

const path = (cls) => (cls === '_User' ? '/users' : cls === '_Role' ? '/roles' : `/classes/${cls}`);

function refused(res, what) {
  assert.ok(res.status >= 400, `${what}: expected a refusal, got ${res.status} ${res.text.slice(0, 200)}`);
}

function noData(res, what, ids) {
  // a refusal must not leak the rows either
  const text = res.text;
  for (const id of ids) {
    assert.ok(!text.includes(id), `${what}: answer mentions ${id}`);
  }
}

async function snapshot(ctx, cls, ids) {
  const out = {};
  for (const id of ids) {
    const r = await ctx.rest('GET', `${path(cls)}/${id}`, {master: true});
    out[id] = r.status === 200 ? JSON.stringify(Object.assign({}, r.json, {updatedAt: 0})) : `missing ${r.status}`;
  }

  return out;
}

test('permissions: setup (seed one object per class with the master key)', async (ctx) => {
  ctx.perm = {a: await ctx.signup('perm-a', 5001), b: await ctx.signup('perm-b', 5002), seeded: {}};
  for (const [cls, body] of Object.entries(SEED)) {
    const r = await ctx.rest('POST', path(cls), {master: true, body});
    assert.strictEqual(r.status, 201, `seed ${cls}: ${r.text}`);
    ctx.perm.seeded[cls] = [r.json.objectId];
  }
  ctx.perm.seeded._User = [ctx.perm.a.id, ctx.perm.b.id];
  const sessions = await ctx.rest('GET', '/classes/_Session', {master: true});
  // a user can have several sessions (signup creates one, a later login another)
  ctx.perm.sessionIds = {};
  for (const s of sessions.json.results) {
    (ctx.perm.sessionIds[s.user.objectId] = ctx.perm.sessionIds[s.user.objectId] || []).push(s.objectId);
  }
  ctx.perm.seeded._Session = [].concat(...Object.values(ctx.perm.sessionIds));
  const role = await ctx.rest('POST', '/roles', {master: true, body: {name: 'seedrole', ACL: {'*': {read: true}}}});
  assert.strictEqual(role.status, 201, role.text);
  ctx.perm.seeded._Role = [role.json.objectId];
});

test('permissions: the schema script was applied before the matrix (every class has its CLP)', async (ctx) => {
  for (const c of CLASSES) {
    const r = await ctx.rest('GET', `/schemas/${c.className}`, {master: true});
    assert.strictEqual(r.status, 200, c.className);
    for (const op of Object.keys(c.classLevelPermissions)) {
      assert.deepStrictEqual(r.json.classLevelPermissions[op], c.classLevelPermissions[op], `${c.className}.${op}`);
    }
  }
});

for (const cls of CLASSES.map((c) => c.className)) {
  test(`permissions: ${cls}`, async (ctx) => {
    const {a, b, seeded} = ctx.perm;
    const ids = seeded[cls];
    const before = await snapshot(ctx, cls, ids);
    const readable = READ_PUBLIC.has(cls);
    const actors = [['anonymous', undefined], ['user A', a.session], ['user B', b.session]];
    const p = path(cls);
    for (const [who, session] of actors) {
      const tag = `${cls} as ${who}`;
      const base = {session};
      if (cls === '_Session') {
        // a user may see his own sessions (that is how the SDK works), never somebody else's
        const find = await ctx.rest('GET', p, base);
        if (find.status === 200) {
          const mine = session === a.session ? ctx.perm.sessionIds[a.id] : session === b.session ? ctx.perm.sessionIds[b.id] : [];
          const others = ids.filter((i) => !mine.includes(i));
          noData(find, `${tag} find`, others);
          assert.ok(session, `${tag} find must be refused for anonymous`);
        } else {
          refused(find, `${tag} find`);
        }
        for (const id of ids) {
          const own = (session === a.session && ctx.perm.sessionIds[a.id].includes(id)) || (session === b.session && ctx.perm.sessionIds[b.id].includes(id));
          if (!own) {
            refused(await ctx.rest('GET', `${p}/${id}`, base), `${tag} get ${id} (owner ${JSON.stringify(Object.keys(ctx.perm.sessionIds).filter((u) => ctx.perm.sessionIds[u].includes(id)))})`);
            refused(await ctx.rest('PUT', `${p}/${id}`, {session, body: {foo: 1}}), `${tag} update ${id} (owner ${JSON.stringify(Object.keys(ctx.perm.sessionIds).filter((u) => ctx.perm.sessionIds[u].includes(id)))}, A=${a.id}, B=${b.id})`);
            refused(await ctx.rest('DELETE', `${p}/${id}`, base), `${tag} delete ${id}`);
          }
        }
        // KNOWN PARSE 4.10.2 LIMITATION (RestWrite.handleSession): a logged-in user can always create
        // a session for HIMSELF, running as master, whatever the CLP, and can add fields to _Session
        // that way. No CLP or trigger can stop it (beforeSave is not allowed on _Session). We only
        // require that it is never a session for somebody else, and clean up what we created.
        for (const body of [{user: {__type: 'Pointer', className: '_User', objectId: a.id}}, {hackedField: 1}]) {
          const created = await ctx.rest('POST', p, {session, body});
          if (created.status < 400) {
            const self = session === a.session ? a.id : session === b.session ? b.id : null;
            assert.ok(self && created.json.user.objectId === self, `${tag} create made a session for ${created.json.user && created.json.user.objectId}`);
            await ctx.rest('DELETE', `${p}/${created.json.objectId}`, {master: true});
          } else {
            assert.ok(session !== undefined || created.status >= 400, `${tag} anonymous create`);
          }
        }
      } else if (cls === '_User') {
        const find = await ctx.rest('GET', p, base);
        refused(find, `${tag} find`);
        noData(find, `${tag} find`, ids);
        const count = await ctx.rest('GET', `${p}?count=1&limit=0`, base);
        refused(count, `${tag} count`);
        for (const id of ids) {
          const own = (session === a.session && id === a.id) || (session === b.session && id === b.id);
          if (!own) {
            const get = await ctx.rest('GET', `${p}/${id}`, base);
            refused(get, `${tag} get ${id}`);
            noData(get, `${tag} get`, ['authData', 'access_token']);
          }
          // nobody (not even the owner, CLP update is {}) updates or deletes through REST
          if (!own) {
            refused(await ctx.rest('PUT', `${p}/${id}`, {session, body: {foo: 1}}), `${tag} update ${id}`);
            refused(await ctx.rest('DELETE', `${p}/${id}`, base), `${tag} delete ${id}`);
          }
        }
        // create without GitHub authData is refused by the beforeSave guard
        refused(await ctx.rest('POST', p, {session, body: {username: `evil-${who.replace(' ', '')}`, password: 'secret-pass-1'}}), `${tag} password signup`);
        refused(await ctx.rest('POST', p, {session, body: {authData: {anonymous: {id: 'abc-123'}}}}), `${tag} anonymous signup`);
        // addField: setting a new field on the own row must be refused too
        if (session) {
          const self = session === a.session ? a.id : b.id;
          refused(await ctx.rest('PUT', `${p}/${self}`, {session, body: {hackedField: 1}}), `${tag} addField on self`);
        }
      } else {
        const find = await ctx.rest('GET', p, base);
        const count = await ctx.rest('GET', `${p}?count=1&limit=0`, base);
        if (readable) {
          assert.strictEqual(find.status, 200, `${tag} find: ${find.text}`);
          assert.ok(find.json.results.length >= 1, `${tag} find returns the seeded rows`);
          assert.strictEqual(count.status, 200, `${tag} count: ${count.text}`);
          for (const id of ids) {
            const get = await ctx.rest('GET', `${p}/${id}`, base);
            assert.strictEqual(get.status, 200, `${tag} get: ${get.text}`);
          }
        } else {
          refused(find, `${tag} find`);
          noData(find, `${tag} find`, ids);
          refused(count, `${tag} count`);
          for (const id of ids) {
            refused(await ctx.rest('GET', `${p}/${id}`, base), `${tag} get ${id}`);
          }
        }
        // writes are refused for everybody, on every class
        refused(await ctx.rest('POST', p, {session, body: JSON.parse(JSON.stringify(SEED[cls] || {name: 'evil'}))}), `${tag} create`);
        refused(await ctx.rest('POST', p, {session, body: {hackedField: 1}}), `${tag} addField (create with a new field)`);
        for (const id of ids) {
          refused(await ctx.rest('PUT', `${p}/${id}`, {session, body: {hackedField: 1, text: 'changed', tag: 'changed', value: -1}}), `${tag} update ${id}`);
          refused(await ctx.rest('DELETE', `${p}/${id}`, base), `${tag} delete ${id}`);
        }
      }
      // the schema cannot be touched either
      refused(await ctx.rest('PUT', `/schemas/${cls}`, {session, body: {className: cls, fields: {hackedField2: {type: 'String'}}}}), `${tag} PUT /schemas`);
      refused(await ctx.rest('POST', `/schemas/NewClass${Date.now()}`, {session, body: {}}), `${tag} POST /schemas`);
    }
    // nothing changed, nothing was added
    assert.deepStrictEqual(await snapshot(ctx, cls, ids), before, `${cls}: rows changed or disappeared`);
    const schema = await ctx.rest('GET', `/schemas/${cls}`, {master: true});
    if (cls === '_Session') {
      // see the known limitation above: remove the field the create path added
      await ctx.rest('PUT', '/schemas/_Session', {master: true, body: {className: '_Session', fields: {hackedField: {__op: 'Delete'}}}});
      assert.ok(!schema.json.fields.hackedField2, 'PUT /schemas must stay refused');
    } else {
      assert.ok(!schema.json.fields.hackedField && !schema.json.fields.hackedField2, `${cls}: a field was added`);
    }
  });
}

test('permissions: client class creation and anonymous users are off', async (ctx) => {
  const {a} = ctx.perm;
  refused(await ctx.rest('POST', '/classes/BrandNewClass', {session: a.session, body: {x: 1}}), 'create object of new class as user');
  refused(await ctx.rest('POST', '/classes/BrandNewClass', {body: {x: 1}}), 'create object of new class as anonymous');
  refused(await ctx.rest('POST', '/users', {body: {authData: {anonymous: {id: '11111111-2222-3333-4444-555555555555'}}}}), 'anonymous user');
  const schemas = await ctx.rest('GET', '/schemas', {master: true});
  assert.ok(!schemas.json.results.some((s) => s.className === 'BrandNewClass'));
});

test('permissions: other endpoints do not give anonymous or user access to private data', async (ctx) => {
  const {a} = ctx.perm;
  for (const [who, session] of [['anonymous', undefined], ['user', a.session]]) {
    refused(await ctx.rest('GET', '/schemas', {session}), `${who} GET /schemas`);
    refused(await ctx.rest('GET', '/installations', {session}), `${who} GET /installations`);
    refused(await ctx.rest('GET', '/roles', {session}), `${who} GET /roles`);
    refused(await ctx.rest('GET', '/users', {session}), `${who} GET /users`);
    const batch = await ctx.rest('POST', '/batch', {session, body: {requests: [
      {method: 'DELETE', path: `/parse/classes/Vote/${ctx.perm.seeded.Vote[0]}`},
      {method: 'POST', path: '/parse/classes/Vote', body: {user: 'evil', pmid: '111', kind: 'tableOk', value: 1}}
    ]}});
    // the batch itself may answer 200, but every item must be an error
    const items = Array.isArray(batch.json) ? batch.json : [];
    assert.ok(batch.status >= 400 || (items.length === 2 && items.every((i) => i.error)), `${who} batch: ${batch.text}`);
  }
  const vote = await ctx.rest('GET', `/classes/Vote/${ctx.perm.seeded.Vote[0]}`, {master: true});
  assert.strictEqual(vote.status, 200, 'the Vote row must still exist after the batch attempt');
});
