// The whole article page (client/article.js + table-edit.js + add-article.js, client fake DOM) against the REAL
// server: logged in as a GitHub user, legacy-shaped article. Edits, split, conflict, missing article, 4-value rows.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {pathToFileURL} = require('url');
const {test} = require('../integration/helpers/mini');
const {record} = require('../articles/sample-xml');

const CLIENT = path.resolve(__dirname, '..', '..', '..', 'client');
const ART = {
  PMID: '888001', Title: 'Page', Authors: 'A,B', Reference: 'r', Abstract: 'a',
  Metadata: {meshHeadings: [{name: 'Brain', majorTopic: true}]},
  Experiments: [
    {id: 1, title: 'T1', caption: 'C1', locations: ['1,2,3', '4,5,6', '7,8,9,2.5', '10,11,12'], tags: [{name: 'LegacyOnly', ontology: 'cognitive', agree: 2, disagree: 0}], markBadTable: {ok: 1, bad: 0}},
    {id: 2, title: 'T2', caption: 'C2', locations: ['0,0,0', '1,1,1'], tags: []}
  ]
};

function copyDir(from, to) {
  fs.mkdirSync(to, {recursive: true});
  for (const f of fs.readdirSync(from)) {
    const src = path.join(from, f);
    if (fs.statSync(src).isFile()) {
      fs.copyFileSync(src, path.join(to, f));
    }
  }
}

test('ui-page: setup', async (ctx) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bs-page-'));
  fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}');
  copyDir(path.join(CLIENT, 'annotation'), path.join(dir, 'annotation'));
  copyDir(path.join(CLIENT, 'src'), path.join(dir, 'src'));
  fs.mkdirSync(path.join(dir, 'test'));
  fs.copyFileSync(path.join(CLIENT, 'test', 'fake-dom.js'), path.join(dir, 'test', 'fake-dom.js'));
  fs.copyFileSync(path.join(CLIENT, 'article.js'), path.join(dir, 'article.js'));
  globalThis.__noAutostart = true;
  globalThis.DOMParser = class {
    parseFromString(s) {
      return {querySelectorAll: () => ({forEach() {}}), documentElement: {textContent: String(s).replace(/<[^>]*>/g, '')}};
    }
  };
  globalThis.confirm = () => true;
  globalThis.window = {};
  const imp = (p) => import(pathToFileURL(path.join(dir, p)).href);
  ctx.page = {
    dir, fake: await imp('test/fake-dom.js'), dom: await imp('annotation/dom.js'), api: await imp('annotation/api.js'),
    session: await imp('annotation/session.js'), hooks: await imp('annotation/hooks.js'), tableEdit: await imp('annotation/table-edit.js'),
    addArticle: await imp('annotation/add-article.js'), article: await imp('article.js')
  };
  assert.strictEqual((await ctx.rest('POST', '/classes/Articles', {master: true, body: ART})).status, 201);
  ctx.page.alice = await ctx.signup('page-alice', 42001);
  ctx.page.bob = await ctx.signup('page-bob', 42002);
});

async function run(ctx, pmid, who) {
  const p = ctx.page;
  const doc = p.fake.makeDocument();
  p.dom.setDocument(doc);
  globalThis.document = doc;
  const root = doc.register('article', doc.createElement('div'));
  globalThis.location = {search: `?pmid=${pmid}`, reload() { p.reloads = (p.reloads || 0) + 1; }};
  globalThis.Parse = {User: {current: () => (who ? {} : null), logOut: async () => {}}};
  p.session._reset();
  p.hooks._clear();
  p.articleFetches = 0;
  p.api.setBackend({
    async call(name, params) {
      const r = await ctx.cloud(name, params, who ? who.session : undefined);
      if (r.status === 200) {
        return r.json.result;
      }
      throw {code: Number.isInteger(r.json && r.json.code) ? r.json.code : -1, message: (r.json && r.json.error) || 'Unexpected error'};
    },
    async getArticle(id) {
      p.articleFetches++;
      const r = await ctx.rest('GET', `/classes/Articles?where=${encodeURIComponent(JSON.stringify({PMID: id}))}`);

      return r.json.results[0] || null;
    }
  });
  const viewers = [];
  p.article.setViewerFactory(async (id, locs) => {
    viewers.push([id, locs.length]);
  });
  p.tableEdit.register();
  p.addArticle.register();
  await p.session.init();
  await p.article.init();
  await p.fake.flush(20);

  return {root, viewers};
}

const tbody = (root, k) => root.findClass('te-table')[k].byTag('tbody')[0];
const wait = async (ctx, ms) => {
  await new Promise((r) => setTimeout(r, ms || 150));
  await ctx.page.fake.flush(20);
};
const artRow = async (ctx) => (await ctx.rest('GET', `/classes/Articles?where=${encodeURIComponent(JSON.stringify({PMID: '888001'}))}`)).json.results[0];

test('ui-page: logged in page renders from the real article + annotations (rev, tools for every experiment)', async (ctx) => {
  const {root} = await run(ctx, '888001', ctx.page.alice);
  assert.strictEqual(root.buttons('Edit title').length, 2);
  assert.ok(root.textContent.includes('Yes 1'), root.textContent.slice(0, 400));
  // 4-value row rendering: the read-only table puts 4 cells under 3 headers
  const readOnly = root.findClass('coords-table');
  const cells = readOnly.map((t) => t.byTag('tr').map((tr) => tr.children.length));
  console.log(`       INFO cells per row (headers+rows) in the read-only tables: ${JSON.stringify(cells)}`);
});

