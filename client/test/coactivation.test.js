import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {
  DIM, createAccumulator, gaussianKernel, gaussianSmooth, easeAlpha, easeVolume, createScheduler, createMapRenderer, createPool, loadSearch,
  orderCards, scorePercent, articlesRequest, createPacer, httpError, createArticleReader, createResultIds, levelText, mapStatus, backoffMs, isRetryable
} from "../annotation/coactivation.js";

const REAL = JSON.parse(readFileSync(new URL("./fixtures/prosodic-experiments.json", import.meta.url), "utf8"));

// the ORIGINAL algorithm of search.js (before the redesign), kept here as the golden reference
const oldAggregate = (papers) => {
  const [LR, PA, IS] = [45, 54, 45];
  const sum = new Array(LR * PA * IS).fill(0);
  let maxSum = 0;
  const roi = [];
  for (let x = -3; x <= 3; x++) { for (let y = -3; y <= 3; y++) { for (let z = -3; z <= 3; z++) { if (x * x + y * y + z * z <= 9) { roi.push([x, y, z]); } } } }
  for (const exp of papers) {
    if (exp === null || exp.length === 0) { continue; }
    for (let i = 0; i < exp.length; i++) {
      if (exp[i].locations.length === 0) { continue; }
      for (let j = 0; j < exp[i].locations.length; j++) {
        let coord = exp[i].locations[j].split(",");
        coord = [Math.floor(coord[0] / 4 + 22), Math.floor(coord[1] / 4 + 31), Math.floor(coord[2] / 4 + 17.5)];
        for (let k = 0; k < roi.length; k++) {
          const [x, y, z] = [Math.floor(roi[k][0] + coord[0]), Math.floor(roi[k][1] + coord[1]), Math.floor(roi[k][2] + coord[2])];
          if (x >= 0 && x < LR && y >= 0 && y < PA && z >= 0 && z < IS) {
            sum[z * PA * LR + y * LR + x] += 1;
            maxSum = Math.max(sum[z * PA * LR + y * LR + x], maxSum);
          }
        }
      }
    }
  }

  return {sum, maxSum};
};

const seeded = (n) => { let s = 12345; const r = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
  return Array.from({length: n}, () => [{locations: Array.from({length: 1 + Math.floor(r() * 6)}, () => `${Math.round((r() - 0.5) * 240)},${Math.round((r() - 0.5) * 300)},${Math.round((r() - 0.5) * 220)}`)}]); };

const compare = (papers) => {
  const acc = createAccumulator();
  papers.forEach((p) => acc.add(p));
  const old = oldAggregate(papers);
  assert.equal(acc.volume.length, old.sum.length);
  for (let i = 0; i < old.sum.length; i++) { if (acc.volume[i] !== old.sum[i]) { assert.fail(`voxel ${i}: ${acc.volume[i]} vs ${old.sum[i]}`); } }
  assert.equal(acc.max, old.maxSum);

  return acc;
};

test("accumulator equals the original algorithm: real peaks (1060 from 30 papers)", () => {
  const papers = REAL.map((a) => a.Experiments);
  const acc = compare(papers);
  assert.equal(acc.papers, 30);
  assert.equal(acc.peaks, 1060);
  assert.ok(acc.max > 3);
});

test("accumulator equals the original: random peaks including borders, negatives, far outside; empty, null and missing locations", () => {
  const papers = [...seeded(300), null, [], [{locations: []}], [{locations: ["0,0,0"]}], [{locations: ["-88,-124,-70", "88,100,90", "999,999,999", "-999,0,0"]}]];
  compare(papers.filter((p) => p !== null && p.length));
  const acc = createAccumulator();
  acc.add(null); acc.add(undefined); acc.add([]); acc.add([{}]); acc.add([null, {locations: ["4,4,4"]}]);
  assert.equal(acc.papers, 5);
  assert.equal(acc.peaks, 1);
});

test("arrival order does not matter", () => {
  const papers = REAL.map((a) => a.Experiments);
  const a = createAccumulator(); papers.forEach((p) => a.add(p));
  const b = createAccumulator(); [...papers].reverse().forEach((p) => b.add(p));
  assert.deepEqual(Array.from(a.volume), Array.from(b.volume));
  a.reset();
  assert.equal(a.max, 0);
  assert.equal(a.volume.reduce((s, v) => s + v, 0), 0);
});

