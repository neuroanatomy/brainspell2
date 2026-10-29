// Identity (plan, section 3.1). The only trusted identity is request.user with a
// GitHub authData that Parse itself validated at login. The GitHub login name comes
// from GitHub (never from the client) and is cached in the master-only UserProfile class.

const {fail, CODES} = require('./errors');
const {withLock} = require('./locks');
const github = require('./github');

const MASTER = {useMasterKey: true};
const REFRESH_EVERY_MS = 60 * 1000;
const lastRefresh = new Map(); // userId -> time of the last successful GitHub check

function toGithubId(v) {
  const n = typeof v === 'string' && /^[0-9]{1,15}$/.test(v) ? Number(v) : v;

  return typeof n === 'number' && Number.isSafeInteger(n) && n > 0 ? n : null;
}

/**
 * Read the GitHub authData of a user with the master key.
 * @param {Parse.User} user request.user
 * @returns {Promise<{id: number, token: string}|null>} null if the user has no GitHub account
 */
async function githubAuthOf(user) {
  let authData;
  try {
    const full = await new Parse.Query(Parse.User).get(user.id, MASTER);
    authData = full.get('authData') || (full.toJSON() || {}).authData;
  } catch (e) {
    authData = null;
  }
  if (!authData) {
    authData = user.get('authData');
  }
  const gh = authData && authData.github;
  if (!gh || typeof gh !== 'object') {
    return null;
  }
  const id = toGithubId(gh.id);
  if (id === null) {
    return null;
  }

  return {id, token: gh.access_token};
}

async function findProfile(userId) {
  const q = new Parse.Query('UserProfile');
  q.equalTo('user', userId);

  return q.first(MASTER);
}

async function resolveProfile(user, refresh) {
  const auth = await githubAuthOf(user);
  if (!auth) {
    return fail(CODES.FORBIDDEN, 'A GitHub account is required');
  }

  return withLock(`profile:${user.id}`, async () => {
    const existing = await findProfile(user.id);
    const sameAccount = existing && existing.get('githubId') === auth.id;
    const fresh = Date.now() - (lastRefresh.get(user.id) || 0) < REFRESH_EVERY_MS;
    if (sameAccount && (!refresh || fresh)) {
      return {login: existing.get('login'), githubId: auth.id};
    }
    let gh;
    try {
      gh = await github.fetchUser(auth.token);
    } catch (e) {
      if (sameAccount && e && e.code === CODES.UPSTREAM) {
        return {login: existing.get('login'), githubId: auth.id};
      }
      throw e;
    }
    if (gh.id !== auth.id) {
      return fail(CODES.FORBIDDEN, 'GitHub account does not match the session');
    }
    lastRefresh.set(user.id, Date.now());
    let profile = existing;
    if (!profile) {
      profile = new Parse.Object('UserProfile');
      profile.setACL(new Parse.ACL());
      profile.set('user', user.id);
    }
    if (profile.get('login') !== gh.login || profile.get('githubId') !== gh.id || !existing) {
      profile.set('login', gh.login);
      profile.set('githubId', gh.id);
      await profile.save(null, MASTER);
    }

    return {login: gh.login, githubId: gh.id};
  });
}

/**
 * Require a logged in user that has a GitHub account.
 * @param {Object} request Parse cloud function request
 * @returns {Promise<{user: Parse.User, login: string, githubId: number}>} The verified identity
 * @throws Parse.Error 206 not logged in, 119 not a GitHub user, 1002 GitHub unreachable
 */
async function requireGithubUser(request) {
  if (!request || !request.user) {
    return fail(CODES.NOT_LOGGED_IN, 'Login required');
  }
  const {login, githubId} = await resolveProfile(request.user, false);

  return {user: request.user, login, githubId};
}

/**
 * Same as requireGithubUser, but asks GitHub again (at most once a minute per user)
 * so that a renamed account is picked up. Used by `me`.
 * @param {Parse.User} user request.user
 * @returns {Promise<{login: string, githubId: number}>} The verified identity
 */
async function refreshGithubUser(user) {
  return resolveProfile(user, true);
}

/**
 * Forget cached state (for tests).
 * @returns {void}
 */
function reset() {
  lastRefresh.clear();
}

module.exports = {requireGithubUser, refreshGithubUser, githubAuthOf, reset};
