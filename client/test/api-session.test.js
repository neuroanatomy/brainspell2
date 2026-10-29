import test from "node:test";
import assert from "node:assert/strict";
import * as api from "../annotation/api.js";
import * as session from "../annotation/session.js";
import {createMockApi} from "../annotation/mock-api.js";

const reset = () => {
  session._reset();
  api.setBackend(null);
};

test("mapError", () => {
  assert.deepEqual(api.mapError({code: 155, message: "slow down"}), {code: 155, message: "slow down"});
  assert.deepEqual(api.mapError(new Error("boom")), {code: -1, message: "boom"});
  assert.deepEqual(api.mapError(null), {code: -1, message: "Unexpected error"});
  assert.deepEqual(api.mapError({code: "x", message: ""}), {code: -1, message: "Unexpected error"});
});

test("call maps errors and notifies on 206 and 209", async () => {
  let n = 0;
  const off = api.onSessionExpired(() => n++);
  api.setBackend({call: async (name) => {
    const e = new Error(name);
    e.code = name === "a" ? 206 : name === "b" ? 209 : 155;
    throw e;
  }});
  await assert.rejects(api.call("a"), {code: 206, message: "a"});
  await assert.rejects(api.call("b"), {code: 209});
  await assert.rejects(api.call("c"), {code: 155});
  assert.equal(n, 2);
  off();
  reset();
});

test("session.init: anonymous", async () => {
  reset();
  api.setBackend(createMockApi({user: null}));
  // no Parse global and not ?mock: refresh() returns null without calling the server
  assert.equal(await session.init(), null);
  assert.equal(session.current(), null);
});

test("stripStoredToken removes authData from the SDK's stored user only", () => {
  const data = {
    "Parse/APPID/currentUser": JSON.stringify({objectId: "u1", sessionToken: "r:abc", authData: {github: {access_token: "SECRET", id: 1}}}),
    "Parse/APPID/installationId": "xyz",
    "other": JSON.stringify({authData: 1})
  };
  const storage = {
    get length() { return Object.keys(data).length; },
    key: (i) => Object.keys(data)[i],
    getItem: (k) => data[k],
    setItem: (k, v) => { data[k] = v; }
  };
  assert.equal(session.stripStoredToken(storage), 1);
  const u = JSON.parse(data["Parse/APPID/currentUser"]);
  assert.equal(u.authData, undefined);
  assert.equal(u.sessionToken, "r:abc");
  assert.ok(!JSON.stringify(data).includes("SECRET"));
  assert.equal(data.other, JSON.stringify({authData: 1}));
  assert.equal(session.stripStoredToken(storage), 0);
});

test("stripStoredToken survives broken storage", () => {
  const storage = {length: 1, key: () => "Parse/A/currentUser", getItem: () => "{not json", setItem() {}};
  assert.equal(session.stripStoredToken(storage), 0);
});

const withParse = (current = {id: "u1"}) => {
  const calls = {logOut: 0};
  globalThis.Parse = {User: {current: () => current, logOut: async () => { calls.logOut++; }}};

  return calls;
};

test("session restore: valid session", async () => {
  reset();
  const calls = withParse();
  api.setBackend({call: async () => ({id: "u1", login: "alice", githubId: 7})});
  const seen = [];
  session.onChange((u) => seen.push(u && u.login));
  assert.deepEqual(await session.init(), {id: "u1", login: "alice"});
  assert.deepEqual(session.current(), {id: "u1", login: "alice"});
  assert.deepEqual(seen, ["alice"]);
  assert.equal(calls.logOut, 0);
  delete globalThis.Parse;
});

for (const code of [206, 209]) {
  test(`session restore: error ${code} clears the user`, async () => {
    reset();
    const calls = withParse();
    api.setBackend({call: async () => { const e = new Error("x"); e.code = code; throw e; }});
    assert.equal(await session.init(), null);
    assert.equal(session.current(), null);
    assert.ok(calls.logOut >= 1);
    delete globalThis.Parse;
  });
}

test("session restore: me() returns null (not a GitHub user) clears the user", async () => {
  reset();
  const calls = withParse();
  api.setBackend({call: async () => null});
  assert.equal(await session.init(), null);
  assert.equal(calls.logOut, 1);
  delete globalThis.Parse;
});

test("session restore: network error shows logged out UI but keeps the stored session", async () => {
  reset();
  const calls = withParse();
  api.setBackend({call: async () => { const e = new Error("down"); e.code = 100; throw e; }});
  assert.equal(await session.init(), null);
  assert.equal(calls.logOut, 0);
  delete globalThis.Parse;
});

test("no stored Parse user: no call to me()", async () => {
  reset();
  withParse(null);
  let called = 0;
  api.setBackend({call: async () => { called++; return null; }});
  assert.equal(await session.init(), null);
  assert.equal(called, 0);
  delete globalThis.Parse;
});

test("a 206 during a later action logs out", async () => {
  reset();
  const calls = withParse();
  let fail = false;
  api.setBackend({call: async (name) => {
    if (fail) { const e = new Error("x"); e.code = 206; throw e; }

    return {id: "u1", login: "alice"};
  }});
  await session.init();
  assert.equal(session.current().login, "alice");
  fail = true;
  await assert.rejects(api.call("vote", {}), {code: 206});
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(session.current(), null);
  assert.ok(calls.logOut >= 1);
  delete globalThis.Parse;
});
