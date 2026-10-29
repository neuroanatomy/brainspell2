import test from "node:test";
import assert from "node:assert/strict";
import {makeDocument, flush} from "./fake-dom.js";
import {setDocument} from "../annotation/dom.js";
import * as api from "../annotation/api.js";
import * as session from "../annotation/session.js";
import * as hooks from "../annotation/hooks.js";
import {createMockApi} from "../annotation/mock-api.js";

globalThis.__noAutostart = true;
const article = await import("../article.js");

// A stand-in for the browser's inert DOMParser: drops script elements and tags, decodes common entities once.
// (The real parser is exercised by the manual checklist.)
globalThis.DOMParser = class {
  parseFromString(s) {
    const body = String(s).replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<[^>]*>/g, "")
      .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

    return {querySelectorAll: () => ({forEach() {}}), documentElement: {textContent: body}};
  }
};

const run = async ({user, pmid = "12345", mockOpts = {}}) => {
  const doc = makeDocument();
  setDocument(doc);
  globalThis.document = doc;
  const root = doc.register("article", doc.createElement("div"));
  globalThis.location = {search: `?pmid=${pmid}`};
  globalThis.window = {};
  session._reset();
  hooks._clear();
  const mock = createMockApi({user, ...mockOpts});
  api.setBackend(mock);
  const viewers = [];
  article.setViewerFactory(async (id, locs) => { viewers.push([id, locs.length]); });
  const toolCalls = [];
  hooks.registerExperimentTools((container, exp, info) => toolCalls.push({container, id: exp.id, info}));
  const missing = [];
  hooks.registerMissingArticle((container, p) => missing.push([container, p]));
  await session.init().catch(() => {});
  // the fake backend answers me() only in "mock" mode; set the session by hand
  await article.init();
  await flush();

  return {root, mock, viewers, toolCalls, missing, doc};
};

const allNodes = (root) => root.all(() => true);

test("article page: database content is only ever text (no script/img elements)", async () => {
  const {root} = await run({user: null});
  assert.deepEqual(allNodes(root).filter((n) => ["SCRIPT", "IMG", "IFRAME", "STYLE"].includes(n.tagName)), []);
  const t = root.textContent;
  assert.ok(t.includes("Sample <i>mock</i> article about working memory & attention"), "entities decoded once, shown as text");
  assert.equal(root.byTag("i").length, 0);
  assert.ok(t.includes("Smith J, Doe A, Roe B Mock J Neurosci 2020"));
  assert.ok(t.includes("not bold"));
  assert.ok(!t.includes("window.__xss"), "script content removed from the abstract");
  assert.ok(t.includes("<img src=x onerror=alert(1)>"), "hostile MeSH name shown literally as text");
  assert.ok(t.includes("Activations for <b>task</b> vs baseline"));
  // the coordinates
  assert.ok(root.byTag("td").some((td) => td.textContent === "-42"));
});

test("anonymous: counts visible, no write control, empty table hidden, tools only for non-empty tables", async () => {
  const {root, viewers, toolCalls} = await run({user: null});
  const sections = root.textContent;
  assert.match(sections, /Medical Subject Headings/);
  assert.match(sections, /Log in to contribute/);
  assert.match(sections, /Table is correct: \u2713 Yes 2/);
  assert.match(sections, /working memory/);
  assert.match(sections, /Stereotaxic space: MNI 2/);
  assert.match(sections, /Discussion/);
  // the only buttons are chips (they open a read-only popup): no vote, edit or add control
  assert.ok(root.buttons().every((b) => b.classList.contains("chip")), root.buttons().map((b) => b.textContent).join("|"));
  assert.equal(root.byTag("textarea")[0].parentNode.hidden, true);
  const exps = root.findClass("experiment");
  assert.equal(exps.length, 3);
  assert.deepEqual(exps.map((e) => e.hidden), [false, false, true]);
  assert.deepEqual(viewers, [["viewer0", 5], ["viewer1", 2]]);
  assert.deepEqual(toolCalls.map((c) => c.id), [1, 2]);
  assert.equal(toolCalls[0].info.pmid, "12345");
  assert.equal(toolCalls[0].info.rev, 0);
  assert.equal(typeof toolCalls[0].info.reload, "function");
});

