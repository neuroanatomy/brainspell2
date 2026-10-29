// Test environment: a fresh fake Parse, a stub of api.github.com, and the cloud code loaded.

const http = require('http');
const path = require('path');
const fakeParse = require('./fake-parse');

const root = path.resolve(__dirname, '..', '..');

function clearModules() {
  for (const k of Object.keys(require.cache)) {
    if (k.startsWith(path.join(root, 'cloud') + path.sep) || k.startsWith(path.join(root, 'lib') + path.sep)) {
      delete require.cache[k];
    }
  }
}

// Stub GitHub: GET /user with `Authorization: token T` answers from `accounts[T]`.
function startGithubStub(accounts) {
  const calls = [];
  const server = http.createServer((req, res) => {
    calls.push({url: req.url, auth: req.headers.authorization});
    const m = /^token (.+)$/.exec(req.headers.authorization || '');
    const acc = m && accounts[m[1]];
    if (req.url !== '/user' || !acc) {
      res.writeHead(401, {'content-type': 'application/json'});
      res.end('{"message":"Bad credentials"}');

      return;
    }
    if (acc.status) {
      res.writeHead(acc.status);
      res.end('{}');

      return;
    }
    res.writeHead(200, {'content-type': 'application/json'});
    res.end(JSON.stringify(acc));
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        url: `http://127.0.0.1:${server.address().port}`,
        calls,
        accounts,
        close: () => new Promise((r) => server.close(r))
      });
    });
  });
}

/**
 * Create a fresh environment.
 * @param {Object} [accounts] token -> {id, login} served by the GitHub stub
 * @returns {Promise<Object>} {fake, run, github, close, loadLib}
 */
async function setup(accounts) {
  const fake = fakeParse.create();
  global.Parse = fake.Parse;
  clearModules();
  const github = await startGithubStub(accounts || {});
  process.env.GITHUB_API_URL = github.url;
  require(path.join(root, 'cloud', 'main.js'));

  return {
    fake,
    github,
    run: fake.run,
    lib: (name) => require(path.join(root, 'lib', name)),
    close: async () => {
      await github.close();
      delete process.env.GITHUB_API_URL;
      delete global.Parse;
      clearModules();
    }
  };
}

module.exports = {setup, ParseError: fakeParse.ParseError};
