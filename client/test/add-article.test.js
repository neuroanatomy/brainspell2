import test from "node:test";
import assert from "node:assert/strict";
import {makeDocument, flush} from "./fake-dom.js";
import {setDocument} from "../annotation/dom.js";
import {createMockApi} from "../annotation/mock-api.js";
import {renderAddArticle, parseNTables, addArticleError} from "../annotation/add-article.js";

const setup = (user, wrap = (c) => c) => {
  const doc = makeDocument();
  setDocument(doc);
  const mock = createMockApi({user});
  const state = {user: user ? {id: "u", login: user} : null, reloads: 0, subs: []};
  const box = doc.createElement("div");
  renderAddArticle(box, "424242", {
    call: wrap(mock.call), user: () => state.user, subscribeUser: (cb) => state.subs.push(cb),
    reload: () => { state.reloads++; }
  });

  return {mock, state, box};
};

test("parseNTables", () => {
  assert.equal(parseNTables("1"), 1);
  assert.equal(parseNTables(" 0 "), 0);
  assert.equal(parseNTables("50"), 50);
  for (const b of ["", "51", "-1", "1.5", "abc", "1e1"]) { assert.equal(parseNTables(b), null, b); }
});

test("anonymous: message, no form", () => {
  const {box} = setup(null);
  assert.equal(box.textContent, "This article is not in the database yet. Log in to add it.");
  assert.equal(box.buttons().length, 0);
  assert.equal(box.byTag("input").length, 0);
});

test("logged in: add with default 1 table, then reload", async () => {
  const {box, mock, state} = setup("alice");
  assert.equal(box.byTag("input")[0].value, "424242");
  assert.equal(box.byTag("input")[0].readOnly, true);
  await box.buttons("Add article")[0].dispatch("click");
  await flush();
  assert.equal(state.reloads, 1);
  const art = await mock.getArticle("424242");
  assert.equal(art.Experiments.length, 1);
});

test("pending state, no double submit; invalid n is not sent", async () => {
  let calls = 0;
  let release;
  const gate = new Promise((r) => { release = r; });
  const {box, state} = setup("alice", (c) => async (n, p) => { calls++; await gate; return c(n, p); });
  const n = box.byTag("input")[1];
  n.value = "99";
  await box.buttons("Add article")[0].dispatch("click");
  assert.equal(calls, 0);
  assert.ok(box.textContent.includes("between 0 and 50"));
  n.value = "3";
  const p1 = box.buttons("Add article")[0].dispatch("click");
  await flush();
  assert.ok(box.textContent.includes("Saving"));
  assert.equal(box.buttons("Add article")[0].disabled, true);
  release();
  await p1; await flush();
  assert.equal(calls, 1);
  assert.equal(state.reloads, 1);
});

test("errors: 137 reloads, 1002, 155, 142", async () => {
  for (const [code, msg, reloads, expect] of [
    [137, "x", 1, "added meanwhile"], [1002, "x", 0, "PubMed has no record for this PMID or is unavailable"],
    [155, "retry in 9 s", 0, "retry in 9 s"], [142, "nTables bad", 0, "nTables bad"]]) {
    const {box, state} = setup("alice", () => async () => { throw {code, message: msg}; });
    await box.buttons("Add article")[0].dispatch("click");
    assert.equal(state.reloads, reloads, String(code));
    assert.ok(box.textContent.includes(expect), `${code}: ${box.textContent}`);
    assert.equal(box.buttons("Add article")[0].disabled, false);
  }
  assert.equal(addArticleError({code: 1002}).includes("PubMed"), true);
});

test("login after the page is drawn shows the form", () => {
  const {box, state} = setup(null);
  state.user = {id: "u", login: "a"};
  state.subs.forEach((cb) => cb());
  assert.equal(box.buttons("Add article").length, 1);
});
