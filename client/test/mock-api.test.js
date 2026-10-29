import test from "node:test";
import assert from "node:assert/strict";
import {createMockApi} from "../annotation/mock-api.js";

const mk = (user = "alice", extra = {}) => createMockApi({user, ...extra});
const find = (ann, kind, exp, tag) => ann.votes.find((v) => v.kind === kind && v.experimentId === exp && v.tag === tag);
const V = (o) => ({pmid: "12345", experimentId: 1, kind: "tag", ontology: "cognitive", tag: "attention", value: 1, ...o});

test("anonymous: reads work, every write is refused with 206", async () => {
  const api = mk(null);
  assert.equal(await api.call("me"), null);
  const ann = await api.call("getAnnotations", {pmid: "12345"});
  assert.equal(ann.pmid, "12345");
  assert.equal(find(ann, "mesh", -1, "Brain").mine, 0);
  assert.equal(ann.stereo.mine, null);
  for (const [name, p] of [["vote", V()], ["setStereoSpace", {pmid: "12345", space: "MNI"}], ["setNSubjects", {pmid: "12345", n: 5}],
    ["postComment", {pmid: "12345", text: "x"}], ["editExperiment", {pmid: "12345", experimentId: 1, rev: 0, ops: [{op: "setTitle", text: "x"}]}],
    ["addArticle", {pmid: "1"}], ["listCollections", {}], ["saveCollection", {name: "x"}], ["deleteCollection", {id: "x"}]]) {
    await assert.rejects(api.call(name, p), {code: 206}, name);
  }
});

test("me", async () => {
  const me = await mk("alice").call("me");
  assert.equal(me.login, "alice");
  assert.ok(me.id && Number.isInteger(me.githubId));
});

test("getAnnotations: legacy baseline and display rule", async () => {
  const ann = await mk(null).call("getAnnotations", {pmid: "12345"});
  // every MeSH heading is shown, with zero counts
  assert.equal(ann.votes.filter((v) => v.kind === "mesh").length, 4);
  // table correct baseline
  const t = find(ann, "tableOk", 1, "ok");
  assert.deepEqual([t.agree, t.disagree], [2, 1]);
  // a legacy tag with 3/1 is shown, one with 0/0 is not
  assert.ok(find(ann, "tag", 1, "working memory"));
  assert.equal(find(ann, "tag", 1, "Stroop task"), undefined);
  assert.deepEqual([ann.stereo.MNI, ann.stereo.Talairach], [2, 1]);
  assert.deepEqual(ann.nsubjects, {value: 20, values: [], mine: null});
  assert.deepEqual(ann.comments, []);
  assert.equal(ann.commentCount, 0);
});

test("vote state machine: create, flip, double submit, retract, re-vote", async () => {
  const api = mk();
  let r = await api.call("vote", V());
  assert.deepEqual([r.agree, r.disagree, r.mine, r.tag], [1, 0, 1, "attention"]);
  r = await api.call("vote", V());
  assert.deepEqual([r.agree, r.disagree, r.mine], [1, 0, 1]); // same vote twice: no double count
  r = await api.call("vote", V({value: -1}));
  assert.deepEqual([r.agree, r.disagree, r.mine], [0, 1, -1]); // flip
  r = await api.call("vote", V({value: 0}));
  assert.deepEqual([r.agree, r.disagree, r.mine], [0, 0, 0]); // retract
  r = await api.call("vote", V({value: 0}));
  assert.deepEqual([r.agree, r.disagree, r.mine], [0, 0, 0]); // retract again: none
  r = await api.call("vote", V());
  assert.deepEqual([r.agree, r.disagree, r.mine], [1, 0, 1]); // re-vote
});

test("votes of two users add up; mine is per user; a tag at zero disappears", async () => {
  const api = mk("alice");
  await api.call("vote", V());
  api._asOtherUser("bob");
  const r = await api.call("vote", V({value: -1}));
  assert.deepEqual([r.agree, r.disagree, r.mine], [1, 1, -1]);
  let ann = await api.call("getAnnotations", {pmid: "12345"});
  assert.equal(find(ann, "tag", 1, "attention").mine, -1);
  api._asOtherUser("alice");
  ann = await api.call("getAnnotations", {pmid: "12345"});
  assert.equal(find(ann, "tag", 1, "attention").mine, 1);
  await api.call("vote", V({value: 0}));
  api._asOtherUser("bob");
  await api.call("vote", V({value: 0}));
  ann = await api.call("getAnnotations", {pmid: "12345"});
  assert.equal(find(ann, "tag", 1, "attention"), undefined);
});

test("tag names are normalised and stored with the canonical spelling", async () => {
  const api = mk();
  const r = await api.call("vote", V({tag: "  ATTENTION "}));
  assert.equal(r.tag, "attention");
  const r2 = await api.call("vote", V({ontology: "tasks", tag: "n-back   TASK"}));
  assert.equal(r2.tag, "n-back task");
});

