// CONTRACT test: the REAL cloud functions (through REST) against client/annotation/mock-api.js, which the
// client was developed against. Each test runs the same call on both and fails when the shape (keys, types,
// null vs absent), the error code, or the listed values differ. A failing test = a divergence that the UI
// engineers did not see. Run: node test/contract/run.js   (see run.js)

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {pathToFileURL} = require('url');
const {test} = require('../integration/helpers/mini');
const {record} = require('../articles/sample-xml');

const MOCK_SRC = path.resolve(__dirname, '..', '..', '..', 'client', 'annotation', 'mock-api.js');

// ---------- shape comparison --------------------------------------------------------------------

function typeOf(v) {
  if (v === null) {
    return 'null';
  }
  if (Array.isArray(v)) {
    return 'array';
  }

  return typeof v;
}

// path -> Set of types, arrays are walked as "[]"
function collect(v, p, out) {
  const t = typeOf(v);
  (out[p] = out[p] || new Set()).add(t);
  if (t === 'array') {
    v.forEach((x) => collect(x, `${p}[]`, out));
  } else if (t === 'object') {
    Object.keys(v).forEach((k) => collect(v[k], `${p}.${k}`, out));
  }

  return out;
}

function diffShape(real, mock) {
  const a = collect(real, '$', {});
  const b = collect(mock, '$', {});
  const issues = [];
  Object.keys(a).concat(Object.keys(b)).filter((k, i, arr) => arr.indexOf(k) === i).sort().forEach((p) => {
    if (!a[p]) {
      issues.push(`${p}: only in MOCK (${Array.from(b[p]).join('|')})`);
    } else if (!b[p]) {
      issues.push(`${p}: only in REAL (${Array.from(a[p]).join('|')})`);
    } else {
      const x = Array.from(a[p]).sort().join('|');
      const y = Array.from(b[p]).sort().join('|');
      if (x !== y) {
        issues.push(`${p}: real=${x} mock=${y}`);
      }
    }
  });

  return issues;
}

const VOLATILE = new Set(['id', 'objectId', 'createdAt', 'updatedAt']);
function norm(v) {
  if (Array.isArray(v)) {
    return v.map(norm);
  }
  if (v && typeof v === 'object') {
    const o = {};
    Object.keys(v).sort().forEach((k) => {
      o[k] = VOLATILE.has(k) ? typeOf(v[k]) : norm(v[k]);
    });

    return o;
  }

  return v;
}

const j = (v) => JSON.stringify(v);

// ---------- helpers -----------------------------------------------------------------------------------

async function both(ctx, fn, params, who) {
  const session = who ? ctx.u[who].session : undefined;
  const r = await ctx.cloud(fn, params, session);
  const real = r.status === 200 ? {ok: r.json.result} : {err: {code: r.json && r.json.code, message: r.json && r.json.error}};
  ctx.mock.loginAs(who ? ctx.u[who].login : null);
  let mock;
  try {
    mock = {ok: await ctx.mock.call(fn, params)};
  } catch (e) {
    mock = {err: {code: e.code, message: e.message}};
  }

  return {real, mock, label: `${fn}(${j(params).slice(0, 90)}) as ${who || 'anon'}`};
}

// Fail when the two sides differ in outcome, error code, shape; with opts.values also in normalised values.
// opts.ignore: paths (as printed in shape issues) to tolerate.
function check(res, opts) {
  const o = opts || {};
  const issues = [];
  if (res.real.err || res.mock.err) {
    if (!res.real.err || !res.mock.err || res.real.err.code !== res.mock.err.code) {
      issues.push(`outcome: real=${res.real.err ? `ERR ${res.real.err.code} "${res.real.err.message}"` : 'OK'} ` +
        `mock=${res.mock.err ? `ERR ${res.mock.err.code} "${res.mock.err.message}"` : 'OK'}`);
    }
  } else {
    diffShape(res.real.ok, res.mock.ok).forEach((i) => {
      if (!(o.ignore || []).some((g) => i.startsWith(g))) {
        issues.push(`shape ${i}`);
      }
    });
    if (o.values) {
      const x = j(norm(res.real.ok));
      const y = j(norm(res.mock.ok));
      if (x !== y) {
        issues.push(`values differ:\n         real=${x.slice(0, 700)}\n         mock=${y.slice(0, 700)}`);
      }
    }
  }
  assert.ok(!issues.length, `DIVERGENCE in ${res.label}\n       - ${issues.join('\n       - ')}`);

  return res;
}

