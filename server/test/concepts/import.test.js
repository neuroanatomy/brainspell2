'use strict';
const test = require('node:test');
const assert = require('node:assert');
const imp = require('../../scripts/import-ontologies.js');

const terms = [
  { ontology: 'cognitive', name: 'Attention', parent: 'Attention' },
  { ontology: 'tasks', name: 'Stroop task', parent: null },
  { ontology: 'behavioural', name: 'Action', parent: null },
  { ontology: 'tasks', name: 'Stroop task', parent: null }
];

// Fake Parse REST server: GET classes/Concept, POST batch.
function fakeServer() {
  const rows = [];
  let n = 0;
  const calls = [];
  async function request(method, p, body) {
    calls.push(method + ' ' + p.split('?')[0]);
    if (method === 'GET') {
      const where = JSON.parse(decodeURIComponent(/where=([^&]*)/.exec(p)[1]));
      const gt = where.objectId && where.objectId.$gt;
      return { results: rows.filter((r) => !gt || r.objectId > gt).sort((a, b) => (a.objectId < b.objectId ? -1 : 1)).slice(0, 1000).map((r) => Object.assign({}, r)) };
    }
    assert.strictEqual(method, 'POST');
    assert.strictEqual(p, 'batch');
    assert.ok(body.requests.length <= 50);
    return body.requests.map((r) => {
      if (r.method === 'POST') { assert.strictEqual(r.path, '/parse/classes/Concept'); rows.push(Object.assign({ objectId: 'o' + String(++n).padStart(6, '0') }, r.body)); }
      else { const id = r.path.split('/').pop(); Object.assign(rows.find((x) => x.objectId === id), r.body); }
      return { success: {} };
    });
  }
  return { rows, calls, request };
}

test('buildRecord: empty definition, search url for Cognitive Atlas, none for BrainMap', () => {
  const r = imp.buildRecord(terms[1]);
  assert.deepStrictEqual(r, { name: 'Stroop task', ontology: 'tasks', definition: '', url: 'https://www.cognitiveatlas.org/search?q=Stroop%20task', parent: '' });
  assert.strictEqual(imp.buildRecord(terms[2]).url, '');
  assert.strictEqual(imp.buildRecord(terms[0]).parent, 'Attention');
});

test('plan: creates once per (ontology, name), updates only changes, keeps definitions', () => {
  const ex = [{ objectId: 'a', ontology: 'tasks', name: 'Stroop task', parent: 'x', url: imp.urlFor('tasks', 'Stroop task'), definition: 'kept' }];
  const p = imp.plan(terms, ex);
  assert.strictEqual(p.creates.length, 2);
  assert.deepStrictEqual(p.updates, [{ objectId: 'a', fields: { parent: '' } }]);
});

test('run twice: second run changes nothing; dry run sends nothing', async () => {
  const s = fakeServer();
  const dry = await imp.run(terms, s.request, { dryRun: true });
  assert.strictEqual(dry.creates, 3);
  assert.ok(!s.calls.some((c) => c.startsWith('POST')));
  assert.deepStrictEqual(await imp.run(terms, s.request, {}), { creates: 3, updates: 0, unchanged: 0, dryRun: false });
  assert.strictEqual(s.rows.length, 3);
  assert.deepStrictEqual(await imp.run(terms, s.request, {}), { creates: 0, updates: 0, unchanged: 3, dryRun: false });
  assert.strictEqual(s.rows.length, 3);
  // changed parent -> one update, no duplicate
  const t2 = terms.map((t) => (t.name === 'Action' ? Object.assign({}, t, { parent: 'Z' }) : t));
  assert.strictEqual((await imp.run(t2, s.request, {})).updates, 1);
  assert.strictEqual(s.rows.length, 3);
});

test('batches of at most 50 and pagination of existing rows', async () => {
  const s = fakeServer();
  const many = [];
  for (let i = 0; i < 1203; i++) { many.push({ ontology: 'tasks', name: 'T' + i, parent: null }); }
  await imp.run(many, s.request, {});
  assert.strictEqual(s.rows.length, 1203);
  assert.deepStrictEqual(await imp.run(many, s.request, {}), { creates: 0, updates: 0, unchanged: 1203, dryRun: false });
});

test('a failing batch item aborts', async () => {
  const request = async (m) => (m === 'GET' ? { results: [] } : [{ error: { code: 1, error: 'x' } }]);
  await assert.rejects(imp.run(terms, request, {}), /batch item failed/);
});
