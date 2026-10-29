// addArticle (plan, sections 3.7 and 4.3): create an article from its PubMed record.

var {fail, CODES} = require('../lib/errors');
var validate = require('../lib/validate');
var {requireGithubUser} = require('../lib/auth');
var {withLock} = require('../lib/locks');
var rateLimit = require('../lib/rate-limit');
var pubmed = require('../lib/pubmed');
var solr = require('../lib/solr');
var {MASTER} = require('../lib/articles');

function emptyExperiments(n) {
  var list = [];
  for (var i = 1; i <= n; i++) {
    list.push({id: i, title: '', caption: '', locations: [], tags: []});
  }

  return list;
}

Parse.Cloud.define('addArticle', async (request) => {
  var {user, githubId} = await requireGithubUser(request);
  var p = validate.noUnknown(request.params, ['pmid', 'nTables']);
  var pmid = validate.pmid(p.pmid);
  var nTables = validate.has(p, 'nTables') ? validate.int(p.nTables, 'nTables', {min: 0, max: 50}) : 1;
  rateLimit.check(String(githubId), 'addArticle');

  return withLock(`pmid:${pmid}`, async () => {
    var q = new Parse.Query('Articles');
    q.equalTo('PMID', pmid);
    if (await q.first(MASTER)) {
      fail(CODES.EXISTS, 'This article already exists');
    }
    var rec = await pubmed.fetchRecord(pmid);

    var article = new Parse.Object('Articles');
    var acl = new Parse.ACL();
    acl.setPublicReadAccess(true);
    article.setACL(acl);
    article.set('Title', rec.Title);
    article.set('Authors', rec.Authors);
    article.set('Abstract', rec.Abstract);
    article.set('Reference', rec.Reference);
    article.set('PMID', pmid);
    article.set('DOI', rec.DOI);
    article.set('Timestamp', new Date().toISOString().slice(0, 10));
    article.set('Experiments', emptyExperiments(nTables));
    article.set('Metadata', {meshHeadings: rec.meshHeadings});
    article.set('rev', 0);
    article.set('indexed', false);
    await article.save(null, MASTER);

    var indexed = await solr.index({id: article.id, Title: rec.Title, Authors: rec.Authors, Abstract: rec.Abstract});
    if (indexed) {
      article.set('indexed', true);
      try {
        await article.save(null, MASTER);
      } catch (e) {
        indexed = false;
      }
    }

    return {objectId: article.id, pmid: pmid, indexed: indexed};
  });
});
