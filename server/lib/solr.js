// Posts a document to Solr's update handler (JSON update format, as admin/populate-solr.sh
// does). The URL comes from SOLR_UPDATE_URL; default is the local core.

const http = require('http');
const https = require('https');
const {URL} = require('url');

const DEFAULT_URL = 'http://localhost:8983/solr/brainspell/update?commit=true';
const TIMEOUT_MS = 10000;
const MAX_BYTES = 1024 * 1024;

let retryDelayMs = 500;

function updateUrl() {
  return process.env.SOLR_UPDATE_URL || DEFAULT_URL;
}

function post(urlString, payload) {
  return new Promise((resolve, reject) => {
    let url;
    try {
      url = new URL(urlString);
    } catch (e) {
      reject(new Error('bad Solr URL'));

      return;
    }
    const lib = url.protocol === 'http:' ? http : https;
    const body = Buffer.from(JSON.stringify(payload));
    const req = lib.request(url, {
      method: 'POST',
      headers: {'Content-Type': 'application/json', 'Content-Length': body.length},
      timeout: TIMEOUT_MS
    }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
        size += c.length;
        if (size > MAX_BYTES) {
          req.destroy(new Error('response too large'));

          return;
        }
        chunks.push(c);
      });
      res.on('end', () => resolve({status: res.statusCode, body: Buffer.concat(chunks).toString('utf8')}));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/**
 * Post one document once.
 * @param {{id: string, Title: string, Authors: string, Abstract: string}} doc Solr document
 * @returns {Promise<boolean>} true when Solr accepted it
 */
async function tryIndex(doc) {
  try {
    const res = await post(updateUrl(), [doc]);
    if (res.status < 200 || res.status > 299) {
      return false;
    }
    try {
      const json = JSON.parse(res.body);
      if (json && json.responseHeader && json.responseHeader.status !== undefined && json.responseHeader.status !== 0) {
        return false;
      }
    } catch (e) {
      // a 2xx answer that is not JSON is accepted
    }

    return true;
  } catch (e) {
    return false;
  }
}

/**
 * Post a document to Solr, with one retry.
 * @param {{id: string, Title: string, Authors: string, Abstract: string}} doc Solr document
 * @returns {Promise<boolean>} true when indexed
 */
async function index(doc) {
  const document = {id: doc.id, Title: doc.Title, Authors: doc.Authors, Abstract: doc.Abstract};
  if (await tryIndex(document)) {
    return true;
  }
  await new Promise((r) => setTimeout(r, retryDelayMs));

  return tryIndex(document);
}

/**
 * Change the pause before the retry (for tests).
 * @param {number} ms Milliseconds
 * @returns {void}
 */
function setRetryDelay(ms) {
  retryDelayMs = ms;
}

module.exports = {index, tryIndex, setRetryDelay, DEFAULT_URL};