const keyOf = (v) => `${v.kind}|${v.experimentId}|${v.ontology}|${v.tag}`;

// ---------- legacy-shaped data (doc 2 section 4, plan section 2) --------------------------------------

const LEGACY = {
  PMID: '555001',
  UniqueID: 777001,
  Timestamp: '2015-09-06',
  Title: 'Legacy &lt;i&gt;shaped&lt;/i&gt; article',
  Authors: 'Smith J,Doe A',
  Reference: 'Smith J, Doe A (2015) J Legacy 1:2-3',
  Abstract: 'An abstract',
  DOI: '10.1/x',
  Metadata: {
    meshHeadings: [
      {name: 'Brain', majorTopic: true},
      {name: 'Memory,  Short-Term', majorTopic: false},
      {name: 'Humans', majorTopic: false}
    ],
    space: 'MNI',
    stereo: {MNI: 2, Talairach: 1},
    nsubjects: 20
  },
  Experiments: [
    {
      id: 1, title: 'Task > baseline', caption: 'Activations',
      locations: ['-42,18,24', '44,20,26', '-8,-72,12,3.5', '30,-60,-14'],
      tags: [
        {name: 'Working Memory', ontology: 'cognitive', agree: 3, disagree: 1},
        {name: 'Stroop task', ontology: 'tasks', agree: 0, disagree: 0},
        {name: 'LegacyOnly', ontology: 'cognitive', agree: 2, disagree: 0}
      ],
      markBadTable: {ok: 2, bad: 1}
    },
    {id: 2, title: '', caption: '', locations: ['10,10,10', '-10,-10,-10']},
    {id: 3, title: 'Empty', caption: '', locations: [], tags: [], markBadTable: {ok: 0, bad: 0}}
  ]
};
// second legacy article: only the old `space` string, no counts, no nsubjects; no Experiments tags
const LEGACY2 = {
  PMID: '555002', Title: 'Legacy two', Authors: 'Poe E', Reference: 'r', Abstract: 'a',
  Metadata: {meshHeadings: [{name: 'Humans', majorTopic: false}], space: 'TAL'},
  Experiments: [{id: 1, title: 't', caption: 'c', locations: ['1,2,3']}]
};
// third: no Metadata content at all
const LEGACY3 = {PMID: '555003', Title: 'Legacy three', Experiments: [{id: 5, title: '', caption: '', locations: ['1,2,3']}], Metadata: {}};

const CONCEPTS = {
  cognitive: [['attention', null], ['working memory', 'memory'], ['memory', null], ['face perception', 'perception'], ['perception', null], ['emotion', null]],
  behavioural: [['Cognition', null], ['Cognition.Attention', 'Cognition'], ['Action.Execution', 'Action'], ['Perception.Vision', 'Perception']],
  tasks: [['n-back task', null], ['Stroop task', null], ['go/no-go task', null]]
};

// ---------- setup ---------------------------------------------------------------------------------------

