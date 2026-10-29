import test from "node:test";
import assert from "node:assert/strict";
import * as hooks from "../annotation/hooks.js";

test("hooks: registered functions are called; a failing hook does not break the others", () => {
  hooks._clear();
  const seen = [];
  hooks.registerExperimentTools(() => { throw new Error("boom"); });
  hooks.registerExperimentTools((c, e, i) => seen.push([c, e, i]));
  hooks.runExperimentTools("C", {id: 1}, {pmid: "1", rev: 0, reload() {}});
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0].slice(0, 2), ["C", {id: 1}]);
  assert.equal(hooks.runMissingArticle("C", "9"), false);
  const m = [];
  hooks.registerMissingArticle((c, p) => m.push([c, p]));
  assert.equal(hooks.runMissingArticle("C", "9"), true);
  assert.deepEqual(m, [["C", "9"]]);
  hooks._clear();
});
