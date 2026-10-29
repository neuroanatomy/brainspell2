/* global Parse */
/**
 * Single entry point to the server: call(name, params) wraps Parse.Cloud.run and maps every
 * failure to {code, message} (plan 4.2). With ?mock=1 in the page URL everything goes to the
 * in-memory implementation in mock-api.js instead (development without a server).
 *
 *   ?mock=1                 anonymous visitor
 *   ?mock=1&as=alice        logged in as alice
 *   ?mock=1&fail=155        every write function fails with that code (206, 155, 142, ...)
 *   ?mock=1&latency=300     artificial latency in ms (default 120)
 */

export const CODES = {
  VALIDATION: 142,
  NOT_LOGGED_IN: 206,
  FORBIDDEN: 119,
  RATE_LIMITED: 155,
  NOT_FOUND: 101,
  EXISTS: 137,
  CONFLICT: 1001,
  UPSTREAM: 1002,
  INVALID_SESSION: 209, // Parse's own code for a dead session token
  NETWORK: 100,
  UNKNOWN: -1
};

const params = () => new URLSearchParams(typeof location === "undefined" ? "" : location.search);

export const isMock = () => params().get("mock") === "1";

/** Map anything thrown by Parse or the mock to {code, message}. */
export const mapError = (err) => {
  const code = err && Number.isInteger(err.code) ? err.code : CODES.UNKNOWN;
  const message = err && typeof err.message === "string" && err.message ? err.message : "Unexpected error";

  return {code, message};
};

const expiredListeners = new Set();

/** cb() is called when a server answer says the session is gone (206 or 209). Returns an unsubscribe function. */
export const onSessionExpired = (cb) => {
  expiredListeners.add(cb);

  return () => expiredListeners.delete(cb);
};

let mock = null;
const getMock = async () => {
  if (!mock) {
    const m = await import("./mock-api.js");
    const p = params();
    mock = m.createMockApi({
      user: p.get("as") || null,
      failCode: p.get("fail") ? Number(p.get("fail")) : null,
      latency: p.has("latency") ? Number(p.get("latency")) : 120
    });
  }

  return mock;
};

/** Test hook: use an explicit backend instead of Parse/mock-api. */
let backend = null;
export const setBackend = (b) => {
  backend = b;
  mock = null;
};

const run = async (name, p) => {
  if (backend) {
    return backend.call(name, p);
  }
  if (isMock()) {
    return (await getMock()).call(name, p);
  }

  return Parse.Cloud.run(name, p);
};

export const call = async (name, p = {}) => {
  try {
    return await run(name, p);
  } catch (err) {
    const e = mapError(err);
    if (e.code === CODES.NOT_LOGGED_IN || e.code === CODES.INVALID_SESSION) {
      expiredListeners.forEach((cb) => {
        try {
          cb();
        } catch (e2) {
          console.log("onSessionExpired listener failed", e2);
        }
      });
    }
    throw e;
  }
};

/**
 * The article document (not a cloud function: public read of the Articles class).
 * Resolves to the plain JSON of the article or null if the PMID is not in the database.
 */
export const getArticle = async (pmid) => {
  try {
    if (backend && backend.getArticle) {
      return await backend.getArticle(pmid);
    }
    if (isMock()) {
      return (await getMock()).getArticle(pmid);
    }
    const Article = Parse.Object.extend("Articles");
    const query = new Parse.Query(Article);
    query.equalTo("PMID", String(pmid));
    const ob = await query.first();

    return ob ? ob.toJSON() : null;
  } catch (err) {
    throw mapError(err);
  }
};

/** Mock only: the mock backend object (loginAs, logout), for the header and the session. */
export const getMockBackend = () => getMock();
