import test from "node:test";
import assert from "node:assert/strict";
import {makeDocument, flush} from "./fake-dom.js";
import {setDocument} from "../annotation/dom.js";
import {parseLocations, openImportDialog} from "../annotation/import-table.js";

const xyz = (t) => parseLocations(t).rows.map((r) => r.xyz);

test("grammar vectors", () => {
  assert.deepEqual(xyz("10,20,30"), [[10, 20, 30]]);
  assert.deepEqual(xyz("x=-5.5; y: 2; z=3"), [[-5.5, 2, 3]]);
  assert.deepEqual(xyz("−12\t34\t56"), [[-12, 34, 56]]);
  assert.deepEqual(xyz("1,2,3,4.5"), [[1, 2, 3]]);
  assert.deepEqual(xyz("\"10\",\"20\",\"30\""), [[10, 20, 30]]);
  assert.deepEqual(xyz("a1b2c3"), [[1, 2, 3]]);
  assert.deepEqual(xyz("  7 , -8 , 9  "), [[7, -8, 9]]);
  assert.deepEqual(xyz("1.50,2.000,.5"), [[1.5, 2, 0.5]]);
});

test("skipped, errors, no valid line", () => {
  const a = parseLocations("1 2");
  assert.deepEqual(a.skipped, [{line: 1, text: "1 2"}]);
  assert.equal(a.ok, false);
  const b = parseLocations("300,0,0");
  assert.equal(b.ok, false);
  assert.equal(b.errors[0].line, 1);
  assert.match(b.errors[0].message, /line 1/);
  for (const t of ["", "no numbers here"]) {
    const r = parseLocations(t);
    assert.equal(r.ok, false);
    assert.equal(r.rows.length, 0);
  }
  const m = parseLocations("1,2,3\r\n\r\nfoo\n4,5,6\n9,9,999");
  assert.deepEqual(m.rows.map((r) => r.line), [1, 4]);
  assert.deepEqual(m.skipped.map((s) => s.line), [3]);
  assert.equal(m.errors[0].line, 5);
  assert.equal(m.ok, false);
  assert.equal(parseLocations("200,-200,0").ok, true);
});

test("dialog: preview, replace sends the original text, errors keep it open", async () => {
  setDocument(makeDocument());
  const host = makeDocument().createElement("div");
  const sent = [];
  let closed = 0;
  let answer = {ok: false, error: "Not accepted: boom"};
  const d = openImportDialog(host, {onReplace: async (t) => { sent.push(t); return answer; }, onClose: () => { closed++; }});
  const area = d.node.byTag("textarea")[0];
  const replace = () => d.node.buttons("Replace")[0];
  assert.equal(replace().disabled, true);
  area.value = "x 1 y 2 z 3\nbad line\n  −2, 3, 4 ";
  await d.node.buttons("Preview")[0].dispatch("click");
  assert.ok(d.node.textContent.includes("2 locations will replace"));
  assert.ok(d.node.textContent.includes("line 2: bad line"));
  assert.equal(replace().disabled, false);
  await replace().dispatch("click");
  assert.deepEqual(sent, [area.value]);
  assert.equal(closed, 0);
  assert.ok(d.node.textContent.includes("Not accepted: boom"));
  answer = {ok: true};
  await replace().dispatch("click");
  assert.equal(sent.length, 2);
  assert.equal(closed, 1);
  assert.equal(host.childNodes.length, 0);
});

test("dialog: an invalid text cannot be replaced; editing after preview needs a new preview", async () => {
  setDocument(makeDocument());
  const host = makeDocument().createElement("div");
  const sent = [];
  const d = openImportDialog(host, {onReplace: async (t) => { sent.push(t); return {ok: true}; }});
  const area = d.node.byTag("textarea")[0];
  area.value = "999,0,0";
  await d.node.buttons("Preview")[0].dispatch("click");
  assert.equal(d.node.buttons("Replace")[0].disabled, true);
  assert.ok(d.node.textContent.includes("line 1"));
  area.value = "1,2,3";
  await d.node.buttons("Preview")[0].dispatch("click");
  area.value = "4,5,6";
  await area.dispatch("input");
  assert.equal(d.node.buttons("Replace")[0].disabled, true);
  await flush();
  assert.deepEqual(sent, []);
});
