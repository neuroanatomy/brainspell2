// Normalisation of tag names for comparison (plan, section 3.4).

/**
 * Comparison key of a tag name: Unicode NFC, trimmed, runs of whitespace collapsed to a
 * single space, lower case.
 * @param {string} s Tag name
 * @returns {string} Key
 */
function tagKey(s) {
  if (typeof s !== 'string') {
    throw new TypeError('tagKey expects a string');
  }

  return s.normalize('NFC').replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * Same as tagKey but keeps the case: used to store a cleaned-up spelling.
 * @param {string} s Tag name
 * @returns {string} Cleaned name
 */
function cleanName(s) {
  return s.normalize('NFC').replace(/\s+/g, ' ').trim();
}

module.exports = {tagKey, cleanName};
