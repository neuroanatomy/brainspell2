import test from "node:test";
import assert from "node:assert/strict";
import {makeDocument, flush} from "./fake-dom.js";
import {setDocument, el} from "../annotation/dom.js";
import {createMockApi} from "../annotation/mock-api.js";
import * as api from "../annotation/api.js";
import * as session from "../annotation/session.js";
import * as col from "../annotation/collections.js";
import * as page from "../collections.js";

globalThis.__noAutostart = true;

// stand-in for the browser's inert DOMParser (the real one is covered by the manual checklist)
globalThis.DOMParser = class {
  parseFromString(s) {
    const body = String(s).replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<[^>]*>/g, "")
      .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

    return {querySelectorAll: () => ({forEach() {}}), documentElement: {textContent: body}};
  }
};

const setup = async ({user = "alice", fail = null} = {}) => {
  const doc = makeDocument();
  setDocument(doc);
  globalThis.document = doc;
  globalThis.location = {search: "?mock=1"};
  const mock = createMockApi({user});
  const calls = [];
  api.setBackend({
    call: async (name, p) => {
      calls.push([name, p]);
      if (fail && name === "saveCollection") {
        throw {code: fail, message: "boom"};
      }

      return mock.call(name, p);
    },
    getArticle: (pmid) => mock.getArticle(pmid)
  });
  session._reset();
  await session.init();

  return {doc, mock, calls};
};

const makeList = (doc, pmids) => {
  const list = doc.register("paper-list", doc.createElement("ol"));
  const toolbar = doc.register("selection-toolbar", doc.createElement("div"));
  const add = (ps) => ps.forEach((p) => list.appendChild(el("li", {dataset: {pmid: p}}, col.selectSlot(), el("a", {href: "x"}, `Title ${p}`))));
  add(pmids);

  return {list, toolbar, add};
};
const boxes = (list) => list.all((n) => n.classList.contains("col-box"));
const check = async (box, on) => {
  box.checked = on;
  await box.dispatch("change");
};

