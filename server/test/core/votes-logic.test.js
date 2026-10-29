const test = require('node:test');
const assert = require('node:assert');
const L = require('../../lib/votes-logic');

test('decide: first vote creates', () => {
  assert.deepStrictEqual(L.decide(null, 1), {op: 'create', value: 1});
  assert.deepStrictEqual(L.decide(null, -1), {op: 'create', value: -1});
});

test('decide: retract without a vote does nothing', () => {
  assert.deepStrictEqual(L.decide(null, 0), {op: 'none'});
});

test('decide: double submit does nothing', () => {
  assert.deepStrictEqual(L.decide({value: 1}, 1), {op: 'none'});
  assert.deepStrictEqual(L.decide({value: -1}, -1), {op: 'none'});
});

test('decide: flip updates', () => {
  assert.deepStrictEqual(L.decide({value: 1}, -1), {op: 'update', value: -1});
  assert.deepStrictEqual(L.decide({value: -1}, 1), {op: 'update', value: 1});
});

test('decide: retract deletes', () => {
  assert.deepStrictEqual(L.decide({value: 1}, 0), {op: 'delete'});
  assert.deepStrictEqual(L.decide({value: -1}, 0), {op: 'delete'});
});

test('decide: exhaustive table over current x requested', () => {
  const expected = {
    'null|1': 'create', 'null|-1': 'create', 'null|0': 'none',
    '1|1': 'none', '1|-1': 'update', '1|0': 'delete',
    '-1|1': 'update', '-1|-1': 'none', '-1|0': 'delete'
  };
  for (const cur of [null, 1, -1]) {
    for (const req of [1, -1, 0]) {
      const r = L.decide(cur === null ? null : {value: cur}, req);
      assert.strictEqual(r.op, expected[`${cur}|${req}`], `${cur} -> ${req}`);
    }
  }
});

test('decide: retract then revote is create, delete, create', () => {
  assert.strictEqual(L.decide(null, 1).op, 'create');
  assert.strictEqual(L.decide({value: 1}, 0).op, 'delete');
  assert.strictEqual(L.decide(null, 1).op, 'create');
});

test('decide: refuses bad input', () => {
  assert.throws(() => L.decide(null, 2), RangeError);
  assert.throws(() => L.decide(null, '1'), RangeError);
  assert.throws(() => L.decide({value: 0}, 1), RangeError);
});

test('decideReplace: space and nsubjects', () => {
  assert.deepStrictEqual(L.decideReplace(null, 'MNI'), {op: 'create', value: 'MNI'});
  assert.deepStrictEqual(L.decideReplace('MNI', 'MNI'), {op: 'none'});
  assert.deepStrictEqual(L.decideReplace('MNI', 'Talairach'), {op: 'update', value: 'Talairach'});
  assert.deepStrictEqual(L.decideReplace('MNI', null), {op: 'delete'});
  assert.deepStrictEqual(L.decideReplace(null, null), {op: 'none'});
  assert.deepStrictEqual(L.decideReplace(null, 12), {op: 'create', value: 12});
  assert.deepStrictEqual(L.decideReplace(12, 13), {op: 'update', value: 13});
  assert.deepStrictEqual(L.decideReplace(12, 12), {op: 'none'});
  assert.deepStrictEqual(L.decideReplace(12, null), {op: 'delete'});
});

const row = (o) => Object.assign({
  id: 'r', user: 'u1', experimentId: 1, kind: 'tag', ontology: 'cognitive', tag: 'Memory',
  value: 1, number: null, updatedAt: 1
}, o);

test('latestPerKey keeps the newest row, by normalised tag', () => {
  const rows = [
    row({id: 'a', updatedAt: 1, value: 1}),
    row({id: 'b', updatedAt: 5, value: -1, tag: '  memory '}),
    row({id: 'c', updatedAt: 3, value: 1, user: 'u2'})
  ];
  const out = L.latestPerKey(rows);
  assert.strictEqual(out.length, 2);
  assert.strictEqual(out.find((r) => r.user === 'u1').id, 'b');
});

test('latestPerKey: tie on updatedAt resolved by id; different ontology is a different key', () => {
  const out = L.latestPerKey([row({id: 'a'}), row({id: 'b'}), row({id: 'c', ontology: 'tasks'})]);
  assert.strictEqual(out.length, 2);
  assert.strictEqual(out.find((r) => r.ontology === 'cognitive').id, 'b');
});

const article = () => ({
  Experiments: [
    {id: 1, markBadTable: {ok: 2, bad: 1}, tags: [
      {name: 'Memory', ontology: 'cognitive', agree: 3, disagree: 1},
      {name: 'Unseen', ontology: 'cognitive', agree: 0, disagree: 0}
    ]},
    {id: 2, tags: []}
  ],
  Metadata: {meshHeadings: [{name: 'Brain', majorTopic: true}, {name: 'Humans'}]}
});

test('buildVotes: legacy baseline, always-shown kinds, display rule', () => {
  const v = L.buildVotes(article(), [], null);
  const tags = v.filter((e) => e.kind === 'tag');
  assert.strictEqual(tags.length, 1);
  assert.deepStrictEqual([tags[0].tag, tags[0].agree, tags[0].disagree, tags[0].mine], ['Memory', 3, 1, 0]);
  assert.strictEqual(v.filter((e) => e.kind === 'mesh').length, 2);
  const ok = v.filter((e) => e.kind === 'tableOk');
  assert.strictEqual(ok.length, 2);
  assert.deepStrictEqual([ok[0].agree, ok[0].disagree, ok[1].agree], [2, 1, 0]);
});

