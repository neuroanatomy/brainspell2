// Local HTTP stubs for PubMed (efetch) and Solr (update handler), and a test environment.

const http = require('http');
const {setup} = require('../helpers/env');

function listen(handler) {
  const server = http.createServer(handler);

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({
      server, port: server.address().port, close: () => new Promise((r) => server.close(r))
    }));
  });
}

/**
 * PubMed stub: GET ?db=pubmed&id=N&retmode=xml answers records[N] (a string), or an empty
 * set when absent. state.mode: 'ok' | 'error500' | 'garbage' | 'hang-up'; state.delayMs.
 * @param {Object} records pmid -> xml
 * @returns {Promise<Object>} {url, state, calls, close}
 */
async function startPubmed(records) {
  const state = {mode: 'ok', delayMs: 0, calls: []};
  const s = await listen((req, res) => {
    const u = new URL(req.url, 'http://x');
    state.calls.push({time: Date.now(), params: Object.fromEntries(u.searchParams)});
    const answer = () => {
      if (state.mode === 'hang-up') {
        req.socket.destroy();

        return;
      }
      if (state.mode === 'error500') {
        res.writeHead(500);
        res.end('boom');

        return;
      }
      if (state.mode === 'garbage') {
        res.writeHead(200, {'content-type': 'text/xml'});
        res.end('<not-closed');

        return;
      }
      const xml = records[u.searchParams.get('id')];
      res.writeHead(200, {'content-type': 'text/xml'});
      res.end(xml || '<?xml version="1.0"?><PubmedArticleSet></PubmedArticleSet>');
    };
    if (state.delayMs) {
      setTimeout(answer, state.delayMs);
    } else {
      answer();
    }
  });

  return {url: `http://127.0.0.1:${s.port}/entrez/eutils/efetch.fcgi`, state, calls: state.calls, close: s.close};
}

/**
 * Solr update stub. state.failures = number of requests to refuse with 500 before accepting.
 * @returns {Promise<Object>} {url, state, docs, calls, close}
 */
async function startSolr() {
  const state = {failures: 0, docs: [], calls: []};
  const s = await listen((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      state.calls.push({method: req.method, url: req.url, type: req.headers['content-type']});
      if (state.failures > 0) {
        state.failures -= 1;
        res.writeHead(500);
        res.end('{}');

        return;
      }
      try {
        state.docs.push(...JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (e) {
        res.writeHead(400);
        res.end('{}');

        return;
      }
      res.writeHead(200, {'content-type': 'application/json'});
      res.end('{"responseHeader":{"status":0,"QTime":1}}');
    });
  });

  return {url: `http://127.0.0.1:${s.port}/solr/brainspell/update?commit=true`, state, docs: state.docs, calls: state.calls, close: s.close};
}

/**
 * Environment with GitHub users alice (1) and bob (2), PubMed and Solr stubs.
 * @param {Object} [records] pmid -> xml for the PubMed stub
 * @returns {Promise<Object>} setup() result plus alice, bob, pubmed, solr, expectCode, close
 */
async function withStubs(records) {
  const env = await setup({'token-1': {id: 1, login: 'alice'}, 'token-2': {id: 2, login: 'bob'}});
  env.pubmed = await startPubmed(records || {});
  env.solr = await startSolr();
  process.env.PUBMED_URL = env.pubmed.url;
  process.env.SOLR_UPDATE_URL = env.solr.url;
  env.lib('pubmed').setMinGap(0);
  env.lib('solr').setRetryDelay(0);
  env.alice = env.fake.addGithubUser(1);
  env.bob = env.fake.addGithubUser(2);
  const assert = require('node:assert');
  env.expectCode = async (promise, code, re) => {
    await assert.rejects(promise, (e) => e.code === code && (!re || re.test(e.message)), `expected ${code} ${re || ''}`);
  };
  const baseClose = env.close;
  env.close = async () => {
    await env.pubmed.close();
    await env.solr.close();
    delete process.env.PUBMED_URL;
    delete process.env.SOLR_UPDATE_URL;
    await baseClose();
  };

  return env;
}

module.exports = {withStubs, startPubmed, startSolr};
