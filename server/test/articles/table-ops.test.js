const test = require('node:test');
const assert = require('node:assert');
const fakeParse = require('../helpers/fake-parse');

const fake = fakeParse.create();
global.Parse = fake.Parse;
const ops = require('../../lib/table-ops');

const EXPS = () => [
  {id: 1, title: 't1', caption: 'c1', locations: ['1,2,3', '4,5,6', '7,8,9,0.5'], markBadTable: {ok: 1, bad: 0},
    tags: [{name: 'Memory', ontology: 'cognitive', agree: 2, disagree: 0}]},
  {id: 5, title: 't5', caption: 'c5', locations: ['0,0,0'], tags: []}
];

const code = (fn, c, re) => assert.throws(fn, (e) => e.code === c && (!re || re.test(e.message)), `expected ${c} ${re || ''}`);
const apply = (list, id, o) => ops.applyOps(list, id, o);

test('replaceFromText: normative examples', () => {
  const one = (s) => ops.parseLocations(s);
  assert.deepStrictEqual(one('10,20,30'), ['10,20,30']);
  assert.deepStrictEqual(one('x=-5.5; y: 2; z=3'), ['-5.5,2,3']);
  assert.deepStrictEqual(one('−12\t34\t56'), ['-12,34,56']);
  assert.deepStrictEqual(one('1 2\n3,4,5'), ['3,4,5']);
  assert.deepStrictEqual(one('1,2,3,4.5'), ['1,2,3']);
  assert.deepStrictEqual(one('"10","20","30"'), ['10,20,30']);
  assert.deepStrictEqual(one('a1b2c3'), ['1,2,3']);
  assert.deepStrictEqual(one('  7 , -8 , 9  '), ['7,-8,9']);
  assert.deepStrictEqual(one('1.50,2.000,.5'), ['1.5,2,0.5']);
  assert.deepStrictEqual(one('+3,-0,200\r\n-200;0.0004;1e2'), ['3,0,200', '-200,0,1']);
  code(() => one('300,0,0'), 142, /line 1/);
  code(() => one('1,2,3\n\n0,-201,0'), 142, /line 3/);
  code(() => one(''), 142, /no valid line/);
  code(() => one('no numbers here'), 142, /no valid line/);
  code(() => one('1 2'), 142, /no valid line/);
  code(() => one('99999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999,1,1'), 142, /line 1/);
});

test('formatNumber: three decimals, no trailing zeros, no minus zero', () => {
  assert.strictEqual(ops.formatNumber(1.23456), '1.235');
  assert.strictEqual(ops.formatNumber(1.5), '1.5');
  assert.strictEqual(ops.formatNumber(-0.0001), '0');
  assert.strictEqual(ops.formatNumber(-0), '0');
  assert.strictEqual(ops.formatNumber(200), '200');
  assert.strictEqual(ops.formatLocation([1, -2.25, 0.1]), '1,-2.25,0.1');
});

test('applyOps does not modify its input and returns before-images', () => {
  const list = EXPS();
  const snapshot = JSON.stringify(list);
  const r = apply(list, 1, [{op: 'setTitle', text: 'new'}]);
  assert.strictEqual(JSON.stringify(list), snapshot);
  assert.strictEqual(r.experiments[0].title, 'new');
  assert.strictEqual(r.experiments[1], list[1], 'untouched experiments are shared');
  assert.deepStrictEqual(r.changed.map((e) => e.id), [1]);
  assert.strictEqual(r.before[0].title, 't1');
  assert.deepStrictEqual(r.experiments[0].tags, list[0].tags);
  assert.deepStrictEqual(r.experiments[0].markBadTable, {ok: 1, bad: 0});
});

test('setTitle / setCaption: limits, types, newlines, empty allowed', () => {
  assert.strictEqual(apply(EXPS(), 1, [{op: 'setTitle', text: ''}]).experiments[0].title, '');
  assert.strictEqual(apply(EXPS(), 1, [{op: 'setCaption', text: 'a\nb'}]).experiments[0].caption, 'a\nb');
  code(() => apply(EXPS(), 1, [{op: 'setTitle', text: 'a\nb'}]), 142, /ops\[0\]\.text/);
  code(() => apply(EXPS(), 1, [{op: 'setTitle', text: 'x'.repeat(1001)}]), 142);
  assert.ok(apply(EXPS(), 1, [{op: 'setTitle', text: 'x'.repeat(1000)}]).changed.length);
  code(() => apply(EXPS(), 1, [{op: 'setCaption', text: 'x'.repeat(5001)}]), 142);
  assert.ok(apply(EXPS(), 1, [{op: 'setCaption', text: 'x'.repeat(5000)}]).changed.length);
  code(() => apply(EXPS(), 1, [{op: 'setTitle', text: 5}]), 142);
  code(() => apply(EXPS(), 1, [{op: 'setTitle'}]), 142);
  assert.strictEqual(apply(EXPS(), 1, [{op: 'setTitle', text: 'é'}]).experiments[0].title, 'é');
});

