import test from "node:test";
import assert from "node:assert/strict";
import {makeDocument, flush} from "./fake-dom.js";
import {setDocument} from "../annotation/dom.js";
import {createMockApi} from "../annotation/mock-api.js";
import {createContext} from "../annotation/context.js";
import {renderMesh, renderTableOk, balanceClass, findVote, applyVoteResult} from "../annotation/votes.js";
import {renderTags, filterConcepts, tagsOf} from "../annotation/tags.js";
import {renderMeta, parseSubjects} from "../annotation/meta.js";
import {renderComments, validComment, formatDate} from "../annotation/comments.js";
import {loginHint} from "../annotation/context.js";

const PMID = "12345";
const MESH = [{name: "Brain"}, {name: "Attention"}, {name: "<img src=x onerror=alert(1)>"}];

const setup = async ({user = "alice", wrap = (c) => c, mockOpts = {}} = {}) => {
  setDocument(makeDocument());
  const mock = createMockApi({user, ...mockOpts});
  const state = {user: user ? {id: "u_" + user, login: user} : null};
  const ctx = createContext({pmid: PMID, ann: await mock.call("getAnnotations", {pmid: PMID}), call: wrap(mock.call), user: () => state.user});

  return {mock, ctx, state};
};

test("balanceClass", () => {
  assert.equal(balanceClass(0, 0), "bal-none");
  assert.equal(balanceClass(3, 0), "bal-good");
  assert.equal(balanceClass(2, 1), "bal-ok");
  assert.equal(balanceClass(1, 1), "bal-tie");
  assert.equal(balanceClass(1, 2), "bal-poor");
  assert.equal(balanceClass(0, 3), "bal-bad");
});

test("applyVoteResult: upsert; tags at zero are removed, mesh and tableOk stay", () => {
  const ann = {votes: [{kind: "tag", experimentId: 1, ontology: "tasks", tag: "x", agree: 1, disagree: 0, mine: 1}]};
  applyVoteResult(ann, {kind: "tag", experimentId: 1, ontology: "tasks", tag: "X", agree: 0, disagree: 0, mine: 0});
  assert.equal(ann.votes.length, 0);
  applyVoteResult(ann, {kind: "tag", experimentId: 1, ontology: "tasks", tag: "x", agree: 1, disagree: 0, mine: 1});
  assert.equal(ann.votes.length, 1);
  applyVoteResult(ann, {kind: "mesh", experimentId: -1, ontology: null, tag: "m", agree: 0, disagree: 0, mine: 0});
  assert.equal(findVote(ann, "mesh", -1, null, "m").agree, 0);
});

test("filterConcepts and tagsOf", () => {
  const cs = [{name: "Working memory", parent: "Memory"}, {name: "Attention", parent: ""}];
  assert.equal(filterConcepts(cs, "").length, 2);
  assert.deepEqual(filterConcepts(cs, "mem").map((c) => c.name), ["Working memory"]);
  assert.deepEqual(filterConcepts(cs, " ATT ").map((c) => c.name), ["Attention"]);
  const ann = {votes: [{kind: "tag", experimentId: 1, ontology: "tasks", tag: "b"}, {kind: "tag", experimentId: 1, ontology: "cognitive", tag: "z"},
    {kind: "tag", experimentId: 2, ontology: "cognitive", tag: "q"}, {kind: "mesh", experimentId: -1, tag: "m"}]};
  assert.deepEqual(tagsOf(ann, 1).map((t) => t.tag), ["z", "b"]);
});

test("parseSubjects, validComment, formatDate", () => {
  assert.equal(parseSubjects(" 20 "), 20);
  for (const bad of ["", "0", "1.5", "-3", "abc", "100001", "1e3", "1234567"]) { assert.equal(parseSubjects(bad), null, bad); }
  assert.equal(validComment("  hi "), "hi");
  assert.equal(validComment("   "), null);
  assert.equal(validComment("x".repeat(5001)), null);
  assert.equal(formatDate("2020-01-02T03:04:05.000Z"), "2020-01-02 03:04");
  assert.equal(formatDate("garbage"), "");
});

