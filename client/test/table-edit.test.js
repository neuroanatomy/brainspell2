import test from "node:test";
import assert from "node:assert/strict";
import {makeDocument, flush} from "./fake-dom.js";
import {setDocument} from "../annotation/dom.js";
import {createMockApi} from "../annotation/mock-api.js";
import * as te from "../annotation/table-edit.js";

globalThis.DOMParser = class {
  parseFromString(s) {
    return {querySelectorAll: () => ({forEach() {}}), documentElement: {textContent: String(s).replace(/<[^>]*>/g, "").replace(/&lt;/g, "<").replace(/&amp;/g, "&")}};
  }
};

// ---- pure ------------------------------------------------------------------------------------
test("parseCoordinate / parseXyz", () => {
  assert.deepEqual(te.parseCoordinate(" -12.5 ", "x"), {ok: true, value: -12.5});
  assert.equal(te.parseCoordinate("−3", "x").value, -3);
  assert.equal(te.parseCoordinate("200", "x").ok, true);
  for (const bad of ["", "abc", "1e2", "200.1", "-201", "1,5", "Infinity", "NaN", "--1"]) {
    assert.equal(te.parseCoordinate(bad, "x").ok, false, bad);
  }
  assert.match(te.parseXyz(["1", "2", "x"]).error, /^z must be a number/);
  assert.deepEqual(te.parseXyz(["1", "2", "3"]).xyz, [1, 2, 3]);
});

test("op builders", () => {
  assert.deepEqual(te.opUpdateRow(1, ["1", "2", "3"], 3).ops, [{op: "updateRow", index: 1, xyz: [1, 2, 3]}]);
  assert.equal(te.opUpdateRow(3, ["1", "2", "3"], 3).ok, false);
  assert.equal(te.opUpdateRow(0, ["1", "2", "999"], 3).ok, false);
  assert.deepEqual(te.opAddRow(3, ["1", "2", "3"], 3).ops, [{op: "addRow", index: 3, xyz: [1, 2, 3]}]);
  assert.equal(te.opAddRow(4, ["1", "2", "3"], 3).ok, false);
  assert.equal(te.opAddRow(0, ["1", "2", "3"], 5000).ok, false);
  assert.deepEqual(te.opDeleteRow(0, 2), {ok: true, ops: [{op: "deleteRow", index: 0}]});
  assert.ok(te.opDeleteRow(0, 1).confirm);
  assert.equal(te.opDeleteRow(1, 1).ok, false);
  assert.equal(te.opSplit(null, 3).ok, false);
  assert.equal(te.opSplit(0, 3).ok, false);
  const s = te.opSplit(2, 5);
  assert.deepEqual(s.ops, [{op: "split", index: 2}]);
  assert.ok(s.confirm.includes("Rows 3 to 5"));
  assert.equal(te.opSetTitle("x".repeat(1000)).ok, true);
  assert.equal(te.opSetTitle("x".repeat(1001)).ok, false);
  assert.equal(te.opSetCaption("x".repeat(5000)).ok, true);
  assert.equal(te.opSetCaption("x".repeat(5001)).ok, false);
  assert.equal(te.opReplaceFromText("a").ok, false);
  assert.equal(te.opReplaceFromText("999,1,1").ok, false);
  assert.deepEqual(te.opReplaceFromText("1;2;3\nx").ops, [{op: "replaceFromText", text: "1;2;3\nx"}]);
});