test('contract: setup (mock loaded, legacy articles and concepts seeded, users created)', async (ctx) => {
  const tmp = path.join(os.tmpdir(), `bs-mock-${process.pid}.mjs`);
  fs.copyFileSync(MOCK_SRC, tmp);
  const mod = await import(pathToFileURL(tmp).href);
  fs.unlinkSync(tmp);
  const mockArticles = {};
  [LEGACY, LEGACY2, LEGACY3].forEach((a) => {
    mockArticles[a.PMID] = Object.assign({objectId: `obj${a.PMID}`}, JSON.parse(JSON.stringify(a)));
    mockArticles[a.PMID].Metadata = mockArticles[a.PMID].Metadata || {};
  });
  ctx.mock = mod.createMockApi({articles: mockArticles});
  for (const a of [LEGACY, LEGACY2, LEGACY3]) {
    const r = await ctx.rest('POST', '/classes/Articles', {master: true, body: a});
    assert.strictEqual(r.status, 201, r.text);
  }
  for (const onto of Object.keys(CONCEPTS)) {
    for (const [name, parent] of CONCEPTS[onto]) {
      const body = {name, ontology: onto, definition: '', url: ''};
      if (parent) {
        body.parent = parent;
      }
      const r = await ctx.rest('POST', '/classes/Concept', {master: true, body});
      assert.strictEqual(r.status, 201, r.text);
    }
  }
  ctx.u = {alice: await ctx.signup('qa-alice', 7101), bob: await ctx.signup('qa-bob', 7102), carol: await ctx.signup('qa-carol', 7103)};
});

// ---------- me ----------------------------------------------------------------------------------------------

test('contract me: anonymous', async (ctx) => check(await both(ctx, 'me', {}), {values: true}));
test('contract me: logged in (id is an objectId in real, "u_login" in mock: shape only)', async (ctx) => {
  const r = check(await both(ctx, 'me', {}, 'alice'));
  assert.deepStrictEqual(Object.keys(r.real.ok).sort(), ['githubId', 'id', 'login']);
});

// ---------- getAnnotations -------------------------------------------------------------------------------------

test('contract getAnnotations: legacy article, anonymous (values and ordering)', async (ctx) => {
  const r = await both(ctx, 'getAnnotations', {pmid: '555001'});
  check(r, {values: true});
});
test('contract getAnnotations: legacy article 2 (only old `space` string "TAL")', async (ctx) => {
  check(await both(ctx, 'getAnnotations', {pmid: '555002'}), {values: true});
});
test('contract getAnnotations: article without any metadata, experiment id 5', async (ctx) => {
  check(await both(ctx, 'getAnnotations', {pmid: '555003'}), {values: true});
});
test('contract getAnnotations: unknown pmid -> 101', async (ctx) => check(await both(ctx, 'getAnnotations', {pmid: '999'})));
test('contract getAnnotations: bad pmid -> 142', async (ctx) => {
  check(await both(ctx, 'getAnnotations', {pmid: 555001}));
  check(await both(ctx, 'getAnnotations', {}));
  check(await both(ctx, 'getAnnotations', {pmid: '1', extra: 1}));
});

// ---------- vote ---------------------------------------------------------------------------------------------------