test("pure helpers: chunk, validName, buildSaveParams, limits, messages", () => {
  assert.deepEqual(col.chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  assert.deepEqual(col.chunk([], 100), []);
  assert.equal(col.validName("  x "), "x");
  assert.equal(col.validName("   "), null);
  assert.equal(col.validName("a".repeat(201)), null);
  assert.deepEqual(col.buildSaveParams({id: "c1", add: ["1"], remove: []}), {id: "c1", add: ["1"]});
  assert.deepEqual(col.buildSaveParams({name: "N", add: ["1", "2"]}), {name: "N", add: ["1", "2"]});
  assert.deepEqual(col.buildSaveParams({id: "c1", remove: ["3"]}), {id: "c1", remove: ["3"]});
  assert.equal(col.limitMessage(2000), null);
  assert.match(col.limitMessage(2001), /2001 articles; at most 2000/);
  assert.equal(col.addedMessage(7, [], ["1", "2", "3", "4", "5", "6", "7"], "X"), "Added 7 articles to X");
  assert.equal(col.addedMessage(2, ["1"], ["1", "2"], "X"), "Added 1 article to X (1 already in it)");
});

test("selection logic", () => {
  const s = col.createSelection();
  let n = 0;
  s.subscribe(() => n++);
  s.set("1", true);
  s.setMany(["2", "3"], true);
  assert.equal(s.size(), 3);
  s.set("2", false);
  assert.deepEqual(s.list(), ["1", "3"]);
  s.clear();
  assert.equal(s.size(), 0);
  assert.equal(n, 4);
});

test("anonymous: no checkboxes, toolbar hidden, header link hidden", async () => {
  const {doc} = await setup({user: null});
  const link = doc.register("collections-link", el("a", {hidden: true}));
  col.initHeaderLink();
  const {list, toolbar} = makeList(doc, ["1", "2"]);
  col.mountSearchSelection({list, toolbar});
  assert.equal(boxes(list).length, 0);
  assert.equal(toolbar.hidden, true);
  assert.equal(link.hidden, true);
});

test("logged in: checkboxes on all items, also appended ones; selection survives appends; select all/none", async () => {
  const {doc} = await setup();
  const link = doc.register("collections-link", el("a", {hidden: true}));
  col.initHeaderLink();
  assert.equal(link.hidden, false);
  const {list, toolbar, add} = makeList(doc, ["1", "2", "3"]);
  const ui = col.mountSearchSelection({list, toolbar});
  assert.equal(toolbar.hidden, false);
  assert.equal(boxes(list).length, 3);
  await check(boxes(list)[1], true);
  assert.deepEqual(ui.selection.list(), ["2"]);
  add(["4", "5"]);
  ui.refresh();
  assert.equal(boxes(list).length, 5);
  assert.deepEqual(ui.selection.list(), ["2"]);
  assert.equal(boxes(list)[1].checked, true);
  await toolbar.buttons("Select all")[0].dispatch("click");
  assert.equal(ui.selection.size(), 5);
  assert.ok(boxes(list).every((b) => b.checked));
  assert.match(toolbar.textContent, /5 articles selected/);
  await toolbar.buttons("Select none")[0].dispatch("click");
  assert.equal(ui.selection.size(), 0);
  assert.ok(boxes(list).every((b) => !b.checked));
});

test("logout removes the checkboxes", async () => {
  const {doc} = await setup();
  const {list, toolbar} = makeList(doc, ["1"]);
  col.mountSearchSelection({list, toolbar});
  assert.equal(boxes(list).length, 1);
  await session.logout();
  assert.equal(boxes(list).length, 0);
  assert.equal(toolbar.hidden, true);
});

test("menu: create a new collection, then add to the existing one", async () => {
  const {doc, mock, calls} = await setup();
  const {list, toolbar} = makeList(doc, ["1", "2", "3"]);
  const ui = col.mountSearchSelection({list, toolbar});
  const addBtn = () => toolbar.buttons("Add to collection")[0];
  assert.equal(addBtn().disabled, true);
  ui.selection.setMany(["1", "2", "3"], true);
  assert.equal(addBtn().disabled, false);
  await addBtn().dispatch("click");
  await flush();
  assert.match(toolbar.textContent, /You have no collections yet/);
  await toolbar.buttons("Create new collection")[0].dispatch("click");
  const input = toolbar.all((n) => n.tagName === "INPUT" && n.classList.contains("col-name"))[0];
  // empty name refused locally
  await toolbar.buttons("Create")[0].dispatch("click");
  assert.match(toolbar.textContent, /name must have 1 to 100/);
  input.value = " Memory ";
  await toolbar.buttons("Create")[0].dispatch("click");
  await flush();
  assert.match(toolbar.textContent, /Added 3 articles to Memory/);
  assert.equal(ui.selection.size(), 0);
  assert.deepEqual(calls.filter((c) => c[0] === "saveCollection")[0][1], {name: "Memory", add: ["1", "2", "3"]});
  // second round: existing collection, one overlapping
  ui.selection.setMany(["3", "9"], true);
  await addBtn().dispatch("click");
  await flush();
  await toolbar.buttons("Memory")[0].dispatch("click");
  await flush();
  assert.match(toolbar.textContent, /Added 1 article to Memory \(1 already in it\)/);
  const saved = calls.filter((c) => c[0] === "saveCollection")[1][1];
  assert.deepEqual(saved, {id: saved.id, add: ["3", "9"]});
  assert.deepEqual((await mock.call("listCollections")).map((c) => c.pmids), [["1", "2", "3", "9"]]);
});

test("menu: more than 2000 selected is refused with a message and no call", async () => {
  const {doc, calls} = await setup();
  const {list, toolbar} = makeList(doc, ["1"]);
  const ui = col.mountSearchSelection({list, toolbar});
  ui.selection.setMany(Array.from({length: 2001}, (_, i) => String(i + 1)), true);
  await toolbar.buttons("Add to collection")[0].dispatch("click");
  assert.match(toolbar.textContent, /at most 2000/);
  assert.equal(calls.filter((c) => c[0] !== "me").length, 0);
});

test("menu errors: 142 shows the message, 155 asks to wait; selection is kept", async () => {
  for (const [code, re] of [[142, /Not accepted: boom/], [155, /Too many actions, please wait. boom/]]) {
    const {doc} = await setup({fail: code});
    const {list, toolbar} = makeList(doc, ["1"]);
    const ui = col.mountSearchSelection({list, toolbar});
    ui.selection.set("1", true);
    await toolbar.buttons("Add to collection")[0].dispatch("click");
    await flush();
    await toolbar.buttons("Create new collection")[0].dispatch("click");
    toolbar.all((n) => n.tagName === "INPUT" && n.classList.contains("col-name"))[0].value = "N";
    await toolbar.buttons("Create")[0].dispatch("click");
    await flush();
    assert.match(toolbar.textContent, re);
    assert.equal(ui.selection.size(), 1);
    assert.equal(toolbar.buttons("Add to collection")[0].disabled, false);
  }
});

test("hostile collection and article names are only text", async () => {
  const {doc, mock} = await setup();
  await mock.call("saveCollection", {name: "<img src=x onerror=alert(1)>", add: ["12345"]});
  const root = doc.register("collections", doc.createElement("div"));
  page.setTitleFetcher(async () => ({12345: "&lt;b&gt;Bold&lt;/b&gt; <script>window.__xss=1</script>t"}));
  await page.render();
  await flush();
  await root.buttons("<img")[0].dispatch("click");
  await flush();
  assert.equal(root.all((n) => ["IMG", "SCRIPT", "I"].includes(n.tagName)).length, 0);
  assert.match(root.textContent, /<img src=x onerror=alert\(1\)>/);
  assert.match(root.textContent, /<b>Bold<\/b> t/);
  assert.ok(!root.textContent.includes("__xss"));
});

test("collections page: anonymous", async () => {
  const {doc} = await setup({user: null});
  const root = doc.register("collections", doc.createElement("div"));
  await page.render();
  assert.match(root.textContent, /Log in to see your collections/);
});

test("collections page: list, expand, remove, delete with confirmation", async () => {
  const {doc, mock, calls} = await setup();
  await mock.call("saveCollection", {name: "A", add: ["12345", "67890"]});
  await mock.call("saveCollection", {name: "B"});
  const root = doc.register("collections", doc.createElement("div"));
  const asked = [];
  page.setTitleFetcher(async (pmids) => {
    asked.push(pmids);

    return {12345: "First &amp; best"};
  });
  await page.render();
  await flush();
  assert.equal(root.findClass("collection").length, 2);
  assert.match(root.textContent, /2 articles/);
  assert.match(root.textContent, /0 articles/);
  assert.equal(asked.length, 0, "titles only fetched when expanded");
  await root.buttons("A")[0].dispatch("click");
  await flush();
  assert.deepEqual(asked, [["12345", "67890"]]);
  assert.match(root.textContent, /First & best/);
  assert.match(root.textContent, /PMID 67890/);
  const links = root.byTag("a").map((a) => a.getAttribute("href"));
  assert.ok(links.includes("article.html?pmid=12345"));
  // remove one article
  await root.buttons("remove")[0].dispatch("click");
  await flush();
  assert.deepEqual((await mock.call("listCollections"))[0].pmids, ["67890"]);
  assert.match(root.textContent, /1 article\b/);
  assert.ok(calls.some((c) => c[0] === "saveCollection" && c[1].remove && c[1].remove[0] === "12345"));
  // delete: first click only asks
  const before = calls.length;
  await root.buttons("Delete collection")[0].dispatch("click");
  assert.equal(calls.length, before);
  assert.match(root.textContent, /Delete "A"\?/);
  await root.buttons("Cancel")[0].dispatch("click");
  assert.equal((await mock.call("listCollections")).length, 2);
  await root.buttons("Delete collection")[0].dispatch("click");
  await root.buttons("Yes, delete")[0].dispatch("click");
  await flush();
  assert.deepEqual((await mock.call("listCollections")).map((c) => c.name), ["B"]);
  assert.equal(root.findClass("collection").length, 1);
});

test("collections page: error on listing", async () => {
  const {doc} = await setup();
  const root = doc.register("collections", doc.createElement("div"));
  await page.render(async () => {
    throw {code: 100, message: "x"};
  });
  assert.match(root.textContent, /Cannot reach the server/);
});

test("initHeaderLink is exported by client/collections.js too", () => {
  assert.equal(page.initHeaderLink, col.initHeaderLink);
});
