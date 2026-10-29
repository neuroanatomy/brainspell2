// Table operations of editExperiment (plan, sections 3.5 and 4.3). Pure functions: no
// database access. Validation errors are Parse.Error 142 naming the field.

const {fail, CODES} = require('./errors');
const validate = require('./validate');

const MAX_OPS = 200;
const MAX_ROWS = 5000;
const MAX_TITLE = 1000;
const MAX_CAPTION = 5000;
const MAX_IMPORT_TEXT = 500000;
const COORD_LIMIT = 200;
const NUMBER_RE = /[-+−]?(?:\d+(?:\.\d+)?|\.\d+)/g;

const OP_KEYS = {
  setTitle: ['op', 'text'],
  setCaption: ['op', 'text'],
  updateRow: ['op', 'index', 'xyz'],
  addRow: ['op', 'xyz', 'index'],
  deleteRow: ['op', 'index'],
  split: ['op', 'index'],
  replaceFromText: ['op', 'text']
};

const clone = (v) => JSON.parse(JSON.stringify(v));

/**
 * Format a coordinate: at most 3 decimals, no trailing zeros, no "-0".
 * @param {number} n Finite number
 * @returns {string} Text
 */
function formatNumber(n) {
  return String(Number(n.toFixed(3)));
}

/**
 * Format a location as stored in the database.
 * @param {number[]} xyz Three finite numbers
 * @returns {string} "x,y,z"
 */
function formatLocation(xyz) {
  return xyz.map(formatNumber).join(',');
}

function checkXyz(v, name) {
  if (!Array.isArray(v) || v.length !== 3) {
    return fail(CODES.VALIDATION, `${name}: must be an array of three numbers`);
  }
  v.forEach((n, i) => {
    if (typeof n !== 'number' || !Number.isFinite(n)) {
      fail(CODES.VALIDATION, `${name}[${i}]: must be a finite number`);
    }
    if (n < -COORD_LIMIT || n > COORD_LIMIT) {
      fail(CODES.VALIDATION, `${name}[${i}]: must be between -${COORD_LIMIT} and ${COORD_LIMIT}`);
    }
  });

  return v;
}

/**
 * Validate the shape of the operations (not their fit to a given table).
 * @param {any} ops Value of the `ops` parameter
 * @returns {Object[]} Normalised copy (texts in NFC)
 * @throws Parse.Error 142
 */
function validateOps(ops) {
  if (!Array.isArray(ops)) {
    return fail(CODES.VALIDATION, 'ops: must be an array');
  }
  if (ops.length < 1 || ops.length > MAX_OPS) {
    return fail(CODES.VALIDATION, `ops: must have between 1 and ${MAX_OPS} operations`);
  }

  return ops.map((raw, i) => {
    const name = `ops[${i}]`;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return fail(CODES.VALIDATION, `${name}: must be an object`);
    }
    const kind = validate.oneOf(raw.op, `${name}.op`, Object.keys(OP_KEYS));
    for (const k of Object.keys(raw)) {
      if (!OP_KEYS[kind].includes(k)) {
        fail(CODES.VALIDATION, `${name}.${k}: unknown parameter`);
      }
    }
    const out = {op: kind};
    switch (kind) {
    case 'setTitle':
      out.text = validate.str(raw.text, `${name}.text`, {max: MAX_TITLE}).normalize('NFC');
      break;
    case 'setCaption':
      out.text = validate.str(raw.text, `${name}.text`, {max: MAX_CAPTION, multiline: true}).normalize('NFC');
      break;
    case 'updateRow':
      out.index = validate.int(raw.index, `${name}.index`, {min: 0, max: MAX_ROWS});
      out.xyz = checkXyz(raw.xyz, `${name}.xyz`).slice();
      break;
    case 'addRow':
      out.xyz = checkXyz(raw.xyz, `${name}.xyz`).slice();
      if (validate.has(raw, 'index')) {
        out.index = validate.int(raw.index, `${name}.index`, {min: 0, max: MAX_ROWS});
      }
      break;
    case 'deleteRow':
    case 'split':
      out.index = validate.int(raw.index, `${name}.index`, {min: 0, max: MAX_ROWS});
      break;
    default: // replaceFromText
      out.text = validate.str(raw.text, `${name}.text`, {max: MAX_IMPORT_TEXT, multiline: true});
    }

    return out;
  });
}

/**
 * Parse pasted text into locations. One location per line; the first three numbers of the
 * line are x, y, z; lines with fewer than three numbers are skipped.
 * @param {string} text Pasted text
 * @param {string} [name] Field name for error messages
 * @returns {string[]} Locations "x,y,z"
 * @throws Parse.Error 142 when no line is valid or a coordinate is out of range
 */
