// Fix round: C3 (wiring part is in table-edit-wiring.test.js), C8, C9/C10, C11, C13, C14, C15, C17, C20, timeout.
import test from "node:test";
import assert from "node:assert/strict";
import {makeDocument, flush} from "./fake-dom.js";
import {setDocument, decodeEntitiesOnly, encodeUserText} from "../annotation/dom.js";
import * as api from "../annotation/api.js";
import {describeError} from "../annotation/context.js";
import {createMockApi, sampleArticles} from "../annotation/mock-api.js";
import * as te from "../annotation/table-edit.js";
import {renderAddArticle, INDEX_NOTE} from "../annotation/add-article.js";
import {hasOwnParent} from "../annotation/tags.js";
import {MAX_NAME, validName} from "../annotation/collections.js";

// an entity decoder like the browser's for the tested strings; "<" never reaches it (escaped first)
globalThis.DOMParser = class {
  parseFromString(s) {
    const t = String(s).replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&amp;/g, "&");

    return {documentElement: {textContent: t}};
  }
};

const articles = () => {
  const a = sampleArticles();
  a["12345"].Experiments[0].locations[2] = "-8,-72,12,3.25"; // legacy row with a 4th value
  a["12345"].Experiments[0].tags.push({name: "n-Back Task", ontology: "tasks", agree: 1, disagree: 0});

  return a;
};

const setup = async ({user = "alice", expId = 1, mockOpts = {}} = {}) => {
  const doc = makeDocument();
  setDocument(doc);
  const mock = createMockApi({user, latency: 0, articles: articles(), ...mockOpts});
  const art = await mock.getArticle("12345");
  const container = doc.createElement("div");
  const title = doc.createElement("b");
  const caption = doc.createElement("span");
  const state = {rev: art.rev || 0, reloads: 0, viewers: 0};
  const info = {
    pmid: "12345", get rev() { return state.rev; }, setRev: (r) => { state.rev = r; }, reload: () => { state.reloads++; },
    slots: {title, caption, viewer: doc.createElement("div"), coords: null}, createViewer: async () => { state.viewers++; }
  };
  const make = (experiment) => te.createEditor({container, experiment, info, call: mock.call, user: () => ({id: "u"}), subscribeUser: () => () => {}, confirm: () => true});
  const ed = make(art.Experiments.find((e) => e.id === expId));

  return {doc, mock, ed, root: ed.root, state, title, caption, make, info, container};
};
const tb = (root) => root.byTag("tbody")[0];
const fill = (tr, vals) => tr.byTag("input").forEach((inp, k) => { inp.value = vals[k]; });

// ---- C8 ------------------------------------------------------------------------------------------
test("C8: a no-op edit (server answers experiments: []) closes the editor, no reload, no rev change", async () => {
  const s = await setup();
  await s.root.buttons("Import from text")[0].dispatch("click");
  s.root.byTag("textarea")[0].value = "-42,18,24\n44,20,26\n-8,-72,12\n30,-60,-14\n0,12,48"; // 4-value row loses its 4th value -> a real change
  await s.root.buttons("Preview")[0].dispatch("click");
  await s.root.buttons("Replace table")[0].dispatch("click");
  await flush();
  assert.equal(s.state.rev, 1);
  // same again: now identical
  await s.root.buttons("Import from text")[0].dispatch("click");
  s.root.byTag("textarea")[0].value = "-42,18,24\n44,20,26\n-8,-72,12\n30,-60,-14\n0,12,48";
  await s.root.buttons("Preview")[0].dispatch("click");
  await s.root.buttons("Replace table")[0].dispatch("click");
  await flush();
  assert.equal(s.state.rev, 1, "no new rev");
  assert.equal(s.state.reloads, 0);
  assert.equal(s.root.byTag("textarea").length, 0, "dialog closed");
  assert.equal(tb(s.root).children.length, 5);
  assert.ok(!s.root.textContent.includes("Saving"));
});

test("C8: mock no-op answers {rev unchanged, experiments: []}", async () => {
  const mock = createMockApi({user: "alice", latency: 0, articles: articles()});
  const r = await mock.call("editExperiment", {pmid: "12345", experimentId: 1, rev: 0, ops: [{op: "setTitle", text: "Task > baseline"}]});
  assert.deepEqual(r, {rev: 0, experiments: []});
  assert.equal((await mock.call("getAnnotations", {pmid: "12345"})).rev, 0);
});

