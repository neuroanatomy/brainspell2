// Pure logic of the votes: the state machine (plan, section 3.3) and the merge of the
// legacy baseline with the Vote rows (plan, section 3.4). No Parse, no I/O.

const {tagKey} = require('./normalize');

const ONTOLOGIES = ['cognitive', 'behavioural', 'tasks'];
const VOTE_KINDS = ['mesh', 'tag', 'tableOk'];
const SPACES = ['MNI', 'Talairach'];

/**
 * State machine of a per-key vote (kinds mesh, tag, tableOk).
 * @param {{value: number}|null} current The user's existing row for the key, or null
 * @param {number} requested 1, -1 or 0 (retract)
 * @returns {{op: "create"|"update"|"delete"|"none", value?: number}} What to do
 */
function decide(current, requested) {
  if (requested !== 1 && requested !== -1 && requested !== 0) {
    throw new RangeError('requested must be 1, -1 or 0');
  }
  if (current && current.value !== 1 && current.value !== -1) {
    throw new RangeError('current.value must be 1 or -1');
  }
  if (!current) {
    return requested === 0 ? {op: 'none'} : {op: 'create', value: requested};
  }
  if (requested === 0) {
    return {op: 'delete'};
  }
  if (requested === current.value) {
    return {op: 'none'};
  }

  return {op: 'update', value: requested};
}

/**
 * State machine of a replace-type vote (kinds space and nsubjects): one row per user and
 * article, choosing again replaces the previous choice, null retracts.
 * @param {string|number|null} currentValue Value of the user's existing row, or null
 * @param {string|number|null} requestedValue Requested value, or null to clear
 * @returns {{op: "create"|"update"|"delete"|"none", value?: string|number}} What to do
 */
function decideReplace(currentValue, requestedValue) {
  const cur = currentValue === undefined ? null : currentValue;
  const req = requestedValue === undefined ? null : requestedValue;
  if (cur === null) {
    return req === null ? {op: 'none'} : {op: 'create', value: req};
  }
  if (req === null) {
    return {op: 'delete'};
  }

  return req === cur ? {op: 'none'} : {op: 'update', value: req};
}

/**
 * Identity of a vote row for the "one row per key" rule.
 * @param {Object} row Plain Vote row
 * @returns {string} Key
 */
function rowKey(row) {
  if (row.kind === 'space' || row.kind === 'nsubjects') {
    return [row.user, row.kind].join('\u0001');
  }

  return [row.user, row.kind, row.experimentId, row.ontology || '', tagKey(String(row.tag))].join('\u0001');
}

function isNewer(a, b) {
  if (a.updatedAt !== b.updatedAt) {
    return a.updatedAt > b.updatedAt;
  }

  return String(a.id) > String(b.id);
}

/**
 * Keep the newest row (by updatedAt, then id) of each key.
 * @param {Object[]} rows Plain Vote rows of one article
 * @returns {Object[]} One row per key
 */
function latestPerKey(rows) {
  const best = new Map();
  for (const row of rows) {
    const k = rowKey(row);
    const old = best.get(k);
    if (!old || isNewer(row, old)) {
      best.set(k, row);
    }
  }

  return Array.from(best.values());
}

