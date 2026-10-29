'use strict';
// Public cloud functions: listConcepts({ontology}) and getConcept({name, ontology}). See plan 4.3.
// Uses the global Parse object (as cloud code does). Reads with the master key.
// Load from cloud/main.js with: require('./concepts');

const ONTOLOGIES = ['cognitive', 'behavioural', 'tasks'];
const CACHE_MS = 60 * 60 * 1000;
const MAX_NAME = 200;
const cache = new Map(); // ontology -> {at, rows: [{name, parent, definition, url}], byNorm: Map}

function bad(msg) { return new Parse.Error(142, msg); }

function norm(s) { return s.normalize('NFC').trim().replace(/\s+/g, ' ').toLowerCase(); }

function checkParams(params, allowed) {
  if (params === null || typeof params !== 'object' || Array.isArray(params)) { throw bad('params must be an object'); }
  Object.keys(params).forEach((k) => { if (!allowed.includes(k)) { throw bad('unknown parameter: ' + k); } });
}

function checkOntology(v) {
  if (typeof v !== 'string' || !ONTOLOGIES.includes(v)) { throw bad('ontology must be one of ' + ONTOLOGIES.join(', ')); }
  return v;
}

function checkName(v) {
  if (typeof v !== 'string' || !v.trim().length || v.length > MAX_NAME) { throw bad('name must be a non-empty string of at most ' + MAX_NAME + ' characters'); }
  return v;
}

async function load(ontology) {
  const hit = cache.get(ontology);
  if (hit && Date.now() - hit.at < CACHE_MS) { return hit; }
  const rows = [];
  for (let skip = 0; ; skip += 1000) {
    const q = new Parse.Query('Concept');
    q.equalTo('ontology', ontology);
    q.ascending('name');
    q.limit(1000);
    q.skip(skip);
    const page = await q.find({ useMasterKey: true });
    page.forEach((o) => rows.push({
      name: o.get('name'),
      parent: o.get('parent') || null,
      definition: o.get('definition') || '',
      url: o.get('url') || ''
    }));
    if (page.length < 1000) { break; }
  }
  const entry = { at: Date.now(), rows, byNorm: new Map() };
  rows.forEach((r) => { const k = norm(r.name); if (!entry.byNorm.has(k)) { entry.byNorm.set(k, r); } });
  cache.set(ontology, entry);
  return entry;
}

async function listConcepts(req) {
  const params = req.params || {};
  checkParams(params, ['ontology']);
  const entry = await load(checkOntology(params.ontology));
  return entry.rows.map((r) => ({ name: r.name, parent: r.parent }));
}

async function getConcept(req) {
  const params = req.params || {};
  checkParams(params, ['name', 'ontology']);
  const ontology = checkOntology(params.ontology);
  const name = checkName(params.name);
  const entry = await load(ontology);
  const r = entry.byNorm.get(norm(name));
  if (!r) { throw new Parse.Error(101, 'concept not found'); }
  return { name: r.name, ontology, definition: r.definition, url: r.url };
}

function clearCache() { cache.clear(); }

if (typeof Parse !== 'undefined' && Parse.Cloud && Parse.Cloud.define) {
  Parse.Cloud.define('listConcepts', listConcepts);
  Parse.Cloud.define('getConcept', getConcept);
}

module.exports = { listConcepts, getConcept, clearCache, ONTOLOGIES, CACHE_MS };