test('contract vote: anonymous -> 206', async (ctx) => check(await both(ctx, 'vote', {pmid: '555001', experimentId: -1, kind: 'mesh', tag: 'Brain', value: 1})));
test('contract vote: mesh agree / flip / retract / case+space variants', async (ctx) => {
  const base = {pmid: '555001', experimentId: -1, kind: 'mesh', tag: 'Brain'};
  check(await both(ctx, 'vote', Object.assign({value: 1}, base), 'alice'), {values: true});
  check(await both(ctx, 'vote', Object.assign({value: -1}, base), 'alice'), {values: true});
  check(await both(ctx, 'vote', Object.assign({value: 1}, base, {tag: ' brain '}), 'bob'), {values: true});
  check(await both(ctx, 'vote', Object.assign({value: 0}, base), 'alice'), {values: true});
  // heading with a double space in the stored name: the client sends the stored spelling
  check(await both(ctx, 'vote', {pmid: '555001', experimentId: -1, kind: 'mesh', tag: 'Memory,  Short-Term', value: 1}, 'alice'), {values: true});
});
test('contract vote: mesh with a heading that is not on the article -> 142', async (ctx) => {
  check(await both(ctx, 'vote', {pmid: '555001', experimentId: -1, kind: 'mesh', tag: 'Nope', value: 1}, 'alice'));
});
test('contract vote: tag on a legacy tag, a Concept not yet tagged, and a legacy-only tag', async (ctx) => {
  const b = {pmid: '555001', experimentId: 1, kind: 'tag', ontology: 'cognitive'};
  check(await both(ctx, 'vote', Object.assign({tag: 'Working Memory', value: 1}, b), 'alice'), {values: true});
  check(await both(ctx, 'vote', Object.assign({tag: 'attention', value: 1}, b), 'alice'), {values: true});
  check(await both(ctx, 'vote', Object.assign({tag: 'LegacyOnly', value: -1}, b), 'alice'), {values: true});
  // hidden legacy tag (0/0) gets its first vote
  check(await both(ctx, 'vote', {pmid: '555001', experimentId: 1, kind: 'tag', ontology: 'tasks', tag: 'Stroop task', value: 1}, 'alice'), {values: true});
  // retract the only vote on a new tag: counts 0/0, client then drops it
  check(await both(ctx, 'vote', Object.assign({tag: 'attention', value: 0}, b), 'alice'), {values: true});
});
test('contract vote: tag validation (unknown term, wrong ontology, missing ontology, bad experiment)', async (ctx) => {
  check(await both(ctx, 'vote', {pmid: '555001', experimentId: 1, kind: 'tag', ontology: 'cognitive', tag: 'zzz', value: 1}, 'bob'));
  check(await both(ctx, 'vote', {pmid: '555001', experimentId: 1, kind: 'tag', ontology: 'nope', tag: 'attention', value: 1}, 'bob'));
  check(await both(ctx, 'vote', {pmid: '555001', experimentId: 1, kind: 'tag', tag: 'attention', value: 1}, 'bob'));
  check(await both(ctx, 'vote', {pmid: '555001', experimentId: 99, kind: 'tag', ontology: 'cognitive', tag: 'attention', value: 1}, 'bob'));
  check(await both(ctx, 'vote', {pmid: '555001', experimentId: 1, kind: 'tag', ontology: 'cognitive', tag: 'attention', value: 2}, 'bob'));
  check(await both(ctx, 'vote', {pmid: '555001', experimentId: 1, kind: 'mesh', tag: 'Brain', value: 1}, 'bob'));
});
test('contract vote: tableOk yes / no / retract; experiment without markBadTable', async (ctx) => {
  const b = {pmid: '555001', kind: 'tableOk', tag: 'ok'};
  check(await both(ctx, 'vote', Object.assign({experimentId: 1, value: 1}, b), 'alice'), {values: true});
  check(await both(ctx, 'vote', Object.assign({experimentId: 1, value: -1}, b), 'bob'), {values: true});
  check(await both(ctx, 'vote', Object.assign({experimentId: 2, value: 1}, b), 'alice'), {values: true});
  check(await both(ctx, 'vote', Object.assign({experimentId: 1, value: 0}, b), 'alice'), {values: true});
});
test('contract vote: unknown article -> 101', async (ctx) => {
  check(await both(ctx, 'vote', {pmid: '999', experimentId: -1, kind: 'mesh', tag: 'Brain', value: 1}, 'alice'));
});
test('contract getAnnotations after votes: values for alice, ordering of the votes array', async (ctx) => {
  const r = await both(ctx, 'getAnnotations', {pmid: '555001'}, 'alice');
  const order = (x) => x.ok.votes.map(keyOf);
  const same = j(order(r.real)) === j(order(r.mock));
  assert.ok(same, `DIVERGENCE in getAnnotations votes ORDER\n       real=${j(order(r.real))}\n       mock=${j(order(r.mock))}`);
  check(r, {values: true});
});

