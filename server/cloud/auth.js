// Identity: `me`, and the guard that only GitHub users can be created (plan, section 3.1).

var {CODES, fail} = require('../lib/errors');
var validate = require('../lib/validate');
var {refreshGithubUser, githubAuthOf} = require('../lib/auth');

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
Parse.Cloud.beforeSave(Parse.User, (request) => {
  if (request.original) {
    return;
  }
  var authData = request.object.get('authData');
  var gh = authData && authData.github;
  if (!gh || typeof gh !== 'object' || gh.id === undefined || gh.id === null || gh.id === '') {
    fail(CODES.FORBIDDEN, 'Only GitHub users can be created');
  }
});