function count(n) {
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

function entryKey(kind, experimentId, ontology, tag) {
  return [kind, experimentId, ontology || '', tagKey(tag)].join('\u0001');
}

/**
 * All vote entries of an article: legacy baseline plus Vote rows, before the display rule.
 * @param {{Experiments: Array, Metadata: Object}} article Plain article
 * @param {Object[]} rows Plain Vote rows of the article
 * @param {string|null} userId The caller, for `mine`
 * @returns {Array<{kind, experimentId, ontology, tag, agree, disagree, mine}>} Entries
 */
function buildEntries(article, rows, userId) {
  const entries = new Map();
  const order = [];
  const add = (kind, experimentId, ontology, tag) => {
    const k = entryKey(kind, experimentId, ontology, tag);
    let e = entries.get(k);
    if (!e) {
      e = {kind, experimentId, ontology: ontology || null, tag, agree: 0, disagree: 0, mine: 0};
      entries.set(k, e);
      order.push(e);
    }

    return e;
  };
  const meta = article.Metadata || {};
  const experiments = Array.isArray(article.Experiments) ? article.Experiments : [];
  const experimentIds = new Set();

  for (const h of Array.isArray(meta.meshHeadings) ? meta.meshHeadings : []) {
    if (h && typeof h.name === 'string' && h.name.trim()) {
      add('mesh', -1, null, h.name);
    }
  }
  for (const exp of experiments) {
    const id = Number(exp && exp.id);
    if (!Number.isInteger(id)) {
      continue;
    }
    experimentIds.add(id);
    const mark = exp.markBadTable || {};
    const t = add('tableOk', id, null, 'ok');
    t.agree += count(mark.ok);
    t.disagree += count(mark.bad);
    for (const tag of Array.isArray(exp.tags) ? exp.tags : []) {
      if (tag && typeof tag.name === 'string' && ONTOLOGIES.includes(tag.ontology) && tag.name.trim()) {
        const e = add('tag', id, tag.ontology, tag.name);
        e.agree += count(tag.agree);
        e.disagree += count(tag.disagree);
      }
    }
  }
  const fromRows = [];
  for (const row of latestPerKey(rows)) {
    if (!VOTE_KINDS.includes(row.kind) || (row.value !== 1 && row.value !== -1) || typeof row.tag !== 'string') {
      continue;
    }
    const ont = row.kind === 'tag' ? row.ontology : null;
    const exists = entries.has(entryKey(row.kind, row.experimentId, ont, row.tag));
    if (!exists) {
      // votes on a heading or an experiment that is no longer there are ignored
      if (row.kind === 'mesh' || !experimentIds.has(row.experimentId) || row.kind === 'tableOk') {
        continue;
      }
      if (!ONTOLOGIES.includes(ont)) {
        continue;
      }
      fromRows.push(row);
    }
  }
  fromRows.sort((a, b) => (a.experimentId - b.experimentId) || (tagKey(a.tag) < tagKey(b.tag) ? -1 : 1));
  for (const row of fromRows) {
    add('tag', row.experimentId, row.ontology, row.tag);
  }
  for (const row of latestPerKey(rows)) {
    if (!VOTE_KINDS.includes(row.kind) || (row.value !== 1 && row.value !== -1) || typeof row.tag !== 'string') {
      continue;
    }
    const ont = row.kind === 'tag' ? row.ontology : null;
    const e = entries.get(entryKey(row.kind, row.experimentId, ont, row.tag));
    if (!e) {
      continue;
    }
    if (row.value === 1) {
      e.agree += 1;
    } else {
      e.disagree += 1;
    }
    if (userId && row.user === userId) {
      e.mine = row.value;
    }
  }

  // order: mesh, then per experiment: tableOk, legacy tags, new tags (keeps insertion order)
  return order;
}

/**
 * The entries returned by getAnnotations: MeSH headings and table votes always, experiment
 * tags only when agree + disagree >= 1 (plan, section 3.4).
 * @param {{Experiments: Array, Metadata: Object}} article Plain article
 * @param {Object[]} rows Plain Vote rows of the article
 * @param {string|null} userId The caller
 * @returns {Array} Entries
 */
function buildVotes(article, rows, userId) {
  return buildEntries(article, rows, userId).filter((e) => e.kind !== 'tag' || e.agree + e.disagree >= 1);
}

/**
 * Find one entry (even if hidden by the display rule).
 * @param {Array} entries Result of buildEntries
 * @param {string} kind Kind
 * @param {number} experimentId Experiment id (-1 for mesh)
 * @param {string|null} ontology Ontology or null
 * @param {string} tag Tag
 * @returns {Object|null} Entry
 */
function findEntry(entries, kind, experimentId, ontology, tag) {
  const k = entryKey(kind, experimentId, ontology, tag);

  return entries.find((e) => entryKey(e.kind, e.experimentId, e.ontology, e.tag) === k) || null;
}

function spaceOfString(s) {
  const t = typeof s === 'string' ? s.trim().toLowerCase() : '';
  if (t.startsWith('mni')) {
    return 'MNI';
  }
  if (t.startsWith('tal')) {
    return 'Talairach';
  }

  return null;
}

/**
 * Stereotaxic space counts: legacy Metadata.stereo (or, when it has no counts, the legacy
 * Metadata.space string counted as one vote) plus the votes.
 * @param {{Metadata: Object}} article Plain article
 * @param {Object[]} rows Plain Vote rows
 * @param {string|null} userId The caller
 * @returns {{MNI: number, Talairach: number, mine: string|null}} Counts
 */
function buildStereo(article, rows, userId) {
  const meta = article.Metadata || {};
  const stereo = meta.stereo && typeof meta.stereo === 'object' ? meta.stereo : {};
  const out = {MNI: count(stereo.MNI), Talairach: count(stereo.Talairach), mine: null};
  if (out.MNI + out.Talairach === 0) {
    const legacy = spaceOfString(meta.space);
    if (legacy) {
      out[legacy] = 1;
    }
  }
  for (const row of latestPerKey(rows)) {
    if (row.kind === 'space' && SPACES.includes(row.tag)) {
      out[row.tag] += 1;
      if (userId && row.user === userId) {
        out.mine = row.tag;
      }
    }
  }

  return out;
}

/**
 * Number of subjects: the most voted value, ties by most recent vote, falling back to
 * the legacy Metadata.nsubjects when nobody voted.
 * @param {{Metadata: Object}} article Plain article
 * @param {Object[]} rows Plain Vote rows
 * @param {string|null} userId The caller
 * @returns {{value: number|null, values: Array<{n: number, count: number}>, mine: number|null}} Result
 */
function buildNSubjects(article, rows, userId) {
  const byN = new Map();
  let mine = null;
  for (const row of latestPerKey(rows)) {
    if (row.kind !== 'nsubjects' || !Number.isInteger(row.number) || row.number < 1) {
      continue;
    }
    const e = byN.get(row.number) || {n: row.number, count: 0, last: 0};
    e.count += 1;
    e.last = Math.max(e.last, row.updatedAt);
    byN.set(row.number, e);
    if (userId && row.user === userId) {
      mine = row.number;
    }
  }
  const list = Array.from(byN.values()).sort((a, b) => (b.count - a.count) || (b.last - a.last) || (a.n - b.n));
  let value = list.length ? list[0].n : null;
  if (value === null) {
    const legacy = Number((article.Metadata || {}).nsubjects);
    value = Number.isInteger(legacy) && legacy >= 1 ? legacy : null;
  }

  return {value, values: list.map((e) => ({n: e.n, count: e.count})), mine};
}

module.exports = {
  ONTOLOGIES, VOTE_KINDS, SPACES,
  decide, decideReplace, rowKey, latestPerKey,
  buildEntries, buildVotes, findEntry, buildStereo, buildNSubjects
};