// ---------- setStereoSpace / setNSubjects ---------------------------------------------------------------

test('contract setStereoSpace: MNI, flip, retract, legacy-space-only article, validation, anonymous', async (ctx) => {
  check(await both(ctx, 'setStereoSpace', {pmid: '555001', space: 'MNI'}), {});
  check(await both(ctx, 'setStereoSpace', {pmid: '555001', space: 'MNI'}, 'alice'), {values: true});
  check(await both(ctx, 'setStereoSpace', {pmid: '555001', space: 'Talairach'}, 'alice'), {values: true});
  check(await both(ctx, 'setStereoSpace', {pmid: '555001', space: null}, 'alice'), {values: true});
  check(await both(ctx, 'setStereoSpace', {pmid: '555001', space: 'mni'}, 'alice'));
  check(await both(ctx, 'setStereoSpace', {pmid: '555001'}, 'alice'));
});
test('contract setNSubjects: set, replace, retract, ties, legacy fallback, validation', async (ctx) => {
  check(await both(ctx, 'setNSubjects', {pmid: '555001', n: 30}, 'alice'), {values: true});
  check(await both(ctx, 'setNSubjects', {pmid: '555001', n: 30}, 'bob'), {values: true});
  check(await both(ctx, 'setNSubjects', {pmid: '555001', n: 12}, 'carol'), {values: true});
  check(await both(ctx, 'setNSubjects', {pmid: '555001', n: null}, 'alice'), {values: true});
  check(await both(ctx, 'setNSubjects', {pmid: '555001', n: null}, 'bob'), {values: true});
  check(await both(ctx, 'setNSubjects', {pmid: '555001', n: null}, 'carol'), {values: true});
  for (const n of [0, 1.5, '20', 100001, -3]) {
    check(await both(ctx, 'setNSubjects', {pmid: '555001', n}, 'alice'));
  }
  check(await both(ctx, 'setNSubjects', {pmid: '555001'}, 'alice'));
});

// ---------- postComment ------------------------------------------------------------------------------------------

test('contract postComment: ok (values), anonymous, empty, 5001 chars, padded text', async (ctx) => {
  check(await both(ctx, 'postComment', {pmid: '555001', text: 'first'}), {});
  check(await both(ctx, 'postComment', {pmid: '555001', text: 'first <b>comment</b>'}, 'carol'), {values: true});
  check(await both(ctx, 'postComment', {pmid: '555001', text: ''}, 'carol'));
  check(await both(ctx, 'postComment', {pmid: '555001', text: 'x'.repeat(5001)}, 'carol'));
});
test('contract postComment: padded text (server trims, mock keeps the spaces)', async (ctx) => {
  const padded = await both(ctx, 'postComment', {pmid: '555003', text: '  padded  '}, 'carol');
  check(padded, {});
  assert.strictEqual(padded.real.ok.text, padded.mock.ok.text, `DIVERGENCE postComment text: real=${j(padded.real.ok.text)} mock=${j(padded.mock.ok.text)}`);
});
test('contract setNSubjects: NaN / Infinity are serialised as null by JSON = RETRACT (client guards with parseSubjects)', async (ctx) => {
  const r = await ctx.cloud('setNSubjects', {pmid: '555003', n: NaN}, ctx.u.carol.session);
  assert.strictEqual(r.status, 200, `NaN -> JSON null is accepted as a retract: ${r.text}`);
});
test('contract getAnnotations: comments and commentCount agree', async (ctx) => {
  check(await both(ctx, 'getAnnotations', {pmid: '555001'}, 'carol'), {values: true});
});

// ---------- editExperiment ---------------------------------------------------------------------------------------------

const edit = (ctx, p, who) => both(ctx, 'editExperiment', Object.assign({pmid: '555001'}, p), who || 'alice');

