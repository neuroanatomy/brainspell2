// Integration test of scripts/repair-encoding.js against a throwaway MongoDB (default port 27117,
// override with REPAIR_TEST_MONGO_URI = server URL without database). Skipped when unreachable.
// Run:  node --test test/repair/

const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const {execFile} = require('child_process');

const base = (process.env.REPAIR_TEST_MONGO_URI || 'mongodb://127.0.0.1:27117').replace(/\/+$/, '');
const dbName = `repair_it_${crypto.randomBytes(4).toString('hex')}`;
const script = path.join(__dirname, '..', '..', 'scripts', 'repair-encoding.js');
const garble = (s) => Buffer.from(s, 'utf8').toString('latin1');

const DOCS = () => [
  {_id: 'a1', PMID: '1001', Title: 'A study', Authors: garble('Müller, Köster; Peppé'), Abstract: garble('Don’t panic — naïve'), Reference: garble('J Neurosci 2001'),
    Experiments: [
      {id: 1, title: garble('Tâche'), caption: 'clean caption', locations: ['1,2,3'], tags: [{name: garble('mémoire'), ontology: 'cognitive', agree: 1, disagree: 0}, {name: 'attention'}]},
      {id: 2, title: 'ok', caption: garble('Ångström'), locations: [], tags: []}
    ], Metadata: {meshHeadings: [{name: garble('Cérebro'), majorTopic: true}, {name: 'Humans'}], space: garble('MNI é')}, _created_at: new Date(1e12), _updated_at: new Date(1e12)},
  {_id: 'a2', PMID: '1002', Title: 'Genuine Müller and naïve', Authors: 'Ali-Chérif', Abstract: 'Ångström 東京 😀', Reference: 'ok', Experiments: [], Metadata: {meshHeadings: []}},
  {_id: 'a3', PMID: '1003', Title: 'MÃ¼ller and Москва', Authors: garble('Müller') + ' and Müller', Abstract: 'trunc MÃ', Reference: 'x', Experiments: [], Metadata: {}},
  {_id: 'a4', PMID: '1004', Title: garble('Smile 😀'), Authors: 'x', Abstract: 'He said \\\'naïve\\\' and \\"x\\"', Reference: 'y', Experiments: 'not an array', Metadata: null},
  {_id: 'a6', PMID: '1006', Title: garble('Müller') + " O\\'Neil <or= 3  ", Authors: '  Smith J  ', Abstract: 'p <or= 0.05 and d >or= 2, "\\"I know\\" to novel"',
    Reference: garble('Müller RC,   ') + "(2007) Neuroimage O\\'Neil  ", Experiments: [], Metadata: {}},
  {_id: 'a7', PMID: '1007', Title: 'fMRI)\\\\magnetoencephalography', Authors: 'x', Abstract: 'ambiguous \\\\\' kept', Reference: '()', Experiments: [], Metadata: {}},
  {_id: 'a5', NIDM: true, Title: garble('NIDM é'), weird: {nested: [garble('é'), 5, null, {deep: garble('ü')}]}, Authors: undefined}
];

let mongo;
let client;
let coll;
let tmp;
let reachable = false;
let solr;

function run(args, env) {
  return new Promise((resolve) => {
    execFile(process.execPath, [script].concat(args), {
      env: Object.assign({}, process.env, {REPAIR_MONGO_URI: `${base}/${dbName}`}, env)
    }, (err, stdout, stderr) => resolve({code: err ? err.code : 0, stdout, stderr}));
  });
}

let initPromise = null;
function ready() {
  if (!initPromise) {
    initPromise = init();
  }

  return initPromise;
}

