// Express middleware: removes `authData` (which holds the GitHub access token) from the JSON
// answers of the Parse REST API, unless the request carries the master key.
//
// Why not an afterFind trigger: GET /users/me reads the user with Parse's own master
// authority (UsersRouter.handleMe), so a trigger cannot tell it from a master-key request.
// Cloud functions and the server's own queries do not go through HTTP, so lib/auth.js still
// reads authData.

function strip(value, depth) {
  if (depth > 5 || value === null || typeof value !== 'object') {
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((v) => strip(v, depth + 1));

    return;
  }
  delete value.authData;
  Object.keys(value).forEach((k) => strip(value[k], depth + 1));
}

/**
 * @param {string} masterKey The server's master key
 * @returns {function} Express middleware
 */
function stripAuthData(masterKey) {
  return function(req, res, next) {
    if (req.get('X-Parse-Master-Key') === masterKey) {
      return next();
    }
    const json = res.json;
    res.json = function(body) {
      strip(body, 0);

      return json.call(this, body);
    };

    return next();
  };
}

module.exports = {stripAuthData, strip};