test('a no-op changes nothing', () => {
  const r = apply(EXPS(), 1, [{op: 'setTitle', text: 't1'}]);
  assert.deepStrictEqual(r.changed, []);
  assert.deepStrictEqual(r.before, []);
});

test('updateRow: rewrites a legacy 4-value row as three numbers; others untouched', () => {
  const r = apply(EXPS(), 1, [{op: 'updateRow', index: 2, xyz: [1.23456, -2, 0]}]);
  assert.deepStrictEqual(r.experiments[0].locations, ['1,2,3', '4,5,6', '1.235,-2,0,0.5'], 'a 3-number update keeps the 4th value');
  const r4 = apply(EXPS(), 1, [{op: 'updateRow', index: 2, xyz: [1, 2, 3, 9.5]}]);
  assert.deepStrictEqual(r4.experiments[0].locations[2], '1,2,3,9.5', 'a 4-number update stores 4');
  const r2 = apply(EXPS(), 1, [{op: 'updateRow', index: 0, xyz: [9, 9, 9]}]);
  assert.deepStrictEqual(r2.experiments[0].locations, ['9,9,9', '4,5,6', '7,8,9,0.5'], 'legacy 4th value kept');
});

test('updateRow validation', () => {
  const bad = (o, re) => code(() => apply(EXPS(), 1, [Object.assign({op: 'updateRow', index: 0, xyz: [1, 2, 3]}, o)]), 142, re);
  bad({index: 3}, /out of range/);
  bad({index: -1});
  bad({index: 1.5});
  bad({index: '1'});
  bad({index: undefined});
  bad({xyz: [1, 2]});
  bad({xyz: [1, 2, 3, 4, 5]});
  bad({xyz: [1, 2, 3, 1e7]});
  bad({xyz: [1, 2, 3, null]});
  bad({xyz: '1,2,3'});
  bad({xyz: [1, 2, '3']});
  bad({xyz: [1, 2, null]});
  bad({xyz: [1, 2, 200.5]}, /between -200 and 200/);
  bad({xyz: [-200.001, 2, 3]});
  bad({extra: 1}, /unknown parameter/);
  assert.ok(apply(EXPS(), 1, [{op: 'updateRow', index: 0, xyz: [200, -200, 0]}]).changed.length);
});

test('coordinates must be finite (JSON cannot carry NaN, but direct callers can)', () => {
  for (const n of [NaN, Infinity, -Infinity]) {
    code(() => apply(EXPS(), 1, [{op: 'addRow', xyz: [n, 0, 0]}]), 142, /finite/);
  }
});

test('only CHANGED rows are range checked: a legacy row beyond 200 survives other edits', () => {
  const list = EXPS();
  list[0].locations = ['500,0,0', '1,1,1'];
  const r = apply(list, 1, [{op: 'updateRow', index: 1, xyz: [2, 2, 2]}]);
  assert.deepStrictEqual(r.experiments[0].locations, ['500,0,0', '2,2,2']);
});

test('addRow: default end, index start/middle/end, out of range', () => {
  const add = (o) => apply(EXPS(), 1, [Object.assign({op: 'addRow', xyz: [0, 0, 1]}, o)]).experiments[0].locations;
  assert.deepStrictEqual(add({}), ['1,2,3', '4,5,6', '7,8,9,0.5', '0,0,1']);
  assert.deepStrictEqual(add({index: 0}), ['0,0,1', '1,2,3', '4,5,6', '7,8,9,0.5']);
  assert.deepStrictEqual(add({index: 1}), ['1,2,3', '0,0,1', '4,5,6', '7,8,9,0.5']);
  assert.deepStrictEqual(add({index: 3}), ['1,2,3', '4,5,6', '7,8,9,0.5', '0,0,1']);
  code(() => add({index: 4}), 142, /out of range/);
  code(() => add({index: -1}), 142);
  code(() => add({xyz: [0, 0, 201]}), 142);
});

test('addRow on an empty experiment and on an experiment without locations', () => {
  const list = [{id: 1, title: '', caption: '', locations: [], tags: []}, {id: 2}];
  assert.deepStrictEqual(apply(list, 1, [{op: 'addRow', xyz: [1, 2, 3]}]).experiments[0].locations, ['1,2,3']);
  assert.deepStrictEqual(apply(list, 2, [{op: 'addRow', xyz: [1, 2, 3]}]).experiments[1].locations, ['1,2,3']);
});

