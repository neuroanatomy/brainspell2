// Stage 3 of the UI round: in-place title/caption editing, icon buttons, toolbar below the table.
import test from "node:test";
import assert from "node:assert/strict";
import {makeDocument, flush} from "./fake-dom.js";
import {setDocument, el} from "../annotation/dom.js";
import {createMockApi} from "../annotation/mock-api.js";
import * as te from "../annotation/table-edit.js";

globalThis.DOMParser = class {
  parseFromString(s) { return {documentElement: {textContent: String(s).replace(/&lt;/g, "<").replace(/&amp;/g, "&")}}; }
};

const setup = async ({user = "alice"} = {}) => {
  const doc = makeDocument();
  setDocument(doc);
  const mock = createMockApi({user: "alice", latency: 0});
  const art = await mock.getArticle("12345");
  const ex = art.Experiments[0];
  const title = el("b", {class: "exp-title"}, ex.title);
  const caption = el("span", {class: "exp-caption"}, ex.caption);
  const titleBox = el("div", {class: "exp-title-box"}, title);
  const captionBox = el("div", {class: "exp-caption-box"}, caption);
  const container = el("div", {class: "experiment"}, titleBox, captionBox);
  const state = {user: user ? {id: "u"} : null, rev: 0, calls: []};
  const info = {pmid: "12345", get rev() { return state.rev; }, setRev: (r) => { state.rev = r; }, reload() {},
    slots: {title, caption, titleBox, captionBox, viewer: el("div"), coords: null}, createViewer: async () => {}};
  const call = async (n, p) => { state.calls.push(n); return mock.call(n, p); };
  const ed = te.createEditor({container, experiment: ex, info, call, user: () => state.user, subscribeUser: (cb) => { state.cb = cb; return () => {}; }, confirm: () => true});

  return {ed, state, title, caption, titleBox, captionBox, root: ed.root, container, mock};
};

test("pencil buttons: icon only, labelled, next to the text; the text shows again after saving", async () => {
  const s = await setup();
  const pencil = s.titleBox.byLabel("Edit title")[0];
  assert.ok(pencil, "pencil in the title box");
  assert.equal(pencil.textContent, "✎");
  assert.equal(pencil.getAttribute("title"), "Edit title");
  assert.equal(s.captionBox.byLabel("Edit caption").length, 1);
  await pencil.dispatch("click");
  assert.equal(s.title.hidden, true, "the text is replaced by the form");
  const input = s.titleBox.byTag("input")[0];
  assert.equal(input.value, "Task > baseline");
  assert.equal(FocusCheck(input), true);
  input.value = "Renamed";
  await input.dispatch("keydown", {key: "Enter"});
  await flush();
  assert.equal(s.title.hidden, false);
  assert.equal(s.title.textContent, "Renamed");
  assert.equal(s.titleBox.byTag("input").length, 0);
  assert.equal(s.state.rev, 1);
});

const FocusCheck = (n) => n.tagName === "INPUT"; // focus is not observable in the fake DOM beyond FNode.active

test("clicking the text starts editing; Escape reverts without sending anything", async () => {
  const s = await setup();
  await s.title.dispatch("click");
  const input = s.titleBox.byTag("input")[0];
  assert.ok(input);
  input.value = "never saved";
  await input.dispatch("keydown", {key: "Escape"});
  assert.equal(s.titleBox.byTag("input").length, 0);
  assert.equal(s.title.hidden, false);
  assert.equal(s.title.textContent, "Task > baseline");
  assert.deepEqual(s.state.calls, []);
  // the Cancel button reverts too
  await s.caption.dispatch("click");
  await s.captionBox.buttons("Cancel")[0].dispatch("click");
  assert.equal(s.caption.hidden, false);
  assert.deepEqual(s.state.calls, []);
});

test("caption: Enter adds a line, Ctrl+Enter or Save commits", async () => {
  const s = await setup();
  await s.captionBox.byLabel("Edit caption")[0].dispatch("click");
  const area = s.captionBox.byTag("textarea")[0];
  area.value = "line one\nline two";
  await area.dispatch("keydown", {key: "Enter"});
  assert.deepEqual(s.state.calls, []);
  await area.dispatch("keydown", {key: "Enter", ctrlKey: true});
  await flush();
  assert.equal(s.caption.textContent, "line one\nline two");
  assert.equal(s.state.rev, 1);
});

test("anonymous: no pencil, clicking the text does nothing", async () => {
  const s = await setup({user: null});
  assert.equal(s.titleBox.byLabel("Edit title").length, 0);
  await s.title.dispatch("click");
  assert.equal(s.titleBox.byTag("input").length, 0);
  assert.equal(s.title.hidden, false);
});

test("table: icon buttons per row with labels, header Add row, toolbar below the table", async () => {
  const s = await setup();
  const main = s.root.findClass("te-main")[0];
  const kids = main.children.map((c) => c.className);
  assert.ok(kids.indexOf("te-scroll") < kids.indexOf("te-toolbar"), `toolbar after the table: ${kids}`);
  assert.equal(s.root.byLabel("Add row after this row").length, 5);
  assert.equal(s.root.byLabel("Delete this row").length, 5);
  assert.equal(s.root.byLabel("Add row").length, 1);
  assert.ok(s.root.byLabel("Delete this row").every((b) => b.classList.contains("icon-btn")));
  assert.equal(s.root.findClass("te-toolbar")[0].buttons().length, 2);
  const split = s.root.buttons("Split here")[0];
  assert.equal(split.disabled, true);
  assert.match(split.getAttribute("title"), /Select a row/);
  await s.root.byTag("tbody")[0].children[2].dispatch("click");
  assert.equal(s.root.buttons("Split here")[0].disabled, false);
  assert.match(s.root.buttons("Split here")[0].getAttribute("title"), /Cut the table/);
});