test("a vote on a legacy tag that is not in the concepts is accepted; unknown tags are not", async () => {
  const api = mk();
  const r = await api.call("vote", V({ontology: "tasks", tag: "Stroop task"}));
  assert.equal(r.agree, 1);
  await assert.rejects(api.call("vote", V({tag: "nonsense term"})), {code: 142});
});

test("mesh and tableOk votes", async () => {
  const api = mk();
  let r = await api.call("vote", {pmid: "12345", experimentId: -1, kind: "mesh", tag: "Brain", value: -1});
  assert.deepEqual([r.agree, r.disagree, r.mine, r.ontology], [0, 1, -1, null]);
  r = await api.call("vote", {pmid: "12345", experimentId: 1, kind: "tableOk", tag: "ok", value: 1});
  assert.deepEqual([r.agree, r.disagree, r.mine], [3, 1, 1]); // baseline 2/1 included
  await assert.rejects(api.call("vote", {pmid: "12345", experimentId: -1, kind: "mesh", tag: "Not a heading", value: 1}), {code: 142});
});

test("vote validation: 142 for bad input, 101 for unknown article", async () => {
  const api = mk();
  await assert.rejects(api.call("vote", V({value: 2})), {code: 142});
  await assert.rejects(api.call("vote", V({kind: "space"})), {code: 142});
  await assert.rejects(api.call("vote", V({ontology: "bogus"})), {code: 142});
  await assert.rejects(api.call("vote", V({experimentId: 99})), {code: 142});
  await assert.rejects(api.call("vote", V({extra: 1})), {code: 142});
  await assert.rejects(api.call("vote", V({pmid: "999999"})), {code: 101});
  await assert.rejects(api.call("vote", V({pmid: "abc"})), {code: 142});
});

test("rate limit: 61st vote in a minute is 155, window slides", async () => {
  let t = 1000;
  const api = mk("alice", {now: () => t});
  for (let i = 0; i < 60; i++) {
    await api.call("vote", V({value: i % 2 ? 1 : -1}));
  }
  await assert.rejects(api.call("vote", V()), (e) => e.code === 155 && /retry in \d+ s/.test(e.message));
  t += 61000;
  await api.call("vote", V());
});

test("comments: post, newest 200 oldest first, validation, rate limit 5/min", async () => {
  let t = 1;
  const api = mk("alice", {now: () => t});
  const c = await api.call("postComment", {pmid: "12345", text: "hello <b>x</b>"});
  assert.deepEqual(Object.keys(c).sort(), ["createdAt", "id", "login", "text"]);
  assert.equal(c.text, "hello <b>x</b>"); // stored verbatim, escaped by the client
  await assert.rejects(api.call("postComment", {pmid: "12345", text: ""}), {code: 142});
  await assert.rejects(api.call("postComment", {pmid: "12345", text: "x".repeat(5001)}), {code: 142});
  for (let i = 0; i < 4; i++) { await api.call("postComment", {pmid: "12345", text: `c${i}`}); }
  await assert.rejects(api.call("postComment", {pmid: "12345", text: "one more"}), {code: 155});
  const ann = await api.call("getAnnotations", {pmid: "12345"});
  assert.equal(ann.comments.length, 5);
  assert.equal(ann.comments[4].text, "c3");
  assert.equal(ann.commentCount, 5);
});

test("comments: only the newest 200 are returned", async () => {
  let t = 0;
  const api = mk("alice", {now: () => t});
  for (let i = 0; i < 210; i++) {
    t += 3600e3 * 24; // far apart: no rate limit
    await api.call("postComment", {pmid: "67890", text: `n${i}`});
  }
  const ann = await api.call("getAnnotations", {pmid: "67890"});
  assert.equal(ann.comments.length, 200);
  assert.equal(ann.comments[0].text, "n10");
  assert.equal(ann.comments[199].text, "n209");
  assert.equal(ann.commentCount, 210);
});

test("stereo space: replace, retract, validation", async () => {
  const api = mk();
  let r = await api.call("setStereoSpace", {pmid: "12345", space: "Talairach"});
  assert.deepEqual(r, {MNI: 2, Talairach: 2, mine: "Talairach"});
  r = await api.call("setStereoSpace", {pmid: "12345", space: "MNI"});
  assert.deepEqual(r, {MNI: 3, Talairach: 1, mine: "MNI"});
  r = await api.call("setStereoSpace", {pmid: "12345", space: null});
  assert.deepEqual(r, {MNI: 2, Talairach: 1, mine: null});
  await assert.rejects(api.call("setStereoSpace", {pmid: "12345", space: "mni"}), {code: 142});
});