test('buildVotes: rows add to the baseline and set mine; a vote makes a hidden tag visible', () => {
  const rows = [
    row({id: 'a', user: 'u1', value: 1}),
    row({id: 'b', user: 'u2', value: -1, tag: 'memory'}),
    row({id: 'c', user: 'u1', tag: 'Unseen', value: -1}),
    row({id: 'd', user: 'u1', experimentId: -1, kind: 'mesh', ontology: null, tag: 'brain', value: 1}),
    row({id: 'e', user: 'u1', experimentId: 2, kind: 'tableOk', ontology: null, tag: 'ok', value: -1})
  ];
  const v = L.buildVotes(article(), rows, 'u1');
  const mem = v.find((e) => e.tag === 'Memory');
  assert.deepStrictEqual([mem.agree, mem.disagree, mem.mine], [4, 2, 1]);
  const unseen = v.find((e) => e.tag === 'Unseen');
  assert.deepStrictEqual([unseen.agree, unseen.disagree, unseen.mine], [0, 1, -1]);
  const brain = v.find((e) => e.kind === 'mesh' && e.tag === 'Brain');
  assert.deepStrictEqual([brain.agree, brain.mine], [1, 1]);
  const t2 = v.find((e) => e.kind === 'tableOk' && e.experimentId === 2);
  assert.deepStrictEqual([t2.disagree, t2.mine], [1, -1]);
});

test('buildVotes: a tag only present in Concept (no legacy) appears once voted; ignored if experiment or heading is gone', () => {
  const rows = [
    row({id: 'a', experimentId: 2, tag: 'Attention'}),
    row({id: 'b', experimentId: 9, tag: 'Gone'}),
    row({id: 'c', experimentId: -1, kind: 'mesh', ontology: null, tag: 'Gone heading'}),
    row({id: 'd', experimentId: 1, ontology: 'nonsense', tag: 'Bad ontology'})
  ];
  const v = L.buildVotes(article(), rows, null);
  assert.ok(v.find((e) => e.tag === 'Attention' && e.experimentId === 2));
  assert.ok(!v.find((e) => e.tag === 'Gone'));
  assert.ok(!v.find((e) => e.tag === 'Gone heading'));
  assert.ok(!v.find((e) => e.tag === 'Bad ontology'));
});

test('buildVotes: a retracted-to-zero legacy-less tag disappears, legacy counts malformed are 0', () => {
  const a = article();
  a.Experiments[0].tags[0].agree = 'x';
  a.Experiments[0].tags[0].disagree = -4;
  assert.ok(!L.buildVotes(a, [], null).find((e) => e.tag === 'Memory'));
  assert.ok(L.buildEntries(a, [], null).find((e) => e.tag === 'Memory'));
});

test('buildStereo: legacy counts, legacy space string as one vote, votes, mine', () => {
  assert.deepStrictEqual(L.buildStereo({Metadata: {}}, [], 'u1'), {MNI: 0, Talairach: 0, mine: null});
  assert.deepStrictEqual(L.buildStereo({Metadata: {stereo: {MNI: 3, Talairach: 1}, space: 'MNI'}}, [], 'u1'),
    {MNI: 3, Talairach: 1, mine: null});
  assert.deepStrictEqual(L.buildStereo({Metadata: {space: 'Talairach'}}, [], null),
    {MNI: 0, Talairach: 1, mine: null});
  assert.deepStrictEqual(L.buildStereo({Metadata: {space: 'MNI152'}}, [], null).MNI, 1);
  assert.deepStrictEqual(L.buildStereo({Metadata: {space: 'other'}}, [], null), {MNI: 0, Talairach: 0, mine: null});
  const rows = [
    {id: 'a', user: 'u1', kind: 'space', tag: 'MNI', updatedAt: 1},
    {id: 'b', user: 'u1', kind: 'space', tag: 'Talairach', updatedAt: 2},
    {id: 'c', user: 'u2', kind: 'space', tag: 'Talairach', updatedAt: 1}
  ];
  assert.deepStrictEqual(L.buildStereo({Metadata: {}}, rows, 'u1'), {MNI: 0, Talairach: 2, mine: 'Talairach'});
});

test('buildNSubjects: most voted, tie by most recent, legacy fallback, mine', () => {
  const nrow = (id, user, number, updatedAt) => ({id, user, kind: 'nsubjects', tag: 'n', number, updatedAt});
  assert.deepStrictEqual(L.buildNSubjects({Metadata: {nsubjects: 20}}, [], 'u1'), {value: 20, values: [], mine: null});
  assert.deepStrictEqual(L.buildNSubjects({Metadata: {nsubjects: '12'}}, [], null).value, 12);
  assert.strictEqual(L.buildNSubjects({Metadata: {nsubjects: 'many'}}, [], null).value, null);
  const rows = [nrow('a', 'u1', 10, 1), nrow('b', 'u2', 10, 2), nrow('c', 'u3', 12, 9)];
  const r = L.buildNSubjects({Metadata: {nsubjects: 99}}, rows, 'u3');
  assert.deepStrictEqual(r, {value: 10, values: [{n: 10, count: 2}, {n: 12, count: 1}], mine: 12});
  const tie = L.buildNSubjects({Metadata: {}}, [nrow('a', 'u1', 10, 1), nrow('c', 'u3', 12, 9)], null);
  assert.strictEqual(tie.value, 12);
});
