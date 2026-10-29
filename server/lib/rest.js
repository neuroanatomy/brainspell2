// Tiny Parse REST client for the maintenance scripts. URL, application id and master key
// come from the environment (PARSE_URL, PARSE_APP_ID, PARSE_MASTER_KEY), never from
// arguments, and are never printed.

const http = require('http');
const https = require('https');
const {URL} = require('url');

function config() {
  const missing = ['PARSE_URL', 'PARSE_APP_ID', 'PARSE_MASTER_KEY'].filter((k) => !process.env[k]);
  if (missing.length) {
    throw new Error(`Missing environment variables: ${missing.join(', ')}`);
  }

  return {
    base: process.env.PARSE_URL.replace(/\/+$/, ''),
    appId: process.env.PARSE_APP_ID,
    masterKey: process.env.PARSE_MASTER_KEY
  };
}

/**
 * Send a REST request with the master key.
 * @param {string} method HTTP method
 * @param {string} path Path below the server URL, starting with /
 * @param {Object} [body] JSON body
 * @returns {Promise<{status: number, json: any}>} Answer (json is null if not JSON)
 */
function request(method, path, body) {
  const c = config();

  return new Promise((resolve, reject) => {
    const url = new URL(c.base + path);
    const lib = url.protocol === 'http:' ? http : https;
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const headers = {
      'X-Parse-Application-Id': c.appId,
      'X-Parse-Master-Key': c.masterKey,
      'Content-Type': 'application/json'
    };
    if (payload) {
      headers['Content-Length'] = payload.length;
    }
    const req = lib.request(url, {method, headers, timeout: 60000}, (res) => {
      const chunks = [];
      res.on('data', (d) => chunks.push(d));
      res.on('end', () => {
        let json = null;
        try {
          json = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch (e) {
          json = null;
        }
        resolve({status: res.statusCode, json});
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (e) => reject(new Error(`request failed: ${e.code || e.message}`)));
    if (payload) {
      req.write(payload);
    }
    req.end();
  });
}

module.exports = {request, config};