test("number of subjects: most voted wins, ties by most recent, legacy fallback", async () => {
  let t = 1;
  const api = mk("alice", {now: () => t});
  let r = await api.call("setNSubjects", {pmid: "12345", n: 18});
  assert.deepEqual(r, {value: 18, values: [{n: 18, count: 1}], mine: 18});
  api._asOtherUser("bob"); t = 2;
  r = await api.call("setNSubjects", {pmid: "12345", n: 22});
  assert.equal(r.value, 22); // tie, most recent
  api._asOtherUser("carol"); t = 3;
  r = await api.call("setNSubjects", {pmid: "12345", n: 18});
  assert.equal(r.value, 18);
  assert.deepEqual(r.values, [{n: 18, count: 2}, {n: 22, count: 1}]);
  r = await api.call("setNSubjects", {pmid: "12345", n: null});
  assert.equal(r.mine, null);
  api._asOtherUser("alice"); await api.call("setNSubjects", {pmid: "12345", n: null});
  api._asOtherUser("bob"); r = await api.call("setNSubjects", {pmid: "12345", n: null});
  assert.deepEqual(r, {value: 20, values: [], mine: null}); // legacy
  await assert.rejects(api.call("setNSubjects", {pmid: "12345", n: 0}), {code: 142});
  await assert.rejects(api.call("setNSubjects", {pmid: "12345", n: 1.5}), {code: 142});
  await assert.rejects(api.call("setNSubjects", {pmid: "12345", n: 100001}), {code: 142});
});

test("failCode makes every write fail with that code, reads still work", async () => {
  const api = mk("alice", {failCode: 155});
  await assert.rejects(api.call("vote", V()), {code: 155});
  await assert.ok(await api.call("getAnnotations", {pmid: "12345"}));
});

test("listConcepts / getConcept", async () => {
  const api = mk(null);
  for (const o of ["cognitive", "behavioural", "tasks"]) {
    const l = await api.call("listConcepts", {ontology: o});
    assert.ok(l.length > 0 && l.every((c) => typeof c.name === "string" && "parent" in c));
  }
  await assert.rejects(api.call("listConcepts", {ontology: "x"}), {code: 142});
  const c = await api.call("getConcept", {name: "attention", ontology: "cognitive"});
  assert.deepEqual(Object.keys(c).sort(), ["definition", "name", "ontology", "url"]);
  await assert.rejects(api.call("getConcept", {name: "zzz", ontology: "cognitive"}), {code: 101});
});

test("editExperiment: ops, rev conflict, split, replaceFromText", async () => {
  const api = mk();
  await assert.rejects(api.call("editExperiment", {pmid: "12345", experimentId: 1, rev: 5, ops: [{op: "setTitle", text: "t"}]}), {code: 1001});
  let r = await api.call("editExperiment", {pmid: "12345", experimentId: 1, rev: 0, ops: [{op: "setTitle", text: "New"}, {op: "addRow", xyz: [1, 2, 3.14159]}, {op: "deleteRow", index: 0}]});
  assert.equal(r.rev, 1);
  assert.equal(r.experiments[0].title, "New");
  assert.equal(r.experiments[0].locations.at(-1), "1,2,3.142");
  r = await api.call("editExperiment", {pmid: "12345", experimentId: 1, rev: 1, ops: [{op: "split", index: 2}]});
  assert.equal(r.experiments.length, 2);
  assert.equal(r.experiments[1].id, 4); // max id (3) + 1
  assert.deepEqual(r.experiments[1].tags, []);
  r = await api.call("editExperiment", {pmid: "12345", experimentId: 3, rev: 2, ops: [{op: "replaceFromText", text: "a\nx 1, 2−, 3\n4;5;-6"}]});
  assert.deepEqual(r.experiments[0].locations, ["1,2,3", "4,5,-6"]); // "a" has no numbers: skipped
  await assert.rejects(api.call("editExperiment", {pmid: "12345", experimentId: 3, rev: 3, ops: [{op: "replaceFromText", text: "nothing"}]}), {code: 142});
  await assert.rejects(api.call("editExperiment", {pmid: "12345", experimentId: 3, rev: 3, ops: [{op: "addRow", xyz: [500, 0, 0]}]}), {code: 142});
});

test("addArticle and collections", async () => {
  const api = mk();
  const r = await api.call("addArticle", {pmid: "555", nTables: 2});
  assert.equal(r.pmid, "555");
  await assert.rejects(api.call("addArticle", {pmid: "555"}), {code: 137});
  assert.equal((await api.getArticle("555")).Experiments.length, 2);
  const c = await api.call("saveCollection", {name: "mine", add: ["12345", "67890"]});
  assert.deepEqual(c.pmids, ["12345", "67890"]);
  const c2 = await api.call("saveCollection", {id: c.id, remove: ["12345"]});
  assert.deepEqual(c2.pmids, ["67890"]);
  assert.equal((await api.call("listCollections", {})).length, 1);
  await api.call("deleteCollection", {id: c.id});
  assert.equal((await api.call("listCollections", {})).length, 0);
  assert.equal(await api.getArticle("nope"), null);
});
