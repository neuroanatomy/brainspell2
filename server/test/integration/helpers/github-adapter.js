// Parse Server auth adapter for the integration tests: validates GitHub authData against
// the stub GitHub server (GITHUB_API_URL) instead of api.github.com. Same contract as
// Parse's own github adapter: the token must belong to the claimed id.

const http = require('http');
const {URL} = require('url');
const Parse = require('parse/node').Parse;

function validateAuthData(authData) {
  return new Promise((resolve, reject) => {
    const url = new URL(`${process.env.GITHUB_API_URL}/user`);
    const req = http.request(url, {method: 'GET', headers: {Authorization: `bearer ${authData.access_token}`, 'User-Agent': 'parse-server'}}, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        let data = null;
        try {
          data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch (e) {
          data = null;
        }
        if (res.statusCode === 200 && data && String(data.id) === String(authData.id)) {
          resolve();
        } else {
          reject(new Parse.Error(Parse.Error.OBJECT_NOT_FOUND, 'Github auth is invalid for this user.'));
        }
      });
    });
    req.on('error', () => reject(new Parse.Error(Parse.Error.OBJECT_NOT_FOUND, 'Github auth is invalid for this user.')));
    req.end();
  });
}

function validateAppId() {
  return Promise.resolve();
}

module.exports = {validateAuthData, validateAppId};
