// editExperiment (plan, sections 3.5 and 4.3): the only way to change Articles.Experiments.

var {fail, CODES} = require('../lib/errors');
var validate = require('../lib/validate');
var {requireGithubUser} = require('../lib/auth');
var {withLock} = require('../lib/locks');
var rateLimit = require('../lib/rate-limit');
var tableOps = require('../lib/table-ops');
var {findArticle, articleData, MASTER} = require('../lib/articles');

Parse.Cloud.define('editExperiment', async (request) => {
  var {user, login} = await requireGithubUser(request);
  var p = validate.noUnknown(request.params, ['pmid', 'experimentId', 'rev', 'ops']);
  var pmid = validate.pmid(p.pmid);
  var experimentId = validate.int(p.experimentId, 'experimentId', {min: 0, max: 1000000000});
  var rev = validate.has(p, 'rev') ? validate.int(p.rev, 'rev', {min: 0, max: 1000000000}) : 0;
  var ops = tableOps.validateOps(p.ops);
  rateLimit.check(user.id, 'editExperiment');

  return withLock(`pmid:${pmid}`, async () => {
    var article = await findArticle(pmid);
    var data = articleData(article);
    if (rev !== data.rev) {
      fail(CODES.CONFLICT, `Conflict: the article is now at rev ${data.rev}`);
    }
    var result = tableOps.applyOps(data.Experiments, experimentId, ops);
    if (!result.changed.length) {
      return {rev: data.rev, experiments: []};
    }
    var newRev = data.rev + 1;

    // The revision is written first: an orphan revision (crash before the update) is harmless.
    var revision = new Parse.Object('Revision');
    revision.setACL(new Parse.ACL());
    revision.set('pmid', pmid);
    revision.set('rev', newRev);
    revision.set('user', user.id);
    revision.set('login', login);
    revision.set('ops', ops);
    revision.set('before', result.before);
    await revision.save(null, MASTER);

    article.set('Experiments', result.experiments);
    article.set('rev', newRev);
    await article.save(null, MASTER);

    return {rev: newRev, experiments: result.changed};
  });
});
