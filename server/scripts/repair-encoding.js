#!/usr/bin/env node
// Repair stored article text in the Articles collection, with four ordered transforms
// (lib/text-repair.js): mojibake ("MÃ¼ller" -> "Müller"), slashes (PHP stripslashes of \' \" \\),
// orequals ("<or=" -> "≤") and whitespace (references). Talks to MongoDB directly
// (REPAIR_MONGO_URI), not through Parse.
//
//   node scripts/repair-encoding.js                       dry run (default): reports, writes nothing
//   node scripts/repair-encoding.js --apply --audit-file audit.jsonl
//   node scripts/repair-encoding.js --revert audit.jsonl
//   node scripts/repair-encoding.js --solr-only --audit-file audit.jsonl
//   flags: --no-solr (skip the Solr update after --apply / --revert)
//          --only mojibake,slashes,orequals,whitespace   (default: all four)
//
// Environment: REPAIR_MONGO_URI (default mongodb://127.0.0.1:27017/parse),
//              REPAIR_SOLR_UPDATE_URL (default http://localhost:8983/solr/brainspell/update?commit=true).
// Run `mongodump` first. See docs/repair-encoding.md.

const fs = require('fs');
const http = require('http');
const https = require('https');
const {URL} = require('url');
const {fixMojibake} = require('../lib/mojibake');
const {repairText, slashesAmbiguous, TRANSFORMS, TOP} = require('../lib/text-repair');

const DEFAULT_MONGO = 'mongodb://127.0.0.1:27017/parse';
const DEFAULT_SOLR = 'http://localhost:8983/solr/brainspell/update?commit=true';
const COLLECTION = 'Articles';
const BATCH = 200;
const SAMPLES = 12;
const SCANNED = [
  'Title', 'Authors', 'Abstract', 'Reference',
  'Experiments[].title', 'Experiments[].caption', 'Experiments[].tags[].name', 'Metadata.meshHeadings[].name'
];
const SOLR_FIELDS = ['Title', 'Authors', 'Abstract'];

const idLabel = (doc) => (doc.PMID === undefined || doc.PMID === null ? `id:${doc._id}` : doc.PMID);
const patternOf = (path) => path.replace(/\.\d+(?=\.|$)/g, '[]');
const isPlain = (v) => v !== null && typeof v === 'object' && (Array.isArray(v) || Object.getPrototypeOf(v) === Object.prototype);

/**
 * Walk a document and yield every string with its dot path (array indexes as .N).
 * Parse's own bookkeeping fields (_id, _created_at, _acl ...) are skipped.
 * @param {any} value Value
 * @param {string} path Path so far
 * @param {function(string, string): void} visit Called with (path, string)
 * @param {number} depth Depth guard
 * @returns {void}
 */
function walk(value, path, visit, depth) {
  if (typeof value === 'string') {
    visit(path, value);
  } else if (depth < 10 && isPlain(value)) {
    Object.keys(value).forEach((k) => {
      if (!path && k.charAt(0) === '_') {
        return;
      }
      walk(value[k], path ? `${path}.${k}` : k, visit, depth + 1);
    });
  }
}

function window40(text, at) {
  const start = Math.max(0, at - 20);

  return (start > 0 ? '…' : '') + text.slice(start, at + 20) + (at + 20 < text.length ? '…' : '');
}

function firstDiff(a, b) {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) {
    i++;
  }

  return i;
}

function newStats() {
  const stats = {};
  SCANNED.forEach((p) => {
    stats[p] = {scanned: 0, changed: 0, mixed: 0, invalid: 0, byTransform: {}};
    TRANSFORMS.forEach((t) => {
      stats[p].byTransform[t] = 0;
    });
  });

  return stats;
}

function newExtra() {
  const samples = {};
  TRANSFORMS.forEach((t) => {
    samples[t] = [];
  });

  return {
    samples,
    unrepairable: [],
    ambiguousFields: 0, ambiguousDocs: new Set(), ambiguousSamples: [],
    remainingBackslash: 0, remainingSamples: [],
    emptyReferences: 0,
    otherFields: {}
  };
}