function parseLocations(text, name) {
  const field = name || 'text';
  const out = [];
  String(text).split(/\r\n|\r|\n/).forEach((line, i) => {
    const found = line.match(NUMBER_RE);
    if (!found || found.length < 3) {
      return;
    }
    const xyz = found.slice(0, 3).map((s) => Number(s.replace('−', '-')));
    xyz.forEach((n) => {
      if (!Number.isFinite(n) || n < -COORD_LIMIT || n > COORD_LIMIT) {
        fail(CODES.VALIDATION, `${field}: line ${i + 1}: coordinates must be between -${COORD_LIMIT} and ${COORD_LIMIT}`);
      }
    });
    out.push(formatLocation(xyz));
    if (out.length > MAX_ROWS) {
      fail(CODES.VALIDATION, `${field}: more than ${MAX_ROWS} locations`);
    }
  });
  if (!out.length) {
    fail(CODES.VALIDATION, `${field}: no valid line (each line needs three numbers)`);
  }

  return out;
}

function rowsOf(exp) {
  return Array.isArray(exp.locations) ? exp.locations : [];
}

function checkIndex(i, len, name, allowEnd) {
  if (i >= len + (allowEnd ? 1 : 0)) {
    fail(CODES.VALIDATION, `${name}: out of range (the table has ${len} rows)`);
  }
}

/**
 * Largest experiment id of an article (0 when there is none).
 * @param {Object[]} experiments Experiments
 * @returns {number} Maximum id
 */
function maxId(experiments) {
  return experiments.reduce((m, e) => (e && Number.isFinite(Number(e.id)) ? Math.max(m, Number(e.id)) : m), 0);
}

/**
 * Apply operations, in order, to a COPY of the article's experiments.
 * Split puts rows index..end into a new experiment right after the edited one (id = largest
 * id + 1, same title and caption, no tags). Later operations of the same call act on the
 * original experiment.
 * @param {Object[]} experiments Current experiments (not modified)
 * @param {number} experimentId Id of the experiment to edit
 * @param {Object[]} rawOps Operations (validated here with validateOps)
 * @returns {{experiments: Object[], changed: Object[], before: Object[]}} New state; the
 *   changed experiments in article order (full JSON); the before-images of the changed
 *   experiments that existed before (a new split half has none)
 * @throws Parse.Error 101 when the experiment does not exist, 142 on invalid operations
 */
function applyOps(experiments, experimentId, rawOps) {
  const ops = validateOps(rawOps);
  const state = experiments.slice();
  const pos = state.findIndex((e) => e && Number(e.id) === experimentId);
  if (pos < 0) {
    return fail(CODES.NOT_FOUND, 'Experiment not found');
  }
  const original = state[pos];
  let exp = clone(original);
  let nextId = maxId(state);
  const created = []; // new experiments, in the order they end up after `exp`

  ops.forEach((op, i) => {
    const name = `ops[${i}]`;
    const rows = rowsOf(exp);
    switch (op.op) {
    case 'setTitle':
      exp.title = op.text;
      break;
    case 'setCaption':
      exp.caption = op.text;
      break;
    case 'updateRow':
      checkIndex(op.index, rows.length, `${name}.index`, false);
      exp.locations = rows.slice();
      exp.locations[op.index] = formatLocation(op.xyz);
      break;
    case 'addRow': {
      const at = op.index === undefined ? rows.length : op.index;
      checkIndex(at, rows.length, `${name}.index`, true);
      if (rows.length + 1 > MAX_ROWS) {
        fail(CODES.VALIDATION, `${name}: a table has at most ${MAX_ROWS} rows`);
      }
      exp.locations = rows.slice();
      exp.locations.splice(at, 0, formatLocation(op.xyz));
      break;
    }
    case 'deleteRow':
      checkIndex(op.index, rows.length, `${name}.index`, false);
      exp.locations = rows.slice();
      exp.locations.splice(op.index, 1);
      break;
    case 'split': {
      checkIndex(op.index, rows.length, `${name}.index`, false);
      nextId += 1;
      created.unshift({id: nextId, title: exp.title === undefined ? '' : exp.title,
        caption: exp.caption === undefined ? '' : exp.caption, locations: rows.slice(op.index), tags: []});
      exp.locations = rows.slice(0, op.index);
      break;
    }
    default: // replaceFromText
      exp.locations = parseLocations(op.text, `${name}.text`);
    }
  });

  const expChanged = JSON.stringify(exp) !== JSON.stringify(original);
  const changed = expChanged ? [exp] : [];
  const before = expChanged ? [clone(original)] : [];
  changed.push(...created);
  const result = state.slice();
  result[pos] = expChanged ? exp : original;
  result.splice(pos + 1, 0, ...created);

  return {experiments: result, changed: changed, before: before};
}

module.exports = {
  applyOps, validateOps, parseLocations, formatLocation, formatNumber, maxId,
  MAX_OPS, MAX_ROWS, COORD_LIMIT
};
