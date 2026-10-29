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
  assert.equal(root.buttons("Edit title").length, 0);
  assert.equal(root.buttons("Import from text").length, 0);
});

test("article page, logged in: edit a coordinate end to end (rev from the annotations, rebuilt viewer)", async () => {
  const {root, viewers} = await run("?pmid=12345&mock=1&as=alice&latency=0");
  assert.equal(root.buttons("Edit title").length, 3, "also for the empty experiment");
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
