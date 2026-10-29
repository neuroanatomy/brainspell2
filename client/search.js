/* global Parse */
import TranslucentCluster from "./node_modules/translucent-viewer/translucent-cluster.js";
import {spinHint} from "./annotation/spin-hint.js";
import * as login from "./src/login.js";
import {el, setChildren, decoded} from "./annotation/dom.js";
import {referenceNodes} from "./annotation/reference.js";
import {mountSearchSelection, selectSlot, initHeaderLink} from "./annotation/collections.js";
import * as surfacenets from "./node_modules/translucent-viewer/surfacenets.js";
import {buildGlb, exportFilename} from "./annotation/model-export.js";
import {createAccumulator, createArticleReader, createPacer, createMapRenderer, createPool, createResultIds, loadSearch, orderCards, levelText, mapStatus} from "./annotation/coactivation.js";

const params = new URLSearchParams(location.search);
const SMOOTH = params.get("smooth") !== "0"; // ?smooth=0: no easing, no smoothing (the plain map, for comparison)
const BATCH = 20; // results shown at a time
let level = 50;
let trc = null;
let trcReady = false;
let selectionUI = null; // checkboxes and "add to collection" (logged-in users only)
const pool = createPool({limit: 3});
const acc = createAccumulator();
const resultIds = createResultIds();
const cards = new Map(); // objectId -> {id, PMID, Title, Reference, DOI}
let renderer = null;
let shown = 0;
let loadingList = false;
let listFailed = false;
let mapState = {total: 0, done: false, failed: 0};

const setupTouch = () => {
  console.log("[init] init()");
  // Is JS enabled? Is it a touch device?
  var htmlTag = document.getElementsByTagName('html').item(0);
  htmlTag.className = (htmlTag.className + ' ' || '') + 'hasJS';
  if ('ontouchstart' in document.documentElement) {
    htmlTag.className = (htmlTag.className + ' ' || '') + 'isTouch';
  }
};

const getArticleCount = async () => {
  var Articles = Parse.Object.extend("Articles");
  var query = new Parse.Query(Articles);
  const n = await query.count();
  document.getElementById('num-articles').textContent = String(n);

  return n;
};

// ---- data: Parse and the Solr cloud function ------------------------------------------------------------------------------------

const paceSelect = createPacer(65); // the server allows 30 selects per second for everybody: we use about 15

const select = async ({q, start, rows}) => {
  await paceSelect();

  return Parse.Cloud.run("select", {
    q,
    defType: "edismax",
    qf: "Abstract Title",
    fl: "score,id", // only what is needed: the document ids and their scores
    "q.op": "OR",
    start,
    rows
  });
};

// Parse.serverURL and applicationId are set by login.init(), so they are read at call time
const readArticles = (ids, keys) => createArticleReader({fetch: (...args) => fetch(...args), serverURL: Parse.serverURL, appId: Parse.applicationId})(ids, keys);

// map pipeline: only the coordinates
const fetchExperiments = async (ids) => (await readArticles(ids, ["PMID", "Experiments"])).map((a) => ({id: a.objectId, PMID: a.PMID, Experiments: a.Experiments}));
// list pipeline: only what the list shows
const fetchCards = async (ids) => (await readArticles(ids, ["PMID", "Title", "Reference", "DOI"])).map((a) => ({
  id: a.objectId, pmid: a.PMID, title: a.Title, reference: a.Reference, doi: a.DOI
}));

// ---- the result list (infinite scroll, 20 at a time; records joined to the Solr scores by objectId) -----------------------------------

const renderItems = (items) => {
  const list = document.getElementById("paper-list");
  for (const {pmid, title, reference, doi, score} of items) {
    list.appendChild(el("li", {dataset: {pmid: String(pmid)}},
      selectSlot(),
      el("span", {class: "title"}, el("a", {href: `/article.html?pmid=${encodeURIComponent(pmid)}`}, decoded(title))),
      " ",
      el("span", {class: "reference"}, referenceNodes(reference, doi)),
      " ",
      el("span", {class: "score"}, `(${Number(score) || 0}%)`)));
  }
  if (selectionUI) {
    selectionUI.refresh();
  }
};

