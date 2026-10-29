// The fake DOM of the tests returns real arrays for `children`/`childNodes`; in a browser they are an HTMLCollection /
// NodeList (no filter, find, map, some, every, reduce, indexOf). A real browser run found such a call in collections.js,
// so this static check keeps the page code to what both support (use Array.from(node.children)).
import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync, readdirSync} from "node:fs";

const root = new URL("../", import.meta.url);
const files = [...readdirSync(new URL("annotation/", root)).filter((f) => f.endsWith(".js")).map((f) => `annotation/${f}`),
  "article.js", "search.js", "index.js", "collections.js"];

test("page code does not call array methods on children/childNodes", () => {
  for (const f of files) {
    const src = readFileSync(new URL(f, root), "utf8");
    const bad = src.match(/\.(children|childNodes)\.(filter|find|map|some|every|reduce|indexOf|forEach|slice)\b/g);
    assert.equal(bad, null, `${f}: ${bad}`);
  }
});