test('row limit: 5000 rows', () => {
  const list = [{id: 1, locations: Array.from({length: 4999}, () => '0,0,0')}];
  assert.strictEqual(apply(list, 1, [{op: 'addRow', xyz: [1, 1, 1]}]).experiments[0].locations.length, 5000);
  const full = [{id: 1, locations: Array.from({length: 5000}, () => '1,2,3')}];
  code(() => apply(full, 1, [{op: 'addRow', xyz: [1, 1, 1]}]), 142, /5000/);
  assert.strictEqual(apply(full, 1, [{op: 'deleteRow', index: 0}]).experiments[0].locations.length, 4999);
  const text = Array.from({length: 5001}, () => '1,2,3').join('\n');
  code(() => apply(full, 1, [{op: 'replaceFromText', text}]), 142, /5000/);
  assert.strictEqual(apply(full, 1, [{op: 'replaceFromText', text: text.split('\n').slice(0, 5000).join('\n')}]).changed.length, 0, 'same content is a no-op');
});

test('deleteRow: first, middle, last, down to empty, out of range', () => {
  const del = (i, list) => apply(list || EXPS(), 1, [{op: 'deleteRow', index: i}]).experiments[0].locations;
  assert.deepStrictEqual(del(0), ['4,5,6', '7,8,9,0.5']);
  assert.deepStrictEqual(del(1), ['1,2,3', '7,8,9,0.5']);
  assert.deepStrictEqual(del(2), ['1,2,3', '4,5,6']);
  code(() => del(3), 142, /out of range/);
  const r = apply([{id: 1, title: 'a', locations: ['1,2,3'], tags: []}], 1, [{op: 'deleteRow', index: 0}]);
  assert.deepStrictEqual(r.experiments[0].locations, []);
  code(() => apply([{id: 1, locations: []}], 1, [{op: 'deleteRow', index: 0}]), 142);
});

test('split in the middle: new experiment after, id = max + 1, no tags, same title/caption', () => {
  const r = apply(EXPS(), 1, [{op: 'split', index: 1}]);
  assert.deepStrictEqual(r.experiments.map((e) => e.id), [1, 6, 5]);
  assert.deepStrictEqual(r.experiments[0].locations, ['1,2,3']);
  assert.deepStrictEqual(r.experiments[1], {id: 6, title: 't1', caption: 'c1', locations: ['4,5,6', '7,8,9,0.5'], tags: []});
  assert.deepStrictEqual(r.experiments[0].tags, EXPS()[0].tags);
  assert.deepStrictEqual(r.experiments[0].markBadTable, {ok: 1, bad: 0});
  assert.deepStrictEqual(r.changed.map((e) => e.id), [1, 6], 'both halves, in order');
  assert.deepStrictEqual(r.before.map((e) => e.id), [1], 'the new half has no before-image');
  assert.strictEqual(r.before[0].locations.length, 3);
});

test('split at the first row and at the last row', () => {
  const first = apply(EXPS(), 1, [{op: 'split', index: 0}]);
  assert.deepStrictEqual(first.experiments[0].locations, []);
  assert.strictEqual(first.experiments[1].locations.length, 3);
  const last = apply(EXPS(), 1, [{op: 'split', index: 2}]);
  assert.deepStrictEqual(last.experiments[0].locations, ['1,2,3', '4,5,6']);
  assert.deepStrictEqual(last.experiments[1].locations, ['7,8,9,0.5']);
  code(() => apply(EXPS(), 1, [{op: 'split', index: 3}]), 142, /out of range/);
  code(() => apply([{id: 1, locations: []}], 1, [{op: 'split', index: 0}]), 142);
});

test('split of the last experiment, and of one with a non-numeric max id', () => {
  const r = apply(EXPS(), 5, [{op: 'split', index: 0}]);
  assert.deepStrictEqual(r.experiments.map((e) => e.id), [1, 5, 6]);
  const odd = [{id: 'x', locations: ['1,1,1']}, {id: 2, locations: ['1,1,1']}];
  assert.strictEqual(apply(odd, 2, [{op: 'split', index: 0}]).experiments[2].id, 3);
});

test('split twice in one call, and ops after a split act on the original', () => {
  const r = apply(EXPS(), 1, [{op: 'split', index: 2}, {op: 'split', index: 1}, {op: 'setTitle', text: 'X'}]);
  assert.deepStrictEqual(r.experiments.map((e) => e.id), [1, 7, 6, 5]);
  assert.deepStrictEqual(r.experiments[0].locations, ['1,2,3']);
  assert.deepStrictEqual(r.experiments[1].locations, ['4,5,6'], 'the second split is inserted right after the original');
  assert.deepStrictEqual(r.experiments[2].locations, ['7,8,9,0.5']);
  assert.strictEqual(r.experiments[0].title, 'X');
  assert.strictEqual(r.experiments[1].title, 't1');
  assert.deepStrictEqual(r.changed.map((e) => e.id), [1, 7, 6]);
});

