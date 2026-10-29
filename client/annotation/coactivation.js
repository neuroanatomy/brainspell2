/**
 * The coactivation map of the search page, without any DOM: the accumulator (peaks -> 45x54x45 volume), the request pool,
 * the search loader (Solr pages -> experiments), Gaussian smoothing, easing and the throttled mesh scheduler.
 * The page (search.js) only connects these to Parse, the viewer and the DOM. See docs/coactivation-map.md.
 */

export const DIM = [45, 54, 45];
export const [LR, PA, IS] = DIM;
const VOXELS = LR * PA * IS;

// ---- accumulator ------------------------------------------------------------------------------------------------

/** Displacements of the small ball (radius 3) that is added around every peak. */
export const roiOffsets = (R = 3) => {
  const roi = [];
  for (let x = -R; x <= R; x++) {
    for (let y = -R; y <= R; y++) {
      for (let z = -R; z <= R; z++) {
        if (x * x + y * y + z * z <= R * R) {
          roi.push([x, y, z]);
        }
      }
    }
  }

  return roi;
};

/** Voxel of a peak "x,y,z" (mm): same geometry as the original page. */
export const voxelOf = (location) => {
  const c = String(location).split(",");

  return [Math.floor(c[0] / 4 + 22), Math.floor(c[1] / 4 + 31), Math.floor(c[2] / 4 + 17.5)];
};

/**
 * The volume of overlapping peaks. add(experiments) adds the peaks of one paper (the `Experiments` array of an article);
 * counting is exactly the original: one count per peak in every voxel of the ball around it, inside the volume.
 */
export const createAccumulator = () => {
  const roi = roiOffsets();
  const acc = {
    volume: new Float32Array(VOXELS),
    max: 0,
    papers: 0,
    peaks: 0,
    add: (experiments) => {
      acc.papers++;
      if (!Array.isArray(experiments)) {
        return;
      }
      for (const e of experiments) {
        for (const loc of (e && e.locations) || []) {
          acc.peaks++;
          const [cx, cy, cz] = voxelOf(loc);
          for (const [dx, dy, dz] of roi) {
            const x = Math.floor(dx + cx);
            const y = Math.floor(dy + cy);
            const z = Math.floor(dz + cz);
            if (x >= 0 && x < LR && y >= 0 && y < PA && z >= 0 && z < IS) {
              const i = z * PA * LR + y * LR + x;
              const v = ++acc.volume[i];
              if (v > acc.max) {
                acc.max = v;
              }
            }
          }
        }
      }
    },
    reset: () => {
      acc.volume.fill(0);
      acc.max = 0;
      acc.papers = 0;
      acc.peaks = 0;
    }
  };

  return acc;
};

// ---- smoothing and easing -----------------------------------------------------------------------------------------------

export const gaussianKernel = (sigma = 1) => {
  const r = Math.max(1, Math.ceil(3 * sigma));
  const k = [];
  let s = 0;
  for (let i = -r; i <= r; i++) {
    const v = Math.exp(-(i * i) / (2 * sigma * sigma));
    k.push(v);
    s += v;
  }

  return k.map((v) => v / s);
};

/**
 * Separable 3D Gaussian smoothing of src (dim = [nx, ny, nz], x fastest) into dst; `tmp` is a scratch array of the same size.
 * Voxels outside the volume count as 0, so mass is conserved except near the border.
 */
export const gaussianSmooth = (src, dst, tmp, dim = DIM, sigma = 1) => {
  const [nx, ny, nz] = dim;
  const k = gaussianKernel(sigma);
  const r = (k.length - 1) / 2;
  const strides = [1, nx, nx * ny];
  const sizes = [nx, ny, nz];
  const pass = (from, to, axis) => {
    const stride = strides[axis];
    const n = sizes[axis];
    for (let z = 0; z < nz; z++) {
      for (let y = 0; y < ny; y++) {
        for (let x = 0; x < nx; x++) {
          const i = z * nx * ny + y * nx + x;
          const pos = axis === 0 ? x : axis === 1 ? y : z;
          let s = 0;
          for (let d = -r; d <= r; d++) {
            const p = pos + d;
            if (p >= 0 && p < n) {
              s += from[i + d * stride] * k[d + r];
            }
          }
          to[i] = s;
        }
      }
    }
  };
  pass(src, tmp, 0);
  pass(tmp, dst, 1);
  pass(dst, tmp, 2);
  dst.set(tmp);

  return dst;
};

