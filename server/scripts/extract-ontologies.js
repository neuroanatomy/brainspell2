#!/usr/bin/env node
'use strict';
// Extracts the ontology term lists from the original brainspell templates (as text only;
// nothing from the templates is executed).
// Usage: node extract-ontologies.js <cogatlas-cognitive.html> <brainmap-behavioural.html> <cogatlas-tasks.html> <out.json>
// The ontology of each file is decided by its position in the argument list.
//
// Template structure (verified in the templates' configureOntologyModal):
//  * cognitive:   {superClass:"1",name:G} is a heading (not a tag); the plain {name:T} items
//                 after it are tags, grouped under G. A term listed under several headings
//                 keeps the first heading.
//  * behavioural: {superClass:"1",name:D} is a tag named "D"; plain {name:S} is the tag
//                 "D:S"; {minorClass:"1",name:M} is the tag "D:S:M" (this is the tag name the
//                 original stored). parent = the name of the enclosing tag, or null.
//  * tasks:       a flat list; parent null (the initial-letter headings are not groups).
const fs = require('fs');

const ORDER = ['cognitive', 'behavioural', 'tasks'];

function parseClasses(html) {
  const m = /var\s+classes\s*=\s*new\s+Array\(([\s\S]*?)\);\s*(?:\r?\n|$)/.exec(html);
  if (!m) { throw new Error('classes array not found'); }
  const items = [];
  const objRe = /\{([^{}]*)\}/g;
  const pairRe = /([A-Za-z]+)\s*:\s*"((?:[^"\\]|\\.)*)"/g;
  let o;
  while ((o = objRe.exec(m[1])) !== null) {
    const item = {};
    let p;
    pairRe.lastIndex = 0;
    while ((p = pairRe.exec(o[1])) !== null) { item[p[1]] = JSON.parse('"' + p[2] + '"'); }
    if (typeof item.name !== 'string') { throw new Error('item without name: ' + o[0]); }
    items.push(item);
  }
  if (!items.length) { throw new Error('empty classes array'); }
  return items;
}

function clean(s) { return s.normalize('NFC').trim().replace(/\s+/g, ' '); }

function termsFor(ontology, items) {
  const out = [];
  if (ontology === 'cognitive') {
    let group = null;
    for (const it of items) {
      if (it.superClass === '1') { group = clean(it.name); continue; }
      out.push({ ontology, name: clean(it.name), parent: group });
    }
  } else if (ontology === 'behavioural') {
    let sup = '';
    let mid = '';
    for (const it of items) {
      const n = clean(it.name);
      if (it.superClass === '1') { sup = n; mid = ''; out.push({ ontology, name: n, parent: null }); }
      else if (it.minorClass === '1') { out.push({ ontology, name: sup + ':' + mid + ':' + n, parent: sup + ':' + mid }); }
      else { mid = n; out.push({ ontology, name: sup + ':' + n, parent: sup }); }
    }
  } else {
    for (const it of items) { out.push({ ontology, name: clean(it.name), parent: null }); }
  }
  return out;
}

function extract(htmlByOntology) {
  const seen = new Set();
  const all = [];
  for (const ontology of ORDER) {
    for (const t of termsFor(ontology, parseClasses(htmlByOntology[ontology]))) {
      if (!t.name) { continue; }
      const key = ontology + '\u0000' + t.name.toLowerCase();
      if (seen.has(key)) { continue; }
      seen.add(key);
      all.push(t);
    }
  }
  return all;
}

if (require.main === module) {
  const a = process.argv.slice(2);
  if (a.length !== 4) {
    console.error('usage: extract-ontologies.js <cognitive.html> <behavioural.html> <tasks.html> <out.json>');
    process.exit(2);
  }
  const terms = extract({
    cognitive: fs.readFileSync(a[0], 'utf8'),
    behavioural: fs.readFileSync(a[1], 'utf8'),
    tasks: fs.readFileSync(a[2], 'utf8')
  });
  fs.writeFileSync(a[3], JSON.stringify(terms, null, 1) + '\n');
  const c = {};
  terms.forEach((t) => { c[t.ontology] = (c[t.ontology] || 0) + 1; });
  console.log(JSON.stringify(c));
}

module.exports = { parseClasses, termsFor, extract, ORDER };
