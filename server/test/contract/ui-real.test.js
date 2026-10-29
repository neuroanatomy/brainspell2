// The REAL client UI modules (client/annotation/{votes,tags,meta,comments,context,dom}.js, with the client's own
// fake DOM) driven against the REAL server through REST: legacy-shaped article, anonymous and logged in.
// This is what the browser does, minus the browser. Fails where the UI would show something wrong.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {pathToFileURL} = require('url');
const {test} = require('../integration/helpers/mini');

const CLIENT = path.resolve(__dirname, '..', '..', '..', 'client');
const PMID = '777001';
const ART = {
  PMID, Title: 'UI', Authors: 'A', Reference: 'r', Abstract: 'a',
  Metadata: {
    meshHeadings: [{name: 'Brain', majorTopic: true}, {name: 'Memory,  Short-Term', majorTopic: false}, {name: '<img src=x onerror=alert(1)>', majorTopic: false}],
    stereo: {MNI: 2, Talairach: 1}, nsubjects: 20
  },
  Experiments: [
    {id: 1, title: 't', caption: 'c', locations: ['1,2,3'], markBadTable: {ok: 2, bad: 1}, tags: [
      {name: 'Working Memory', ontology: 'cognitive', agree: 3, disagree: 1},
      {name: 'Stroop task', ontology: 'tasks', agree: 0, disagree: 0},
      {name: 'LegacyOnly', ontology: 'cognitive', agree: 2, disagree: 0}]},
    {id: 2, title: '', caption: '', locations: ['4,5,6']}
  ]
};

async function loadClient() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bs-client-'));
  fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}');
  fs.mkdirSync(path.join(dir, 'annotation'));
  fs.mkdirSync(path.join(dir, 'test'));
  for (const f of fs.readdirSync(path.join(CLIENT, 'annotation'))) {
    fs.copyFileSync(path.join(CLIENT, 'annotation', f), path.join(dir, 'annotation', f));
  }
  fs.copyFileSync(path.join(CLIENT, 'test', 'fake-dom.js'), path.join(dir, 'test', 'fake-dom.js'));
  const imp = (p) => import(pathToFileURL(path.join(dir, p)).href);
  const m = {
    fake: await imp('test/fake-dom.js'), dom: await imp('annotation/dom.js'), context: await imp('annotation/context.js'),
    votes: await imp('annotation/votes.js'), tags: await imp('annotation/tags.js'), meta: await imp('annotation/meta.js'),
    comments: await imp('annotation/comments.js'), api: await imp('annotation/api.js')
  };
  m.cleanup = () => fs.rmSync(dir, {recursive: true, force: true});

  return m;
}

const realCall = (ctx, session) => async (name, params) => {
  const r = await ctx.cloud(name, params, session);
  if (r.status === 200) {
    return r.json.result;
  }
  // what api.mapError makes of a Parse.Error
  throw {code: Number.isInteger(r.json && r.json.code) ? r.json.code : -1, message: (r.json && r.json.error) || 'Unexpected error'};
};

const keyOf = (v) => `${v.kind}|${v.experimentId}|${v.ontology || ''}|${String(v.tag).toLowerCase()}`;
const asMap = (votes) => Object.fromEntries(votes.map((v) => [keyOf(v), `${v.agree}/${v.disagree}/${v.mine}`]));

test('ui-real: setup', async (ctx) => {
  assert.strictEqual((await ctx.rest('POST', '/classes/Articles', {master: true, body: ART})).status, 201);
  for (const [name, ontology, parent] of [['attention', 'cognitive', 'attention'], ['Working Memory', 'cognitive', ''], ['Stroop task', 'tasks', ''], ['Cognition', 'behavioural', '']]) {
    // like import-ontologies.js: parent '' is stored for roots, the term itself for the top group
    const r = await ctx.rest('POST', '/classes/Concept', {master: true, body: {name, ontology, parent, definition: '', url: ontology === 'behavioural' ? '' : `https://www.cognitiveatlas.org/search?q=${encodeURIComponent(name)}`}});
    assert.strictEqual(r.status, 201, r.text);
  }
  ctx.ui = {client: await loadClient(), alice: await ctx.signup('ui-alice', 41001), bob: await ctx.signup('ui-bob', 41002)};
});

