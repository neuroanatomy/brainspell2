import test from "node:test";
import assert from "node:assert/strict";
import {makeDocument, flush} from "./fake-dom.js";
import {setDocument} from "../annotation/dom.js";
import * as api from "../annotation/api.js";
import * as session from "../annotation/session.js";
import * as hooks from "../annotation/hooks.js";
import * as tableEdit from "../annotation/table-edit.js";
import * as addArticle from "../annotation/add-article.js";

globalThis.__noAutostart = true;
globalThis.DOMParser = class {
  parseFromString(s) {
    return {querySelectorAll: () => ({forEach() {}}), documentElement: {textContent: String(s).replace(/<[^>]*>/g, "")}};
  }
};
const article = await import("../article.js");

const run = async (query) => {
  const doc = makeDocument();
  setDocument(doc);
  globalThis.document = doc;
  const root = doc.register("article", doc.createElement("div"));
  globalThis.location = {search: query};
  globalThis.window = {};
  session._reset();
  hooks._clear();
  api.setBackend(null);
  const viewers = [];
  article.setViewerFactory(async (id, locs) => { viewers.push([id, locs.length]); });
  tableEdit.register();
  addArticle.register();
  await session.init();
  await article.init();
  await flush(10);

  return {root, viewers};
};

test("article page, anonymous: no editing control", async () => {
  const {root} = await run("?pmid=12345&mock=1&latency=0");
  assert.equal(root.findClass("te-root").every((n) => n.hidden), true);
  assert.equal(root.byLabel("Edit title").length, 0);
  assert.equal(root.buttons("Import from text").length, 0);
});

test("article page, logged in: edit a coordinate end to end (rev from the annotations, rebuilt viewer)", async () => {
  const {root, viewers} = await run("?pmid=12345&mock=1&as=alice&latency=0");
  assert.equal(root.byLabel("Edit title").length, 3, "also for the empty experiment");
  const before = viewers.length;
  const tbody = root.findClass("te-table")[0].byTag("tbody")[0];
  await tbody.children[0].dispatch("click");
  const tr = root.findClass("te-table")[0].byTag("tbody")[0].children[0];
  tr.byTag("input").forEach((inp, k) => { inp.value = ["5", "6", "7"][k]; });
  await tr.byTag("input")[0].dispatch("keydown", {key: "Enter"});
  await flush(10);
  assert.equal(root.findClass("te-table")[0].byTag("tbody")[0].children[0].children[0].textContent, "5");
  assert.equal(viewers.length, before + 1);
  // a second edit works: the rev was updated in the page context
  await root.findClass("te-table")[0].byTag("tbody")[0].children[1].dispatch("click");
  const tr2 = root.findClass("te-table")[0].byTag("tbody")[0].children[1];
  tr2.byTag("input").forEach((inp, k) => { inp.value = ["1", "2", "3"][k]; });
  await tr2.byTag("input")[0].dispatch("keydown", {key: "Enter"});
  await flush(10);
  assert.equal(root.findClass("te-table")[0].byTag("tbody")[0].children[1].children[0].textContent, "1");
  assert.ok(!root.textContent.includes("changed meanwhile"));
});

test("missing article: anonymous message / add form", async () => {
  const a = await run("?pmid=555&mock=1&latency=0");
  assert.ok(a.root.textContent.includes("Log in to add it."));
  const b = await run("?pmid=555&mock=1&as=alice&latency=0");
  assert.equal(b.root.buttons("Add article").length, 1);
});

// ---- fix round: C3 (rev of the rendered document) and C17 (truncated notice) ------------------------
const runWith = async (backendOf) => {
  const doc = makeDocument();
  setDocument(doc);
  globalThis.document = doc;
  const root = doc.register("article", doc.createElement("div"));
  globalThis.location = {search: "?pmid=12345"};
  globalThis.window = {};
  globalThis.Parse = {User: {current: () => ({}), logOut: async () => {}}};
  session._reset();
  hooks._clear();
  const {createMockApi} = await import("../annotation/mock-api.js");
  const mock = createMockApi({user: "alice", latency: 0, truncated: backendOf.truncated});
  const stats = {fetches: 0};
  api.setBackend({
    call: async (name, p) => {
      if (name === "getAnnotations" && backendOf.beforeAnnotations) {
        const f = backendOf.beforeAnnotations;
        backendOf.beforeAnnotations = null;
        await f(mock); // another user's edit, after the page has fetched the article
      }

      return mock.call(name, p);
    },
    getArticle: async (pmid) => {
      stats.fetches++;

      return mock.getArticle(pmid);
    }
  });
  article.setViewerFactory(async () => {});
  tableEdit.register();
  await session.init();
  await article.init();
  await flush(10);

  return {root, mock, stats};
};

test("C3: another user inserts a row between the article fetch and getAnnotations: our delete gets 1001 and reloads, the wrong row is not deleted", async () => {
  const {root, mock, stats} = await runWith({
    beforeAnnotations: (m) => m.call("editExperiment", {pmid: "12345", experimentId: 1, rev: 0, ops: [{op: "addRow", index: 0, xyz: [1, 1, 1]}]})
  });
  assert.equal((await mock.getArticle("12345")).rev, 1);
  const rows = root.findClass("te-table")[0].byTag("tbody")[0].children;
  assert.equal(rows.length, 5, "the page shows the rows it fetched (without the inserted one)");
  assert.equal(rows[0].children[0].textContent, "-42");
  const fetches = stats.fetches;
  await rows[0].byLabel("Delete this row")[0].dispatch("click"); // delete what the user sees as the first row
  await flush(10);
  const art = await mock.getArticle("12345");
  assert.equal(art.Experiments[0].locations.length, 6, "nothing was deleted");
  assert.equal(art.Experiments[0].locations[1], "-42,18,24");
  assert.equal(art.rev, 1);
  assert.equal(stats.fetches, fetches + 1, "the page reloaded");
  // after the reload the page shows the inserted row and a delete works
  const again = root.findClass("te-table")[0].byTag("tbody")[0].children;
  assert.equal(again.length, 6);
  await again[0].byLabel("Delete this row")[0].dispatch("click");
  await flush(10);
  assert.equal((await mock.getArticle("12345")).Experiments[0].locations.length, 5);
});

test("C17: 'Counts may be incomplete' only when getAnnotations says truncated", async () => {
  const a = await runWith({truncated: true});
  const note = a.root.findClass("ann-status").find((n) => n.textContent === "Counts may be incomplete");
  assert.ok(note);
  assert.equal(note.hidden, false);
  const b = await runWith({});
  const note2 = b.root.findClass("ann-status").find((n) => n.textContent === "Counts may be incomplete");
  assert.equal(note2.hidden, true);
});
