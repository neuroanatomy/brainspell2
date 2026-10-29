// In-process FIFO locks. Valid only while Parse runs as a single process (plan, section 2).

const tails = new Map();

/**
 * Run `fn` once every earlier call with the same key has finished.
 * The lock is released whether `fn` resolves or throws.
 * @param {string} key Lock key
 * @param {function(): Promise<any>} fn Work to do while holding the lock
 * @returns {Promise<any>} What `fn` returns
 */
function withLock(key, fn) {
  const previous = tails.get(key) || Promise.resolve();
  const run = previous.then(() => fn());
  const tail = run.then(() => undefined, () => undefined);
  tails.set(key, tail);
  tail.then(() => {
    if (tails.get(key) === tail) {
      tails.delete(key);
    }
  });

  return run;
}

/**
 * Number of keys currently locked (for tests).
 * @returns {number} Count
 */
function size() {
  return tails.size;
}

module.exports = {withLock, size};
