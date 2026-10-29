// getAnnotations, vote, setStereoSpace, setNSubjects (plan, sections 3.3, 3.4 and 4.3).
// Votes are rows; counts are computed on read; writes are serialised per user.

var {fail, CODES} = require('../lib/errors');
var validate = require('../lib/validate');
var {requireGithubUser} = require('../lib/auth');
var {withLock} = require('../lib/locks');
var rateLimit = require('../lib/rate-limit');
var {tagKey, cleanName} = require('../lib/normalize');
var logic = require('../lib/votes-logic');
var {findArticle, articleData, loadVoteRows, loadComments, voteRow, MASTER} = require('../lib/articles');

var CONCEPT_PAGE = 1000;
var CONCEPT_MAX = 10000;
var MAX_VOTES_PER_ARTICLE = 300;

function newVote(user, login, pmid, fields) {
  var o = new Parse.Object('Vote');
  o.setACL(new Parse.ACL());
  o.set('user', user.id);
  o.set('login', login);
  o.set('pmid', pmid);
  Object.keys(fields).forEach((k) => o.set(k, fields[k]));

  return o;
}

// Rows of the caller for a query, newest first. `refine` filters in memory.
async function myRows(user, pmid, kind, setup) {
  var q = new Parse.Query('Vote');
  q.equalTo('user', user.id);
  q.equalTo('pmid', pmid);
  if (kind) {
    q.equalTo('kind', kind);
  }
  if (setup) {
    setup(q);
  }
  q.descending('updatedAt');
  q.addDescending('objectId');
  q.limit(1000);

  return q.find(MASTER);
}

// Apply a decision to the newest row; delete any older duplicate of the same key.
async function apply(decision, current, extras, create, changes) {
  if (decision.op === 'create') {
    await create().save(null, MASTER);
  } else if (decision.op === 'update') {
    Object.keys(changes).forEach((k) => current.set(k, changes[k]));
    await current.save(null, MASTER);
  } else if (decision.op === 'delete') {
    await current.destroy(MASTER);
  }
  for (var i = 0; i < extras.length; i++) {
    await extras[i].destroy(MASTER);
  }
}

async function findConceptName(ontology, key) {
  var q = new Parse.Query('Concept');
  q.equalTo('ontology', ontology);
  q.limit(CONCEPT_PAGE);
  for (var skip = 0; skip < CONCEPT_MAX; skip += CONCEPT_PAGE) {
    q.skip(skip);
    var page = await q.find(MASTER);
    for (var i = 0; i < page.length; i++) {
      var name = page[i].get('name');
      if (typeof name === 'string' && tagKey(name) === key) {
        return name;
      }
    }
    if (page.length < CONCEPT_PAGE) {
      break;
    }
  }

  return null;
}

function findExperiment(article, experimentId) {
  return article.Experiments.find((e) => e && Number(e.id) === experimentId) || null;
}

// Canonical spelling of the tag, or a 142 error naming the field.
async function canonicalTag(article, kind, experimentId, ontology, tag) {
  var key = tagKey(tag);
  if (kind === 'tableOk') {
    return 'ok';
  }
  if (kind === 'mesh') {
    var headings = Array.isArray(article.Metadata.meshHeadings) ? article.Metadata.meshHeadings : [];
    var h = headings.find((x) => x && typeof x.name === 'string' && tagKey(x.name) === key);
    if (!h) {
      fail(CODES.VALIDATION, 'tag: not a MeSH heading of this article');
    }

    return h.name;
  }
  var concept = await findConceptName(ontology, key);
  if (concept) {
    return concept;
  }
  var exp = findExperiment(article, experimentId);
  var legacy = exp && Array.isArray(exp.tags) ?
    exp.tags.find((t) => t && t.ontology === ontology && typeof t.name === 'string' && tagKey(t.name) === key) : null;
  if (!legacy) {
    fail(CODES.VALIDATION, 'tag: unknown term for this ontology');
  }

  return legacy.name;
}

Parse.Cloud.define('getAnnotations', async (request) => {
  var params = validate.noUnknown(request.params, ['pmid']);
  var pmid = validate.pmid(params.pmid);
  var userId = request.user ? request.user.id : null;
  var article = articleData(await findArticle(pmid));
  var rows = await loadVoteRows(pmid);
  var stereo = logic.buildStereo(article, rows, userId);
  var com = await loadComments(pmid);

  return {
    pmid: pmid,
    rev: article.rev,
    votes: logic.buildVotes(article, rows, userId),
    stereo: stereo,
    nsubjects: logic.buildNSubjects(article, rows, userId),
    comments: com.comments,
    commentCount: com.commentCount,
    truncated: rows.truncated === true
  };
});

