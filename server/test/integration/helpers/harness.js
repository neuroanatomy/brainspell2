// Integration harness: starts the real server/app.js on a throwaway database and ports,
// with a stub of api.github.com and a stub of Solr, applies the schema, and offers a REST
// client and user creation. See ../README.md.
//
// Environment (all optional):
//   TEST_MONGO_URI        MongoDB server, WITHOUT database name   (default mongodb://127.0.0.1:27017)
//   TEST_PARSE_PORT       default 18337
//   TEST_LIVEQUERY_PORT   default 18080
// The database name is random (brainspell_it_<hex>) and is dropped at the end.
// Keys are random and used only for this run.

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const {spawn, execFile} = require('child_process');

const serverDir = path.resolve(__dirname, '..', '..', '..');

function hex(n) {
  return crypto.randomBytes(n).toString('hex');
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function httpJson(method, urlString, headers, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlString);
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const h = Object.assign({'Content-Type': 'application/json'}, headers);
    if (payload) {
      h['Content-Length'] = payload.length;
    }
    const req = http.request(url, {method, headers: h, timeout: 60000}, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try {
          json = JSON.parse(text);
        } catch (e) {
          json = null;
        }
        resolve({status: res.statusCode, json, text});
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    if (payload) {
      req.write(payload);
    }
    req.end();
  });
}

