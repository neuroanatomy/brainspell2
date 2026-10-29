// A very small test runner. The integration tests must run on Node 16.14 (the VM's
// version), where node:test does not exist, so they do not use it.

const tests = [];

function test(name, fn) {
  tests.push({name, fn});
}

function withTimeout(promise, ms, name) {
  let timer;
  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`timeout after ${ms} ms: ${name}`)), ms);
  });

  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Run all registered tests in order.
 * @param {Object} ctx Passed to every test
 * @param {string} [filter] Only run tests whose name contains this text
 * @returns {Promise<{pass: number, fail: number}>} Counts
 */
async function runAll(ctx, filter) {
  let pass = 0;
  let fail = 0;
  for (const t of tests) {
    if (filter && !t.name.includes(filter)) {
      continue;
    }
    try {
      await withTimeout(Promise.resolve().then(() => t.fn(ctx)), 120000, t.name);
      pass++;
      console.log(`ok     ${t.name}`);
    } catch (e) {
      fail++;
      console.log(`NOT OK ${t.name}\n       ${String(e && e.stack || e).split('\n').join('\n       ')}`);
    }
  }

  return {pass, fail};
}

module.exports = {test, runAll};
