// editExperiment through the real REST API: full flows, revisions, conflicts, concurrency,
// legacy-shaped articles, and who can read what.

const assert = require('assert');
const {test} = require('./helpers/mini');

const LEGACY = {
  PMID: '808080',
  Title: 'Legacy shaped article',
  Experiments: [
    {id: 1, title: 'Table 1', caption: 'caption 1', locations: ['1,2,3', '4,5,6,7.5', '-10,20,30'],
      markBadTable: {ok: 4, bad: 1}, tags: [{name: 'Memory', ontology: 'cognitive', agree: 3, disagree: 1}]},
    {id: 2, title: 'Table 2', caption: '', locations: ['0,0,0'], tags: []}
  ],
  Metadata: {meshHeadings: [{name: 'Brain', majorTopic: true}], stereo: {MNI: 2, Talairach: 0}, nsubjects: 20}
};

const ok = (res, what) => {
  assert.strictEqual(res.status, 200, `${what}: ${res.status} ${res.text}`);

  return res.json.result;
};
const code = (res, c, what) => {
  assert.ok(res.status >= 400, `${what}: expected failure, got ${res.status} ${res.text}`);
  assert.strictEqual(res.json.code, c, `${what}: ${res.text}`);
};
const where = (o) => encodeURIComponent(JSON.stringify(o));
const article = async (ctx) => (await ctx.rest('GET', `/classes/Articles?where=${where({PMID: '808080'})}`, {master: true})).json.results[0];
const revisions = async (ctx) => (await ctx.rest('GET', `/classes/Revision?where=${where({pmid: '808080'})}&order=rev`, {master: true})).json.results;
const edit = (ctx, who, p) => ctx.cloud('editExperiment', Object.assign({pmid: '808080', experimentId: 1}, p), who.session);

test('editExperiment: setup (legacy-shaped article, users, a vote)', async (ctx) => {
  const art = await ctx.rest('POST', '/classes/Articles', {master: true, body: LEGACY});
  assert.strictEqual(art.status, 201, art.text);
  ctx.exp = {
    alice: await ctx.signup('exp-alice', 9301), bob: await ctx.signup('exp-bob', 9302),
    carol: await ctx.signup('exp-carol', 9303), dave: await ctx.signup('exp-dave', 9304)
  };
  const v = ok(await ctx.cloud('vote', {pmid: '808080', experimentId: 1, kind: 'tag', ontology: 'cognitive', tag: 'memory', value: 1}, ctx.exp.bob.session), 'vote');
  assert.strictEqual(v.agree, 4);
});

test('editExperiment: refusals (anonymous, unknown parameters, bad ops, unknown ids)', async (ctx) => {
  const {alice} = ctx.exp;
  const ops = [{op: 'setTitle', text: 'x'}];
  code(await ctx.cloud('editExperiment', {pmid: '808080', experimentId: 1, ops}), 206, 'anonymous');
  code(await edit(ctx, alice, {ops, login: 'bob'}), 142, 'login parameter');
  code(await edit(ctx, alice, {ops, user: 'bob'}), 142, 'user parameter');
  code(await edit(ctx, alice, {ops: []}), 142, 'no ops');
  code(await edit(ctx, alice, {ops: [{op: 'setTitle', text: 'x', evil: 1}]}), 142, 'unknown op key');
  code(await edit(ctx, alice, {ops: [{op: 'addRow', xyz: [1, 2, 201]}]}), 142, 'out of range');
  code(await edit(ctx, alice, {ops: [{op: 'addRow', xyz: [1, 2, null]}]}), 142, 'null coordinate');
  code(await edit(ctx, alice, {ops: [{op: 'deleteRow', index: 99}]}), 142, 'row out of range');
  code(await edit(ctx, alice, {ops: [{op: 'replaceFromText', text: '300,0,0'}]}), 142, 'import out of range');
  code(await edit(ctx, alice, {experimentId: 99, ops}), 101, 'unknown experiment');
  code(await ctx.cloud('editExperiment', {pmid: '999999', experimentId: 1, ops}, alice.session), 101, 'unknown article');
  assert.strictEqual((await revisions(ctx)).length, 0);
  assert.strictEqual((await article(ctx)).rev, undefined);
});

