// Ordered text repairs for the stored articles. Pure, Node 16 compatible.
//
//   mojibake    UTF-8 read as Latin-1 ("MÃ¼ller" -> "Müller"), see mojibake.js
//   slashes     PHP stripslashes limited to \' \" and \\  (one left-to-right pass)
//   orequals    PubMed's "<or=" / ">or=" -> "≤" / "≥"          (Title, Abstract, Reference)
//   whitespace  Reference: collapse space runs, trim, drop a comma before "(2007)";
//               Title, Authors, Abstract: trim only
//
// slashes, orequals and whitespace only apply to the four top-level fields; mojibake applies
// to every field it is given.

const {fixMojibake} = require('./mojibake');

const TRANSFORMS = ['mojibake', 'slashes', 'orequals', 'whitespace'];
const TOP = ['Title', 'Authors', 'Abstract', 'Reference'];
const ORE_FIELDS = ['Title', 'Abstract', 'Reference'];

/**
 * True when a string has a backslash layout that stripslashes would read ambiguously: two or
 * more backslashes followed by a quote (`\\'`, a legitimately escaped backslash before an
 * escaped quote?), or three or more backslashes in a row. Such strings are left alone.
 * @param {string} s String
 * @returns {boolean} Ambiguous
 */
function slashesAmbiguous(s) {
  return /\\{2,}['"]/.test(s) || /\\{3,}/.test(s);
}

function slashes(s) {
  if (s.indexOf('\\') === -1 || slashesAmbiguous(s)) {
    return s;
  }

  return s.replace(/\\(['"\\])/g, '$1');
}

function orequals(s) {
  return s.replace(/<or=/g, '\u2264').replace(/>or=/g, '\u2265');
}

function whitespace(s, field) {
  if (field === undefined || field === 'Reference') {
    return s.replace(/,\s*(?=\(\d{4}\))/g, ' ').replace(/[ \t]{2,}/g, ' ').trim();
  }

  return s.trim();
}

/**
 * Apply the selected transforms, in the fixed order, to one string.
 * @param {string} str Stored text
 * @param {{transforms?: string[], field?: string}} [opts] transforms: subset of TRANSFORMS
 *   (default all); field: path pattern such as "Title" or "Experiments[].title" (default: no
 *   field restriction, whitespace works as for Reference)
 * @returns {{text: string, applied: string[], steps: Array<{name: string, before: string, after: string}>}}
 *   applied: the transforms that changed the text, in order
 */
function repairText(str, opts) {
  const o = opts || {};
  const wanted = o.transforms || TRANSFORMS;
  const field = o.field;
  const out = {text: str, applied: [], steps: []};
  if (typeof str !== 'string') {
    return out;
  }
  const top = field === undefined || TOP.includes(field);
  const step = (name, fn) => {
    if (!wanted.includes(name)) {
      return;
    }
    const after = fn(out.text);
    if (after !== out.text) {
      out.steps.push({name, before: out.text, after});
      out.applied.push(name);
      out.text = after;
    }
  };
  step('mojibake', (s) => fixMojibake(s).text);
  if (top) {
    step('slashes', slashes);
    if (field === undefined || ORE_FIELDS.includes(field)) {
      step('orequals', orequals);
    }
    step('whitespace', (s) => whitespace(s, field));
  }

  return out;
}

module.exports = {repairText, slashesAmbiguous, TRANSFORMS, TOP};
