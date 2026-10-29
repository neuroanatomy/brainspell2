#!/usr/bin/env node
'use strict';
// Idempotent import of server/data/ontologies.json into the Parse class Concept (REST API).
// Environment (never arguments, never printed):
//   PARSE_URL          e.g. http://localhost:1337/parse (PARSE_SERVER_URL is accepted as an alias)
//   PARSE_APP_ID
//   PARSE_MASTER_KEY
// Usage: node import-ontologies.js [--dry-run]
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { URL } = require('url');

const BATCH = 50;

// UNVERIFIED: the templates carry no Cognitive Atlas ids, so this is a search URL.
function urlFor(ontology, name) {
  if (ontology === 'cognitive' || ontology === 'tasks') {
    return 'https://www.cognitiveatlas.org/search?q=' + encodeURIComponent(name);
  }
  return ''; // BrainMap: no known URL scheme
}

function buildRecord(term) {
  return {
    name: term.name,
    ontology: term.ontology,
    definition: typeof term.definition === 'string' ? term.definition : '',
    url: term.url || urlFor(term.ontology, term.name),
    parent: term.parent || ''
  };
}

const keyOf = (o, n) => o + '\u0000' + n;

// existing: array of Concept rows ({objectId, name, ontology, definition, url, parent}).
// Returns {creates: [record], updates: [{objectId, fields}], unchanged: n}.
// A definition already stored is never overwritten with an empty one.
function plan(terms, existing) {
  const byKey = new Map();
  existing.forEach((r) => { if (!byKey.has(keyOf(r.ontology, r.name))) { byKey.set(keyOf(r.ontology, r.name), r); } });
  const creates = [];
  const updates = [];
  let unchanged = 0;
  const seen = new Set();
  for (const t of terms) {
    const rec = buildRecord(t);
    const k = keyOf(rec.ontology, rec.name);
    if (seen.has(k)) { continue; }
    seen.add(k);
    const ex = byKey.get(k);
    if (!ex) { creates.push(rec); continue; }
    const fields = {};
    if ((ex.parent || '') !== rec.parent) { fields.parent = rec.parent; }
    if ((ex.url || '') !== rec.url) { fields.url = rec.url; }
    if (rec.definition && (ex.definition || '') !== rec.definition) { fields.definition = rec.definition; }
    if (Object.keys(fields).length) { updates.push({ objectId: ex.objectId, fields }); } else { unchanged++; }
  }
  return { creates, updates, unchanged };
}

function realHttp(baseUrl, headers) {
  const base = new URL(baseUrl.replace(/\/+$/, '') + '/');
  const lib = base.protocol === 'https:' ? https : http;
  return function request(method, apiPath, body) {
    return new Promise((resolve, reject) => {
      const u = new URL(apiPath.replace(/^\//, ''), base);
      const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
      const h = Object.assign({}, headers);
      if (data) { h['Content-Type'] = 'application/json'; h['Content-Length'] = data.length; }
      const req = lib.request(u, { method, headers: h }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode < 200 || res.statusCode >= 300) {
            return reject(new Error('HTTP ' + res.statusCode + ' on ' + method + ' ' + u.pathname));
          }
          try { resolve(text ? JSON.parse(text) : {}); } catch (e) { reject(new Error('bad JSON from server')); }
        });
      });
      req.on('error', (e) => reject(new Error('request failed: ' + e.code)));
      if (data) { req.write(data); }
      req.end();
    });
  };
}

// request(method, path, body) -> parsed JSON. path is relative to the server URL ("classes/Concept").
async function fetchExisting(request) {
  const rows = [];
  let last = null;
  for (;;) {
    const where = last ? { objectId: { $gt: last } } : {};
    const qs = 'limit=1000&order=objectId&where=' + encodeURIComponent(JSON.stringify(where));
    const res = await request('GET', 'classes/Concept?' + qs);
    const results = res.results || [];
    rows.push(...results);
    if (results.length < 1000) { break; }
    last = results[results.length - 1].objectId;
  }
  return rows;
}

async function sendBatches(request, reqs) {
  let done = 0;
  for (let i = 0; i < reqs.length; i += BATCH) {
    const chunk = reqs.slice(i, i + BATCH);
    const res = await request('POST', 'batch', { requests: chunk });
    (Array.isArray(res) ? res : []).forEach((r) => { if (r && r.error) { throw new Error('batch item failed: ' + r.error.code); } });
    done += chunk.length;
  }
  return done;
}

async function run(terms, request, opts) {
  const dry = !!(opts && opts.dryRun);
  const existing = dry && !request ? [] : await fetchExisting(request);
  const p = plan(terms, existing);
  const summary = { creates: p.creates.length, updates: p.updates.length, unchanged: p.unchanged, dryRun: dry };
  if (dry) { return summary; }
  const mount = (opts && opts.mountPath) || '/parse';
  const reqs = [];
  p.creates.forEach((r) => reqs.push({ method: 'POST', path: mount + '/classes/Concept', body: r }));
  p.updates.forEach((u) => reqs.push({ method: 'PUT', path: mount + '/classes/Concept/' + u.objectId, body: u.fields }));
  await sendBatches(request, reqs);
  return summary;
}

function loadTerms(file) {
  const terms = JSON.parse(fs.readFileSync(file || path.join(__dirname, '..', 'data', 'ontologies.json'), 'utf8'));
  if (!Array.isArray(terms)) { throw new Error('ontologies.json must be an array'); }
  return terms;
}

async function main(argv, env) {
  const dry = argv.includes('--dry-run');
  const unknown = argv.filter((a) => a !== '--dry-run');
  if (unknown.length) { throw new Error('unknown arguments (only --dry-run is accepted)'); }
  const terms = loadTerms();
  const counts = {};
  terms.forEach((t) => { counts[t.ontology] = (counts[t.ontology] || 0) + 1; });
  console.log('terms in file:', JSON.stringify(counts));
  if (dry) {
    // Dry run: no network at all; everything counts as a create.
    console.log('dry run, nothing sent:', JSON.stringify(await run(terms, null, { dryRun: true })));
    return;
  }
  const serverUrl = env.PARSE_URL || env.PARSE_SERVER_URL;
  const missing = [serverUrl ? null : 'PARSE_URL', env.PARSE_APP_ID ? null : 'PARSE_APP_ID', env.PARSE_MASTER_KEY ? null : 'PARSE_MASTER_KEY'].filter(Boolean);
  if (missing.length) { throw new Error('missing environment variables: ' + missing.join(', ')); }
  const request = realHttp(serverUrl, {
    'X-Parse-Application-Id': env.PARSE_APP_ID,
    'X-Parse-Master-Key': env.PARSE_MASTER_KEY
  });
  const mountPath = new URL(serverUrl).pathname.replace(/\/+$/, '');
  console.log('done:', JSON.stringify(await run(terms, request, { mountPath })));
  console.log('note: listConcepts keeps a one hour cache; restart pm2 (or wait one hour) to see the new terms.');
}

if (require.main === module) {
  main(process.argv.slice(2), process.env).catch((e) => { console.error('error:', e.message); process.exit(1); });
}

module.exports = { urlFor, buildRecord, plan, fetchExisting, sendBatches, run, loadTerms };
