'use strict';
const test = require('node:test');
const assert = require('node:assert');

// Minimal fake of the Parse cloud API.
const DB = [];
let finds = 0;
const defined = {};
class ParseError extends Error { constructor(code, message) { super(message); this.code = code; } }
class Query {
  constructor(cls) { this.cls = cls; this.f = []; this.s = 0; this.l = 100; }
  equalTo(k, v) { this.f.push([k, v]); }
  ascending(k) { this.k = k; }
  limit(n) { this.l = n; }
  skip(n) { this.s = n; }
  async find(opts) {
    assert.strictEqual(opts && opts.useMasterKey, true);
    finds++;
    let r = DB.filter((o) => this.f.every(([k, v]) => o[k] === v));
    if (this.k) { r = r.slice().sort((a, b) => (a[this.k] < b[this.k] ? -1 : 1)); }
    return r.slice(this.s, this.s + this.l).map((o) => ({ get: (k) => o[k] }));
  }
}
global.Parse = { Error: ParseError, Query, Cloud: { define: (n, f) => { defined[n] = f; } } };
const c = require('../../cloud/concepts.js');

function seed() {
  DB.length = 0;
  DB.push(
    { ontology: 'tasks', name: 'Stroop task', parent: '', definition: 'd', url: 'u' },
    { ontology: 'tasks', name: 'Flanker task', parent: '' },
    { ontology: 'cognitive', name: 'Attention', parent: 'Attention', definition: '', url: 'https://x' },
    { ontology: 'cognitive', name: 'Action', parent: 'Action' }
  );
  c.clearCache();
  finds = 0;
}
const call = (f, params) => f({ params });
const code = (p) => p.then(() => null, (e) => e.code);

test('functions are registered', () => {
  assert.strictEqual(defined.listConcepts, c.listConcepts);
  assert.strictEqual(defined.getConcept, c.getConcept);
});

test('listConcepts returns {name, parent} sorted, scoped to ontology', async () => {
  seed();
  assert.deepStrictEqual(await call(c.listConcepts, { ontology: 'tasks' }), [{ name: 'Flanker task', parent: null }, { name: 'Stroop task', parent: null }]);
  assert.deepStrictEqual(await call(c.listConcepts, { ontology: 'behavioural' }), []);
});

test('listConcepts validation -> 142', async () => {
  seed();
  for (const p of [{}, { ontology: 'x' }, { ontology: 5 }, { ontology: 'tasks', extra: 1 }, null]) {
    assert.strictEqual(await code(call(c.listConcepts, p)), 142, JSON.stringify(p));
  }
});

test('getConcept returns the record; match is normalised', async () => {
  seed();
  assert.deepStrictEqual(await call(c.getConcept, { name: '  stroop   TASK ', ontology: 'tasks' }), { name: 'Stroop task', ontology: 'tasks', definition: 'd', url: 'u' });
  assert.deepStrictEqual(await call(c.getConcept, { name: 'Action', ontology: 'cognitive' }), { name: 'Action', ontology: 'cognitive', definition: '', url: '' });
});

test('getConcept: not found -> 101, validation -> 142', async () => {
  seed();
  assert.strictEqual(await code(call(c.getConcept, { name: 'Nope', ontology: 'tasks' })), 101);
  assert.strictEqual(await code(call(c.getConcept, { name: 'Stroop task', ontology: 'cognitive' })), 101);
  const bads = [{ ontology: 'tasks' }, { name: 'a' }, { name: '', ontology: 'tasks' }, { name: '   ', ontology: 'tasks' },
    { name: 5, ontology: 'tasks' }, { name: 'a'.repeat(201), ontology: 'tasks' }, { name: 'a', ontology: 'zzz' }, { name: 'a', ontology: 'tasks', x: 1 }];
  for (const p of bads) { assert.strictEqual(await code(call(c.getConcept, p)), 142, JSON.stringify(p)); }
  assert.strictEqual(await code(call(c.getConcept, { name: 'a'.repeat(200), ontology: 'tasks' })), 101);
});

test('cache: one read per ontology for an hour, then refresh', async () => {
  seed();
  const real = Date.now;
  let now = real();
  Date.now = () => now;
  try {
    await call(c.listConcepts, { ontology: 'tasks' });
    await call(c.listConcepts, { ontology: 'tasks' });
    await call(c.getConcept, { name: 'Stroop task', ontology: 'tasks' });
    assert.strictEqual(finds, 1);
    await call(c.listConcepts, { ontology: 'cognitive' });
    assert.strictEqual(finds, 2);
    DB.push({ ontology: 'tasks', name: 'Zebra task' });
    now += c.CACHE_MS - 1;
    assert.strictEqual((await call(c.listConcepts, { ontology: 'tasks' })).length, 2);
    now += 2;
    assert.strictEqual((await call(c.listConcepts, { ontology: 'tasks' })).length, 3);
  } finally { Date.now = real; }
});

test('pagination past 1000 rows', async () => {
  seed();
  for (let i = 0; i < 1500; i++) { DB.push({ ontology: 'behavioural', name: 'n' + String(i).padStart(5, '0'), parent: '' }); }
  assert.strictEqual((await call(c.listConcepts, { ontology: 'behavioural' })).length, 1500);
});