// ---- editor against the mock ------------------------------------------------------------------
const setup = async ({user = "alice", expId = 1, wrap = (c) => c, confirm = () => true, pmid = "12345"} = {}) => {
  const doc = makeDocument();
  setDocument(doc);
  const mock = createMockApi({user, latency: 0});
  const art = await mock.getArticle(pmid);
  const experiment = art.Experiments.find((e) => e.id === expId);
  const container = doc.createElement("div");
  const title = doc.createElement("b");
  const caption = doc.createElement("span");
  const viewer = experiment.locations.length ? doc.createElement("div") : null;
  const state = {user: user ? {id: "u", login: user} : null, rev: art.rev || 0, reloads: 0, viewers: [], subs: [], loaded: true};
  const info = {
    pmid,
    get rev() { return state.rev; },
    get annotationsLoaded() { return state.loaded; },
    setRev: (r) => { state.rev = r; },
    reload: () => { state.reloads++; },
    slots: {title, caption, viewer, coords: null},
    createViewer: async (id, locs) => { state.viewers.push([id, locs.length]); }
  };
  const ed = te.createEditor({
    container, experiment, info, call: wrap(mock.call), user: () => state.user, subscribeUser: (cb) => { state.subs.push(cb); return () => {}; }, confirm
  });

  return {doc, mock, container, ed, state, info, title, caption, root: ed.root};
};
const rowsText = (root) => root.byTag("tbody")[0].children.map((tr) => tr.children.slice(0, 3).map((td) => td.textContent).join(","));
const fill = (tr, vals) => tr.byTag("input").forEach((inp, k) => { inp.value = vals[k]; });

test("anonymous sees no controls", async () => {
  const {root, container} = await setup({user: null});
  assert.equal(root.hidden, true);
  assert.equal(root.buttons().length, 0);
  assert.equal(container.classList.contains("te-active"), false);
});

test("logged in: controls, rows listed, empty experiment prompt", async () => {
  const {root, container} = await setup();
  assert.equal(root.hidden, false);
  assert.ok(container.classList.contains("te-active"));
  assert.equal(rowsText(root).length, 5);
  assert.equal(root.buttons("Split here").length, 1);
  const e = await setup({expId: 3});
  assert.ok(e.root.textContent.includes("This table has no coordinates."));
  assert.equal(e.root.buttons("Add row").length, 1);
  assert.equal(e.root.buttons("Import from text").length >= 1, true);
});

test("edit a coordinate: no optimistic update, row shown from the server's answer, viewer rebuilt, rev tracked", async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const {root, ed, state, mock} = await setup({wrap: (c) => async (n, p) => { await gate; return c(n, p); }});
  await root.byTag("tbody")[0].children[1].dispatch("click"); // select + edit row 2
  const tr = root.byTag("tbody")[0].children[1];
  fill(tr, ["1.23456", "-5", "6"]);
  const pending = tr.byTag("input")[2].dispatch("keydown", {key: "Tab"});
  await flush();
  assert.equal((await mock.getArticle("12345")).Experiments[0].locations[1], "44,20,26", "server data unchanged while pending");
  assert.equal(rowsText(root)[3], "30,-60,-14", "other rows untouched");
  assert.equal(ed.state().busy, true);
  release();
  await pending; await flush();
  assert.equal(rowsText(root)[1], "1.235,-5,6");
  assert.equal(state.rev, 1);
  assert.equal(state.viewers.length, 1);
  assert.equal(state.viewers[0][1], 5);
});

test("invalid coordinate: nothing sent, message shown; Escape cancels; unchanged row sends nothing", async () => {
  const calls = [];
  const {root} = await setup({wrap: (c) => async (n, p) => { calls.push(n); return c(n, p); }});
  await root.byTag("tbody")[0].children[0].dispatch("click");
  let tr = root.byTag("tbody")[0].children[0];
  fill(tr, ["1", "2", "500"]);
  await tr.byTag("input")[0].dispatch("keydown", {key: "Enter"});
  assert.deepEqual(calls, []);
  assert.ok(root.textContent.includes("z must be between -200 and 200"));
  await tr.byTag("input")[0].dispatch("keydown", {key: "Escape"});
  assert.equal(root.byTag("input").length, 0);
  assert.equal(rowsText(root)[0], "-42,18,24");
  await root.byTag("tbody")[0].children[0].dispatch("click");
  tr = root.byTag("tbody")[0].children[0];
  await tr.byTag("input")[0].dispatch("keydown", {key: "Enter"}); // same values
  assert.deepEqual(calls, []);
});