async function start() {
  const base = (process.env.TEST_MONGO_URI || 'mongodb://127.0.0.1:27017').replace(/\/+$/, '');
  if (/^mongodb(\+srv)?:\/\/[^/]*\/./.test(base)) {
    throw new Error('TEST_MONGO_URI must not contain a database name (a random one is used)');
  }
  const dbName = `brainspell_it_${hex(4)}`;
  const port = Number(process.env.TEST_PARSE_PORT || 18337);
  const lqPort = Number(process.env.TEST_LIVEQUERY_PORT || 18080);
  const appId = `it-${hex(8)}`;
  const masterKey = `it-${hex(16)}`;
  const serverURL = `http://127.0.0.1:${port}/parse`;

  // GitHub stub: token -> {id, login}. Answers GET /user for "token X" and "bearer X".
  const accounts = {};
  const githubCalls = [];
  const githubServer = http.createServer((req, res) => {
    const m = /^(?:token|bearer) (.+)$/i.exec(req.headers.authorization || '');
    githubCalls.push(req.url);
    const acc = m && accounts[m[1]];
    if (req.url !== '/user' || !acc) {
      res.writeHead(401, {'content-type': 'application/json'});
      res.end('{"message":"Bad credentials"}');

      return;
    }
    res.writeHead(200, {'content-type': 'application/json'});
    res.end(JSON.stringify(acc));
  });
  const githubPort = await listen(githubServer);

  // Solr stub: remembers the queries it receives.
  const solrCalls = [];
  const solrServer = http.createServer((req, res) => {
    solrCalls.push(new URL(req.url, 'http://x').searchParams);
    res.writeHead(200, {'content-type': 'application/json'});
    res.end(JSON.stringify({response: {numFound: 1, start: 0, maxScore: 1, docs: [{id: 'a', score: 1}]}}));
  });
  const solrPort = await listen(solrServer);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bs-it-'));
  const configPath = path.join(tmp, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({
    githubConfig: {clientId: 'it-client', clientSecret: `it-${hex(8)}`},
    parseConfig: {
      appId,
      masterKey,
      appName: 'brainspell-it',
      cloud: path.join(serverDir, 'cloud', 'main'),
      allowClientClassCreation: false,
      enableAnonymousUsers: false,
      databaseURI: `${base}/${dbName}`,
      serverURL,
      auth: {github: {module: path.join(__dirname, 'github-adapter.js')}},
      liveQuery: {classNames: ['RealTime']}
    }
  }), {mode: 0o600});

  const env = Object.assign({}, process.env, {
    CONFIG: configPath,
    PORT: String(port),
    LIVEQUERY_PORT: String(lqPort),
    GITHUB_API_URL: `http://127.0.0.1:${githubPort}`,
    SOLR_URL: `http://127.0.0.1:${solrPort}/solr/brainspell/select`
  });
  const child = spawn(process.execPath, ['app.js'], {cwd: serverDir, env, stdio: ['ignore', 'pipe', 'pipe']});
  let output = '';
  const keep = (d) => {
    output = (output + d.toString()).slice(-20000);
  };
  child.stdout.on('data', keep);
  child.stderr.on('data', keep);
  let exited = false;
  child.on('exit', () => {
    exited = true;
  });

  const ctx = {
    appId, masterKey, serverURL, dbName, accounts, githubCalls, solrCalls, serverDir,
    serverOutput: () => output,
    // REST call. opts: {session, master, body}
    async rest(method, p, opts) {
      const o = opts || {};
      const headers = {'X-Parse-Application-Id': appId};
      if (o.master) {
        headers['X-Parse-Master-Key'] = masterKey;
      }
      if (o.session) {
        headers['X-Parse-Session-Token'] = o.session;
      }

      return httpJson(method, serverURL + p, headers, o.body);
    },
    // Cloud function call; returns {status, json}. json.result or json.code.
    cloud(name, params, session) {
      return ctx.rest('POST', `/functions/${name}`, {session, body: params || {}});
    },
    // Create (or log in) a user through the real GitHub-authData path.
    async signup(login, githubId) {
      const token = `tok-${login}-${hex(4)}`;
      accounts[token] = {id: githubId, login};
      const res = await ctx.rest('POST', '/users', {body: {authData: {github: {id: String(githubId), access_token: token}}}});
      if (res.status !== 200 && res.status !== 201) {
        throw new Error(`signup of ${login} failed: ${res.status} ${res.text}`);
      }

      return {login, githubId, token, id: res.json.objectId, session: res.json.sessionToken};
    },
    // Run a script of server/scripts with the credentials in its environment.
    runScript(script, args) {
      return new Promise((resolve) => {
        execFile(process.execPath, [path.join(serverDir, 'scripts', script)].concat(args || []), {
          env: Object.assign({}, process.env, {PARSE_URL: serverURL, PARSE_APP_ID: appId, PARSE_MASTER_KEY: masterKey}),
          cwd: serverDir
        }, (err, stdout, stderr) => resolve({code: err ? err.code : 0, stdout, stderr}));
      });
    },
    async stop() {
      child.kill('SIGTERM');
      await new Promise((r) => (exited ? r() : child.on('exit', r)));
      await new Promise((r) => githubServer.close(r));
      await new Promise((r) => solrServer.close(r));
      try {
        const {MongoClient} = require('mongodb');
        const client = await MongoClient.connect(base, {useUnifiedTopology: true});
        await client.db(dbName).dropDatabase();
        await client.close();
      } catch (e) {
        console.log(`(could not drop database ${dbName}: ${e.message})`);
      }
      fs.rmSync(tmp, {recursive: true, force: true});
    }
  };

  async function waitForParse() {
    const deadline = Date.now() + 60000;
    for (;;) {
      if (exited) {
        await new Promise((r) => setTimeout(r, 100));
        throw new Error(`server exited during start-up:\n${output}`);
      }
      try {
        const res = await httpJson('GET', `${serverURL}/health`, {});
        if (res.status === 200) {
          break;
        }
      } catch (e) {
        // not listening yet
      }
      if (Date.now() > deadline) {
        child.kill('SIGTERM');
        throw new Error(`server did not start:\n${output}`);
      }
      await new Promise((r) => setTimeout(r, 300));
    }
  }

  // wait for Parse
  try {
    await waitForParse();
  } catch (e) {
    await ctx.stop();
    throw e;
  }

  // first application of the schema
  ctx.firstApply = await ctx.runScript('apply-schema.js');
  if (ctx.firstApply.code !== 0) {
    await ctx.stop();
    throw new Error(`apply-schema failed on the first run:\n${ctx.firstApply.stdout}\n${ctx.firstApply.stderr}`);
  }

  return ctx;
}

module.exports = {start, serverDir};