// ---- smoothing ------------------------------------------------------------------------------------------------------------------
test("gaussian kernel is normalised and symmetric", () => {
  const k = gaussianKernel(1);
  assert.equal(k.length, 7);
  assert.ok(Math.abs(k.reduce((s, v) => s + v, 0) - 1) < 1e-12);
  for (let i = 0; i < 3; i++) { assert.ok(Math.abs(k[i] - k[6 - i]) < 1e-15); }
});

test("smoothing conserves mass away from the border and is symmetric", () => {
  const n = DIM[0] * DIM[1] * DIM[2];
  const src = new Float32Array(n); const dst = new Float32Array(n); const tmp = new Float32Array(n);
  const at = (x, y, z) => z * 54 * 45 + y * 45 + x;
  src[at(22, 27, 22)] = 100;
  src[at(24, 27, 22)] = 40;
  gaussianSmooth(src, dst, tmp);
  const mass = dst.reduce((s, v) => s + v, 0);
  assert.ok(Math.abs(mass - 140) < 1e-2, String(mass));
  // impulse response symmetric around the voxel
  const one = new Float32Array(n); one[at(22, 27, 22)] = 1;
  const out = new Float32Array(n); gaussianSmooth(one, out, tmp);
  for (const [dx, dy, dz] of [[1, 0, 0], [0, 2, 0], [0, 0, 3], [1, 1, 1]]) {
    assert.ok(Math.abs(out[at(22 + dx, 27 + dy, 22 + dz)] - out[at(22 - dx, 27 - dy, 22 - dz)]) < 1e-7);
  }
  assert.ok(out[at(22, 27, 22)] > out[at(23, 27, 22)]);
});

// ---- easing and scheduler ---------------------------------------------------------------------------------------------------------
test("easing converges monotonically toward the target and never overshoots", () => {
  const target = new Float32Array([10, 0, 5]);
  const display = new Float32Array(3);
  let prev = Infinity;
  let steps = 0;
  while (steps < 200) {
    const diff = easeVolume(display, target, easeAlpha(66, 250));
    assert.ok(diff <= prev + 1e-9);
    assert.ok(display[0] <= 10 && display[2] <= 5 && display[1] === 0);
    prev = diff;
    steps++;
    if (diff < 0.005) { break; }
  }
  assert.ok(steps < 40, `converged in ${steps} steps (about ${steps * 66} ms)`);
  assert.ok(Math.abs(display[0] - 10) < 0.01);
  assert.equal(easeAlpha(0), 0);
  assert.ok(Math.abs(easeAlpha(250) - (1 - Math.exp(-1))) < 1e-12);
});

const fakeClock = () => {
  let t = 0; const timers = [];
  return {now: () => t, setTimer: (fn, ms) => { const h = {fn, at: t + ms}; timers.push(h); return h; }, clearTimer: (h) => { const i = timers.indexOf(h); if (i >= 0) { timers.splice(i, 1); } },
    advance: (ms) => { const end = t + ms; for (;;) { timers.sort((a, b) => a.at - b.at); const h = timers[0]; if (!h || h.at > end) { break; } timers.shift(); t = Math.max(t, h.at); h.fn(); } t = end; },
    pending: () => timers.length};
};

test("scheduler: at most one step per interval, stops by itself, restarts with kick", () => {
  const c = fakeClock();
  let calls = 0; let left = 10;
  const s = createScheduler({step: () => { calls++; return --left > 0; }, minInterval: 66, now: c.now, setTimer: c.setTimer, clearTimer: c.clearTimer});
  s.kick(); s.kick();
  c.advance(1000);
  assert.equal(calls, 10);
  assert.equal(c.pending(), 0, "no idle timer");
  assert.equal(s.running(), false);
  calls = 0; left = 3000;
  s.kick();
  c.advance(1000);
  assert.ok(calls <= 16 && calls >= 14, `~15 steps per second, got ${calls}`);
  s.stop();
  assert.equal(c.pending(), 0);
});

test("map renderer: eases toward the target, meshes at most ~15 times per second, stops when converged, slider eases", () => {
  const c = fakeClock();
  const target = new Float32Array(DIM[0] * DIM[1] * DIM[2]);
  target[1000] = 20;
  const meshes = [];
  const r = createMapRenderer({target, getMax: () => 20, mesh: (f) => meshes.push({max: Math.max(...f.data.slice(900, 1100)), level: f.level, final: f.final}), smooth: true, percent: 50,
    now: c.now, setTimer: c.setTimer, clearTimer: c.clearTimer});
  r.touch();
  c.advance(300);
  const early = meshes[meshes.length - 1];
  assert.ok(early.max > 0 && early.max < 20 * 0.4, "still rising after 300 ms");
  c.advance(6000);
  const last = meshes[meshes.length - 1];
  assert.equal(last.final, true);
  assert.ok(meshes.length < 6.3 * 15 + 2);
  const n = meshes.length;
  c.advance(5000);
  assert.equal(meshes.length, n, "no more meshes once converged");
  assert.equal(c.pending(), 0);
  for (let i = 1; i < meshes.length; i++) { assert.ok(meshes[i].max >= meshes[i - 1].max - 1e-6, "monotone"); }
  // the slider moves the level smoothly
  const before = last.level;
  r.setPercent(90);
  c.advance(200);
  const mid = meshes[meshes.length - 1].level;
  assert.ok(mid > before);
  c.advance(5000);
  assert.ok(meshes[meshes.length - 1].level > mid);
});

