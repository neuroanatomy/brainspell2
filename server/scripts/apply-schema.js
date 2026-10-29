#!/usr/bin/env node
// Apply server/schema.js (fields, indexes, class-level permissions) through the REST
// /schemas endpoint. Idempotent: only missing fields and indexes are sent; the CLP are
// always set to the full table.
//
//   PARSE_URL=http://localhost:1337/parse PARSE_APP_ID=... PARSE_MASTER_KEY=... \
//     node scripts/apply-schema.js
//   node scripts/apply-schema.js --dry-run     (no credentials needed, sends nothing)
//
// The credentials are read from the environment only and are never printed.

const {CLASSES, OPERATIONS} = require('../schema');

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Compare a wanted class with what the server has.
 * @param {Object} wanted An element of schema.CLASSES
 * @param {Object|null} existing Answer of GET /schemas/<class>, or null if the class does not exist
 * @returns {{exists: boolean, addFields: Object, addIndexes: Object, conflicts: string[]}} Differences
 */
function diff(wanted, existing) {
  const have = (existing && existing.fields) || {};
  const haveIdx = (existing && existing.indexes) || {};
  const addFields = {};
  const addIndexes = {};
  const conflicts = [];
  for (const [name, def] of Object.entries(wanted.fields)) {
    if (!have[name]) {
      addFields[name] = def;
    } else if (have[name].type !== def.type) {
      conflicts.push(`${wanted.className}.${name} is ${have[name].type}, expected ${def.type}`);
    }
  }
  for (const [name, keys] of Object.entries(wanted.indexes)) {
    const present = Object.keys(haveIdx).some((n) => n === name || same(haveIdx[n], keys));
    if (!present) {
      addIndexes[name] = keys;
    }
  }

  return {exists: Boolean(existing), addFields, addIndexes, conflicts};
}

function describe(c) {
  const lines = [`${c.className}`];
  for (const op of OPERATIONS) {
    lines.push(`  clp ${op.padEnd(9)} ${JSON.stringify(c.classLevelPermissions[op])}`);
  }
  for (const [n, def] of Object.entries(c.fields)) {
    lines.push(`  field ${n}: ${def.type}`);
  }
  for (const [n, keys] of Object.entries(c.indexes)) {
    lines.push(`  index ${n}: ${JSON.stringify(keys)}`);
  }

  return lines.join('\n');
}

async function apply(rest, log) {
  const failures = [];
  for (const c of CLASSES) {
    const got = await rest.request('GET', `/schemas/${c.className}`);
    let existing = null;
    if (got.status === 200 && got.json) {
      existing = got.json;
    } else if (!(got.status === 404 || (got.json && got.json.code === 103))) {
      failures.push(`${c.className}: GET /schemas answered ${got.status}`);
      continue;
    }
    const d = diff(c, existing);
    if (d.conflicts.length) {
      failures.push(...d.conflicts);
      continue;
    }
    let res;
    if (!d.exists) {
      res = await rest.request('POST', `/schemas/${c.className}`, {
        className: c.className,
        fields: c.fields,
        indexes: c.indexes,
        classLevelPermissions: c.classLevelPermissions
      });
    } else {
      if (Object.keys(d.addFields).length) {
        res = await rest.request('PUT', `/schemas/${c.className}`, {className: c.className, fields: d.addFields});
        if (res.status !== 200) {
          failures.push(`${c.className}: adding fields answered ${res.status}`);
          continue;
        }
      }
      const body = {className: c.className, classLevelPermissions: c.classLevelPermissions};
      if (Object.keys(d.addIndexes).length) {
        body.indexes = d.addIndexes;
      }
      res = await rest.request('PUT', `/schemas/${c.className}`, body);
    }
    if (res.status !== 200) {
      failures.push(`${c.className}: answered ${res.status}${res.json && res.json.error ? ` (${res.json.error})` : ''}`);
    } else {
      log(`${c.className}: ${d.exists ? 'updated' : 'created'}` +
        ` (+${Object.keys(d.addFields).length} fields, +${Object.keys(d.addIndexes).length} indexes)`);
    }
  }

  return failures;
}

async function main() {
  if (process.argv.includes('--dry-run') || process.env.DRY_RUN === '1') {
    console.log(CLASSES.map(describe).join('\n'));
    console.log('\nDry run: nothing was sent.');

    return 0;
  }
  const rest = require('../lib/rest');
  rest.config(); // fails early, naming the missing variables
  const failures = await apply(rest, (s) => console.log(s));
  if (failures.length) {
    console.error(`\nFAILED:\n  ${failures.join('\n  ')}`);

    return 1;
  }
  console.log('Schema applied.');

  return 0;
}

if (require.main === module) {
  main().then((code) => {
    process.exitCode = code;
  }, (e) => {
    console.error(e.message);
    process.exitCode = 1;
  });
}

module.exports = {diff, apply, describe};
