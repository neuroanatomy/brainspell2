#!/usr/bin/env node
// Integration test runner:  node test/integration/run.js [name filter]
// See README.md. Needs Node 16, MongoDB, and a Parse Server 4.10.2 that starts.

const fs = require('fs');
const path = require('path');
const {runAll} = require('./helpers/mini');
const harness = require('./helpers/harness');

for (const f of fs.readdirSync(__dirname).filter((n) => n.endsWith('.test.js')).sort()) {
  require(path.join(__dirname, f));
}

(async () => {
  let ctx;
  let result = {pass: 0, fail: 1};
  try {
    ctx = await harness.start();
    result = await runAll(ctx, process.argv[2]);
  } catch (e) {
    console.log(`SETUP FAILED: ${e.message}`);
  } finally {
    if (ctx) {
      if (result.fail) {
        console.log(`\n--- server output (tail) ---\n${ctx.serverOutput()}`);
      }
      await ctx.stop();
    }
  }
  console.log(`\n${result.pass} passed, ${result.fail} failed`);
  process.exit(result.fail ? 1 : 0);
})();
