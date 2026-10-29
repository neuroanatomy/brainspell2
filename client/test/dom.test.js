import test from "node:test";
import assert from "node:assert/strict";
import {makeDocument} from "./fake-dom.js";
import {el, text, setDocument, isSafeUrl, setChildren, decodeEntities} from "../annotation/dom.js";

setDocument(makeDocument());

test("el builds nodes; hostile strings stay text", () => {
  const evil = "<img src=x onerror=alert(1)><script>alert(2)</script>";
  const n = el("div", {class: "a b"}, evil, 42, null, false, [el("span", null, evil)]);
  assert.equal(n.className, "a b");
  assert.equal(n.textContent, evil + "42" + evil);
  assert.deepEqual(n.all(() => true).map((c) => c.tagName), ["SPAN"]);
});

test("el refuses innerHTML, non-function handlers and unsafe URLs", () => {
  assert.throws(() => el("div", {innerHTML: "x"}));
  assert.throws(() => el("div", {outerHTML: "x"}));
  assert.throws(() => el("div", {onclick: "alert(1)"}));
  assert.throws(() => el("a", {href: "javascript:alert(1)"}));
  assert.throws(() => el("a", {href: " JaVa\nscript:alert(1)"}));
  assert.throws(() => el("a", {href: "data:text/html,x"}));
  assert.doesNotThrow(() => el("a", {href: "https://github.com/x"}));
  assert.doesNotThrow(() => el("a", {href: "/article.html?pmid=1"}));
  assert.doesNotThrow(() => el("a", {href: "#"}));
});

test("isSafeUrl", () => {
  assert.ok(isSafeUrl("mailto:a@b.c"));
  assert.ok(!isSafeUrl("vbscript:x"));
  assert.ok(!isSafeUrl("\tjavascript:x"));
});

test("properties and handlers", async () => {
  let clicked = 0;
  const b = el("button", {disabled: true, hidden: false, onclick: () => clicked++}, "x");
  assert.equal(b.disabled, true);
  assert.equal(b.hidden, false);
  await b.dispatch("click");
  assert.equal(clicked, 0);
  b.disabled = false;
  await b.dispatch("click");
  assert.equal(clicked, 1);
});

test("setChildren replaces and accepts arrays", () => {
  const n = el("div", null, "old");
  setChildren(n, ["a", [el("b", null, "c")]], null, "d");
  assert.equal(n.textContent, "acd");
});

test("text(null) is empty", () => {
  assert.equal(text(null).data, "");
  assert.equal(text(0).data, "0");
});

test("decodeEntities goes through DOMParser and drops markup", () => {
  const seen = [];
  globalThis.DOMParser = class {
    parseFromString(s, type) {
      seen.push([s, type]);

      return {querySelectorAll: () => ({forEach() {}}), documentElement: {textContent: "decoded"}};
    }
  };
  assert.equal(decodeEntities("&lt;i&gt;"), "decoded");
  assert.deepEqual(seen, [["&lt;i&gt;", "text/html"]]);
  assert.equal(decodeEntities(null), "");
  delete globalThis.DOMParser;
});
