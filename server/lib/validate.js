// Parameter validation. Every function throws Parse.Error 142 naming the field.

const {fail, CODES} = require('./errors');

const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

function bad(name, why) {
  return fail(CODES.VALIDATION, `${name}: ${why}`);
}

/**
 * Validate a string.
 * Control characters are refused (newline, carriage return and tab are allowed with
 * `multiline: true`). The length is counted in Unicode code points.
 * @param {any} v Value
 * @param {string} name Field name, used in the error message
 * @param {{min?: number, max?: number, multiline?: boolean}} [opts] Limits (min 0, max 10000)
 * @returns {string} The same string
 */
function str(v, name, opts) {
  const {min = 0, max = 10000, multiline = false} = opts || {};
  if (typeof v !== 'string') {
    return bad(name, 'must be a string');
  }
  const re = multiline ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/ : /[\u0000-\u001f\u007f]/;
  if (re.test(v)) {
    return bad(name, 'contains control characters');
  }
  // fast path: UTF-16 length is an upper bound of the code point count
  const n = v.length > max ? Array.from(v).length : v.length;
  if (n < min) {
    return bad(name, `must have at least ${min} characters`);
  }
  if (n > max) {
    return bad(name, `must have at most ${max} characters`);
  }

  return v;
}

/**
 * Validate an integer (a JSON number; strings are refused).
 * @param {any} v Value
 * @param {string} name Field name
 * @param {{min?: number, max?: number}} [opts] Inclusive limits
 * @returns {number} The same number
 */
function int(v, name, opts) {
  const {min = -Number.MAX_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER} = opts || {};
  if (typeof v !== 'number' || !Number.isInteger(v)) {
    return bad(name, 'must be an integer');
  }
  if (v < min || v > max) {
    return bad(name, `must be between ${min} and ${max}`);
  }

  return v;
}

/**
 * Validate a PMID: a string of 1 to 9 digits.
 * @param {any} v Value
 * @returns {string} The same string
 */
function pmid(v) {
  if (typeof v !== 'string' || !/^[0-9]{1,9}$/.test(v)) {
    return bad('pmid', 'must be a string of 1 to 9 digits');
  }

  return v;
}

/**
 * Validate that a value is one of a set (strict equality, so 1 is not "1").
 * @param {any} v Value
 * @param {string} name Field name
 * @param {Array|Set} set Allowed values
 * @returns {any} The same value
 */
function oneOf(v, name, set) {
  const list = Array.from(set);
  if (!list.some((x) => x === v)) {
    return bad(name, `must be one of ${list.map((x) => JSON.stringify(x)).join(', ')}`);
  }

  return v;
}

/**
 * Check that `obj` is a plain object having no key outside `allowed`.
 * undefined and null count as an empty object.
 * @param {any} obj Parameters
 * @param {string[]} allowed Allowed keys
 * @returns {Object} The object (or {})
 */
function noUnknown(obj, allowed) {
  if (obj === undefined || obj === null) {
    return {};
  }
  if (typeof obj !== 'object' || Array.isArray(obj)) {
    return bad('params', 'must be an object');
  }
  for (const k of Object.keys(obj)) {
    if (!allowed.includes(k)) {
      return bad(k, 'unknown parameter');
    }
  }

  return obj;
}

/**
 * True when `obj` has its own, defined property `k`.
 * @param {Object} obj Object
 * @param {string} k Key
 * @returns {boolean} Present
 */
function has(obj, k) {
  return hasOwn(obj, k) && obj[k] !== undefined;
}

module.exports = {str, int, pmid, oneOf, noUnknown, has};
