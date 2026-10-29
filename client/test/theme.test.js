import test from "node:test";
import assert from "node:assert/strict";

globalThis.__noAutostart = true;
const theme = await import("../annotation/theme.js");

const memory = () => {
  const m = new Map();

  return {getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, v), removeItem: (k) => m.delete(k), m};
};
const root = () => {
  const attrs = {};

  return {setAttribute: (k, v) => { attrs[k] = v; }, attrs};
};

test("default is dark and nothing is stored", () => {
  const st = memory();
  const r = root();
  assert.equal(theme.init({search: "", storage: st, root: r}), "dark");
  assert.equal(r.attrs["data-theme"], "dark");
  assert.equal(st.m.size, 0);
});

test("?theme=light applies and is remembered; the next page without a parameter keeps it; ?theme=dark forgets it", () => {
  const st = memory();
  assert.equal(theme.init({search: "?pmid=1&theme=light", storage: st, root: root()}), "light");
  assert.equal(st.getItem(theme.KEY), "light");
  const r = root();
  assert.equal(theme.init({search: "?pmid=2", storage: st, root: r}), "light");
  assert.equal(r.attrs["data-theme"], "light");
  assert.equal(theme.init({search: "?theme=dark", storage: st, root: root()}), "dark");
  assert.equal(st.getItem(theme.KEY), null);
});

test("unknown values are ignored; blocked storage never breaks the page", () => {
  const st = memory();
  assert.equal(theme.init({search: "?theme=<script>", storage: st, root: root()}), "dark");
  st.setItem(theme.KEY, "neon");
  assert.equal(theme.init({search: "", storage: st, root: root()}), "dark");
  const blocked = {getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); }, removeItem() { throw new Error("blocked"); }};
  assert.equal(theme.init({search: "?theme=light", storage: blocked, root: root()}), "light");
  assert.equal(theme.init({search: "", storage: blocked, root: root()}), "dark");
  assert.equal(theme.init({search: "", storage: null, root: root()}), "dark");
});