test('contract editExperiment: anonymous, missing rev, stale rev, bad ops', async (ctx) => {
  check(await both(ctx, 'editExperiment', {pmid: '555001', experimentId: 1, rev: 0, ops: [{op: 'setTitle', text: 'x'}]}));
  check(await edit(ctx, {experimentId: 1, rev: 5, ops: [{op: 'setTitle', text: 'x'}]}));
  check(await edit(ctx, {experimentId: 1, rev: 0, ops: []}));
  check(await edit(ctx, {experimentId: 1, rev: 0, ops: [{op: 'nope'}]}));
  check(await edit(ctx, {experimentId: 99, rev: 0, ops: [{op: 'setTitle', text: 'x'}]}));
});
test('contract editExperiment: rev is required by the mock; the real server defaults a missing rev to 0', async (ctx) => {
  const p = {pmid: '555003', experimentId: 5, ops: [{op: 'setTitle', text: 'no rev'}]};
  const r = await both(ctx, 'editExperiment', p, 'alice');
  // keep the mock in step with the real state whatever happens
  if (r.mock.err && r.real.ok) {
    await ctx.mock.call('editExperiment', Object.assign({rev: 0}, p));
  }
  check(r);
});
test('contract editExperiment: setTitle + setCaption (rev 0 -> 1), changed experiments are full JSON', async (ctx) => {
  check(await edit(ctx, {experimentId: 1, rev: 0, ops: [{op: 'setTitle', text: 'New title'}, {op: 'setCaption', text: 'New caption'}]}), {values: true});
});
test('contract editExperiment: NO-OP (same title) must behave like the mock (rev, experiments array)', async (ctx) => {
  const r = await edit(ctx, {experimentId: 1, rev: 1, ops: [{op: 'setTitle', text: 'New title'}]});
  // the mock bumps the rev on a no-op, the real server does not: re-synchronise so later tests are meaningful
  if (r.mock.ok && r.real.ok && r.mock.ok.rev !== r.real.ok.rev) {
    ctx.mock._state.articles['555001'].rev = r.real.ok.rev;
  }
  check(r, {values: true});
});
test('contract editExperiment: rows - updateRow on a 4-value row, addRow, deleteRow', async (ctx) => {
  const rev = (await ctx.cloud('getAnnotations', {pmid: '555001'})).json.result.rev;
  check(await edit(ctx, {experimentId: 1, rev, ops: [{op: 'updateRow', index: 2, xyz: [1, 2, 3.14159]}, {op: 'addRow', xyz: [5, 6, 7], index: 0}, {op: 'deleteRow', index: 1}]}), {values: true});
});
test('contract editExperiment: split (new experiment: keys, tags, markBadTable, order)', async (ctx) => {
  const rev = (await ctx.cloud('getAnnotations', {pmid: '555001'})).json.result.rev;
  const r = await edit(ctx, {experimentId: 1, rev, ops: [{op: 'split', index: 1}]});
  check(r, {values: true});
});
test('contract getAnnotations after split: votes of the new experiment, rev', async (ctx) => {
  check(await both(ctx, 'getAnnotations', {pmid: '555001'}, 'alice'), {values: true});
});
test('contract editExperiment: replaceFromText, empty result, out-of-range, 201 coordinate', async (ctx) => {
  const rev = (await ctx.cloud('getAnnotations', {pmid: '555001'})).json.result.rev;
  check(await edit(ctx, {experimentId: 2, rev, ops: [{op: 'replaceFromText', text: '1,2,3\nfoo\n4 5 6\n"7" −08 9'}]}), {values: true});
  const rev2 = (await ctx.cloud('getAnnotations', {pmid: '555001'})).json.result.rev;
  check(await edit(ctx, {experimentId: 2, rev: rev2, ops: [{op: 'replaceFromText', text: 'nothing'}]}));
  check(await edit(ctx, {experimentId: 2, rev: rev2, ops: [{op: 'deleteRow', index: 50}]}));
  check(await edit(ctx, {experimentId: 2, rev: rev2, ops: [{op: 'addRow', xyz: [201, 0, 0]}]}));
  check(await edit(ctx, {experimentId: 3, rev: rev2, ops: [{op: 'updateRow', index: 0, xyz: [1, 1, 1]}]}));
});