async function init() {
  try {
    const {MongoClient} = require('mongodb');
    client = await MongoClient.connect(base, {useUnifiedTopology: true, serverSelectionTimeoutMS: 2000});
    reachable = true;
    coll = client.db(dbName).collection('Articles');
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'repair-'));
    const calls = [];
    solr = {calls, fail: false};
    solr.server = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        calls.push({url: req.url, body: JSON.parse(Buffer.concat(chunks).toString('utf8'))});
        res.writeHead(solr.fail ? 500 : 200, {'content-type': 'application/json'});
        res.end(solr.fail ? '{}' : '{"responseHeader":{"status":0}}');
      });
    });
    await new Promise((r) => solr.server.listen(0, '127.0.0.1', r));
    solr.url = `http://127.0.0.1:${solr.server.address().port}/solr/x/update?commit=true`;
  } catch (e) {
    reachable = false;
  }
}

// hooks are not reliable across Node 16 minor versions: initialise lazily, clean up in the last test
let cleaned = false;
async function cleanup() {
  if (cleaned || !initPromise) {
    return;
  }
  cleaned = true;
  if (client) {
    try {
      await client.db(dbName).dropDatabase();
    } finally {
      await client.close();
    }
  }
  if (solr && solr.server) {
    await new Promise((r) => solr.server.close(r));
  }
  if (tmp) {
    fs.rmSync(tmp, {recursive: true, force: true});
  }
}
process.on('exit', () => {
  if (tmp && !cleaned) {
    fs.rmSync(tmp, {recursive: true, force: true});
  }
});

const snapshot = async () => JSON.stringify(await coll.find({}).sort({_id: 1}).toArray());

test('dry run (default) changes nothing and reports', async (t) => {
  await ready();
  if (!reachable) {
    return t.skip('no MongoDB');
  }
  await coll.insertMany(DOCS());
  const before = await snapshot();
  const r = await run([]);
  assert.strictEqual(r.code, 0, r.stderr);
  if (process.env.REPAIR_TEST_VERBOSE) {
    console.log(r.stdout);
  }
  assert.strictEqual(await snapshot(), before);
  assert.match(r.stdout, /mode: dry-run/);
  assert.match(r.stdout, /Authors\s+1\s+0\s+0\s+1\s+2\s+6\n/);
  assert.match(r.stdout, /TOTAL\s+10\s+5\s+2\s+3\s+14\n/);
  assert.match(r.stdout, /documents that would change: 5/);
  assert.match(r.stdout, /strings that would change:\s+14/);
  assert.match(r.stdout, /PMID 1001 Authors/);
  assert.match(r.stdout, /before: .*MÃ¼ller/);
  assert.match(r.stdout, /after : .*Müller/);
  assert.match(r.stdout, /samples, slashes/);
  assert.match(r.stdout, /ambiguous backslash layouts SKIPPED .*: 1 strings in 1 documents/);
  assert.match(r.stdout, /empty references "\(\)" \(left as they are\): 1/);
  assert.match(r.stdout, /other string fields with mojibake \(not scanned, not touched\):[\s\S]*weird\.nested\[\]: 1[\s\S]*weird\.nested\[\]\.deep: 1/);
  assert.match(r.stdout, /Dry run: nothing was written/);
  assert.ok(!r.stdout.includes(base));
  const explicit = await run(['--dry-run']);
  assert.strictEqual(explicit.code, 0);
  assert.strictEqual(await snapshot(), before);
});

test('apply refuses without an audit file; refuses to overwrite one', async (t) => {
  await ready();
  if (!reachable) {
    return t.skip('no MongoDB');
  }
  const before = await snapshot();
  const r = await run(['--apply']);
  assert.notStrictEqual(r.code, 0);
  assert.match(r.stderr, /--audit-file/);
  const existing = path.join(tmp, 'existing.jsonl');
  fs.writeFileSync(existing, 'old\n');
  const r2 = await run(['--apply', '--audit-file', existing, '--no-solr']);
  assert.notStrictEqual(r2.code, 0);
  assert.strictEqual(fs.readFileSync(existing, 'utf8'), 'old\n');
  assert.strictEqual(await snapshot(), before);
  assert.notStrictEqual((await run(['--apply', '--dry-run', '--audit-file', path.join(tmp, 'x')])).code, 0);
});