test('ui-real: anonymous page shows the legacy counts and no write control', async (ctx) => {
  const {client: c} = ctx.ui;
  c.dom.setDocument(c.fake.makeDocument());
  const call = realCall(ctx, undefined);
  const ann = await call('getAnnotations', {pmid: PMID});
  const cx = c.context.createContext({pmid: PMID, ann, call, user: () => null});
  const mesh = c.votes.renderMesh(cx, ART.Metadata.meshHeadings);
  const ok = c.votes.renderTableOk(cx, 1);
  const tags = c.tags.renderTags(cx, 1);
  const meta = c.meta.renderMeta(cx);
  const comments = c.comments.renderComments(cx);
  for (const n of [mesh, ok, meta]) {
    assert.strictEqual(n.buttons().length, 0);
  }
  assert.match(ok.textContent, /Yes 2/);
  assert.match(ok.textContent, /No 1/);
  assert.match(meta.textContent, /MNI 2/);
  assert.match(meta.textContent, /Talairach 1/);
  assert.match(meta.textContent, /Number of subjects: 20/);
  const chips = tags.buttons().map((b) => b.textContent);
  assert.ok(chips.some((t) => /Working Memory.*\+3 -1/.test(t)), JSON.stringify(chips));
  assert.ok(chips.some((t) => /LegacyOnly.*\+2 -0/.test(t)), JSON.stringify(chips));
  assert.ok(!chips.some((t) => /Stroop/.test(t)), 'tag with 0/0 votes must be hidden');
  assert.ok(mesh.textContent.includes('<img src=x onerror=alert(1)>'));
  assert.deepStrictEqual(mesh.all(() => true).filter((n) => ['IMG', 'SCRIPT'].includes(n.tagName)), []);
  void comments;
});