// ---------- addArticle ------------------------------------------------------------------------------------------

test('contract addArticle: ok / exists / anonymous / bad / PubMed has no record', async (ctx) => {
  ctx.pubmed.records['7771'] = record({pmid: '7771'});
  check(await both(ctx, 'addArticle', {pmid: '7771', nTables: 2}));
  check(await both(ctx, 'addArticle', {pmid: '7771', nTables: 2}, 'alice'), {ignore: []}); // mock has no PubMed: shape only
  check(await both(ctx, 'addArticle', {pmid: '7771', nTables: 2}, 'alice'));
  check(await both(ctx, 'addArticle', {pmid: '12345678901', nTables: 2}, 'alice'));
  check(await both(ctx, 'addArticle', {pmid: '7771', nTables: 51}, 'alice'));
  const r = await ctx.cloud('addArticle', {pmid: '7772', nTables: 0}, ctx.u.bob.session); // not in the PubMed stub: the mock has no PubMed
  assert.strictEqual(r.json.code, 1002, r.text);
});
test('contract addArticle: the new article read the way the client reads it (getAnnotations)', async (ctx) => {
  check(await both(ctx, 'getAnnotations', {pmid: '7771'}, 'alice'), {values: false});
  const art = (await ctx.rest('GET', `/classes/Articles?where=${encodeURIComponent(JSON.stringify({PMID: '7771'}))}`)).json.results[0];
  const mockArt = await ctx.mock.getArticle('7771');
  const issues = diffShape(art.Experiments, mockArt.Experiments);
  assert.ok(!issues.length, `DIVERGENCE: experiments of an added article (client reads them from Articles)\n       - ${issues.join('\n       - ')}`);
});

// ---------- collections ------------------------------------------------------------------------------------------

test('contract collections: list / create / add / remove / rename / delete / foreign / unknown / limits', async (ctx) => {
  check(await both(ctx, 'listCollections', {}));
  check(await both(ctx, 'listCollections', {}, 'alice'), {values: true});
  const created = await both(ctx, 'saveCollection', {name: 'My papers', add: ['555001', '555002']}, 'alice');
  check(created, {values: true});
  const id = created.real.ok.id;
  const mid = created.mock.ok.id;
  // second user with the same ids (each side has its own ids, so do the calls by hand)
  const r1 = await ctx.cloud('saveCollection', {id, add: ['555003', '555001'], remove: ['555002']}, ctx.u.alice.session);
  ctx.mock.loginAs('qa-alice');
  const m1 = await ctx.mock.call('saveCollection', {id: mid, add: ['555003', '555001'], remove: ['555002']});
  assert.deepStrictEqual(diffShape(r1.json.result, m1), []);
  assert.deepStrictEqual(r1.json.result.pmids, m1.pmids, 'pmids order after add/remove');
  const r2 = await ctx.cloud('saveCollection', {id, name: 'Renamed'}, ctx.u.alice.session);
  const m2 = await ctx.mock.call('saveCollection', {id: mid, name: 'Renamed'});
  assert.deepStrictEqual(diffShape(r2.json.result, m2), []);
  // other user: foreign id
  const r3 = await ctx.cloud('saveCollection', {id, name: 'Hijack'}, ctx.u.bob.session);
  ctx.mock.loginAs('qa-bob');
  let m3;
  try {
    await ctx.mock.call('saveCollection', {id: mid, name: 'Hijack'});
  } catch (e) {
    m3 = e.code;
  }
  const div = [];
  if (r3.json.code !== m3) {
    div.push(`saveCollection with a foreign id: real=${r3.json.code} mock=${m3}`);
  }
  const r4 = await ctx.cloud('deleteCollection', {id}, ctx.u.bob.session);
  let m4;
  try {
    await ctx.mock.call('deleteCollection', {id: mid});
  } catch (e) {
    m4 = e.code;
  }
  if (r4.json.code !== m4) {
    div.push(`deleteCollection with a foreign id: real=${r4.json.code} mock=${m4}`);
  }
  // unknown id (well formed)
  check(await both(ctx, 'saveCollection', {id: 'doesNotExist1', name: 'x'}, 'alice'));
  check(await both(ctx, 'deleteCollection', {id: 'doesNotExist1'}, 'alice'));
  check(await both(ctx, 'saveCollection', {name: ''}, 'bob'));
  check(await both(ctx, 'saveCollection', {add: ['1']}, 'bob'));
  check(await both(ctx, 'saveCollection', {name: 'ok', add: ['abc']}, 'bob'));
  // list then delete
  const l = await ctx.cloud('listCollections', {}, ctx.u.alice.session);
  assert.deepStrictEqual(diffShape(l.json.result, [m2]), []);
  const d = await ctx.cloud('deleteCollection', {id}, ctx.u.alice.session);
  ctx.mock.loginAs('qa-alice');
  const dm = await ctx.mock.call('deleteCollection', {id: mid});
  assert.deepStrictEqual(diffShape(d.json.result, dm), []);
  assert.deepStrictEqual(div, [], 'DIVERGENCE (error codes for a foreign collection id)');
});
test('contract saveCollection: a 150 character name (client/annotation/collections.js MAX_NAME = 200, mock 200)', async (ctx) => {
  check(await both(ctx, 'saveCollection', {name: 'n'.repeat(150)}, 'bob'));
});

