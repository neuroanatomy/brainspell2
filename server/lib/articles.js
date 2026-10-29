// Shared readers for the annotation cloud functions. All use the master key.

const {fail, CODES} = require('./errors');

const MASTER = {useMasterKey: true};
const PAGE = 1000;
const VOTE_CAP = 5000;

/**
 * Find an article by PMID.
 * @param {string} pmid Validated PMID
 * @returns {Promise<Parse.Object>} The Articles object
 * @throws Parse.Error 101
 */
async function findArticle(pmid) {
  const q = new Parse.Query('Articles');
  q.equalTo('PMID', pmid);
  const article = await q.first(MASTER);
  if (!article) {
    return fail(CODES.NOT_FOUND, 'Article not found');
  }

  return article;
}

/**
 * Plain view of the parts of an Articles object used by the vote logic.
 * @param {Parse.Object} article Articles object
 * @returns {{rev: number, Experiments: Array, Metadata: Object}} Plain data
 */
function articleData(article) {
  const rev = article.get('rev');

  return {
    rev: typeof rev === 'number' ? rev : 0,
    Experiments: Array.isArray(article.get('Experiments')) ? article.get('Experiments') : [],
    Metadata: article.get('Metadata') && typeof article.get('Metadata') === 'object' ? article.get('Metadata') : {}
  };
}

/**
 * Plain view of a Vote object.
 * @param {Parse.Object} o Vote object
 * @returns {Object} Plain row
 */
function voteRow(o) {
  const updated = o.updatedAt || o.createdAt;

  return {
    id: o.id,
    user: o.get('user'),
    login: o.get('login'),
    pmid: o.get('pmid'),
    experimentId: o.get('experimentId'),
    kind: o.get('kind'),
    ontology: o.get('ontology') === undefined ? null : o.get('ontology'),
    tag: o.get('tag'),
    value: o.get('value'),
    number: o.get('number') === undefined ? null : o.get('number'),
    updatedAt: updated ? updated.getTime() : 0
  };
}

/**
 * Read the Vote rows of an article, newest first, capped at 5000.
 * @param {string} pmid Validated PMID
 * @returns {Promise<Object[]>} Plain rows
 */
async function loadVoteRows(pmid) {
  const rows = [];
  for (let skip = 0; skip < VOTE_CAP; skip += PAGE) {
    const q = new Parse.Query('Vote');
    q.equalTo('pmid', pmid);
    q.descending('createdAt');
    q.addDescending('objectId');
    q.limit(Math.min(PAGE, VOTE_CAP - skip));
    q.skip(skip);
    const page = await q.find(MASTER);
    rows.push(...page.map(voteRow));
    if (page.length < PAGE) {
      break;
    }
  }

  return rows;
}

/**
 * Newest 200 comments of an article, oldest first, and the total count.
 * @param {string} pmid Validated PMID
 * @returns {Promise<{comments: Object[], commentCount: number}>} Comments
 */
async function loadComments(pmid) {
  const q = new Parse.Query('Comment');
  q.equalTo('pmid', pmid);
  q.descending('createdAt');
  q.addDescending('objectId');
  q.limit(200);
  const list = await q.find(MASTER);
  const c = new Parse.Query('Comment');
  c.equalTo('pmid', pmid);
  const commentCount = await c.count(MASTER);

  return {
    comments: list.reverse().map((o) => ({
      id: o.id,
      login: o.get('login'),
      text: o.get('text'),
      createdAt: o.createdAt.toISOString()
    })),
    commentCount
  };
}

module.exports = {findArticle, articleData, voteRow, loadVoteRows, loadComments, MASTER};