test("anonymous: counts visible, no write control anywhere, hint shown", async () => {
  const {ctx} = await setup({user: null});
  const mesh = renderMesh(ctx, MESH);
  const ok = renderTableOk(ctx, 1);
  const tags = renderTags(ctx, 1);
  const meta = renderMeta(ctx);
  const comments = renderComments(ctx);
  const hint = loginHint(ctx);
  assert.equal(hint.hidden, false);
  assert.equal(hint.textContent, "Log in to contribute");
  for (const n of [mesh, ok, meta]) {
    assert.equal(n.buttons().length, 0, "no buttons");
  }
  // the only buttons in tags are the existing chips (read-only popups); "Add tag" is hidden
  assert.deepEqual(tags.buttons().map((b) => b.textContent.split(" ")[0]), ["working"]);
  assert.equal(tags.buttons("Add tag").length, 0);
  assert.equal(comments.findClass("comment-box")[0].hidden, true);
  assert.equal(meta.byTag("input").length, 0);
  assert.match(ok.textContent, /Yes 2/);
  assert.match(ok.textContent, /No 1/);
  assert.match(meta.textContent, /MNI 2/);
  assert.match(meta.textContent, /Number of subjects: 20/);
  // the popup of a tag is readable by anonymous visitors, without vote buttons
  await tags.buttons("working")[0].dispatch("click");
  assert.equal(tags.findClass("tag-popup")[0].buttons("Agree").length, 0);
  assert.match(tags.findClass("tag-popup")[0].textContent, /Agree 3/);
});

test("MeSH: hostile heading names are text, controls update from the server answer", async () => {
  const {ctx, mock} = await setup();
  const mesh = renderMesh(ctx, MESH);
  assert.deepEqual(mesh.all(() => true).filter((n) => ["IMG", "SCRIPT"].includes(n.tagName)), []);
  assert.ok(mesh.textContent.includes("<img src=x onerror=alert(1)>"));
  const brain = mesh.findClass("mesh-item")[0];
  assert.equal(brain.buttons("Retract").length, 0);
  await brain.buttons("Agree")[0].dispatch("click");
  await flush();
  assert.equal(findVote(ctx.ann, "mesh", -1, null, "Brain").agree, 1);
  assert.match(brain.textContent, /Agree 1/);
  assert.equal(brain.findClass("tag")[0].className, "tag bal-good");
  assert.ok(brain.buttons("Agree")[0].classList.contains("mine"));
  assert.equal(brain.buttons("Retract").length, 1);
  await brain.buttons("Disagree")[0].dispatch("click");
  await flush();
  assert.match(brain.textContent, /Agree 0/);
  assert.match(brain.textContent, /Disagree 1/);
  await brain.buttons("Retract")[0].dispatch("click");
  await flush();
  assert.equal(findVote(ctx.ann, "mesh", -1, null, "Brain").disagree, 0);
  assert.equal(brain.buttons("Retract").length, 0);
  assert.equal((await mock.call("getAnnotations", {pmid: PMID})).votes.find((v) => v.tag === "Brain").mine, 0);
});

test("pending state disables the buttons; nothing changes before the answer", async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const {ctx} = await setup({wrap: (call) => async (n, p) => { if (n === "vote") { await gate; } return call(n, p); }});
  const mesh = renderMesh(ctx, MESH);
  const item = mesh.findClass("mesh-item")[0];
  const p = item.buttons("Agree")[0].dispatch("click");
  await flush();
  assert.match(item.findClass("ann-status")[0].textContent, /Saving/);
  assert.ok(item.byTag("button").every((b) => b.disabled));
  assert.equal(findVote(ctx.ann, "mesh", -1, null, "Brain").agree, 0, "not optimistic");
  release();
  await p;
  await flush();
  assert.equal(findVote(ctx.ann, "mesh", -1, null, "Brain").agree, 1);
  assert.ok(item.byTag("button").every((b) => !b.disabled));
  assert.equal(item.findClass("ann-status")[0].textContent, "");
});