// ---- C9 / C10 -------------------------------------------------------------------------------------
test("C9/C10: mock aligned with the server", async () => {
  const mock = createMockApi({user: "alice", latency: 0, articles: articles()});
  await assert.rejects(mock.call("editExperiment", {pmid: "12345", experimentId: 77, rev: 0, ops: [{op: "setTitle", text: "x"}]}), {code: 101});
  await assert.rejects(mock.call("editExperiment", {pmid: "12345", experimentId: 1, ops: [{op: "setTitle", text: "x"}]}), {code: 142});
  const c = await mock.call("saveCollection", {name: "mine"});
  mock.loginAs("bob");
  await assert.rejects(mock.call("saveCollection", {id: c.id, add: ["1"]}), {code: 119});
  await assert.rejects(mock.call("deleteCollection", {id: c.id}), {code: 119});
  await assert.rejects(mock.call("deleteCollection", {id: "nope"}), {code: 101});
  await assert.rejects(mock.call("saveCollection", {name: "x".repeat(101)}), {code: 142});
  assert.ok(await mock.call("saveCollection", {name: "x".repeat(100)}));
  const roots = (await mock.call("listConcepts", {ontology: "cognitive"})).filter((x) => x.name === "attention");
  assert.equal(roots[0].parent, null);
  const cm = await mock.call("postComment", {pmid: "12345", text: "  hi  \n"});
  assert.equal(cm.text, "hi");
  await assert.rejects(mock.call("postComment", {pmid: "12345", text: "   "}), {code: 142});
  const v = await mock.call("vote", {pmid: "12345", experimentId: 1, kind: "tag", ontology: "tasks", tag: "n-back TASK", value: 1});
  assert.equal(v.tag, "n-Back Task", "legacy spelling");
});

// ---- C11 ------------------------------------------------------------------------------------------
test("C11: collection names are limited to 100 characters", () => {
  assert.equal(MAX_NAME, 100);
  assert.equal(validName("x".repeat(100)).length, 100);
  assert.equal(validName("x".repeat(101)), null);
});

// ---- C13 ------------------------------------------------------------------------------------------
test("C13: a 4-value row: 3 inputs, an Extra column, the extra value is shown and survives an edit", async () => {
  const s = await setup();
  assert.ok(s.root.byTag("th").some((t) => t.textContent === "Extra"));
  assert.equal(tb(s.root).children[2].children.length, 5, "x y z extra actions");
  assert.equal(tb(s.root).children[2].children[3].textContent, "3.25");
  assert.equal(tb(s.root).children[0].children[3].textContent, "", "rows without extra have an empty cell");
  await tb(s.root).children[2].dispatch("click");
  const tr = tb(s.root).children[2];
  assert.equal(tr.byTag("input").length, 3);
  assert.equal(te.sameXyz("-8,-72,12,3.25", [-8, -72, 12]), true);
  fill(tr, ["70", "-72", "12"]);
  await tr.byTag("input")[0].dispatch("keydown", {key: "Enter"});
  await flush();
  assert.equal((await s.mock.getArticle("12345")).Experiments[0].locations[2], "70,-72,12,3.25");
  assert.equal(tb(s.root).children[2].children[3].textContent, "3.25");
  // unchanged x y z of a 4-value row: nothing sent
  const rev = s.state.rev;
  await tb(s.root).children[2].dispatch("click");
  await tb(s.root).children[2].byTag("input")[0].dispatch("keydown", {key: "Enter"});
  assert.equal(s.state.rev, rev);
});

test("C13: without any 4-value row there is no Extra column", async () => {
  const s = await setup({expId: 2});
  assert.ok(!s.root.byTag("th").some((t) => t.textContent === "Extra"));
});