test("add row after a row, at the end, and into an empty table", async () => {
  const {root, state} = await setup();
  await root.buttons("+").find((b) => b.getAttribute("title").includes("after")).dispatch("click"); // after row 1
  let tr = root.byTag("tbody")[0].children[1];
  assert.equal(tr.classList.contains("te-new"), true);
  fill(tr, ["9", "8", "7"]);
  await tr.byTag("input")[2].dispatch("keydown", {key: "Enter"});
  await flush();
  assert.equal(rowsText(root)[1], "9,8,7");
  assert.equal(rowsText(root).length, 6);
  await root.byTag("thead")[0].buttons("+")[0].dispatch("click"); // at the end
  tr = root.byTag("tbody")[0].children[6];
  fill(tr, ["1", "1", "1"]);
  await tr.byTag("input")[0].dispatch("keydown", {key: "Enter"});
  await flush();
  assert.equal(rowsText(root)[6], "1,1,1");
  assert.equal(state.rev, 2);
  const e = await setup({expId: 3});
  await e.root.buttons("Add row")[0].dispatch("click");
  tr = e.root.byTag("tbody")[0].children[0];
  fill(tr, ["3", "4", "5"]);
  await tr.byTag("input")[0].dispatch("keydown", {key: "Enter"});
  await flush();
  assert.equal(rowsText(e.root)[0], "3,4,5");
  assert.equal(e.state.viewers.length, 1, "a viewer is created for a table that was empty");
  assert.equal(e.state.viewers[0][0], "viewer-te-3");
});

test("delete row; the last row asks for confirmation", async () => {
  const {root} = await setup({expId: 2, confirm: () => false});
  await root.buttons("-")[0].dispatch("click");
  await flush();
  assert.equal(rowsText(root).length, 1);
  await root.buttons("-")[0].dispatch("click");
  await flush();
  assert.equal(rowsText(root).length, 1, "declined: still there");
  const ok = await setup({expId: 2, confirm: () => true});
  await ok.root.buttons("-")[0].dispatch("click");
  await ok.root.buttons("-")[0].dispatch("click");
  await flush();
  assert.ok(ok.root.textContent.includes("This table has no coordinates."));
  assert.equal(ok.state.rev, 2);
});

test("split: needs a selected row and a confirmation; the page is reloaded to show the new table", async () => {
  const asked = [];
  const s = await setup({confirm: (q) => { asked.push(q); return true; }});
  assert.equal(s.root.buttons("Split here")[0].disabled, true, "no row selected yet");
  await s.root.byTag("tbody")[0].children[2].dispatch("click");
  await s.root.buttons("Split here")[0].dispatch("click");
  await flush();
  assert.equal(asked.length, 1);
  assert.equal(rowsText(s.root).length, 2);
  assert.equal(s.state.reloads, 1);
  const art = await s.mock.getArticle("12345");
  assert.equal(art.Experiments.length, 4);
  const declined = await setup({confirm: () => false});
  await declined.root.byTag("tbody")[0].children[2].dispatch("click");
  await declined.root.buttons("Split here")[0].dispatch("click");
  assert.equal(rowsText(declined.root).length, 5);
  assert.equal(declined.state.reloads, 0);
});

test("title and caption: edit, limits, plain text shown", async () => {
  const s = await setup();
  await s.root.buttons("Edit title")[0].dispatch("click");
  const input = s.root.byTag("input")[0];
  assert.equal(input.value, "Task > baseline");
  input.value = "New <b>title</b>";
  await s.root.buttons("Save")[0].dispatch("click");
  await flush();
  assert.equal(s.title.textContent, "New <b>title</b>");
  assert.equal(s.title.byTag("b").length, 0);
  await s.root.buttons("Edit caption")[0].dispatch("click");
  const area = s.root.byTag("textarea")[0];
  assert.equal(area.value, "Activations for task vs baseline");
  area.value = "x".repeat(5001);
  await s.root.buttons("Save")[0].dispatch("click");
  assert.ok(s.root.textContent.includes("too long"));
  assert.equal(s.state.rev, 1, "the long caption was not sent");
  area.value = "short";
  await s.root.buttons("Save")[0].dispatch("click");
  await flush();
  assert.equal(s.caption.textContent, "short");
  assert.equal(s.state.rev, 2);
});

