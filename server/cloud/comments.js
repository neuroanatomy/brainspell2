// postComment (plan, section 4.3).

var {fail, CODES} = require('../lib/errors');
var validate = require('../lib/validate');
var {requireGithubUser} = require('../lib/auth');
var {withLock} = require('../lib/locks');
var rateLimit = require('../lib/rate-limit');
var {findArticle, MASTER} = require('../lib/articles');

Parse.Cloud.define('postComment', async (request) => {
  var {user, login} = await requireGithubUser(request);
  var params = validate.noUnknown(request.params, ['pmid', 'text']);
  var pmid = validate.pmid(params.pmid);
  var text = validate.str(params.text, 'text', {min: 1, max: 5000, multiline: true}).normalize('NFC').trim();
  if (!text) {
    fail(CODES.VALIDATION, 'text: must not be empty');
  }
  rateLimit.check(user.id, 'postComment');

  return withLock(`user:${user.id}`, async () => {
    await findArticle(pmid);
    var comment = new Parse.Object('Comment');
    var acl = new Parse.ACL();
    acl.setPublicReadAccess(true);
    comment.setACL(acl);
    comment.set('user', user.id);
    comment.set('login', login);
    comment.set('pmid', pmid);
    comment.set('text', text);
    await comment.save(null, MASTER);

    return {id: comment.id, login: login, text: text, createdAt: comment.createdAt.toISOString()};
  });
});
