// Identity: `me`, and the guard that only GitHub users can be created (plan, section 3.1).

var {CODES, fail} = require('../lib/errors');
var validate = require('../lib/validate');
var {refreshGithubUser, githubAuthOf, toGithubId} = require('../lib/auth');

Parse.Cloud.define('me', async (request) => {
  validate.noUnknown(request.params, []);
  if (!request.user) {
    return null;
  }
  if (!await githubAuthOf(request.user)) {
    return null;
  }
  var {login, githubId} = await refreshGithubUser(request.user);

  return {id: request.user.id, login: login, githubId: githubId};
});

// Creation of a _User without GitHub authData is refused, for everybody, master key included.
// Logging in with authData is a POST /users too, and carries authData.github.
// The GitHub id must be canonical (lib/auth.js toGithubId) and must not belong to an existing user.
Parse.Cloud.beforeSave(Parse.User, async (request) => {
  if (request.original) {
    return;
  }
  var authData = request.object.get('authData');
  var gh = authData && authData.github;
  var id = gh && typeof gh === 'object' ? toGithubId(gh.id) : null;
  if (id === null) {
    fail(CODES.FORBIDDEN, 'Only GitHub users can be created');
  }
  var q = new Parse.Query(Parse.User);
  q.containedIn('authData.github.id', [id, String(id)]);
  if (await q.first({useMasterKey: true})) {
    fail(CODES.FORBIDDEN, 'This GitHub account is already used by another user');
  }
});
