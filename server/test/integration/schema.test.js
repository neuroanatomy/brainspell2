// apply-schema is idempotent (the harness already ran it once, before any test).

const assert = require('assert');
const {test} = require('./helpers/mini');
const {CLASSES} = require('../../schema');

async function dump(ctx) {
  const out = {};
  for (const c of CLASSES) {
    const r = await ctx.rest('GET', `/schemas/${c.className}`, {master: true});
    assert.strictEqual(r.status, 200, c.className);
    out[c.className] = r.json;
  }

  return out;
}

test('apply-schema: first run (done by the harness) succeeded and printed no secret', async (ctx) => {
  assert.strictEqual(ctx.firstApply.code, 0, ctx.firstApply.stderr);
  assert.match(ctx.firstApply.stdout, /Schema applied/);
  for (const secret of [ctx.masterKey, ctx.appId]) {
    assert.ok(!ctx.firstApply.stdout.includes(secret) && !ctx.firstApply.stderr.includes(secret), 'secret in output');
  }
});

test('apply-schema: fields, indexes and CLP are in place', async (ctx) => {
  const s = await dump(ctx);
  for (const c of CLASSES) {
    for (const [f, def] of Object.entries(c.fields)) {
      assert.strictEqual(s[c.className].fields[f] && s[c.className].fields[f].type, def.type, `${c.className}.${f}`);
    }
    for (const name of Object.keys(c.indexes)) {
      assert.ok(s[c.className].indexes && s[c.className].indexes[name], `index ${c.className}.${name}`);
    }
    // Parse adds protectedFields: {} itself; compare only the operations declared
    for (const op of Object.keys(c.classLevelPermissions)) {
      assert.deepStrictEqual(s[c.className].classLevelPermissions[op], c.classLevelPermissions[op], `${c.className}.${op}`);
    }
  }
});

test('apply-schema: running it twice more changes nothing and reports no failure', async (ctx) => {
  const before = await dump(ctx);
  for (let i = 0; i < 2; i++) {
    const r = await ctx.runScript('apply-schema.js');
    assert.strictEqual(r.code, 0, `${r.stdout}\n${r.stderr}`);
    assert.ok(!r.stdout.includes(ctx.masterKey) && !r.stderr.includes(ctx.masterKey), 'master key printed');
  }
  assert.deepStrictEqual(await dump(ctx), before);
});

test('apply-schema: a drifted CLP is put back', async (ctx) => {
  const r = await ctx.rest('PUT', '/schemas/Vote', {master: true, body: {className: 'Vote', classLevelPermissions: {
    find: {'*': true}, count: {'*': true}, get: {'*': true}, create: {}, update: {}, delete: {}, addField: {}
  }}});
  assert.strictEqual(r.status, 200, r.text);
  const run = await ctx.runScript('apply-schema.js');
  assert.strictEqual(run.code, 0, run.stderr);
  const after = await ctx.rest('GET', '/schemas/Vote', {master: true});
  assert.deepStrictEqual(after.json.classLevelPermissions.find, {});
});

test('apply-schema: dry run sends nothing and needs no credentials', async (ctx) => {
  const before = await dump(ctx);
  const r = await ctx.runScript('apply-schema.js', ['--dry-run']);
  assert.strictEqual(r.code, 0);
  assert.match(r.stdout, /Dry run: nothing was sent/);
  assert.deepStrictEqual(await dump(ctx), before);
});

test('dedupe-votes: report mode finds duplicates, --apply removes only the older ones', async (ctx) => {
  const mk = (body) => ctx.rest('POST', '/classes/Vote', {master: true, body: Object.assign({
    user: 'dupuser', login: 'x', pmid: '9999', experimentId: 1, kind: 'tag', ontology: 'cognitive', tag: 'Memory', value: 1, number: null,
    ACL: {}
  }, body)});
  const old = await mk({value: 1});
  await new Promise((r) => setTimeout(r, 20));
  const fresh = await mk({value: -1, tag: 'memory '});
  const other = await mk({user: 'someone else'});
  assert.strictEqual(old.status, 201);
  let r = await ctx.runScript('dedupe-votes.js');
  assert.strictEqual(r.code, 0, r.stderr);
  assert.match(r.stdout, /1 duplicates/);
  assert.strictEqual((await ctx.rest('GET', `/classes/Vote/${old.json.objectId}`, {master: true})).status, 200);
  r = await ctx.runScript('dedupe-votes.js', ['--apply']);
  assert.strictEqual(r.code, 0, r.stderr);
  assert.strictEqual((await ctx.rest('GET', `/classes/Vote/${old.json.objectId}`, {master: true})).status, 404);
  assert.strictEqual((await ctx.rest('GET', `/classes/Vote/${fresh.json.objectId}`, {master: true})).status, 200);
  assert.strictEqual((await ctx.rest('GET', `/classes/Vote/${other.json.objectId}`, {master: true})).status, 200);
  r = await ctx.runScript('dedupe-votes.js');
  assert.match(r.stdout, /0 duplicates/);
});