test('replaceFromText replaces all rows and nothing else', () => {
  const r = apply(EXPS(), 1, [{op: 'replaceFromText', text: '10,20,30\nbad\n-1 -2 -3'}]);
  assert.deepStrictEqual(r.experiments[0].locations, ['10,20,30', '-1,-2,-3']);
  assert.strictEqual(r.experiments[0].title, 't1');
  code(() => apply(EXPS(), 1, [{op: 'replaceFromText', text: '999,0,0'}]), 142, /ops\[0\]\.text: line 1/);
  code(() => apply(EXPS(), 1, [{op: 'replaceFromText', text: 'nothing'}]), 142);
  code(() => apply(EXPS(), 1, [{op: 'replaceFromText', text: 5}]), 142);
});

test('ops are applied in order and all-or-nothing', () => {
  const list = EXPS();
  const r = apply(list, 1, [{op: 'deleteRow', index: 0}, {op: 'addRow', xyz: [9, 9, 9], index: 0}, {op: 'setTitle', text: 'z'}]);
  assert.deepStrictEqual(r.experiments[0].locations, ['9,9,9', '4,5,6', '7,8,9,0.5']);
  code(() => apply(list, 1, [{op: 'setTitle', text: 'z'}, {op: 'deleteRow', index: 9}]), 142, /ops\[1\]/);
  assert.strictEqual(list[0].title, 't1');
});

test('validateOps: shape, count, unknown ops and keys', () => {
  code(() => ops.validateOps(undefined), 142, /ops/);
  code(() => ops.validateOps('x'), 142);
  code(() => ops.validateOps({}), 142);
  code(() => ops.validateOps([]), 142, /between 1 and 200/);
  code(() => ops.validateOps(Array.from({length: 201}, () => ({op: 'setTitle', text: 'a'}))), 142);
  assert.strictEqual(ops.validateOps(Array.from({length: 200}, () => ({op: 'setTitle', text: 'a'}))).length, 200);
  code(() => ops.validateOps([null]), 142);
  code(() => ops.validateOps(['setTitle']), 142);
  code(() => ops.validateOps([[]]), 142);
  code(() => ops.validateOps([{op: 'drop'}]), 142, /ops\[0\]\.op/);
  code(() => ops.validateOps([{}]), 142);
  code(() => ops.validateOps([{op: 'setTitle', text: 'a', index: 1}]), 142, /unknown parameter/);
  code(() => ops.validateOps([{op: 'deleteRow', index: 0, xyz: [1, 2, 3]}]), 142);
  code(() => ops.validateOps([{op: '__proto__'}]), 142);
});

test('the experiment must exist', () => {
  code(() => apply(EXPS(), 99, [{op: 'setTitle', text: 'a'}]), 101);
  code(() => apply([], 1, [{op: 'setTitle', text: 'a'}]), 101);
  code(() => apply([null, {id: 1, locations: []}], 2, [{op: 'setTitle', text: 'a'}]), 101);
});

test('caps: 20 splits per call, 200 experiments per article, 1,000,000 characters of text per call', () => {
  const many = Array.from({length: 21}, () => ({op: 'split', index: 0}));
  const e = {id: 1, title: '', caption: '', locations: Array.from({length: 30}, (_, i) => `${i},0,0`), tags: []};
  code(() => apply([e], 1, many), 142, /at most 20 split/);
  assert.strictEqual(apply([e], 1, many.slice(0, 20).map((o, i) => ({op: 'split', index: 20 - i}))).experiments.length, 21);
  const full = Array.from({length: 199}, (_, i) => ({id: i + 1, title: '', locations: ['1,1,1', '2,2,2'], tags: []}));
  assert.strictEqual(apply(full, 1, [{op: 'split', index: 1}]).experiments.length, 200);
  const full200 = full.concat([{id: 200, title: '', locations: ['1,1,1', '2,2,2'], tags: []}]);
  code(() => apply(full200, 1, [{op: 'split', index: 1}]), 142, /at most 200 experiments/);
  const text = 'x,1,1 '.repeat(1).padEnd(400000, ' ');
  code(() => apply([e], 1, [{op: 'replaceFromText', text: '1,2,3'.padEnd(400000, ' ')}, {op: 'replaceFromText', text: '1,2,3'.padEnd(400000, ' ')},
    {op: 'replaceFromText', text: '1,2,3'.padEnd(400000, ' ')}]), 142, /1000000 characters/);
  assert.ok(text);
});