/** Fraction of the distance to the target covered in dt ms with time constant tau ms. */
export const easeAlpha = (dtMs, tau = 250) => 1 - Math.exp(-Math.max(0, dtMs) / tau);

/** display += (target - display) * alpha; returns the largest remaining difference. */
export const easeVolume = (display, target, alpha) => {
  let maxDiff = 0;
  for (let i = 0; i < display.length; i++) {
    const d = target[i] - display[i];
    display[i] += d * alpha;
    const a = d < 0 ? -d : d;
    if (a > maxDiff) {
      maxDiff = a;
    }
  }

  return maxDiff * (1 - alpha);
};

// ---- throttled scheduler ------------------------------------------------------------------------------------------------------

/**
 * Calls step(dtMs) at most once every minInterval ms while step returns true (still changing); stops by itself (no idle timer).
 * kick() (re)starts it. Timers and clock are injectable for tests.
 */
export const createScheduler = ({step, minInterval = 66, now = () => Date.now(), setTimer = setTimeout, clearTimer = clearTimeout}) => {
  let timer = null;
  let last = null;
  const s = {
    running: () => timer !== null,
    kick: () => {
      if (timer !== null) {
        return;
      }
      last = now();
      timer = setTimer(tick, 0);
    },
    stop: () => {
      if (timer !== null) {
        clearTimer(timer);
        timer = null;
      }
    }
  };
  function tick () {
    const t = now();
    const dt = t - last;
    last = t;
    timer = null;
    let again = false;
    try {
      again = step(dt);
    } finally {
      if (again) {
        timer = setTimer(tick, Math.max(0, minInterval - (now() - t)));
      }
    }
  }

  return s;
};

/**
 * The map renderer: `target` is the accumulator's volume (live), `display` eases toward it, is smoothed and given to mesh(field).
 * smooth=false disables easing and smoothing (display = target). The slider percentage eases too.
 * mesh({data, dim, level}); onLevel({percent, level}) is called with the displayed level for the legend.
 */
export const createMapRenderer = ({target, getMax, mesh, onLevel = () => {}, smooth = true, tau = 250, minInterval = 66, sigma = 1, percent = 50, now, setTimer, clearTimer}) => {
  const display = new Float32Array(target.length);
  const smoothed = new Float32Array(target.length);
  const tmp = new Float32Array(target.length);
  let wanted = percent;
  let shown = percent;
  let meshes = 0;

  const emit = (final) => {
    let data = display;
    if (smooth) {
      gaussianSmooth(display, smoothed, tmp, DIM, sigma);
      data = smoothed;
    }
    // the level is a percentage of the strongest region in PEAK COUNTS (the eased, unsmoothed volume), so "50% = at least N
    // overlapping peaks" means the same with and without smoothing
    let max = 0;
    if (smooth) {
      for (let i = 0; i < display.length; i++) {
        if (display[i] > max) {
          max = display[i];
        }
      }
    } else {
      max = getMax();
    }
    const level = max > 0 ? max * shown / 100 + max / 1000 : 0.1;
    meshes++;
    mesh({data, dim: DIM, level, final});
    onLevel({percent: shown, level, max});
  };

  const step = (dt) => {
    if (!smooth) {
      display.set(target);
      shown = wanted;
      emit(true);

      return false;
    }
    const alpha = easeAlpha(dt, tau);
    const remaining = easeVolume(display, target, alpha);
    shown += (wanted - shown) * alpha;
    const pctLeft = Math.abs(wanted - shown);
    const done = remaining < 0.005 && pctLeft < 0.05;
    if (done) {
      display.set(target);
      shown = wanted;
    }
    emit(done);

    return !done;
  };

  const scheduler = createScheduler({step, minInterval, now, setTimer, clearTimer});

  return {
    display,
    scheduler,
    meshes: () => meshes,
    /** the target volume changed (or the slider moved): ease toward it */
    touch: () => scheduler.kick(),
    setPercent: (p) => {
      wanted = p;
      scheduler.kick();
    },
    /** show the target at once (e.g. the search is complete and the page is idle) */
    flush: () => {
      scheduler.stop();
      display.set(target);
      shown = wanted;
      emit(true);
    },
    stop: () => scheduler.stop()
  };
};

// ---- request pool ----------------------------------------------------------------------------------------------------------------

export const isRetryable = (err) => {
  const code = err && err.code;

  return code === 155 || code === 100 || code === 1003 || code === -1 || typeof code === "undefined";
};

