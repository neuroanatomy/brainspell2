#!/usr/bin/env node
// Contract runner (QA): node test/contract/run.js [name filter]
// Starts the real server through a copy of the integration harness whose GitHub adapter uses the
// loose `==` of Parse's own adapter (helpers/). Same requirements as
// test/integration/README.md: Node 16, TEST_MONGO_URI) and runs the files *.test.js of this folder.
// Ports 18337/18080: do not run together with test/integration/run.js.

const fs = require('fs');
const path = require('path');
const {runAll} = require('../integration/helpers/mini');
const harness = require('./helpers/harness-loose');

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
      await ctx.stop();
    }
  }
  console.log(`\n${result.pass} passed, ${result.fail} failed`);
  process.exit(result.fail ? 1 : 0);
})();