test("map renderer with smooth=false: no easing, no smoothing, the plain volume at once", () => {
  const c = fakeClock();
  const target = new Float32Array(DIM[0] * DIM[1] * DIM[2]);
  target[500] = 7;
  const got = [];
  const r = createMapRenderer({target, getMax: () => 7, mesh: (f) => got.push(f), smooth: false, percent: 50, now: c.now, setTimer: c.setTimer, clearTimer: c.clearTimer});
  r.touch();
  c.advance(100);
  assert.equal(got.length, 1);
  assert.equal(got[0].data[500], 7);
  assert.equal(got[0].data.filter((v) => v !== 0).length, 1);
  assert.ok(Math.abs(got[0].level - (7 * 0.5 + 7 / 1000)) < 1e-6);
});

// ---- pool -------------------------------------------------------------------------------------------------------------------------------
const sleepFast = () => Promise.resolve();

test("pool: never more than the limit in flight; priorities first", async () => {
  const pool = createPool({limit: 3, sleep: sleepFast});
  let flying = 0; let maxFlying = 0; const order = [];
  const task = (name) => async () => { flying++; maxFlying = Math.max(maxFlying, flying); order.push(name); await new Promise((r) => setTimeout(r, 5)); flying--; return name; };
  const ps = [];
  for (let i = 0; i < 10; i++) { ps.push(pool.run(task(`low${i}`), {priority: 5})); }
  ps.push(pool.run(task("high"), {priority: 0}));
  await Promise.all(ps);
  assert.equal(maxFlying, 3);
  assert.equal(pool.stats.maxInFlight, 3);
  assert.ok(order.indexOf("high") <= 3, `high priority starts early: ${order.indexOf("high")}`);
});

test("pool: retries on rate limit (155) and on network errors, then gives up after 3 tries; other errors are not retried", async () => {
  const waits = [];
  const pool = createPool({limit: 2, sleep: async (ms) => { waits.push(ms); }});
  let n = 0;
  assert.equal(await pool.run(async () => { n++; if (n < 3) { throw {code: 155, message: "Rate limit, retry in 2 s"}; } return "ok"; }), "ok");
  assert.equal(n, 3);
  assert.deepEqual(waits, [2000, 2000]);
  let m = 0;
  await assert.rejects(pool.run(async () => { m++; throw {code: 100, message: "net"}; }), {code: 100});
  assert.equal(m, 3, "three tries in all");
  let k = 0;
  await assert.rejects(pool.run(async () => { k++; throw {code: 142, message: "bad"}; }), {code: 142});
  assert.equal(k, 1);
  assert.equal(backoffMs(1, {code: 100}), 400);
  assert.equal(backoffMs(2, {code: 100}), 1200);
  assert.equal(backoffMs(1, {code: 155, message: "retry in 99 s"}), 5000);
  assert.ok(isRetryable({code: 155}) && !isRetryable({code: 119}));
});

test("pool: cancel rejects the queue, stops retries, and callers can drop stale results", async () => {
  const pool = createPool({limit: 1, sleep: sleepFast});
  const ran = [];
  const gen = pool.generation();
  const p1 = pool.run(async () => { ran.push(1); await new Promise((r) => setTimeout(r, 10)); return 1; });
  const p2 = pool.run(async () => { ran.push(2); return 2; });
  const p3 = pool.run(async () => { ran.push(3); return 3; });
  pool.cancel();
  await assert.rejects(p2, {cancelled: true});
  await assert.rejects(p3, {cancelled: true});
  assert.equal(await p1, 1, "the running task finishes");
  assert.equal(pool.isCancelled(gen), true, "its caller sees the new generation and ignores the result");
  assert.deepEqual(ran, [1]);
  let tries = 0;
  const pool2 = createPool({limit: 1, sleep: async () => { pool2.cancel(); }});
  await assert.rejects(pool2.run(async () => { tries++; throw {code: 155, message: "x"}; }));
  assert.equal(tries, 1, "no retry after cancel");
  // the pool works after a cancel
  assert.equal(await pool.run(async () => "again"), "again");
});