test('ui-page: edit a coordinate, then a second one (rev carried), real server', async (ctx) => {
  const {root} = await run(ctx, '888001', ctx.page.alice);
  await tbody(root, 0).children[0].dispatch('click');
  const tr = tbody(root, 0).children[0];
  tr.byTag('input').forEach((inp, k) => {
    inp.value = ['11', '22', '33'][k];
  });
  await tr.byTag('input')[0].dispatch('keydown', {key: 'Enter'});
  await wait(ctx);
  assert.strictEqual(tbody(root, 0).children[0].children[0].textContent, '11', root.textContent.slice(0, 300));
  await tbody(root, 0).children[1].dispatch('click');
  const tr2 = tbody(root, 0).children[1];
  tr2.byTag('input').forEach((inp, k) => {
    inp.value = ['7', '7', '7'][k];
  });
  await tr2.byTag('input')[0].dispatch('keydown', {key: 'Enter'});
  await wait(ctx);
  assert.ok(!root.textContent.includes('changed meanwhile'), 'second edit conflicted with the first');
  const a = await artRow(ctx);
  assert.strictEqual(a.rev, 2);
  assert.strictEqual(a.Experiments[0].locations[0], '11,22,33');
});

test('ui-page: editing the 4-value row keeps its 4th value', async (ctx) => {
  const {root} = await run(ctx, '888001', ctx.page.alice);
  await tbody(root, 0).children[2].dispatch('click');
  const tr = tbody(root, 0).children[2];
  const n = tr.byTag('input').length;
  tr.byTag('input')[0].value = '70';
  await tr.byTag('input')[0].dispatch('keydown', {key: 'Enter'});
  await wait(ctx);
  const a = await artRow(ctx);
  assert.strictEqual(a.Experiments[0].locations[2], '70,8,9,2.5', `edit form had ${n} inputs; stored row is now "${a.Experiments[0].locations[2]}"`);
});

test('ui-page: split reloads the page and shows the new table; ids/tags/votes stay with the original', async (ctx) => {
  const {root} = await run(ctx, '888001', ctx.page.alice);
  await tbody(root, 0).children[2].dispatch('click');
  await root.buttons('Split here')[0].dispatch('click');
  await wait(ctx, 400);
  const a = await artRow(ctx);
  assert.strictEqual(a.Experiments.length, 3);
  assert.deepStrictEqual(a.Experiments.map((e) => e.id), [1, 3, 2]);
  assert.strictEqual(a.Experiments[1].title, 'T1');
  assert.deepStrictEqual(a.Experiments[1].tags, []);
  assert.strictEqual(a.Experiments[0].locations.length, 2);
  assert.strictEqual(a.Experiments[1].locations.length, 2);
  assert.ok((ctx.page.articleFetches || 0) >= 1);
  // vote on the NEW experiment id 3, which has no markBadTable and no tags
  const v = await ctx.cloud('vote', {pmid: '888001', experimentId: 3, kind: 'tableOk', tag: 'ok', value: 1}, ctx.page.alice.session);
  assert.strictEqual(v.status, 200, v.text);
});

test('ui-page: conflict -- another user edits in between: UI says so and reloads, nothing is overwritten', async (ctx) => {
  const {root} = await run(ctx, '888001', ctx.page.alice);
  const rev = (await ctx.cloud('getAnnotations', {pmid: '888001'})).json.result.rev;
  const other = await ctx.cloud('editExperiment', {pmid: '888001', experimentId: 2, rev, ops: [{op: 'setTitle', text: 'by bob'}]}, ctx.page.bob.session);
  assert.strictEqual(other.status, 200, other.text);
  const fetchesBefore = ctx.page.articleFetches;
  await tbody(root, 0).children[0].dispatch('click');
  const tr = tbody(root, 0).children[0];
  tr.byTag('input')[0].value = '99';
  await tr.byTag('input')[0].dispatch('keydown', {key: 'Enter'});
  await wait(ctx, 400);
  const a = await artRow(ctx);
  assert.notStrictEqual(a.Experiments[0].locations[0].split(',')[0], '99', 'stale edit was applied');
  assert.ok(ctx.page.articleFetches > fetchesBefore, 'the page did not reload after the 1001');
});

test('ui-page: missing article, anonymous and logged in (addArticle with the PubMed stub)', async (ctx) => {
  const anon = await run(ctx, '9001', null);
  assert.ok(anon.root.textContent.includes('Log in to add it'));
  ctx.pubmed.records['9001'] = record({pmid: '9001'});
  const {root} = await run(ctx, '9001', ctx.page.alice);
  const input = root.byTag('input').find((i) => i.attrs.id === 'add-ntables');
  input.value = '2';
  await root.buttons('Add article')[0].dispatch('click');
  await wait(ctx, 600);
  assert.strictEqual(ctx.page.reloads, 1, `page did not reload: ${root.textContent}`);
  const again = await run(ctx, '9001', ctx.page.alice);
  assert.strictEqual(again.root.buttons('Edit title').length, 2, 'the added article shows two empty tables for a logged in user');
});

test('ui-page: cleanup', async (ctx) => {
  fs.rmSync(ctx.page.dir, {recursive: true, force: true});
});