/** Seconds to wait after a rate-limit message ("... retry in 3 s"), else exponential backoff in ms. */
export const backoffMs = (attempt, err) => {
  const m = err && err.code === 155 && /(\d+)\s*s/.exec(String(err.message || ""));
  if (m) {
    return Math.min(5, Math.max(1, Number(m[1]))) * 1000;
  }

  return 400 * 3 ** (attempt - 1);
};

/**
 * Runs async tasks with at most `limit` in flight, lowest priority number first. A failing task is retried (rate limit or
 * network error) with backoff, maxTries in total; then its promise rejects. cancel() rejects everything queued with {cancelled: true}
 * and stops retries; results of tasks already running are ignored by callers through isCancelled().
 */
export const createPool = ({limit = 3, maxTries = 3, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), backoff = backoffMs} = {}) => {
  const queue = [];
  let inFlight = 0;
  let seq = 0;
  let generation = 0;
  const stats = {started: 0, retries: 0, maxInFlight: 0, failed: 0};
  const cancelledError = () => ({cancelled: true, code: -2, message: "cancelled"});

  const exec = async (job) => {
    for (let attempt = 1; ; attempt++) {
      if (job.generation !== generation) {
        throw cancelledError();
      }
      try {
        stats.started++;

        return await job.fn();
      } catch (err) {
        if (!isRetryable(err) || attempt >= maxTries || job.generation !== generation) {
          stats.failed++;
          throw err;
        }
        stats.retries++;
        await sleep(backoff(attempt, err));
      }
    }
  };

  const pump = () => {
    while (inFlight < limit && queue.length) {
      queue.sort((a, b) => a.priority - b.priority || a.seq - b.seq);
      const job = queue.shift();
      inFlight++;
      stats.maxInFlight = Math.max(stats.maxInFlight, inFlight);
      exec(job).then(job.resolve, job.reject).finally(() => {
        inFlight--;
        pump();
      });
    }
  };

  return {
    stats,
    inFlight: () => inFlight,
    queued: () => queue.length,
    run: (fn, {priority = 0} = {}) => new Promise((resolve, reject) => {
      queue.push({fn, priority, seq: seq++, resolve, reject, generation});
      pump();
    }),
    cancel: () => {
      generation++;
      for (const job of queue.splice(0)) {
        job.reject(cancelledError());
      }
    },
    isCancelled: (gen) => gen !== generation,
    generation: () => generation
  };
};

/**
 * Spaces calls at least `ms` apart (the server throttles `select` to 30 per second for ALL visitors together; we stay near 15 per second).
 * pace() resolves when the caller may go; callers are served in order.
 */
export const createPacer = (ms, {now = () => Date.now(), sleep = (d) => new Promise((r) => setTimeout(r, d))} = {}) => {
  let next = 0;

  return async () => {
    const t = now();
    const at = Math.max(t, next);
    next = at + ms;
    if (at > t) {
      await sleep(at - t);
    }
  };
};

// ---- search loader ---------------------------------------------------------------------------------------------------------------

/**
 * Loads a search: Solr pages of `rows` ids (select, fl "score,id") and, for every page, the `Experiments` of its papers.
 *   select({q, start, rows}) -> {numFound, maxScore, start, docs: [{id, score}]}
 *   fetchExperiments(ids)    -> [{id, PMID, Experiments}]
 * onPage(page) is called with every Solr page (any order); onPapers(articles, pageIds) with the experiments of a page when they arrive;
 * onFail({what, start, error}) for a page or fetch that failed after the retries. Resolves to {numFound, pages, failed}.
 */
export const loadSearch = async ({query, rows = 50, pool, select, fetchExperiments, onPage = () => {}, onPapers = () => {}, onFail = () => {}}) => {
  let failed = 0;
  const first = await pool.run(() => select({q: query, start: 0, rows}), {priority: 0});
  const numFound = Number(first.numFound) || 0;
  const pages = Math.max(1, Math.ceil(numFound / rows));
  const fail = (what, start) => (error) => {
    if (error && error.cancelled) {
      return;
    }
    failed++;
    onFail({what, start, error});
  };

  const papersOf = (page, k) => {
    const ids = page.docs.map((d) => d.id);
    if (!ids.length) {
      return Promise.resolve();
    }

    return pool.run(() => fetchExperiments(ids), {priority: 2 + 2 * k})
      .then((articles) => onPapers(articles, ids), fail("papers", page.start));
  };

  onPage(first);
  const tasks = [papersOf(first, 0)];
  let stopPaging = false; // the server refuses a start offset (validation error): the later pages would be refused too
  for (let k = 1; k < pages; k++) {
    tasks.push(pool.run(() => (stopPaging ? Promise.reject({cancelled: true}) : select({q: query, start: k * rows, rows})), {priority: 1 + 2 * k})
      .then((page) => {
        onPage(page);

        return papersOf(page, k);
      }, (error) => {
        if (error && error.code === 142) {
          stopPaging = true;
        }
        fail("page", k * rows)(error);
      }));
  }
  await Promise.all(tasks);

  return {numFound, pages, failed};
};