let original;
let audit;

test('apply fixes exactly the expected fields, writes the audit file first, posts Solr', async (t) => {
  await ready();
  if (!reachable) {
    return t.skip('no MongoDB');
  }
  original = await coll.find({}).sort({_id: 1}).toArray(); // _id order: a1 a2 a3 a4 a5 a6 a7
  audit = path.join(tmp, 'audit.jsonl');
  const r = await run(['--apply', '--audit-file', audit], {REPAIR_SOLR_UPDATE_URL: solr.url});
  assert.strictEqual(r.code, 0, r.stdout + r.stderr);
  const a1 = await coll.findOne({_id: 'a1'});
  assert.strictEqual(a1.Authors, 'Müller, Köster; Peppé');
  assert.strictEqual(a1.Abstract, 'Don’t panic — naïve');
  assert.strictEqual(a1.Reference, 'J Neurosci 2001');
  assert.strictEqual(a1.Experiments[0].title, 'Tâche');
  assert.strictEqual(a1.Experiments[0].caption, 'clean caption');
  assert.strictEqual(a1.Experiments[0].tags[0].name, 'mémoire');
  assert.strictEqual(a1.Experiments[0].tags[0].agree, 1);
  assert.strictEqual(a1.Experiments[1].caption, 'Ångström');
  assert.strictEqual(a1.Metadata.meshHeadings[0].name, 'Cérebro');
  assert.strictEqual(a1.Metadata.meshHeadings[0].majorTopic, true);
  assert.strictEqual(a1.Metadata.space, garble('MNI é'), 'unscanned field untouched');
  assert.ok(a1._updated_at.getTime() > 1e12 + 1000, '_updated_at moved');
  assert.strictEqual(a1._created_at.getTime(), 1e12);
  const a2 = await coll.findOne({_id: 'a2'});
  assert.deepStrictEqual(a2, original[1], 'a correct document is untouched, byte for byte');
  const a3 = await coll.findOne({_id: 'a3'});
  assert.deepStrictEqual(a3, original[2], 'mixed / truncated stay unchanged');
  const a4 = await coll.findOne({_id: 'a4'});
  assert.strictEqual(a4.Title, 'Smile 😀');
  assert.strictEqual(a4.Abstract, 'He said \'naïve\' and "x"', 'stripslashes applied');
  const a6 = await coll.findOne({_id: 'a6'});
  assert.strictEqual(a6.Title, "Müller O'Neil ≤ 3");
  assert.strictEqual(a6.Authors, 'Smith J');
  assert.strictEqual(a6.Abstract, 'p ≤ 0.05 and d ≥ 2, ""I know" to novel"');
  assert.strictEqual(a6.Reference, "Müller RC (2007) Neuroimage O'Neil");
  const a7 = await coll.findOne({_id: 'a7'});
  assert.strictEqual(a7.Title, 'fMRI)\\magnetoencephalography');
  assert.strictEqual(a7.Abstract, original.find((d) => d._id === 'a7').Abstract, 'ambiguous layout left alone');
  assert.strictEqual(a7.Reference, '()');
  assert.strictEqual(a4.Experiments, 'not an array');
  assert.strictEqual(a4.Metadata, null);
  const a5 = await coll.findOne({_id: 'a5'});
  assert.strictEqual(a5.Title, 'NIDM é');
  assert.deepStrictEqual(a5.weird, original.find((d) => d._id === 'a5').weird, 'NIDM weird fields untouched');
  // audit
  const lines = fs.readFileSync(audit, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.strictEqual(lines.length, 14);
  assert.ok(Math.abs(Date.now() - Date.parse(lines[0].at)) < 120000);
  lines.forEach((l) => {
    assert.deepStrictEqual(Object.keys(l).sort(), ['after', 'applied', 'at', 'before', 'objectId', 'path', 'pmid']);
    assert.ok(Array.isArray(l.applied) && l.applied.length >= 1);
  });
  assert.ok(lines.some((l) => l.path === 'Experiments.0.tags.0.name' && l.before === garble('mémoire') && l.applied.join() === 'mojibake'));
  assert.deepStrictEqual(lines.find((l) => l.objectId === 'a6' && l.path === 'Reference').applied, ['mojibake', 'slashes', 'whitespace']);
  assert.deepStrictEqual(lines.find((l) => l.objectId === 'a6' && l.path === 'Abstract').applied, ['slashes', 'orequals']);
  // Solr: articles with Title/Authors/Abstract changes: a1, a3? (no), a4, a5
  const posted = [].concat(...solr.calls.map((c) => c.body));
  assert.deepStrictEqual(posted.map((d) => d.id).sort(), ['a1', 'a4', 'a5', 'a6', 'a7']);
  assert.strictEqual(posted.find((d) => d.id === 'a1').Authors, 'Müller, Köster; Peppé');
  assert.deepStrictEqual(Object.keys(posted[0]).sort().filter((k) => k !== 'Authors'), ['Abstract', 'Title', 'id'].filter((k) => k !== 'Authors' || true));
  assert.strictEqual(solr.calls[0].url, '/solr/x/update?commit=true');
});

test('apply twice changes nothing', async (t) => {
  await ready();
  if (!reachable) {
    return t.skip('no MongoDB');
  }
  const before = await snapshot();
  const second = path.join(tmp, 'audit2.jsonl');
  const callsBefore = solr.calls.length;
  const r = await run(['--apply', '--audit-file', second], {REPAIR_SOLR_UPDATE_URL: solr.url});
  assert.strictEqual(r.code, 0, r.stderr);
  assert.match(r.stdout, /Nothing to change/);
  assert.strictEqual(await snapshot(), before);
  assert.ok(!fs.existsSync(second));
  assert.strictEqual(solr.calls.length, callsBefore);
});

test('revert restores the original values exactly, only where the value is still the repaired one', async (t) => {
  await ready();
  if (!reachable) {
    return t.skip('no MongoDB');
  }
  // somebody edits one repaired field meanwhile
  await coll.updateOne({_id: 'a1'}, {$set: {Authors: 'edited by hand'}});
  const r = await run(['--revert', audit, '--no-solr']);
  assert.strictEqual(r.code, 0, r.stderr);
  assert.match(r.stdout, /fields restored: 13/);
  assert.match(r.stdout, /fields skipped .*: 1/);
  const now = await coll.find({}).sort({_id: 1}).toArray();
  const expected = JSON.parse(JSON.stringify(original));
  expected[0].Authors = 'edited by hand';
  const strip = (docs) => JSON.parse(JSON.stringify(docs.map((d) => {
    const c = Object.assign({}, d);
    delete c._updated_at;

    return c;
  })));
  assert.deepStrictEqual(strip(now), strip(expected));
  // apply again after a revert works (and is a fresh audit file)
  const again = path.join(tmp, 'audit3.jsonl');
  const r2 = await run(['--apply', '--audit-file', again, '--no-solr']);
  assert.strictEqual(r2.code, 0, r2.stderr);
  assert.strictEqual((await coll.findOne({_id: 'a1'})).Abstract, 'Don’t panic — naïve');
});

test('Solr failure keeps the Mongo change, exits non-zero, lists ids; --solr-only re-posts', async (t) => {
  await ready();
  if (!reachable) {
    return t.skip('no MongoDB');
  }
  await coll.deleteMany({});
  await coll.insertMany(DOCS());
  const audit4 = path.join(tmp, 'audit4.jsonl');
  solr.fail = true;
  const r = await run(['--apply', '--audit-file', audit4], {REPAIR_SOLR_UPDATE_URL: solr.url});
  assert.notStrictEqual(r.code, 0);
  assert.match(r.stdout, /Solr: FAILED for 5 articles/);
  assert.match(r.stdout, /a1/);
  assert.strictEqual((await coll.findOne({_id: 'a1'})).Authors, 'Müller, Köster; Peppé', 'Mongo change kept');
  solr.fail = false;
  const before = solr.calls.length;
  const r2 = await run(['--solr-only', '--audit-file', audit4], {REPAIR_SOLR_UPDATE_URL: solr.url});
  assert.strictEqual(r2.code, 0, r2.stdout + r2.stderr);
  const posted = [].concat(...solr.calls.slice(before).map((c) => c.body));
  assert.deepStrictEqual(posted.map((d) => d.id).sort(), ['a1', 'a4', 'a5', 'a6', 'a7']);
  assert.notStrictEqual((await run(['--solr-only'])).code, 0);
  // unreachable Solr: non-zero, and no credentials/URL in the output
  const r3 = await run(['--solr-only', '--audit-file', audit4], {REPAIR_SOLR_UPDATE_URL: 'http://127.0.0.1:1/secret-path/update'});
  assert.notStrictEqual(r3.code, 0);
  assert.ok(!r3.stdout.includes('secret-path'));
});

test('--only restricts the transforms (dry run and apply)', async (t) => {
  await ready();
  if (!reachable) {
    return t.skip('no MongoDB');
  }
  await coll.deleteMany({});
  await coll.insertMany(DOCS());
  const before = await snapshot();
  const dry = await run(['--only', 'slashes,orequals']);
  assert.strictEqual(dry.code, 0, dry.stderr);
  assert.match(dry.stdout, /transforms: slashes, orequals/);
  assert.match(dry.stdout, /TOTAL\s+0\s+5\s+2\s+0\s+/);
  assert.ok(!/samples, mojibake/.test(dry.stdout));
  assert.strictEqual(await snapshot(), before);
  const file = path.join(tmp, 'only.jsonl');
  const r = await run(['--apply', '--only', 'whitespace', '--audit-file', file, '--no-solr']);
  assert.strictEqual(r.code, 0, r.stderr);
  const a6 = await coll.findOne({_id: 'a6'});
  assert.strictEqual(a6.Authors, 'Smith J');
  assert.strictEqual(a6.Reference, garble('Müller RC ') + "(2007) Neuroimage O\\'Neil");
  assert.strictEqual(a6.Title, garble('Müller') + " O\\'Neil <or= 3", 'only whitespace changed');
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(lines.every((l) => l.applied.length === 1 && l.applied[0] === 'whitespace'));
  assert.notStrictEqual((await run(['--only', 'nonsense'])).code, 0);
  assert.notStrictEqual((await run(['--only'])).code, 0);
  // the other transforms can still be applied afterwards, in a second pass, and the result is stable
  const file2 = path.join(tmp, 'rest.jsonl');
  assert.strictEqual((await run(['--apply', '--audit-file', file2, '--no-solr'])).code, 0);
  const again = await run(['--apply', '--audit-file', path.join(tmp, 'rest2.jsonl'), '--no-solr']);
  assert.match(again.stdout, /Nothing to change/);
});

test('bad arguments and URI', async () => {
  await ready();
  const r = await run(['--nonsense']);
  assert.notStrictEqual(r.code, 0);
  const r2 = await run(['--revert']);
  assert.notStrictEqual(r2.code, 0);
  const r3 = await run([], {REPAIR_MONGO_URI: 'mongodb://user:pa55word@127.0.0.1:1/parse?serverSelectionTimeoutMS=500'});
  assert.notStrictEqual(r3.code, 0);
  assert.ok(!(r3.stdout + r3.stderr).includes('pa55word'));
});

test('cleanup (drops the throwaway database)', async () => {
  await cleanup();
});