// ---- loader -----------------------------------------------------------------------------------------------------------------------------
const fakeSolr = (numFound, {failFirst155 = 0} = {}) => {
  const calls = {select: [], papers: []};
  let failed = 0;

  return {
    calls,
    select: async ({q, start, rows}) => {
      calls.select.push({q, start, rows});
      if (failed < failFirst155) { failed++; throw {code: 155, message: "retry in 1 s"}; }
      const n = Math.max(0, Math.min(rows, numFound - start));

      return {numFound, start, maxScore: 10, docs: Array.from({length: n}, (_, i) => ({id: `id${start + i}`, score: 10 - (start + i) / 1000}))};
    },
    fetchExperiments: async (ids) => { calls.papers.push(ids.length); await new Promise((r) => setTimeout(r, Math.random() * 3)); return ids.slice().reverse().map((id) => ({id, PMID: id.slice(2), Experiments: [{locations: ["0,0,0"]}]})); }
  };
};

test("loader: pages of 50 ids, one papers fetch per page, any 0/1/9/50/51/1752 results, concurrency <= 3", async () => {
  for (const n of [0, 1, 9, 50, 51, 1752]) {
    const f = fakeSolr(n);
    const pool = createPool({limit: 3, sleep: sleepFast});
    const acc = createAccumulator();
    const pages = [];
    const res = await loadSearch({query: "q", pool, select: f.select, fetchExperiments: f.fetchExperiments, onPage: (p) => pages.push(p.start), onPapers: (arts) => arts.forEach((a) => acc.add(a.Experiments))});
    assert.equal(res.numFound, n);
    assert.equal(res.failed, 0);
    assert.equal(acc.papers, n, `n=${n}`);
    assert.equal(f.calls.select.length, Math.max(1, Math.ceil(n / 50)));
    assert.ok(f.calls.select.every((c) => c.rows === 50));
    assert.equal(f.calls.papers.length, Math.ceil(n / 50));
    assert.ok(pool.stats.maxInFlight <= 3);
    assert.equal(new Set(pages).size, pages.length);
  }
});

test("loader: a rate limit is retried; a page that keeps failing is reported and the rest still arrives", async () => {
  const f = fakeSolr(120, {failFirst155: 1});
  const pool = createPool({limit: 3, sleep: sleepFast});
  let papers = 0;
  const res = await loadSearch({query: "q", pool, select: f.select, fetchExperiments: f.fetchExperiments, onPapers: (a) => { papers += a.length; }});
  assert.equal(res.failed, 0);
  assert.equal(papers, 120);
  // permanent failure of one page's papers
  const g = fakeSolr(120);
  let calls = 0;
  const fails = [];
  const res2 = await loadSearch({query: "q", pool: createPool({limit: 3, sleep: sleepFast}), select: g.select,
    fetchExperiments: async (ids) => { calls++; if (ids.includes("id50")) { throw {code: 100, message: "net"}; } return g.fetchExperiments(ids); },
    onFail: (f2) => fails.push(f2), onPapers: (a) => { papers += a.length; }});
  assert.equal(fails.length, 1, "only the page that kept failing");
  assert.equal(res2.failed, 1);
  assert.equal(fails[0].start, 50);
  assert.ok(calls >= 3 + 2, "the failing page was tried three times");
});

test("loader: cancelled work is not reported", async () => {
  const f = fakeSolr(500);
  const pool = createPool({limit: 1, sleep: sleepFast});
  const fails = [];
  const p = loadSearch({query: "q", pool, select: f.select, fetchExperiments: f.fetchExperiments, onFail: (x) => fails.push(x)});
  await new Promise((r) => setTimeout(r, 2));
  pool.cancel();
  await p.catch(() => {});
  assert.deepEqual(fails, []);
});

// ---- list: pairing by id ----------------------------------------------------------------------------------------------------------------
test("list items are joined to scores by objectId, not by position", () => {
  const ids = ["a", "b", "c", "d"];
  const page = {start: 0, maxScore: 8, docs: [{id: "a", score: 8}, {id: "b", score: 4}, {id: "c", score: 2}, {id: "d", score: 1}]};
  const r = createResultIds();
  r.addPage(page);
  const cards = [{id: "c", pmid: "3"}, {id: "a", pmid: "1"}, {id: "d", pmid: "4"}, {id: "b", pmid: "2"}]; // Parse order differs
  const items = orderCards(ids, r.scores, cards);
  assert.deepEqual(items.map((i) => [i.pmid, i.score]), [["1", 100], ["2", 50], ["3", 25], ["4", 12]]);
  assert.deepEqual(orderCards(["a", "zzz", "b"], r.scores, cards).map((i) => i.pmid), ["1", "2"], "ids without a record are skipped");
  assert.equal(scorePercent(5, 0), 0);
});

