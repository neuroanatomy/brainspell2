// Solr search, hardened (plan, section 3.7). Same response as before: Solr's `response`.

var request = require('request-promise');
var {fail, CODES} = require('../lib/errors');
var validate = require('../lib/validate');

var ALLOWED = ['q', 'fl', 'defType', 'qf', 'start', 'rows', 'q.op'];
var QF = ['Abstract Title', 'Title', 'Abstract', 'Authors'];
var FL = [
  '* score', '*', 'id', 'id score', 'score,id', 'id,score', 'id Title', 'id Title score',
  'id Title Authors', 'id Title Authors score', 'id Title Authors Abstract', 'id Title Authors Abstract score'
];
var QOP = ['OR', 'AND'];

function solrURL() {
  return process.env.SOLR_URL || 'http://localhost:8983/solr/brainspell/select';
}

function clean(params) {
  var p = validate.noUnknown(params, ALLOWED);
  var q = validate.str(p.q, 'q', {min: 1, max: 1000});
  if (q.indexOf('{!') !== -1 || /_query_/i.test(q) || /\$\{/.test(q)) {
    fail(CODES.VALIDATION, 'q: local parameters and nested queries are not allowed');
  }
  var qs = {q: q};
  qs.defType = validate.has(p, 'defType') ? validate.oneOf(p.defType, 'defType', ['edismax']) : 'edismax';
  qs.qf = validate.has(p, 'qf') ? validate.oneOf(p.qf, 'qf', QF) : 'Abstract Title';
  qs.fl = validate.has(p, 'fl') ? validate.oneOf(p.fl, 'fl', FL) : '* score';
  if (validate.has(p, 'q.op')) {
    qs['q.op'] = validate.oneOf(p['q.op'], 'q.op', QOP);
  }
  if (validate.has(p, 'start')) {
    qs.start = validate.int(p.start, 'start', {min: 0, max: 100000});
  }
  if (validate.has(p, 'rows')) {
    qs.rows = validate.int(p.rows, 'rows', {min: 0, max: 50});
  }

  return qs;
}

Parse.Cloud.define('select', async (req) => {
  var qs = clean(req.params);
  var res;
  try {
    res = await request({url: solrURL(), qs: qs, timeout: 15000});
  } catch (e) {
    return fail(CODES.UPSTREAM, 'Search is not available');
  }

  return JSON.parse(res).response;
});

module.exports = {clean};