test("import from text through the dialog replaces the table", async () => {
  const s = await setup();
  await s.root.buttons("Import from text")[0].dispatch("click");
  const area = s.root.byTag("textarea")[0];
  area.value = "1,2,3\nx=4 y=5 z=6\njunk";
  await s.root.buttons("Preview")[0].dispatch("click");
  await s.root.buttons("Replace table")[0].dispatch("click");
  await flush();
  assert.deepEqual(rowsText(s.root), ["1,2,3", "4,5,6"]);
  assert.equal(s.root.byTag("textarea").length, 0, "dialog closed");
});

test("server rejects the import: error shown in the dialog, table unchanged", async () => {
  const s = await setup({wrap: (c) => async (n, p) => { throw {code: 142, message: "text bad"}; }});
  await s.root.buttons("Import from text")[0].dispatch("click");
  s.root.byTag("textarea")[0].value = "1,2,3";
  await s.root.buttons("Preview")[0].dispatch("click");
  await s.root.buttons("Replace table")[0].dispatch("click");
  await flush();
  assert.ok(s.root.textContent.includes("Not accepted: text bad"));
  assert.equal(rowsText(s.root).length, 5);
});

test("conflict (1001): message and reload, nothing changed", async () => {
  const s = await setup();
  s.state.rev = 7; // stale rev -> the mock answers 1001
  await s.root.byTag("tbody")[0].children[0].dispatch("click");
  const tr = s.root.byTag("tbody")[0].children[0];
  fill(tr, ["1", "1", "1"]);
  await tr.byTag("input")[0].dispatch("keydown", {key: "Enter"});
  await flush();
  assert.ok(s.root.textContent.includes("This article changed meanwhile; reloading"));
  assert.equal(s.state.reloads, 1);
});

test("errors 142 and 155 are shown next to the controls and the table stays as it was", async () => {
  for (const [code, msg, expect] of [[142, "index out of range", "Not accepted: index out of range"], [155, "retry in 12 s", "Too many actions, please wait. retry in 12 s"]]) {
    const s = await setup({wrap: () => async () => { throw {code, message: msg}; }});
    await s.root.byTag("tbody")[0].children[0].dispatch("click");
    const tr = s.root.byTag("tbody")[0].children[0];
    fill(tr, ["1", "1", "1"]);
    await tr.byTag("input")[0].dispatch("keydown", {key: "Enter"});
    await flush();
    assert.ok(s.root.textContent.includes(expect), s.root.textContent);
    assert.equal(s.state.reloads, 0);
    assert.equal(s.state.rev, 0);
  }
});

test("not sent while annotations are loading; logout hides the controls", async () => {
  const calls = [];
  const s = await setup({wrap: (c) => async (n, p) => { calls.push(n); return c(n, p); }});
  s.state.loaded = false;
  await s.root.buttons("Edit title")[0].dispatch("click");
  await s.root.buttons("Save")[0].dispatch("click"); // unchanged: cancels
  await s.root.buttons("Import from text")[0].dispatch("click");
  s.root.byTag("textarea")[0].value = "1,2,3";
  await s.root.buttons("Preview")[0].dispatch("click");
  await s.root.buttons("Replace table")[0].dispatch("click");
  assert.deepEqual(calls, []);
  assert.ok(s.root.textContent.includes("still loading"));
  s.state.user = null;
  s.state.subs.forEach((cb) => cb());
  assert.equal(s.root.hidden, true);
  assert.equal(s.container.classList.contains("te-active"), false);
});

test("no innerHTML in the new modules", async () => {
  const {readFileSync} = await import("node:fs");
  for (const f of ["table-edit", "import-table", "add-article"]) {
    assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write/.test(readFileSync(new URL(`../annotation/${f}.js`, import.meta.url), "utf8")), f);
  }
});