const showMore = async () => {
  if (loadingList) {
    return;
  }
  const next = resultIds.prefix().slice(shown, shown + BATCH);
  if (!next.length) {
    return;
  }
  loadingList = true;
  const gen = pool.generation();
  try {
    const missing = next.filter((id) => !cards.has(id));
    if (missing.length) {
      const got = await pool.run(() => fetchCards(missing), {priority: 0});
      got.forEach((c) => cards.set(c.id, c));
    }
    if (pool.isCancelled(gen)) {
      return;
    }
    renderItems(orderCards(next, resultIds.scores, next.map((id) => cards.get(id)).filter(Boolean)));
    shown += next.length;
  } catch (err) {
    if (!(err && err.cancelled)) {
      listFailed = true;
      console.log("could not load the results", err);
      showNotice("Some results could not be loaded. Reload the page to try again.");
    }
  } finally {
    loadingList = false;
  }
  displayArticles();
};

/** Show more results when the end of the list is on the screen (also called on scroll). */
const displayArticles = () => {
  const {scrollTop, clientHeight: contentHeight} = document.querySelector("html");
  const paperListBottom = document.querySelector("#paper-list").getBoundingClientRect().bottom;

  if (!listFailed && paperListBottom < scrollTop + contentHeight) {
    showMore();
  }
};

// ---- the map -----------------------------------------------------------------------------------------------------------------------

const info = () => document.getElementById("viewer-info");

const showNotice = (message) => {
  let n = document.getElementById("map-notice");
  if (!n) {
    n = el("p", {id: "map-notice", class: "ann-status error", role: "status"});
    document.getElementById("viewer-container").appendChild(n);
  }
  setChildren(n, message);
};

const updateStatus = () => {
  setChildren(info(), mapStatus({papers: acc.papers, total: mapState.total, done: mapState.done, failed: mapState.failed}));
};

const _initTranslucentCluster = async () => {
  trc = new TranslucentCluster({
    elemId: 'viewer',
    assetsPath: '/node_modules/translucent-viewer/',
    backgroundColor: 0x00ff00,
    alpha: 0,
    brainColor: 'white'
  });
  await trc.init();
  trc.createEmptyData([45, 54, 45]);
  trcReady = true;
  renderer.touch();
  spinHint(trc.tr,document.getElementById('viewer'));
};

const setupMap = () => {
  const levelInput = document.querySelector('#level');
  const levelText_ = document.querySelector('#levelValue');
  levelInput.value = level;
  setChildren(levelText_, `${level}%`);
  renderer = createMapRenderer({
    target: acc.volume,
    getMax: () => acc.max,
    smooth: SMOOTH,
    percent: level,
    mesh: (field) => {
      if (trcReady) {
        trc.updateMesh(field);
      }
    },
    onLevel: ({percent, level: l}) => {
      setChildren(levelText_, acc.max > 0 ? levelText(percent, l) : `${Math.round(percent)}%`);
    }
  });
  levelInput.addEventListener('input', () => {
    level = Number(levelInput.value);
    renderer.setPercent(level);
  });
};

// ---- 3D model export (.glb) --------------------------------------------------------------------------------------------------------

/** The translucent brain of the live viewer scene as arrays (viewer units), or null while it is not loaded. */
const brainGeometry = () => {
  const scene = trc && trc.tr && trc.tr.scene;
  const mesh = scene && Array.from(scene.children).find((o) => o.isMesh && o !== trc.surfacemesh && o.material && o.material.isShaderMaterial &&
    o.geometry && o.geometry.vertices && o.geometry.vertices.length > 1000);
  if (!mesh) {
    return null;
  }
  const {vertices, faces} = mesh.geometry;
  const positions = new Float32Array(vertices.length * 3);
  vertices.forEach((v, i) => {
    positions[i * 3] = v.x; positions[i * 3 + 1] = v.y; positions[i * 3 + 2] = v.z;
  });

  return {positions, indices: faces.flatMap((f) => [f.a, f.b, f.c])};
};

const downloadBytes = (bytes, filename) => {
  const url = URL.createObjectURL(new Blob([bytes], {type: "model/gltf-binary"}));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
};

const exportStatus = (message, error = false) => {
  const s = document.getElementById("export-status");
  s.className = `ann-status${error ? " error" : ""}`;
  setChildren(s, message);
};