test("result ids: contiguous prefix even when pages arrive out of order", () => {
  const r = createResultIds();
  r.addPage({start: 50, maxScore: 1, docs: [{id: "p50", score: 1}]});
  assert.deepEqual(r.prefix(), []);
  r.addPage({start: 0, maxScore: 1, docs: Array.from({length: 50}, (_, i) => ({id: `p${i}`, score: 1}))});
  assert.equal(r.prefix().length, 51);
  assert.equal(r.prefix()[50], "p50");
});

test("legend texts", () => {
  assert.equal(levelText(50, 123.6), "50% = at least 124 overlapping peaks");
  assert.equal(levelText(50, 0.2), "50% = at least 1 overlapping peaks");
  assert.equal(mapStatus({papers: 150, total: 445, done: false, failed: 0}), "Map from 150 of 445 papers");
  assert.equal(mapStatus({papers: 445, total: 445, done: true, failed: 0}), "Map from 445 papers");
  assert.match(mapStatus({papers: 400, total: 445, done: true, failed: 1}), /some data could not be loaded/);
});

test("loader: after a validation error on a Solr page the later pages are not requested", async () => {
  const f = fakeSolr(2500);
  let selects = 0;
  const select = async (a) => { selects++; if (a.start >= 1000) { throw {code: 142, message: "start too large"}; } return f.select(a); };
  const fails = [];
  await loadSearch({query: "q", pool: createPool({limit: 1, sleep: sleepFast}), select, fetchExperiments: f.fetchExperiments, onFail: (x) => fails.push(x)});
  assert.ok(selects <= 22, `20 good pages and one refused, not all 50; got ${selects}`);
  assert.ok(fails.length >= 1);
});

test("REST reader: url, headers, plain records, error mapping", async () => {
  const r = articlesRequest("https://h.example/parse/", ["a", "b"], ["PMID", "Experiments"], "APP");
  assert.equal(r.url, "https://h.example/parse/classes/Articles");
  assert.equal(r.init.method, "POST");
  assert.equal(r.init.headers["Content-Type"], "text/plain", "a simple request: no CORS preflight");
  assert.deepEqual(JSON.parse(r.init.body), {_method: "GET", _ApplicationId: "APP", where: {objectId: {$in: ["a", "b"]}}, keys: "PMID,Experiments", limit: 2});
  let seen;
  const ok = createArticleReader({serverURL: "https://h.example/parse", appId: "APP", fetch: async (url, init) => { seen = init; return {ok: true, status: 200, json: async () => ({results: [{objectId: "a", PMID: "1"}]})}; }});
  assert.deepEqual(await ok(["a"], ["PMID"]), [{objectId: "a", PMID: "1"}]);
  assert.equal(JSON.parse(seen.body)._ApplicationId, "APP");
  const bad = (status, body) => createArticleReader({serverURL: "https://h", appId: "A", fetch: async () => ({ok: false, status, json: async () => body})});
  await assert.rejects(bad(429, {})(["a"], ["PMID"]), {code: 155});
  await assert.rejects(bad(503, null)(["a"], ["PMID"]), {code: 100});
  await assert.rejects(bad(400, {code: 142, error: "bad"})(["a"], ["PMID"]), {code: 142, message: "bad"});
  await assert.rejects(createArticleReader({serverURL: "https://h", appId: "A", fetch: async () => { throw new TypeError("Failed to fetch"); }})(["a"], ["PMID"]), {code: 100});
  assert.deepEqual(httpError(0, null).code, 100);
});

test("pacer: calls start at least `ms` apart, in order", async () => {
  let t = 0;
  const starts = [];
  const pace = createPacer(65, {now: () => t, sleep: async (d) => { t += d; }});
  await Promise.all([1, 2, 3, 4].map(async (i) => { await pace(); starts.push([i, t]); }));
  assert.deepEqual(starts.map((x) => x[0]), [1, 2, 3, 4]);
  for (let i = 1; i < starts.length; i++) { assert.ok(starts[i][1] - starts[i - 1][1] >= 65 - 1e-9 || starts[i][1] >= 65 * i); }
  assert.ok(t >= 65 * 3);
});
