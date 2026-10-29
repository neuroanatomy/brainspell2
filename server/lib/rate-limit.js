// Per-user, in-process rate limits (plan, section 4.2). Valid while Parse is one process.

const {fail, CODES} = require('./errors');

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const LIMITS = {
  vote: [{ms: MIN, max: 60}],
  postComment: [{ms: MIN, max: 5}, {ms: DAY, max: 20}],
  editExperiment: [{ms: MIN, max: 30}],
  addArticle: [{ms: HOUR, max: 5}],
  saveCollection: [{ms: MIN, max: 30}],
  // global (one key for everybody): the search is public
  select: [{ms: 1000, max: 30}, {ms: MIN, max: 600}]
};

const hits = new Map(); // `${name}|${userId}` -> array of timestamps, oldest first
let clock = () => Date.now();
let sinceSweep = 0;

function longest(name) {
  return Math.max(...LIMITS[name].map((l) => l.ms));
}

function sweep(now) {
  for (const [key, list] of hits) {
    const name = key.slice(0, key.indexOf('|'));
    const keep = list.filter((t) => now - t < longest(name));
    if (keep.length) {
      hits.set(key, keep);
    } else {
      hits.delete(key);
    }
  }
}

/**
 * Count one call of `name` by `userId`; throw 155 when a window is full.
 * A refused call is not counted. Entries older than the longest window are evicted.
 * @param {string} userId _User objectId
 * @param {string} name Key of LIMITS
 * @returns {void}
 */
function check(userId, name) {
  if (!LIMITS[name]) {
    throw new Error(`rate-limit: unknown name ${name}`);
  }
  const now = clock();
  if (++sinceSweep >= 1000) {
    sinceSweep = 0;
    sweep(now);
  }
  const key = `${name}|${userId}`;
  const list = (hits.get(key) || []).filter((t) => now - t < longest(name));
  for (const {ms, max} of LIMITS[name]) {
    const inWindow = list.filter((t) => now - t < ms);
    if (inWindow.length >= max) {
      const retry = Math.max(1, Math.ceil((inWindow[0] + ms - now) / 1000));

      return fail(CODES.RATE_LIMITED, `Too many requests, retry in ${retry} seconds`);
    }
  }
  list.push(now);
  hits.set(key, list);
}

/**
 * Forget everything (for tests).
 * @returns {void}
 */
function reset() {
  hits.clear();
  sinceSweep = 0;
  clock = () => Date.now();
}

/**
 * Replace the clock (for tests).
 * @param {function(): number} fn Returns milliseconds
 * @returns {void}
 */
function setClock(fn) {
  clock = fn;
}

/**
 * Number of tracked keys (for tests).
 * @returns {number} Count
 */
function size() {
  return hits.size;
}

module.exports = {check, reset, setClock, size, LIMITS};