// ---- C14 ------------------------------------------------------------------------------------------
test("C14: titles/captions with < and & survive a save and a reload exactly as typed", async () => {
  for (const typed of ["Faces<Houses contrast", "A &amp; B", "x<y>z", "&lt;b&gt;", "plain & simple", "a < b && c > d"]) {
    const s = await setup();
    await s.root.byLabel("Edit title")[0].dispatch("click");
    s.root.byTag("input")[0].value = typed;
    await s.root.buttons("Save")[0].dispatch("click");
    await flush();
    assert.equal(s.title.textContent, typed, `shown after save: ${typed}`);
    const stored = (await s.mock.getArticle("12345")).Experiments[0].title;
    assert.equal(decodeEntitiesOnly(stored), typed);
    // "reload": a new editor on the stored experiment; its edit box starts with the typed text
    const again = s.make((await s.mock.getArticle("12345")).Experiments[0]);
    await again.root.byLabel("Edit title")[0].dispatch("click");
    assert.equal(again.root.byTag("input")[0].value, typed);
    // caption too
    await again.root.buttons("Cancel")[0].dispatch("click");
    await again.root.byLabel("Edit caption")[0].dispatch("click");
    again.root.byTag("textarea")[0].value = typed;
    await again.root.buttons("Save")[0].dispatch("click");
    await flush();
    assert.equal(s.caption.textContent, typed);
  }
});

test("C14: decodeEntitiesOnly decodes references only; legacy values", () => {
  assert.equal(decodeEntitiesOnly("Faces<Houses contrast"), "Faces<Houses contrast");
  assert.equal(decodeEntitiesOnly("Tom &amp; Jerry"), "Tom & Jerry");
  assert.equal(decodeEntitiesOnly(null), "");
  assert.equal(encodeUserText("a & b<c"), "a &amp; b<c");
});

// ---- C15 ------------------------------------------------------------------------------------------
test("C15: indexed false shows a note first; reload after OK or after the timer, once", async () => {
  for (const how of ["ok", "timer"]) {
    const doc = makeDocument();
    setDocument(doc);
    const box = doc.createElement("div");
    let reloads = 0;
    let timer;
    renderAddArticle(box, "424242", {
      call: async () => ({objectId: "o", pmid: "424242", indexed: false}), user: () => ({id: "u"}), subscribeUser: () => {},
      reload: () => { reloads++; }, setTimer: (fn, ms) => { timer = {fn, ms}; }, noteMs: 4000
    });
    await box.buttons("Add article")[0].dispatch("click");
    await flush();
    assert.ok(box.textContent.includes(INDEX_NOTE));
    assert.match(INDEX_NOTE, /search indexing is pending/);
    assert.equal(reloads, 0);
    assert.equal(timer.ms, 4000);
    if (how === "ok") {
      await box.buttons("OK")[0].dispatch("click");
    } else {
      timer.fn();
    }
    assert.equal(reloads, 1);
    timer.fn();
    await box.buttons("OK")[0].dispatch("click");
    assert.equal(reloads, 1, "only once");
  }
});

test("C15: indexed true reloads at once", async () => {
  const doc = makeDocument();
  setDocument(doc);
  const box = doc.createElement("div");
  let reloads = 0;
  renderAddArticle(box, "424242", {call: async () => ({indexed: true}), user: () => ({id: "u"}), subscribeUser: () => {}, reload: () => { reloads++; }});
  await box.buttons("Add article")[0].dispatch("click");
  await flush();
  assert.equal(reloads, 1);
});

// ---- C20 ------------------------------------------------------------------------------------------
test("C20: a parent is shown only when it differs from the name", () => {
  assert.equal(hasOwnParent({name: "attention", parent: "attention"}), false);
  assert.equal(hasOwnParent({name: "Attention", parent: " attention "}), false);
  assert.equal(hasOwnParent({name: "working memory", parent: "memory"}), true);
  assert.equal(hasOwnParent({name: "memory", parent: null}), false);
  assert.equal(hasOwnParent({name: "memory", parent: ""}), false);
});

// ---- timeout ----------------------------------------------------------------------------------------
test("api.call times out with code 1003", async () => {
  api.setTimeoutMs(30);
  api.setBackend({call: () => new Promise(() => {}), getArticle: () => new Promise(() => {})});
  await assert.rejects(api.call("getAnnotations", {pmid: "1"}), (e) => e.code === 1003 && e.message === "The server did not answer");
  await assert.rejects(api.getArticle("1"), {code: 1003});
  assert.match(describeError({code: 1003, message: "The server did not answer"}), /did not answer/);
  api.setTimeoutMs(30000);
  api.setBackend({call: async () => 5});
  assert.equal(await api.call("x"), 5);
  api.setBackend(null);
});