test('editExperiment: edits a legacy article; tags, votes and untouched rows survive', async (ctx) => {
  const {alice} = ctx.exp;
  const out = ok(await edit(ctx, alice, {ops: [
    {op: 'setTitle', text: 'New title'},
    {op: 'updateRow', index: 0, xyz: [1.23456, -2, 0]},
    {op: 'addRow', xyz: [9, 9, 9], index: 1}
  ]}), 'edit');
  assert.strictEqual(out.rev, 1);
  assert.strictEqual(out.experiments.length, 1);
  assert.deepStrictEqual(out.experiments[0].locations, ['1.235,-2,0', '9,9,9', '4,5,6,7.5', '-10,20,30']);
  const a = await article(ctx);
  assert.strictEqual(a.rev, 1);
  assert.deepStrictEqual(a.Experiments[0], out.experiments[0]);
  assert.deepStrictEqual(a.Experiments[0].tags, LEGACY.Experiments[0].tags);
  assert.deepStrictEqual(a.Experiments[0].markBadTable, {ok: 4, bad: 1});
  assert.deepStrictEqual(a.Experiments[1], LEGACY.Experiments[1]);
  assert.deepStrictEqual(a.Metadata, LEGACY.Metadata);
  assert.strictEqual(a.Title, LEGACY.Title);
  // votes are intact and still attached to the same experiment
  const ann = ok(await ctx.cloud('getAnnotations', {pmid: '808080'}), 'getAnnotations');
  assert.strictEqual(ann.rev, 1);
  const mem = ann.votes.find((x) => x.tag === 'Memory');
  assert.deepStrictEqual([mem.experimentId, mem.agree, mem.disagree], [1, 4, 1]);
  // the revision
  const revs = await revisions(ctx);
  assert.strictEqual(revs.length, 1);
  assert.strictEqual(revs[0].rev, 1);
  assert.strictEqual(revs[0].user, alice.id);
  assert.strictEqual(revs[0].login, 'exp-alice');
  assert.strictEqual(revs[0].ops.length, 3);
  assert.strictEqual(revs[0].before.length, 1);
  assert.deepStrictEqual(revs[0].before[0], LEGACY.Experiments[0]);
  assert.ok(!revs[0].ACL || !revs[0].ACL['*'], `Revision has a public ACL: ${JSON.stringify(revs[0].ACL)}`);
});

test('editExperiment: conflicts (missing rev is 0, stale rev, message has the current rev)', async (ctx) => {
  const {alice, bob} = ctx.exp;
  const ops = [{op: 'setCaption', text: 'late'}];
  const missing = await edit(ctx, bob, {ops});
  code(missing, 1001, 'missing rev');
  assert.ok(/rev 1\b/.test(missing.json.error), missing.text);
  code(await edit(ctx, bob, {ops, rev: 0}), 1001, 'stale rev');
  code(await edit(ctx, bob, {ops, rev: '1'}), 142, 'rev as string');
  assert.strictEqual((await article(ctx)).Experiments[0].caption, 'caption 1');
  const out = ok(await edit(ctx, bob, {ops, rev: 1}), 'right rev');
  assert.strictEqual(out.rev, 2);
  assert.strictEqual((await revisions(ctx))[1].login, 'exp-bob');
  assert.strictEqual(alice.login, 'exp-alice');
});

test('editExperiment: split, replaceFromText, delete to empty', async (ctx) => {
  const {alice} = ctx.exp;
  const s = ok(await edit(ctx, alice, {rev: 2, ops: [{op: 'split', index: 2}]}), 'split');
  assert.strictEqual(s.rev, 3);
  assert.deepStrictEqual(s.experiments.map((e) => e.id), [1, 3]);
  assert.deepStrictEqual(s.experiments[1], {id: 3, title: 'New title', caption: 'late', locations: ['4,5,6,7.5', '-10,20,30'], tags: []});
  let a = await article(ctx);
  assert.deepStrictEqual(a.Experiments.map((e) => e.id), [1, 3, 2]);
  assert.deepStrictEqual(a.Experiments[0].tags, LEGACY.Experiments[0].tags);
  const ann = ok(await ctx.cloud('getAnnotations', {pmid: '808080'}), 'annotations after split');
  assert.deepStrictEqual(ann.votes.filter((x) => x.tag === 'Memory').map((x) => [x.experimentId, x.agree]), [[1, 4]]);
  // the new half can be edited and voted on as a table
  const r = ok(await edit(ctx, alice, {experimentId: 3, rev: 3, ops: [{op: 'replaceFromText', text: 'x=-5.5; y: 2; z=3\n−12\t34\t56\n1 2'}]}), 'import');
  assert.deepStrictEqual(r.experiments[0].locations, ['-5.5,2,3', '-12,34,56']);
  const e = ok(await edit(ctx, alice, {experimentId: 2, rev: 4, ops: [{op: 'deleteRow', index: 0}]}), 'delete last row');
  assert.deepStrictEqual(e.experiments[0].locations, []);
  a = await article(ctx);
  assert.strictEqual(a.rev, 5);
  assert.deepStrictEqual(a.Experiments[2].locations, []);
  assert.strictEqual(ok(await ctx.cloud('vote', {pmid: '808080', experimentId: 3, kind: 'tableOk', value: 1}, alice.session), 'table vote').agree, 1);
  const revs = await revisions(ctx);
  assert.deepStrictEqual(revs.map((x) => x.rev), [1, 2, 3, 4, 5]);
  assert.deepStrictEqual(revs[2].before.map((x) => x.id), [1], 'the split half has no before-image');
});