// ---------- concepts -----------------------------------------------------------------------------------------------

test('contract listConcepts: shape and values (parent null vs "")', async (ctx) => {
  for (const o of ['cognitive', 'behavioural', 'tasks']) {
    const r = await both(ctx, 'listConcepts', {ontology: o});
    // order: the real one is sorted by name, the mock keeps insertion order: compare as sets
    const sortKey = (a) => a.slice().sort((x, y) => (x.name < y.name ? -1 : 1));
    r.real.ok = sortKey(r.real.ok);
    r.mock.ok = sortKey(r.mock.ok);
    check(r, {values: true});
  }
});
test('contract listConcepts: bad ontology -> 142', async (ctx) => {
  check(await both(ctx, 'listConcepts', {ontology: 'nope'}));
  check(await both(ctx, 'listConcepts', {}));
});
test('contract getConcept: ok (shape), not found -> 101, bad ontology -> 142', async (ctx) => {
  check(await both(ctx, 'getConcept', {name: 'Working Memory', ontology: 'cognitive'}), {});
  check(await both(ctx, 'getConcept', {name: 'zzz', ontology: 'cognitive'}));
  check(await both(ctx, 'getConcept', {name: 'attention', ontology: 'x'}));
});

// ---------- select (not in the mock; what search.js reads) ---------------------------------------------------------

test('contract select: the response keeps the fields search.js reads (docs[].id/score, maxScore, start, numFound)', async (ctx) => {
  const r = await ctx.cloud('select', {q: 'memory', fl: '* score', start: 0, rows: 10});
  assert.strictEqual(r.status, 200, r.text);
  const x = r.json.result;
  ['numFound', 'start', 'maxScore', 'docs'].forEach((k) => assert.ok(k in x, `select response lacks ${k}`));
  assert.ok(Array.isArray(x.docs) && 'id' in x.docs[0] && 'score' in x.docs[0]);
  // search.js sends fl "* score", q free text, no defType: also check the old param spelling used by index/search
  const r2 = await ctx.cloud('select', {q: 'memory', fl: 'score,id', start: 0, rows: 10});
  assert.strictEqual(r2.status, 200, r2.text);
});
