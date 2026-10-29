// Error codes of the annotation API (plan, section 4.2). The client switches on `code` only.
// `Parse` is the global provided by Parse Server's cloud code runtime.

const CODES = {
  VALIDATION: 142,
  NOT_LOGGED_IN: 206,
  FORBIDDEN: 119,
  RATE_LIMITED: 155,
  NOT_FOUND: 101,
  EXISTS: 137,
  CONFLICT: 1001,
  UPSTREAM: 1002
};

/**
 * Throw a Parse.Error with the given code and message.
 * @param {number} code One of CODES
 * @param {string} message Human readable message (never include secrets)
 * @returns {never}
 */
function fail(code, message) {
  throw new Parse.Error(code, message);
}

module.exports = {fail, CODES};