test('editExperiment: no-op edits write nothing', async (ctx) => {
  const {alice} = ctx.exp;
  const out = ok(await edit(ctx, alice, {rev: 5, ops: [{op: 'setTitle', text: 'New title'}]}), 'no-op');
  assert.deepStrictEqual(out, {rev: 5, experiments: []});
  assert.strictEqual((await revisions(ctx)).length, 5);
});

test('editExperiment: Revision is not readable or writable by clients; Articles is not writable', async (ctx) => {
  const {alice, bob} = ctx.exp;
  const revs = await revisions(ctx);
  for (const [who, session] of [['anonymous', undefined], ['alice', alice.session], ['bob', bob.session]]) {
    for (const [m, p, body] of [
      ['GET', '/classes/Revision'], ['GET', `/classes/Revision/${revs[0].objectId}`], ['GET', '/classes/Revision?count=1&limit=0'],
      ['POST', '/classes/Revision', {pmid: '808080', rev: 99, user: 'x', login: 'x', ops: [], before: []}],
      ['PUT', `/classes/Revision/${revs[0].objectId}`, {login: 'forged'}], ['DELETE', `/classes/Revision/${revs[0].objectId}`]
    ]) {
      const res = await ctx.rest(m, p, {session, body});
      assert.ok(res.status >= 400, `${who} ${m} ${p}: ${res.status} ${res.text}`);
      assert.ok(!res.text.includes('exp-alice'), `${who} ${m} ${p} leaked a login`);
    }
    const a = await article(ctx);
    const put = await ctx.rest('PUT', `/classes/Articles/${a.objectId}`, {session, body: {Experiments: [], rev: 0}});
    assert.ok(put.status >= 400, `${who} updated Articles`);
  }
  assert.strictEqual((await revisions(ctx)).length, 5);
  assert.strictEqual((await article(ctx)).rev, 5);
});

test('editExperiment: concurrent calls with the same rev, exactly one wins, no lost update', async (ctx) => {
  const {alice, bob, carol, dave} = ctx.exp;
  const rows = (await article(ctx)).Experiments.find((e) => e.id === 1).locations.length;
  const start = (await article(ctx)).rev;
  const users = [alice, bob, carol, dave, alice, bob];
  const res = await Promise.all(users.map((u, i) => edit(ctx, u, {rev: start, ops: [{op: 'addRow', xyz: [i, i, i]}]})));
  const won = res.filter((r) => r.status === 200);
  assert.strictEqual(won.length, 1, res.map((r) => r.text).join(' | '));
  res.filter((r) => r.status !== 200).forEach((r) => assert.strictEqual(r.json.code, 1001, r.text));
  const a = await article(ctx);
  assert.strictEqual(a.rev, start + 1);
  assert.strictEqual(a.Experiments.find((e) => e.id === 1).locations.length, rows + 1);
  const revs = await revisions(ctx);
  assert.strictEqual(revs.filter((r) => r.rev === start + 1).length, 1, 'exactly one revision for the new rev');
});

test('editExperiment: concurrent edits that retry on conflict all end up applied', async (ctx) => {
  const users = [ctx.exp.alice, ctx.exp.bob, ctx.exp.carol, ctx.exp.dave];
  const before = (await article(ctx)).Experiments.find((e) => e.id === 2).locations.length;
  const startRev = (await article(ctx)).rev;
  await Promise.all(users.map(async (u, i) => {
    for (let attempt = 0; attempt < 10; attempt++) {
      const cur = ok(await ctx.cloud('getAnnotations', {pmid: '808080'}), 'rev');
      const r = await edit(ctx, u, {experimentId: 2, rev: cur.rev, ops: [{op: 'addRow', xyz: [50 + i, 0, 0]}]});
      if (r.status === 200) {
        return;
      }
      assert.strictEqual(r.json.code, 1001);
    }
    throw new Error('never succeeded');
  }));
  const a = await article(ctx);
  assert.strictEqual(a.Experiments.find((e) => e.id === 2).locations.length, before + 4);
  assert.strictEqual(a.rev, startRev + 4);
  assert.deepStrictEqual((await revisions(ctx)).map((r) => r.rev), Array.from({length: startRev + 4}, (_, i) => i + 1));
});

test('editExperiment: 30 per minute per user (155)', async (ctx) => {
  const u = await ctx.signup('exp-rate', 9305);
  let rev = (await article(ctx)).rev;
  for (let i = 0; i < 30; i++) {
    const out = ok(await edit(ctx, u, {experimentId: 2, rev, ops: [{op: 'setTitle', text: `t${i}`}]}), `edit ${i}`);
    rev = out.rev;
  }
  code(await edit(ctx, u, {experimentId: 2, rev, ops: [{op: 'setTitle', text: 'over'}]}), 155, '31st');
  assert.strictEqual((await article(ctx)).Experiments.find((e) => e.id === 2).title, 't29');
});
