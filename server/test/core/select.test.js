const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {setup} = require('../helpers/env');

function solrStub() {
  const calls = [];
  const server = http.createServer((req, res) => {
    calls.push(new URL(req.url, 'http://x').searchParams);
    res.writeHead(200, {'content-type': 'application/json'});
    res.end(JSON.stringify({response: {numFound: 1, start: 0, maxScore: 1, docs: [{id: 'a', score: 1}]}}));
  });

  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    calls, url: `http://127.0.0.1:${server.address().port}/solr/brainspell/select`, close: () => new Promise((r) => server.close(r))
  })));
}

async function withSelect(fn) {
  const env = await setup({});
  const solr = await solrStub();
  process.env.SOLR_URL = solr.url;
  try {
    await fn(env, solr);
  } finally {
    delete process.env.SOLR_URL;
    await solr.close();
    await env.close();
  }
}

test('select: the query the client sends today still works, public', () => withSelect(async (env, solr) => {
  const res = await env.run('select', {q: 'memory', defType: 'edismax', qf: 'Abstract Title', fl: '* score', 'q.op': 'OR', start: 0, rows: 10});
  assert.strictEqual(res.numFound, 1);
  const p = solr.calls[0];
  assert.strictEqual(p.get('q'), 'memory');
  assert.strictEqual(p.get('rows'), '10');
  assert.strictEqual(p.get('defType'), 'edismax');
  await env.run('select', {q: 'memory', defType: 'edismax', qf: 'Abstract Title', fl: '* score', 'q.op': 'OR'});
  assert.strictEqual(solr.calls[1].get('rows'), null);
  await env.run('select', {q: 'memory'});
  assert.strictEqual(solr.calls[2].get('qf'), 'Abstract Title');
  await env.run('select', {q: 'memory', rows: 50, start: 100000});
}));

test('select: hardening', () => withSelect(async (env, solr) => {
  const bad = [
    {q: '{!func}1'}, {q: '  {!lucene}x'}, {q: 'a {!dismax qf=x}b'}, {q: 'x _query_:"{!func}1"'}, {q: 'x _QUERY_'}, {q: '${x}'},
    {q: ''}, {q: 5}, {q: undefined}, {q: 'a'.repeat(1001)},
    {q: 'x', rows: 51}, {q: 'x', rows: 1000}, {q: 'x', rows: -1}, {q: 'x', rows: '10'}, {q: 'x', rows: 1.5},
    {q: 'x', start: 100001}, {q: 'x', start: -1},
    {q: 'x', defType: 'lucene'}, {q: 'x', defType: 'func'}, {q: 'x', defType: '{!lucene}'},
    {q: 'x', qf: 'Authors^100 id'}, {q: 'x', qf: 'password'}, {q: 'x', fl: 'password'}, {q: 'x', fl: '*,score,[docid]'},
    {q: 'x', 'q.op': 'XOR'}, {q: 'x', wt: 'xml'}, {q: 'x', stream: {url: 'file:///etc/passwd'}}, {q: 'x', fq: '*:*'}, {q: 'x', shards: 'evil'},
    {q: 'x', url: 'http://evil'}
  ];
  for (const p of bad) {
    await assert.rejects(env.run('select', p), (e) => e.code === 142, JSON.stringify(p));
  }
  await assert.rejects(env.run('select', {}), (e) => e.code === 142);
  assert.strictEqual(solr.calls.length, 0);
}));

test('select: Solr failure is 1002', () => withSelect(async (env, solr) => {
  await solr.close();
  process.env.SOLR_URL = 'http://127.0.0.1:1/solr/x/select';
  await assert.rejects(env.run('select', {q: 'x'}), (e) => e.code === 1002);
  solr.close = async () => {};
}));

test('main.js loads every other .js file of its folder and nothing else', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cloudtest-'));
  try {
    fs.copyFileSync(path.join(__dirname, '..', '..', 'cloud', 'main.js'), path.join(dir, 'main.js'));
    fs.writeFileSync(path.join(dir, 'a.js'), 'global.__loaded = (global.__loaded || []).concat("a");');
    fs.writeFileSync(path.join(dir, 'b.js'), 'global.__loaded = (global.__loaded || []).concat("b");');
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'throw new Error("must not load");');
    fs.mkdirSync(path.join(dir, 'sub'));
    fs.writeFileSync(path.join(dir, 'sub', 'c.js'), 'global.__loaded = (global.__loaded || []).concat("c");');
    global.__loaded = [];
    require(path.join(dir, 'main.js'));
    assert.deepStrictEqual(global.__loaded, ['a', 'b']);
  } finally {
    delete global.__loaded;
    fs.rmSync(dir, {recursive: true, force: true});
  }
});
