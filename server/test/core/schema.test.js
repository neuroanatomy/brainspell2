const test = require('node:test');
const assert = require('node:assert');
const {execFileSync} = require('child_process');
const path = require('path');
const {CLASSES, OPERATIONS} = require('../../schema');
const {diff, apply} = require('../../scripts/apply-schema');
const {findDuplicates} = require('../../scripts/dedupe-votes');

const byName = Object.fromEntries(CLASSES.map((c) => [c.className, c]));

test('every class lists every operation explicitly', () => {
  for (const c of CLASSES) {
    assert.deepStrictEqual(Object.keys(c.classLevelPermissions).sort(), OPERATIONS.slice().sort(), c.className);
    for (const op of OPERATIONS) {
      const v = c.classLevelPermissions[op];
      assert.ok(v && typeof v === 'object', `${c.className}.${op}`);
    }
  }
});

test('CLP table of plan 3.2', () => {
  const pub = {'*': true};
  for (const n of ['Articles', 'Concept', 'Comment']) {
    for (const op of ['find', 'count', 'get']) {
      assert.deepStrictEqual(byName[n].classLevelPermissions[op], pub, `${n}.${op}`);
    }
    for (const op of ['create', 'update', 'delete', 'addField']) {
      assert.deepStrictEqual(byName[n].classLevelPermissions[op], {}, `${n}.${op}`);
    }
  }
  for (const n of ['Vote', 'Collection', 'Revision', 'UserProfile', '_Role', 'GameScore']) {
    for (const op of OPERATIONS) {
      assert.deepStrictEqual(byName[n].classLevelPermissions[op], {}, `${n}.${op}`);
    }
  }
  const u = byName._User.classLevelPermissions;
  assert.deepStrictEqual(u.create, pub);
  for (const op of ['find', 'count', 'get', 'update', 'delete', 'addField']) {
    assert.deepStrictEqual(u[op], {}, `_User.${op}`);
  }
});

test('fields of plan 4.1 and indexes', () => {
  assert.deepStrictEqual(Object.keys(byName.Vote.fields).sort(),
    ['experimentId', 'kind', 'login', 'number', 'ontology', 'pmid', 'tag', 'user', 'value']);
  assert.deepStrictEqual(byName.Articles.fields.rev, {type: 'Number'});
  assert.deepStrictEqual(byName.Articles.fields.indexed, {type: 'Boolean'});
  assert.deepStrictEqual(byName.Collection.fields.pmids, {type: 'Array'});
  const idx = {};
  for (const c of CLASSES) {
    for (const k of Object.values(c.indexes)) {
      idx[`${c.className}(${Object.keys(k).join(',')})`] = true;
    }
  }
  for (const want of ['Vote(pmid)', 'Vote(user,pmid)', 'Comment(pmid,createdAt)', 'Collection(user)', 'Revision(pmid,rev)',
    'Concept(ontology,name)', 'Articles(PMID)', 'UserProfile(user)']) {
    assert.ok(idx[want], want);
  }
});

test('diff only reports what is missing and flags type conflicts', () => {
  const vote = byName.Vote;
  const d0 = diff(vote, null);
  assert.strictEqual(d0.exists, false);
  assert.strictEqual(Object.keys(d0.addFields).length, 9);
  const full = {fields: Object.assign({objectId: {type: 'String'}}, vote.fields), indexes: {_id_: {_id: 1}, pmid_1: {pmid: 1}, other_name: {user: 1, pmid: 1}}};
  const d1 = diff(vote, full);
  assert.deepStrictEqual([d1.addFields, d1.addIndexes, d1.conflicts], [{}, {}, []]);
  const bad = {fields: Object.assign({}, full.fields, {pmid: {type: 'Number'}}), indexes: full.indexes};
  assert.strictEqual(diff(vote, bad).conflicts.length, 1);
});

test('apply twice against a fake REST server: second run creates nothing new', async () => {
  const schemas = new Map();
  const calls = [];
  const rest = {
    async request(method, p, body) {
      calls.push(`${method} ${p}`);
      const name = p.split('/')[2];
      if (method === 'GET') {
        return schemas.has(name) ? {status: 200, json: JSON.parse(JSON.stringify(schemas.get(name)))} : {status: 400, json: {code: 103}};
      }
      const cur = schemas.get(name) || {className: name, fields: {}, indexes: {_id_: {_id: 1}}, classLevelPermissions: {}};
      if (method === 'POST' && schemas.has(name)) {
        return {status: 400, json: {code: 103, error: 'exists'}};
      }
      for (const f of Object.keys(body.fields || {})) {
        if (method === 'PUT' && cur.fields[f]) {
          return {status: 400, json: {code: 255, error: 'exists'}};
        }
        cur.fields[f] = body.fields[f];
      }
      for (const i of Object.keys(body.indexes || {})) {
        if (method === 'PUT' && cur.indexes[i]) {
          return {status: 400, json: {code: 67, error: 'exists'}};
        }
        cur.indexes[i] = body.indexes[i];
      }
      cur.classLevelPermissions = body.classLevelPermissions || cur.classLevelPermissions;
      schemas.set(name, cur);

      return {status: 200, json: {}};
    }
  };
  const out = [];
  assert.deepStrictEqual(await apply(rest, (s) => out.push(s)), []);
  assert.ok(calls.some((c) => c === 'POST /schemas/Vote'));
  const before = JSON.stringify([...schemas]);
  calls.length = 0;
  assert.deepStrictEqual(await apply(rest, (s) => out.push(s)), []);
  assert.ok(!calls.some((c) => c.startsWith('POST')));
  assert.strictEqual(JSON.stringify([...schemas]), before);
  assert.deepStrictEqual(schemas.get('_User').classLevelPermissions.create, {'*': true});
});

test('dry run prints CLP and indexes, needs no credentials, sends nothing', () => {
  const env = {PATH: process.env.PATH};
  const out = execFileSync(process.execPath, [path.join(__dirname, '..', '..', 'scripts', 'apply-schema.js'), '--dry-run'], {env}).toString();
  assert.match(out, /Vote\n {2}clp find +\{\}/);
  assert.match(out, /_User\n {2}clp find +\{\}[\s\S]*clp create +\{"\*":true\}/);
  assert.match(out, /index user_1_pmid_1: \{"user":1,"pmid":1\}/);
  assert.match(out, /Dry run: nothing was sent/);
});

test('apply-schema without credentials fails naming the variables, not their values', () => {
  const env = {PATH: process.env.PATH};
  assert.throws(() => execFileSync(process.execPath, [path.join(__dirname, '..', '..', 'scripts', 'apply-schema.js')], {env, stdio: 'pipe'}),
    (e) => /PARSE_URL, PARSE_APP_ID, PARSE_MASTER_KEY/.test(e.stderr.toString()));
});

test('dedupe-votes finds the older duplicates only, per article', () => {
  const r = (id, pmid, user, tag, updatedAt) => ({id, pmid, user, experimentId: 1, kind: 'tag', ontology: 'cognitive', tag, updatedAt});
  const rows = [r('a', '1', 'u', 'X', 1), r('b', '1', 'u', 'x ', 2), r('c', '2', 'u', 'X', 1), r('d', '1', 'v', 'X', 1), r('e', '1', 'u', 'Y', 1)];
  assert.deepStrictEqual(findDuplicates(rows), ['a']);
});
