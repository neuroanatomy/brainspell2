// Minimal GitHub API client (GET /user). The API base can be redirected with the
// GITHUB_API_URL environment variable (used by the tests); default is the real API.
// The access token is only sent in the Authorization header and is never logged.

const http = require('http');
const https = require('https');
const {URL} = require('url');
const {fail, CODES} = require('./errors');

const TIMEOUT_MS = 8000;
const MAX_BYTES = 1024 * 1024;

function baseUrl() {
  return (process.env.GITHUB_API_URL || 'https://api.github.com').replace(/\/+$/, '');
}

function get(urlString, headers) {
  return new Promise((resolve, reject) => {
    let url;
    try {
      url = new URL(urlString);
    } catch (e) {
      reject(new Error('bad GitHub API URL'));

      return;
    }
    const lib = url.protocol === 'http:' ? http : https;
    const req = lib.request(url, {method: 'GET', headers, timeout: TIMEOUT_MS}, (res) => {
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
    req.end();
  });
}

/**
 * Ask GitHub who owns an access token.
 * @param {string} accessToken GitHub OAuth access token of the user
 * @returns {Promise<{id: number, login: string}>} Verified account
 * @throws Parse.Error 119 when GitHub rejects the token, 1002 on any other failure
 */
async function fetchUser(accessToken) {
  if (typeof accessToken !== 'string' || !accessToken || /[\s\u0000-\u001f]/.test(accessToken)) {
    return fail(CODES.FORBIDDEN, 'Missing or malformed GitHub token');
  }
  let res;
  try {
    res = await get(`${baseUrl()}/user`, {
      Authorization: `token ${accessToken}`,
      'User-Agent': 'brainspell',
      Accept: 'application/vnd.github+json'
    });
  } catch (e) {
    return fail(CODES.UPSTREAM, 'GitHub is not reachable');
  }
  if (res.status === 401) {
    return fail(CODES.FORBIDDEN, 'GitHub rejected the token');
  }
  if (res.status !== 200) {
    return fail(CODES.UPSTREAM, `GitHub answered ${res.status}`);
  }
  let data;
  try {
    data = JSON.parse(res.body);
  } catch (e) {
    return fail(CODES.UPSTREAM, 'GitHub answered something that is not JSON');
  }
  const id = data && data.id;
  const login = data && data.login;
  if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0 ||
    typeof login !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9-_]{0,38}$/.test(login)) {
    return fail(CODES.UPSTREAM, 'Unexpected answer from GitHub');
  }

  return {id, login};
}

module.exports = {fetchUser};