const exportModel = async (query) => {
  const button = document.getElementById("export-glb");
  button.disabled = true;
  exportStatus("Preparing…");
  await new Promise((r) => setTimeout(r, 30)); // let the message show before the (short) computation
  try {
    const brain = brainGeometry();
    if (!brain) {
      throw new Error("The brain is not loaded yet, try again in a moment");
    }
    const bytes = buildGlb({
      brain,
      field: renderer.exportField(),
      surfaceNets: surfacenets.init,
      meta: {query, papers: acc.papers, total: mapState.total, sliderPercent: level}
    });
    downloadBytes(bytes, exportFilename(query, acc.papers));
    exportStatus(`Downloaded (${(bytes.length / 1048576).toFixed(1)} MB)`);
  } catch (err) {
    console.log("export failed", err);
    exportStatus(`The 3D model could not be created: ${err && err.message ? err.message : "unexpected error"}`, true);
  } finally {
    button.disabled = false;
  }
};

const enableExport = (query) => {
  const button = document.getElementById("export-glb");
  if (!button || acc.papers === 0) {
    return;
  }
  button.onclick = () => exportModel(query);
  // the map can be complete before the viewer has loaded the brain (a short search): wait for it, then enable the button
  const check = (tries) => {
    if (brainGeometry()) {
      button.disabled = false;
      button.title = "Download the map as a 3D model (glb)";
    } else if (tries > 0) {
      button.title = "Loading the brain…";
      setTimeout(() => check(tries - 1), 300);
    }
  };
  check(200);
};

const runSearch = async (query) => {
  const gen = pool.generation();
  let first = true;
  try {
    const res = await loadSearch({
      query,
      pool,
      select,
      fetchExperiments,
      onPage: (page) => {
        if (pool.isCancelled(gen)) {
          return;
        }
        if (first) {
          first = false;
          document.getElementById('url').value = query;
          setChildren(document.getElementById("paper-list"));
          mapState.total = Number(page.numFound) || 0;
          setChildren(document.getElementById("num-found"), `${mapState.total} articles found`);
        }
        resultIds.addPage(page);
        displayArticles();
        if (shown === 0 && !loadingList) {
          showMore();
        }
      },
      onPapers: (articles) => {
        if (pool.isCancelled(gen)) {
          return;
        }
        articles.forEach((a) => acc.add(a.Experiments));
        updateStatus();
        renderer.touch();
      },
      onFail: ({what, start, error}) => {
        mapState.failed++;
        console.log("search request failed", what, start, error);
        showNotice("Some data could not be loaded (rate limit or network). The map and the list may be incomplete.");
        updateStatus();
      }
    });
    if (pool.isCancelled(gen)) {
      return;
    }
    mapState.total = res.numFound;
    mapState.done = true;
    updateStatus();
    renderer.touch();
    enableExport(query);
  } catch (err) {
    if (!(err && err.cancelled)) {
      console.log("search failed", err);
      setChildren(document.getElementById("num-found"), "The search failed. Please try again.");
      setChildren(info(), "");
    }
  }
};

const newSearch = (query) => {
  pool.cancel();
  location.href = `search.html?q=${encodeURIComponent(query)}`;
};

export const init = async () => {
  setupTouch();
  // no inline onchange in the html (Content-Security-Policy)
  document.getElementById("url").addEventListener("change", (e) => newSearch(e.target.value));
  window.newSearch = newSearch;
  window.addEventListener("pagehide", () => {
    pool.cancel();
    if (renderer) {
      renderer.stop();
    }
  });

  initHeaderLink();
  selectionUI = mountSearchSelection({list: document.getElementById("paper-list"), toolbar: document.getElementById("selection-toolbar")});
  setupMap();
  document.addEventListener('scroll', displayArticles);

  // the viewer starts while the first results are on their way: nothing waits for it
  const viewer = _initTranslucentCluster().catch((err) => {
    console.log("viewer failed", err);
  });
  getArticleCount().catch((err) => console.log("count failed", err));
  const q = params.get('q');
  if (q) {
    await runSearch(q);
  }
  await viewer;
};

export const start = async () => {
  try {
    await login.init();
  } catch (err) {
    console.log("login init failed", err);
  }
  await init();
};

// the page loads this file as a module (no inline script: Content-Security-Policy)
if (typeof document !== "undefined" && document.getElementById("paper-list") && !globalThis.__noAutostart) {
  start();
}
