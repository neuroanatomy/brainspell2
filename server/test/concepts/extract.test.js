'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const ex = require('../../scripts/extract-ontologies.js');

const fx = (n) => fs.readFileSync(path.join(__dirname, 'fixtures', n + '.html'), 'utf8');

test('cognitive: headings are groups, not terms', () => {
  const t = ex.termsFor('cognitive', ex.parseClasses(fx('cognitive')));
  assert.deepStrictEqual(t.map((x) => x.name), ['Action', 'Action Initiation', 'Adaptive Control', 'Attention', 'Attention Capacity']);
  assert.deepStrictEqual(t.map((x) => x.parent), ['Action', 'Action', 'Action', 'Attention', 'Attention']);
});

test('behavioural: composite names and parents', () => {
  const t = ex.termsFor('behavioural', ex.parseClasses(fx('behavioural')));
  const m = new Map(t.map((x) => [x.name, x.parent]));
  assert.strictEqual(m.get('Action'), null);
  assert.strictEqual(m.get('Action:Execution'), 'Action');
  assert.strictEqual(m.get('Action:Execution:Speech'), 'Action:Execution');
  assert.strictEqual(m.get('Cognition:Language:Speech'), 'Cognition:Language');
  assert.strictEqual(t.length, 17);
});

test('tasks: flat, parent null', () => {
  const t = ex.termsFor('tasks', ex.parseClasses(fx('tasks')));
  assert.strictEqual(t.length, 5);
  assert.ok(t.every((x) => x.parent === null));
  assert.strictEqual(t[0].name, 'Abstract/concrete judgment: bilingual');
});

test('extract: ordering by ontology, dedupe, stable', () => {
  const html = { cognitive: fx('cognitive'), behavioural: fx('behavioural'), tasks: fx('tasks') };
  const a = ex.extract(html);
  assert.deepStrictEqual(a, ex.extract(html));
  assert.deepStrictEqual([...new Set(a.map((x) => x.ontology))], ['cognitive', 'behavioural', 'tasks']);
  const dup = '<script>var classes=new Array({name:"A"},{name:"a"},{name:" A "});\n</script>';
  assert.strictEqual(ex.extract({ cognitive: dup, behavioural: dup, tasks: dup }).length, 3);
});

test('parseClasses rejects missing array', () => {
  assert.throws(() => ex.parseClasses('<html></html>'));
});

test('shipped data file is well formed and has no duplicates', () => {
  const d = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'data', 'ontologies.json'), 'utf8'));
  const seen = new Set();
  d.forEach((t) => {
    assert.deepStrictEqual(Object.keys(t), ['ontology', 'name', 'parent']);
    assert.ok(ex.ORDER.includes(t.ontology));
    assert.ok(t.name.length > 0 && t.name.length <= 200);
    const k = t.ontology + '|' + t.name.toLowerCase();
    assert.ok(!seen.has(k), k);
    seen.add(k);
  });
});