/**
 * Examine one document.
 * @param {Object} doc Raw MongoDB document
 * @param {Object} stats Per-pattern counters (updated)
 * @param {Object} extra Samples and notices (updated)
 * @param {string[]} transforms Selected transforms
 * @returns {Array<{path: string, before: string, after: string, applied: string[]}>} Changes to the scanned fields
 */
function scanDoc(doc, stats, extra, transforms) {
  const changes = [];
  walk(doc, '', (path, text) => {
    const pattern = patternOf(path);
    if (!SCANNED.includes(pattern)) {
      if (fixMojibake(text).changed) {
        extra.otherFields[pattern] = (extra.otherFields[pattern] || 0) + 1;
      }

      return;
    }
    const s = stats[pattern];
    s.scanned++;
    if (transforms.includes('mojibake')) {
      const m = fixMojibake(text);
      if (m.reason === 'mixed' || m.reason === 'invalid-utf8') {
        s[m.reason === 'mixed' ? 'mixed' : 'invalid']++;
        extra.unrepairable.push({pmid: idLabel(doc), path, reason: m.reason});
      }
    }
    if (TOP.includes(pattern) && transforms.includes('slashes') && slashesAmbiguous(text)) {
      extra.ambiguousFields++;
      extra.ambiguousDocs.add(String(doc._id));
      if (extra.ambiguousSamples.length < 5) {
        extra.ambiguousSamples.push({pmid: idLabel(doc), path, window: window40(text, Math.max(0, text.search(/\\/)))});
      }
    }
    const r = repairText(text, {transforms, field: pattern});
    if (r.text !== text) {
      s.changed++;
      r.steps.forEach((st) => {
        s.byTransform[st.name]++;
        if (extra.samples[st.name].length < SAMPLES) {
          extra.samples[st.name].push({pmid: idLabel(doc), path, before: st.before, after: st.after});
        }
      });
      changes.push({path, before: text, after: r.text, applied: r.applied});
    }
    if (r.text.indexOf('\\') !== -1 && TOP.includes(pattern)) {
      extra.remainingBackslash++;
      if (extra.remainingSamples.length < 5) {
        extra.remainingSamples.push({pmid: idLabel(doc), path, window: window40(r.text, r.text.indexOf('\\'))});
      }
    }
    if (pattern === 'Reference' && /^\(\s*\)$/.test(r.text)) {
      extra.emptyReferences++;
    }
  }, 0);

  return changes;
}

function sanitize(message, secrets) {
  let out = String(message);
  secrets.filter(Boolean).forEach((s) => {
    out = out.split(s).join('<hidden>');
  });

  return out;
}

function parseArgs(argv) {
  const opts = {mode: 'dry-run', audit: null, revert: null, noSolr: false, solrOnly: false, transforms: TRANSFORMS.slice()};
  const modes = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') {
      modes.push('dry-run');
    } else if (a === '--apply') {
      modes.push('apply');
    } else if (a === '--revert') {
      modes.push('revert');
      opts.revert = argv[++i];
    } else if (a === '--solr-only') {
      modes.push('solr-only');
      opts.solrOnly = true;
    } else if (a === '--audit-file') {
      opts.audit = argv[++i];
    } else if (a === '--only') {
      const list = String(argv[++i] || '').split(',').filter(Boolean);
      const bad = list.filter((t) => !TRANSFORMS.includes(t));
      if (!list.length || bad.length) {
        throw new Error(`--only takes a comma list of: ${TRANSFORMS.join(', ')}`);
      }
      opts.transforms = TRANSFORMS.filter((t) => list.includes(t));
    } else if (a === '--no-solr') {
      opts.noSolr = true;
    } else {
      throw new Error(`unknown argument: ${a}`);
    }
  }
  if (modes.length > 1) {
    throw new Error(`choose one mode, got: ${modes.join(', ')}`);
  }
  if (modes.length) {
    opts.mode = modes[0];
  }
  if (opts.mode === 'apply' && !opts.audit) {
    throw new Error('--apply requires --audit-file <path>');
  }
  if (opts.mode === 'solr-only' && !opts.audit) {
    throw new Error('--solr-only requires --audit-file <path>');
  }
  if (opts.mode === 'revert' && !opts.revert) {
    throw new Error('--revert requires the audit file path');
  }

  return opts;
}