Parse.Cloud.define('vote', async (request) => {
  var {user, login, githubId} = await requireGithubUser(request);
  var p = validate.noUnknown(request.params, ['pmid', 'experimentId', 'kind', 'ontology', 'tag', 'value']);
  var pmid = validate.pmid(p.pmid);
  var kind = validate.oneOf(p.kind, 'kind', logic.VOTE_KINDS);
  var value = validate.oneOf(p.value, 'value', [1, -1, 0]);
  var experimentId;
  var ontology = null;
  var tag;
  if (kind === 'mesh') {
    experimentId = validate.has(p, 'experimentId') ? validate.oneOf(p.experimentId, 'experimentId', [-1]) : -1;
  } else {
    experimentId = validate.int(p.experimentId, 'experimentId', {min: 0, max: 1000000000});
  }
  if (kind === 'tag') {
    ontology = validate.oneOf(p.ontology, 'ontology', logic.ONTOLOGIES);
  } else if (validate.has(p, 'ontology') && p.ontology !== null) {
    fail(CODES.VALIDATION, `ontology: not allowed for kind ${kind}`);
  }
  if (kind === 'tableOk') {
    tag = validate.has(p, 'tag') ? validate.oneOf(p.tag, 'tag', ['ok']) : 'ok';
  } else {
    tag = cleanName(validate.str(p.tag, 'tag', {min: 1, max: 500}));
    if (!tag) {
      fail(CODES.VALIDATION, 'tag: must not be empty');
    }
  }
  rateLimit.check(String(githubId), 'vote');

  return withLock(`user:${githubId}`, async () => {
    var article = articleData(await findArticle(pmid));
    if (value !== 0) {
      if (kind !== 'mesh' && !findExperiment(article, experimentId)) {
        fail(CODES.VALIDATION, 'experimentId: no such experiment in this article');
      }
      tag = await canonicalTag(article, kind, experimentId, ontology, tag);
    }
    var key = tagKey(tag);
    var found = (await myRows(user, pmid, kind, (q) => {
      q.equalTo('experimentId', experimentId);
      if (kind === 'tag') {
        q.equalTo('ontology', ontology);
      }
    })).filter((o) => typeof o.get('tag') === 'string' && tagKey(o.get('tag')) === key);
    var current = found[0] || null;
    var decision = logic.decide(current ? {value: current.get('value')} : null, value);
    if (decision.op === 'create') {
      var mine = await myRows(user, pmid, null);
      var keys = new Set(mine.filter((o) => logic.VOTE_KINDS.includes(o.get('kind'))).map((o) => logic.rowKey(voteRow(o))));
      if (keys.size >= MAX_VOTES_PER_ARTICLE) {
        fail(CODES.VALIDATION, `value: at most ${MAX_VOTES_PER_ARTICLE} different votes per user and article`);
      }
    }
    await apply(decision, current, found.slice(1),
      () => newVote(user, login, pmid, {
        experimentId: experimentId, kind: kind, ontology: ontology, tag: tag, value: value, number: null
      }),
      {value: value, login: login});
    var entries = logic.buildEntries(article, await loadVoteRows(pmid), user.id);
    var e = logic.findEntry(entries, kind, experimentId, ontology, tag) ||
      {agree: 0, disagree: 0, mine: 0};

    return {
      kind: kind, experimentId: experimentId, ontology: ontology, tag: e.tag || tag,
      agree: e.agree, disagree: e.disagree, mine: e.mine
    };
  });
});

Parse.Cloud.define('setStereoSpace', async (request) => {
  var {user, login, githubId} = await requireGithubUser(request);
  var p = validate.noUnknown(request.params, ['pmid', 'space']);
  var pmid = validate.pmid(p.pmid);
  if (p.space === undefined) {
    fail(CODES.VALIDATION, 'space: required (use null to retract)');
  }
  var space = p.space === null ? null : validate.oneOf(p.space, 'space', logic.SPACES);
  rateLimit.check(String(githubId), 'vote');

  return withLock(`user:${githubId}`, async () => {
    var article = articleData(await findArticle(pmid));
    var found = await myRows(user, pmid, 'space');
    var current = found[0] || null;
    var decision = logic.decideReplace(current ? current.get('tag') : null, space);
    await apply(decision, current, found.slice(1),
      () => newVote(user, login, pmid, {
        experimentId: -1, kind: 'space', ontology: null, tag: space, value: 1, number: null
      }),
      {tag: space, login: login});
    var s = logic.buildStereo(article, await loadVoteRows(pmid), user.id);

    return {MNI: s.MNI, Talairach: s.Talairach, mine: s.mine};
  });
});

Parse.Cloud.define('setNSubjects', async (request) => {
  var {user, login, githubId} = await requireGithubUser(request);
  var p = validate.noUnknown(request.params, ['pmid', 'n']);
  var pmid = validate.pmid(p.pmid);
  if (p.n === undefined) {
    fail(CODES.VALIDATION, 'n: required (use null to retract)');
  }
  var n = p.n === null ? null : validate.int(p.n, 'n', {min: 1, max: 100000});
  rateLimit.check(String(githubId), 'vote');

  return withLock(`user:${githubId}`, async () => {
    var article = articleData(await findArticle(pmid));
    var found = await myRows(user, pmid, 'nsubjects');
    var current = found[0] || null;
    var decision = logic.decideReplace(current ? current.get('number') : null, n);
    await apply(decision, current, found.slice(1),
      () => newVote(user, login, pmid, {
        experimentId: -1, kind: 'nsubjects', ontology: null, tag: 'n', value: 1, number: n
      }),
      {number: n, login: login});

    return logic.buildNSubjects(article, await loadVoteRows(pmid), user.id);
  });
});