for (const [code, re] of [[155, /Too many actions/], [142, /Not accepted/], [206, /session has expired/]]) {
  test(`vote error ${code} is shown and the counts stay as the server last said`, async () => {
    const {ctx} = await setup({mockOpts: {failCode: code}});
    const ok = renderTableOk(ctx, 1);
    await ok.buttons("Yes")[0].dispatch("click");
    await flush();
    assert.match(ok.findClass("ann-status")[0].textContent, re);
    assert.equal(findVote(ctx.ann, "tableOk", 1, null, "ok").agree, 2);
    assert.ok(ok.byTag("button").every((b) => !b.disabled));
  });
}

test("table correct: yes / no / retract from the server totals", async () => {
  const {ctx} = await setup();
  const ok = renderTableOk(ctx, 1);
  await ok.buttons("Yes")[0].dispatch("click"); await flush();
  assert.match(ok.textContent, /Yes 3/);
  await ok.buttons("No")[0].dispatch("click"); await flush();
  assert.match(ok.textContent, /Yes 2/);
  assert.match(ok.textContent, /No 2/);
  await ok.buttons("Retract")[0].dispatch("click"); await flush();
  assert.match(ok.textContent, /No 1/);
});

test("tags: chips with counts, add a tag from the picker with a filter", async () => {
  const {ctx} = await setup();
  const tags = renderTags(ctx, 1);
  assert.match(tags.textContent, /working memory/);
  assert.match(tags.textContent, /\+3 -1/);
  assert.doesNotMatch(tags.textContent, /Stroop/);
  const picker = tags.findClass("tag-picker")[0];
  assert.equal(picker.hidden, true);
  await tags.buttons("Add tag")[0].dispatch("click");
  await flush();
  assert.equal(picker.hidden, false);
  assert.deepEqual(picker.buttons("Cognitive Atlas").map((b) => b.textContent), ["Cognitive Atlas concepts", "Cognitive Atlas tasks"]);
  assert.ok(picker.buttons("emotion").length === 1);
  const filter = picker.byTag("input")[0];
  filter.value = "att";
  await filter.dispatch("input");
  assert.deepEqual(picker.findClass("concept").map((b) => b.textContent), ["attention"]);
  await picker.buttons("attention")[0].dispatch("click");
  await flush();
  assert.equal(picker.hidden, true);
  assert.equal(findVote(ctx.ann, "tag", 1, "cognitive", "attention").agree, 1);
  assert.match(tags.findClass("tag-chips")[0].textContent, /attention \+1 -0/);
  // another ontology
  await tags.buttons("Add tag")[0].dispatch("click"); await flush();
  await picker.buttons("tasks")[0].dispatch("click"); await flush();
  assert.ok(picker.buttons("n-back task").length === 1);
  assert.equal(picker.buttons("emotion").length, 0);
});

test("tags: popup with vote controls; retracting the only vote removes the chip", async () => {
  const {ctx} = await setup();
  await ctx.call("vote", {pmid: PMID, experimentId: 1, kind: "tag", ontology: "cognitive", tag: "emotion", value: 1})
    .then((r) => { applyVoteResult(ctx.ann, r); });
  const tags = renderTags(ctx, 1);
  const chip = tags.findClass("chip").find((c) => c.textContent.startsWith("emotion"));
  await chip.dispatch("click");
  const popup = tags.findClass("tag-popup")[0];
  assert.equal(popup.hidden, false);
  assert.match(popup.textContent, /Cognitive Atlas concepts/);
  await flush();
  assert.ok(popup.findClass("tag-info")[0].byTag("a")[0], "link to the term");
  await popup.buttons("Retract")[0].dispatch("click"); await flush();
  assert.equal(findVote(ctx.ann, "tag", 1, "cognitive", "emotion"), null);
  assert.equal(popup.hidden, true);
  assert.doesNotMatch(tags.textContent, /emotion \+/);
});