function dbNameOf(uri) {
  const m = /^mongodb(?:\+srv)?:\/\/[^/]+\/([^?]*)/.exec(uri);
  if (!m || !m[1]) {
    throw new Error('REPAIR_MONGO_URI must contain a database name');
  }

  return decodeURIComponent(m[1]);
}

function readAudit(file) {
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim());
  return lines.map((l, i) => {
    let o;
    try {
      o = JSON.parse(l);
    } catch (e) {
      throw new Error(`audit file line ${i + 1} is not JSON`);
    }
    if (!o || typeof o.objectId !== 'string' || typeof o.path !== 'string' || typeof o.before !== 'string' || typeof o.after !== 'string') {
      throw new Error(`audit file line ${i + 1} is malformed`);
    }

    return o;
  });
}

function writeAudit(file, changes) {
  if (fs.existsSync(file) && fs.statSync(file).size > 0) {
    throw new Error('audit file already exists and is not empty; refusing to overwrite it');
  }
  const fd = fs.openSync(file, 'wx', 0o600);
  try {
    changes.forEach((c) => {
      fs.writeSync(fd, `${JSON.stringify(c)}\n`);
    });
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

// ---------------------------------------------------------------- Solr

function postJson(urlString, payload) {
  return new Promise((resolve, reject) => {
    let url;
    try {
      url = new URL(urlString);
    } catch (e) {
      reject(new Error('bad REPAIR_SOLR_UPDATE_URL'));

      return;
    }
    const lib = url.protocol === 'http:' ? http : https;
    const body = Buffer.from(JSON.stringify(payload));
    const req = lib.request(url, {
      method: 'POST', headers: {'Content-Type': 'application/json', 'Content-Length': body.length}, timeout: 60000
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({status: res.statusCode, body: Buffer.concat(chunks).toString('utf8')}));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function postOnce(url, docs) {
  try {
    const res = await postJson(url, docs);
    if (res.status < 200 || res.status > 299) {
      return false;
    }
    try {
      const j = JSON.parse(res.body);
      if (j && j.responseHeader && j.responseHeader.status !== undefined && j.responseHeader.status !== 0) {
        return false;
      }
    } catch (e) {
      // a 2xx answer that is not JSON is accepted
    }

    return true;
  } catch (e) {
    return false;
  }
}

async function postBatch(url, docs) {
  if (await postOnce(url, docs)) {
    return true;
  }
  await new Promise((r) => setTimeout(r, 500));

  return postOnce(url, docs);
}

/**
 * Post the current values of the given articles to Solr.
 * @param {Object} coll MongoDB collection
 * @param {string[]} ids Article _id values
 * @param {string} url Solr update URL
 * @param {function(string): void} log Logger
 * @returns {Promise<string[]>} ids that could not be posted
 */
async function solrPost(coll, ids, url, log) {
  const failed = [];
  for (let i = 0; i < ids.length; i += BATCH) {
    const chunk = ids.slice(i, i + BATCH);
    const rows = await coll.find({_id: {$in: chunk}}).project({Title: 1, Authors: 1, Abstract: 1}).toArray();
    const docs = rows.map((r) => ({id: String(r._id), Title: r.Title, Authors: r.Authors, Abstract: r.Abstract}));
    if (!(await postBatch(url, docs))) {
      failed.push(...chunk);
    }
  }
  log(`Solr: ${ids.length - failed.length} of ${ids.length} articles posted`);
  if (failed.length) {
    log(`Solr: FAILED for ${failed.length} articles. Re-post with --solr-only --audit-file <file>. ObjectIds:`);
    log(failed.join(' '));
  }

  return failed;
}

function solrIds(changes) {
  const set = new Set();
  changes.forEach((c) => {
    if (SOLR_FIELDS.includes(c.path)) {
      set.add(c.objectId);
    }
  });

  return Array.from(set);
}

// ---------------------------------------------------------------- modes

async function scanAll(coll, transforms) {
  const stats = newStats();
  const extra = newExtra();
  const changes = [];
  let docs = 0;
  const cursor = coll.find({});
  for await (const doc of cursor) {
    docs++;
    scanDoc(doc, stats, extra, transforms).forEach((c) => {
      changes.push({objectId: String(doc._id), pmid: doc.PMID === undefined ? null : doc.PMID, path: c.path, before: c.before, after: c.after, applied: c.applied});
    });
  }

  return {docs, stats, extra, changes};
}

function report(res, transforms, log) {
  const {docs, stats, extra, changes} = res;
  const pad = (v, n) => String(v).padStart(n);
  log(`documents scanned: ${docs}      transforms: ${transforms.join(', ')}`);
  log('');
  log('strings changed, by transform and field:');
  log(`${'field'.padEnd(30)}${TRANSFORMS.map((t) => pad(t, 11)).join('')}${pad('any', 8)}${pad('scanned', 9)}`);
  const totals = {};
  TRANSFORMS.forEach((t) => {
    totals[t] = 0;
  });
  SCANNED.forEach((p) => {
    const st = stats[p];
    TRANSFORMS.forEach((t) => {
      totals[t] += st.byTransform[t];
    });
    log(`${p.padEnd(30)}${TRANSFORMS.map((t) => pad(st.byTransform[t], 11)).join('')}${pad(st.changed, 8)}${pad(st.scanned, 9)}`);
  });
  log(`${'TOTAL'.padEnd(30)}${TRANSFORMS.map((t) => pad(totals[t], 11)).join('')}${pad(changes.length, 8)}`);
  log('');
  log(`documents that would change: ${new Set(changes.map((c) => c.objectId)).size}`);
  log(`strings that would change:   ${changes.length}`);
  TRANSFORMS.forEach((t) => {
    if (!transforms.includes(t)) {
      return;
    }
    log('');
    log(`samples, ${t} (first ${extra.samples[t].length} of ${totals[t]}):`);
    extra.samples[t].forEach((c) => {
      const at = firstDiff(c.before, c.after);
      log(`  PMID ${c.pmid} ${c.path}`);
      log(`    before: ${window40(c.before, at)}`);
      log(`    after : ${window40(c.after, at)}`);
    });
  });
  log('');
  if (transforms.includes('mojibake')) {
    const unrep = extra.unrepairable;
    log(`mojibake: garbled-looking but NOT repairable (left unchanged): ${unrep.length} strings`);
    log('  (mixed = garbled text mixed with genuine non-Latin-1 characters; invalid = not valid UTF-8)');
    unrep.slice(0, 5).forEach((u) => log(`  PMID ${u.pmid} ${u.path} (${u.reason})`));
    log('');
  }
  if (transforms.includes('slashes')) {
    log(`slashes: ambiguous backslash layouts SKIPPED (two or more backslashes before a quote, or three in a row): ${extra.ambiguousFields} strings in ${extra.ambiguousDocs.size} documents`);
    extra.ambiguousSamples.forEach((s) => log(`  PMID ${s.pmid} ${s.path}: ${s.window}`));
    log('');
  }
  log(`strings that still contain a backslash after the repair (top-level fields): ${extra.remainingBackslash}`);
  extra.remainingSamples.forEach((s) => log(`  PMID ${s.pmid} ${s.path}: ${s.window}`));
  if (transforms.includes('whitespace')) {
    log(`empty references "()" (left as they are): ${extra.emptyReferences}`);
  }
  const others = Object.keys(extra.otherFields);
  log('');
  log(`other string fields with mojibake (not scanned, not touched): ${others.length ? '' : 'none'}`);
  others.forEach((p) => log(`  ${p}: ${extra.otherFields[p]}`));
}

async function applyChanges(coll, changes, log) {
  const byDoc = new Map();
  changes.forEach((c) => {
    if (!byDoc.has(c.objectId)) {
      byDoc.set(c.objectId, []);
    }
    byDoc.get(c.objectId).push(c);
  });
  const ops = [];
  byDoc.forEach((list, id) => {
    const filter = {_id: id};
    const set = {_updated_at: new Date()};
    list.forEach((c) => {
      filter[c.path] = c.before;
      set[c.path] = c.after;
    });
    ops.push({updateOne: {filter, update: {$set: set}}});
  });
  let modified = 0;
  for (let i = 0; i < ops.length; i += BATCH) {
    const res = await coll.bulkWrite(ops.slice(i, i + BATCH), {ordered: false});
    modified += res.modifiedCount === undefined ? res.nModified : res.modifiedCount;
  }
  log(`documents updated: ${modified} of ${ops.length}`);
  if (modified < ops.length) {
    log(`${ops.length - modified} documents were skipped because their text changed since the scan; run --dry-run again.`);
  }

  return {modified, total: ops.length};
}

async function revertChanges(coll, entries, log) {
  const ops = entries.map((e) => ({updateOne: {
    filter: {_id: e.objectId, [e.path]: e.after},
    update: {$set: {[e.path]: e.before, _updated_at: new Date()}}
  }}));
  let modified = 0;
  for (let i = 0; i < ops.length; i += BATCH) {
    const res = await coll.bulkWrite(ops.slice(i, i + BATCH), {ordered: false});
    modified += res.modifiedCount === undefined ? res.nModified : res.modifiedCount;
  }
  log(`fields restored: ${modified}`);
  log(`fields skipped (current value is not the repaired one): ${ops.length - modified}`);

  return modified;
}

/**
 * Run the tool.
 * @param {string[]} argv Arguments
 * @param {Object} env Environment
 * @param {function(string): void} log Logger
 * @returns {Promise<number>} Exit code
 */
async function main(argv, env, log) {
  const opts = parseArgs(argv);
  const uri = env.REPAIR_MONGO_URI || DEFAULT_MONGO;
  const solrUrl = env.REPAIR_SOLR_UPDATE_URL || DEFAULT_SOLR;
  const dbName = dbNameOf(uri);
  const {MongoClient} = require('mongodb');
  const client = await MongoClient.connect(uri, {useUnifiedTopology: true, useNewUrlParser: true});
  const secrets = [uri, solrUrl];
  try {
    const coll = client.db(dbName).collection(COLLECTION);
    log(`database: ${dbName}   collection: ${COLLECTION}   mode: ${opts.mode}`);
    let exit = 0;

    if (opts.mode === 'dry-run') {
      report(await scanAll(coll, opts.transforms), opts.transforms, log);
      log('');
      log('Dry run: nothing was written.');

      return 0;
    }

    if (opts.mode === 'solr-only') {
      const ids = solrIds(readAudit(opts.audit));
      const failed = await solrPost(coll, ids, solrUrl, log);

      return failed.length ? 1 : 0;
    }

    let postIds = [];
    if (opts.mode === 'apply') {
      const res = await scanAll(coll, opts.transforms);
      report(res, opts.transforms, log);
      log('');
      if (!res.changes.length) {
        log('Nothing to change.');

        return 0;
      }
      writeAudit(opts.audit, res.changes.map((c) => Object.assign({}, c, {at: new Date().toISOString()})));
      log(`audit file written: ${res.changes.length} entries`);
      const done = await applyChanges(coll, res.changes, log);
      if (done.modified < done.total) {
        exit = 1;
      }
      postIds = solrIds(res.changes);
    } else {
      const entries = readAudit(opts.revert);
      await revertChanges(coll, entries, log);
      postIds = solrIds(entries);
    }

    if (opts.noSolr) {
      log('Solr update skipped (--no-solr).');
    } else if (postIds.length) {
      const failed = await solrPost(coll, postIds, solrUrl, log);
      if (failed.length) {
        exit = 1;
      }
    }

    return exit;
  } catch (e) {
    e.message = sanitize(e.message, secrets);
    throw e;
  } finally {
    await client.close();
  }
}

if (require.main === module) {
  main(process.argv.slice(2), process.env, (s) => console.log(s)).then((code) => {
    process.exitCode = code;
  }, (e) => {
    console.error(`error: ${sanitize(e.message, [process.env.REPAIR_MONGO_URI, process.env.REPAIR_SOLR_UPDATE_URL])}`);
    process.exitCode = 1;
  });
}

module.exports = {main, parseArgs, scanDoc, newStats, newExtra, patternOf, dbNameOf, SCANNED};