test("logged in via ?mock=1&as=alice: full flow", async () => {
  const doc = makeDocument();
  setDocument(doc);
  globalThis.document = doc;
  const root = doc.register("article", doc.createElement("div"));
  globalThis.location = {search: "?pmid=12345&mock=1&as=alice&latency=0"};
  globalThis.window = {};
  session._reset();
  hooks._clear();
  api.setBackend(null);
  article.setViewerFactory(async () => {});
  const toolCalls = [];
  hooks.registerExperimentTools((c, exp) => toolCalls.push(exp.id));
  await session.init();
  assert.equal(session.current().login, "alice");
  await article.init();
  await flush();
  assert.deepEqual(toolCalls, [1, 2, 3], "tools also for the empty table when logged in");
  assert.deepEqual(root.findClass("experiment").map((e) => e.hidden), [false, false, false]);
  assert.equal(root.textContent.includes("Log in to contribute"), true);
  assert.equal(root.findClass("login-hint")[0].hidden, true);
  assert.equal(root.buttons("Agree").length, 0, "no inline vote buttons: they are in the popup");
  // vote on a mesh heading through its popup
  const brain = root.findClass("chip")[0];
  await brain.dispatch("click");
  await brain.parentNode.findClass("vote-popup")[0].buttons("Agree")[0].dispatch("click");
  await flush();
  assert.match(brain.textContent, /\+1 \u22120/);
  // log out: controls disappear at once
  await session.logout();
  await flush();
  assert.equal(root.findClass("login-hint")[0].hidden, false);
  assert.equal(brain.parentNode.findClass("vote-popup")[0].buttons("Agree").length, 0, "the open popup is read-only after logout");
  assert.deepEqual(root.findClass("experiment").map((e) => e.hidden), [false, false, true]);
  api.setBackend(null);
});

test("missing article: neutral message and the hook is called", async () => {
  const {root, missing, toolCalls} = await run({user: null, pmid: "999"});
  assert.match(root.textContent, /Article 999 is not in the database/);
  assert.equal(missing.length, 1);
  assert.equal(missing[0][1], "999");
  assert.equal(missing[0][0].parentNode, root);
  assert.equal(toolCalls.length, 0);
});

test("missing article without hooks: just the message", async () => {
  const doc = makeDocument();
  setDocument(doc);
  globalThis.document = doc;
  const root = doc.register("article", doc.createElement("div"));
  globalThis.location = {search: "?pmid=999"};
  hooks._clear();
  api.setBackend(createMockApi({}));
  await article.init();
  assert.match(root.textContent, /not in the database/);
});

test("annotation load failure shows a retry and keeps the article", async () => {
  let fail = true;
  const doc = makeDocument();
  setDocument(doc);
  globalThis.document = doc;
  const root = doc.register("article", doc.createElement("div"));
  globalThis.location = {search: "?pmid=12345"};
  hooks._clear();
  session._reset();
  const mock = createMockApi({});
  api.setBackend({call: async (n, p) => { if (n === "getAnnotations" && fail) { const e = new Error("down"); e.code = 100; throw e; } return mock.call(n, p); }, getArticle: mock.getArticle});
  article.setViewerFactory(async () => {});
  await article.init();
  await flush();
  assert.match(root.textContent, /Annotations could not be loaded: Cannot reach the server/);
  assert.match(root.textContent, /Sample <i>mock<\/i> article/);
  fail = false;
  await root.buttons("Retry")[0].dispatch("click");
  await flush();
  assert.match(root.textContent, /Medical Subject Headings/);
});

test("no pmid in the URL", async () => {
  const doc = makeDocument();
  setDocument(doc);
  globalThis.document = doc;
  const root = doc.register("article", doc.createElement("div"));
  globalThis.location = {search: ""};
  await article.init();
  assert.match(root.textContent, /No article selected/);
});