// ---- result list -------------------------------------------------------------------------------------------------------------------

/**
 * Items of the list in Solr order, joined by objectId (NOT by position: Parse does not return records in the order of the ids).
 * ids: ["id1", ...]; scores: {id: percent}; cards: [{id, ...}]. Ids without a record are skipped.
 */
export const orderCards = (ids, scores, cards) => {
  const byId = new Map(cards.map((c) => [c.id, c]));

  return ids.filter((id) => byId.has(id)).map((id) => ({...byId.get(id), score: scores[id] || 0}));
};

/** Percent of the best score, as shown in the list. */
export const scorePercent = (score, maxScore) => (maxScore > 0 ? (100 * score / maxScore) | 0 : 0);

/** The ids known so far, in Solr order, as a contiguous prefix (pages may arrive out of order). */
export const createResultIds = () => {
  const slots = [];
  const scores = {};

  return {
    addPage: (page) => {
      page.docs.forEach((d, i) => {
        slots[page.start + i] = d.id;
        scores[d.id] = scorePercent(d.score, page.maxScore);
      });
    },
    prefix: () => {
      const out = [];
      for (let i = 0; i < slots.length && slots[i] !== undefined; i++) {
        out.push(slots[i]);
      }

      return out;
    },
    scores
  };
};

/** "50% = at least 124 overlapping peaks" */
export const levelText = (percent, level) => `${Math.round(percent)}% = at least ${Math.max(1, Math.round(level))} overlapping peaks`;

/** The status line while loading and when done. */
export const mapStatus = ({papers, total, done, failed}) => {
  if (failed) {
    return `Map from ${papers} of ${total} papers: some data could not be loaded`;
  }
  if (!done && papers < total) {
    return `Map from ${papers} of ${total} papers`;
  }

  return `Map from ${papers} papers`;
};

// ---- plain REST reads of Articles (no Parse object cache) -----------------------------------------------------------------------------

/**
 * The request that reads `keys` of the Articles with these objectIds, in the form the Parse SDK uses for reads: a POST with a text/plain body
 * (`_method: "GET"`), which is a "simple" request without a CORS preflight. The Parse SDK itself is not used for the reads: it keeps one shared
 * object per id, and a second partial query for the same ids (keys PMID,Title... after PMID,Experiments) can come back without the new fields.
 */
export const articlesRequest = (serverURL, ids, keys, appId) => ({
  url: `${String(serverURL).replace(/\/+$/, "")}/classes/Articles`,
  init: {
    method: "POST",
    headers: {"Content-Type": "text/plain"},
    body: JSON.stringify({_method: "GET", _ApplicationId: appId, where: {objectId: {$in: ids}}, keys: keys.join(","), limit: ids.length})
  }
});

/** {code, message} for a failed HTTP answer, in the codes of the client (155 rate limit, 100 network/server, else the Parse code). */
export const httpError = (status, body) => {
  if (status === 429) {
    return {code: 155, message: (body && body.error) || "Too many requests"};
  }
  if (status >= 500 || status === 0) {
    return {code: 100, message: (body && body.error) || "The server did not answer"};
  }

  return {code: Number.isInteger(body && body.code) ? body.code : status, message: (body && body.error) || `HTTP ${status}`};
};

/** fetchArticles({fetch, serverURL, appId}) -> async (ids, keys) -> plain records */
export const createArticleReader = ({fetch: doFetch, serverURL, appId}) => async (ids, keys) => {
  let res;
  try {
    const {url, init} = articlesRequest(serverURL, ids, keys, appId);
    res = await doFetch(url, init);
  } catch (err) {
    throw {code: 100, message: "Cannot reach the server"};
  }
  let body = null;
  try {
    body = await res.json();
  } catch (err) {
    body = null;
  }
  if (!res.ok) {
    throw httpError(res.status, body);
  }

  return (body && body.results) || [];
};
