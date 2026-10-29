// editExperiment (plan, sections 3.5 and 4.3): the only way to change Articles.Experiments.

var {fail, CODES} = require('../lib/errors');
var validate = require('../lib/validate');
var {requireGithubUser} = require('../lib/auth');
var {withLock} = require('../lib/locks');
var rateLimit = require('../lib/rate-limit');
var tableOps = require('../lib/table-ops');
var {findArticle, articleData, MASTER} = require('../lib/articles');

Parse.Cloud.define('editExperiment', async (request) => {
  var {user, login, githubId} = await requireGithubUser(request);
  var p = validate.noUnknown(request.params, ['pmid', 'experimentId', 'rev', 'ops']);
  var pmid = validate.pmid(p.pmid);
  var experimentId = validate.int(p.experimentId, 'experimentId', {min: 0, max: 1000000000});
  var rev = validate.int(p.rev, 'rev', {min: 0, max: 1000000000});
  var ops = tableOps.validateOps(p.ops);
  rateLimit.check(String(githubId), 'editExperiment');

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

    // The revision is written first, with applied: false, and marked applied once the article
    // is updated. An unapplied revision (crash in between, or a failed update) is ignored by
    // readers; a retry first removes unapplied revisions of the same rev, so two applied
    // revisions with the same rev cannot exist.
    var stale = new Parse.Query('Revision');
    stale.equalTo('pmid', pmid);
    stale.equalTo('rev', newRev);
    stale.equalTo('applied', false);
    stale.limit(100);
    var old = await stale.find(MASTER);
    for (var i = 0; i < old.length; i++) {
      await old[i].destroy(MASTER);
    }
    var revision = new Parse.Object('Revision');
    revision.setACL(new Parse.ACL());
    revision.set('pmid', pmid);
    revision.set('rev', newRev);
    revision.set('user', user.id);
    revision.set('login', login);
    revision.set('ops', ops);
    revision.set('before', result.before);
    revision.set('applied', false);
    await revision.save(null, MASTER);

    article.set('Experiments', result.experiments);
    article.set('rev', newRev);
    await article.save(null, MASTER);
    revision.set('applied', true);
    await revision.save(null, MASTER);

    return {rev: newRev, experiments: result.changed};
  });
});