test('ui-real: logged in -- every control against the real server, UI state equals a fresh getAnnotations', async (ctx) => {
  const {client: c, alice, bob} = ctx.ui;
  const flush = c.fake.flush;
  // bob votes first so that "mine" and counts of others are exercised
  await realCall(ctx, bob.session)('vote', {pmid: PMID, experimentId: -1, kind: 'mesh', tag: 'Brain', value: -1});
  c.dom.setDocument(c.fake.makeDocument());
  const call = realCall(ctx, alice.session);
  const ann = await call('getAnnotations', {pmid: PMID});
  const cx = c.context.createContext({pmid: PMID, ann, call, user: () => ({id: alice.id, login: 'ui-alice'})});
  const mesh = c.votes.renderMesh(cx, ART.Metadata.meshHeadings);
  const ok = c.votes.renderTableOk(cx, 1);
  const ok2 = c.votes.renderTableOk(cx, 2);
  const tags = c.tags.renderTags(cx, 1);
  const meta = c.meta.renderMeta(cx);
  const comments = c.comments.renderComments(cx);
  const click = async (node, label) => {
    const b = node.buttons(label)[0];
    assert.ok(b, `no button "${label}" in "${node.textContent.slice(0, 120)}"`);
    await b.dispatch('click');
    await flush();
    // some handlers (Save, Post) do not return their promise: wait until nothing is pending
    for (let i = 0; i < 100 && /Saving/.test([mesh, ok, ok2, tags, meta, comments].map((n) => n.textContent).join('')); i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    await flush();
  };
  const err = () => [mesh, ok, tags, meta, comments].map((n) => n.findClass('ann-status').filter((s) => s.classList.contains('error')).map((s) => s.textContent)).flat();

  // MeSH: heading with double space, hostile heading
  const items = mesh.findClass('mesh-item');
  await click(items[0], 'Agree');
  assert.match(items[0].textContent, /Agree 1/);
  assert.match(items[0].textContent, /Disagree 1/); // bob
  await click(items[0], 'Disagree');
  await click(items[0], 'Retract');
  await click(items[1], 'Agree');
  await click(items[2], 'Disagree');
  assert.deepStrictEqual(err(), [], 'errors shown: MeSH');
  // table is correct, on an experiment without markBadTable
  await click(ok, 'Yes');
  assert.match(ok.textContent, /Yes 3/);
  await click(ok2, 'No');
  assert.match(ok2.textContent, /No 1/);
  // existing tag chip -> popup -> Agree
  await click(tags, 'Working Memory');
  const popup = tags.findClass('tag-popup')[0];
  await click(popup, 'Agree');
  assert.match(popup.textContent, /Agree 4/);
  await flush();
  // concept details (getConcept) displayed
  console.log(`       INFO popup text after getConcept: ${JSON.stringify(popup.textContent.slice(0, 160))}`);
  // add a tag from the picker (listConcepts + vote)
  await click(tags, 'Add tag');
  await flush();
  const picker = tags.findClass('tag-picker')[0];
  const listed = picker.findClass('concept').map((b) => b.textContent);
  console.log(`       INFO picker lists: ${JSON.stringify(listed)}`);
  assert.ok(listed.some((t) => t.startsWith('attention')));
  await click(picker, 'attention');
  assert.ok(tags.buttons().some((b) => /attention/.test(b.textContent) && /\+1 -0/.test(b.textContent)), tags.textContent);
  // hidden legacy tag gets a first vote through the picker (tasks ontology)
  await click(tags, 'Add tag');
  await click(picker, 'Cognitive Atlas tasks');
  await flush();
  await click(picker, 'Stroop task');
  assert.ok(tags.buttons().some((b) => /Stroop task/.test(b.textContent)), tags.textContent);
  // retract it again: the chip must disappear (display rule)
  await click(tags, 'Stroop task');
  await click(tags.findClass('tag-popup')[0], 'Retract');
  assert.ok(!tags.buttons().some((b) => /Stroop task/.test(b.textContent)), 'tag at 0/0 must disappear');
  // space and number of subjects
  await click(meta, 'MNI');
  assert.match(meta.textContent, /MNI 3/);
  await click(meta, 'Talairach');
  assert.match(meta.textContent, /MNI 2/);
  assert.match(meta.textContent, /Talairach 2/);
  await click(meta, 'Talairach'); // retract by clicking again
  assert.match(meta.textContent, /Talairach 1/);
  const input = meta.byTag('input')[0];
  input.value = '30';
  await click(meta, 'Save');
  assert.match(meta.textContent, /Number of subjects: 30/);
  await click(meta.findClass('meta-nsubjects')[0], 'Retract');
  assert.match(meta.textContent, /Number of subjects: 20/);
  // comment
  const area = comments.byTag('textarea')[0];
  area.value = '  hello <b>world</b>  ';
  await click(comments, 'Post comment');
  assert.ok(comments.textContent.includes('hello <b>world</b>'), comments.textContent);
  assert.deepStrictEqual(comments.all((n) => n.tagName === 'B'), [], 'comment text became markup');
  assert.deepStrictEqual(err(), [], 'errors shown');

  // the UI state must equal what a reload shows
  const fresh = await call('getAnnotations', {pmid: PMID});
  assert.deepStrictEqual(asMap(cx.ann.votes), asMap(fresh.votes), 'votes after UI actions differ from a reload');
  assert.deepStrictEqual(cx.ann.stereo, fresh.stereo);
  assert.deepStrictEqual(cx.ann.nsubjects, fresh.nsubjects);
  assert.strictEqual(cx.ann.comments.length, fresh.comments.length);
  assert.strictEqual(cx.ann.comments[cx.ann.comments.length - 1].text, fresh.comments[fresh.comments.length - 1].text);
  assert.strictEqual(cx.ann.commentCount, fresh.commentCount);
});

test('ui-real: errors from the real server are mapped to the messages the UI switches on (206, 142, 155)', async (ctx) => {
  const {client: c, alice} = ctx.ui;
  c.dom.setDocument(c.fake.makeDocument());
  // 206: session token dead
  const dead = realCall(ctx, 'r:dead');
  const cx = c.context.createContext({pmid: PMID, ann: await realCall(ctx, undefined)('getAnnotations', {pmid: PMID}), call: dead, user: () => ({id: 'x', login: 'x'})});
  const ok = c.votes.renderTableOk(cx, 1);
  await ok.buttons('Yes')[0].dispatch('click');
  await c.fake.flush();
  console.log(`       INFO dead session shows: ${JSON.stringify(ok.findClass('ann-status')[0].textContent)}`);
  assert.match(ok.findClass('ann-status')[0].textContent, /session has expired|Log in|log in/i);
  // 155 after 60 votes
  const call = realCall(ctx, alice.session);
  let last;
  for (let i = 0; i < 70; i++) {
    try {
      await call('vote', {pmid: PMID, experimentId: 2, kind: 'tableOk', tag: 'ok', value: i % 2 ? 1 : -1});
    } catch (e) {
      last = e;
      break;
    }
  }
  assert.ok(last && last.code === 155, `no 155: ${JSON.stringify(last)}`);
  assert.match(c.context.describeError(last), /Too many actions, please wait\. Too many requests, retry in \d+ seconds/);
});

test('ui-real: cleanup', async (ctx) => {
  ctx.ui.client.cleanup();
});