test("tags: picker error is shown (rate limit) and no tag is added", async () => {
  const {ctx} = await setup({mockOpts: {failCode: 155}});
  const tags = renderTags(ctx, 1);
  await tags.buttons("Add tag")[0].dispatch("click"); await flush();
  const picker = tags.findClass("tag-picker")[0];
  await picker.buttons("attention")[0].dispatch("click"); await flush();
  assert.match(picker.textContent, /Too many actions/);
  assert.equal(picker.hidden, false);
  assert.equal(findVote(ctx.ann, "tag", 1, "cognitive", "attention"), null);
});

test("tags: concept list failure shows a message", async () => {
  const {ctx} = await setup({wrap: (call) => async (n, p) => { if (n === "listConcepts") { const e = new Error("x"); e.code = 100; throw e; } return call(n, p); }});
  const tags = renderTags(ctx, 1);
  await tags.buttons("Add tag")[0].dispatch("click"); await flush();
  assert.match(tags.findClass("tag-picker")[0].textContent, /Could not load/);
});

test("meta: space and number of subjects", async () => {
  const {ctx} = await setup();
  const meta = renderMeta(ctx);
  await meta.buttons("Talairach")[0].dispatch("click"); await flush();
  assert.match(meta.textContent, /Talairach 2/);
  assert.ok(meta.buttons("Talairach")[0].classList.contains("mine"));
  await meta.buttons("Talairach")[0].dispatch("click"); await flush(); // click again retracts
  assert.match(meta.textContent, /Talairach 1/);
  const input = meta.byTag("input")[0];
  input.value = "abc";
  await meta.buttons("Save")[0].dispatch("click");
  assert.match(meta.textContent, /whole number/);
  assert.equal(ctx.ann.nsubjects.mine, null);
  input.value = "18";
  await meta.buttons("Save")[0].dispatch("click"); await flush();
  assert.equal(ctx.ann.nsubjects.mine, 18);
  assert.match(meta.textContent, /Number of subjects: 18/);
  await meta.buttons("Retract")[0].dispatch("click"); await flush();
  assert.equal(ctx.ann.nsubjects.mine, null);
  assert.match(meta.textContent, /Number of subjects: 20/);
});

test("comments: post, hostile text stays text, errors keep the draft", async () => {
  const {ctx, mock} = await setup();
  const c = renderComments(ctx);
  assert.match(c.textContent, /No comments yet/);
  const area = c.byTag("textarea")[0];
  area.value = "<script>alert(1)</script> hi";
  await c.buttons("Post")[0].dispatch("click"); await flush();
  assert.equal(area.value, "");
  assert.equal(c.byTag("script").length, 0);
  assert.ok(c.textContent.includes("<script>alert(1)</script> hi"));
  assert.match(c.byTag("h2")[0].textContent, /\(1\)/);
  assert.equal(c.byTag("a")[0].getAttribute("href"), "https://github.com/alice");
  area.value = "   ";
  await c.buttons("Post")[0].dispatch("click");
  assert.match(c.textContent, /1 to 5000/);
  // server failure keeps the text
  ctx.call = async () => { const e = new Error("slow"); e.code = 155; throw e; };
  area.value = "second";
  await c.buttons("Post")[0].dispatch("click"); await flush();
  assert.equal(area.value, "second");
  assert.match(c.findClass("ann-status")[0].textContent, /Too many/);
  assert.equal(ctx.ann.comments.length, 1);
  assert.equal((await mock.call("getAnnotations", {pmid: PMID})).comments.length, 1);
});

test("logging in and out switches the write controls", async () => {
  const {ctx, state} = await setup({user: null});
  const mesh = renderMesh(ctx, MESH);
  const hint = loginHint(ctx);
  assert.equal(mesh.buttons().length, 0);
  state.user = {id: "u_alice", login: "alice"};
  ctx.notify();
  assert.equal(mesh.buttons("Agree").length, 3);
  assert.equal(hint.hidden, true);
  state.user = null;
  ctx.notify();
  assert.equal(mesh.buttons().length, 0);
  assert.equal(hint.hidden, false);
});
