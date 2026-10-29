/* global Parse */
import TranslucentCluster from "./node_modules/translucent-viewer/translucent-cluster.js";
import * as login from "./src/login.js";
import {el, setChildren, decoded} from "./annotation/dom.js";

const params = new URLSearchParams(location.search);
const sum = [];
const [LR, PA, IS] = [45, 54, 45];
let maxSum = 0;
let level = 50;
let locations;
let trc;
const searchResults = [];
let articlesDisplayed = 0;

/**
 * @func configureROI
 * @description Configure the displacements necessary to create a small 3D ROI
 * @returnValue {array} The ROI displacements
 */

const configureROI = () => {
  // configure roi
  const R = 3;
  const roi = [];
  let x, y, z;
  for (x = -R; x <= R; x++) {
    for (y = -R; y <= R; y++) {
      for (z = -R; z <= R; z++) {
        if (x * x + y * y + z * z <= R * R) {
          roi.push([x, y, z]);
        }
      }
    }
  }

  return roi;
};
const roi = configureROI();

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

const displayMoreArticles = () => {
  const batchSize = 20;
  const narticles = Math.min(searchResults.length - articlesDisplayed, batchSize);

  if (narticles === 0) {
    return;
  }

  console.log("append more articles", articlesDisplayed);

  const list = document.getElementById("paper-list");
  for(let i=0; i<narticles; i++) {
    const {pmid, title, reference, score} = searchResults[articlesDisplayed + i];
    list.appendChild(el("li", null,
      el("span", {class: "title"}, el("a", {href: `/article.html?pmid=${encodeURIComponent(pmid)}`}, decoded(title))),
      " ",
      el("span", {class: "reference"}, decoded(reference)),
      " ",
      el("span", {class: "score"}, `(${Number(score) || 0}%)`)));
  }
  articlesDisplayed += narticles;
  console.log(articlesDisplayed);
};

const displayArticles = () => {
  const {scrollTop, clientHeight: contentHeight} = document.querySelector("html");
  const paperListBottom = document.querySelector("#paper-list").getBoundingClientRect().bottom;

  if (paperListBottom < scrollTop + contentHeight) {
    displayMoreArticles();
    setTimeout(displayArticles, 1000);
  }
};

const queryArticlesSlice = async (res) => {
  var Articles = Parse.Object.extend("Articles");
  var query = new Parse.Query(Articles);
  var ids = res.docs.map((o) => o.id);
  query.containedIn("objectId", ids);
  const res2 = await query.find();

  searchResults.push(...res2.map((a, i) => {
    locations.push(a.get('Experiments'));

    return {
      pmid: a.get("PMID"),
      title: a.get("Title"),
      reference: a.get("Reference"),
      score: (100*res.docs[i].score/res.maxScore)|0
    };
  }));

  displayArticles();

  document.getElementById("viewer-info").textContent =
    `${(100*(res.start+res.docs.length)/res.numFound)|0}% loaded...`;
};

const searchSlice = async (query, start, rows) => {
  const solrQuery = {
    q: query,
    defType: "edismax",
    qf: "Abstract Title",
    fl: "* score",
    "q.op": "OR"
  };
  if (typeof start !== 'undefined') {
    solrQuery.start = start;
    solrQuery.rows = rows;
  }
  const res = await Parse.Cloud.run("select", solrQuery);

  return res;
};

const _searchChunk = async (query, start, rows, resolve) => {
  const res = await searchSlice(query, start, rows);

  if (start === 0) {
    document.getElementById('url').value = query;
    setChildren(document.getElementById("paper-list"));
    document.getElementById("num-found").textContent = `${Number(res.numFound) || 0} articles found`;
  }

  await queryArticlesSlice(res);

  start = res.start + rows;

  if ( res.docs.length >= rows) {
    setTimeout(() => {
      _searchChunk(query, start, rows, resolve);
    }, 250);
  } else {
    return resolve();
  }
};

const search = async (query) => {
  const [start, rows] = [0, 10];

  await new Promise((resolve) => {
    _searchChunk(query, start, rows, resolve);
  });
};

const newSearch = (query) => {
  location.href = `search.html?q=${encodeURIComponent(query)}`;
};

const initAggregateVolume = () => {
  // init query volume
  let i;
  for (i = 0; i < LR * PA * IS; i++) {
    sum[i] = 0;
  }
};

const aggregateLocation = (exp) => {
  // update the sum[] volume
  if (exp === null || exp.length === 0) {
    return;
  }
  for (let i = 0; i < exp.length; i++) {
    if (exp[i].locations.length === 0) { continue; }

    for (let j = 0; j < exp[i].locations.length; j++) {
      let coord = exp[i].locations[j].split(",");
      coord = [
        Math.floor(coord[0] / 4 + 22),
        Math.floor(coord[1] / 4 + 31),
        Math.floor(coord[2] / 4 + 17.5)
      ];
      for (let k = 0; k < roi.length; k++) {
        //[x, y, z] = roi.map((o, col) => (o+coord[col])|0);
        const [x, y, z] = [
          Math.floor(roi[k][0] + coord[0]),
          Math.floor(roi[k][1] + coord[1]),
          Math.floor(roi[k][2] + coord[2])
        ];
        if (x >= 0 && x < LR && y >= 0 && y < PA && z >= 0 && z < IS) {
          sum[z * PA * LR + y * LR + x] += 1;
          maxSum = Math.max(sum[z * PA * LR + y * LR + x], maxSum);
        }
      }
    }
  }
};

const aggregateLocations = () => {
  console.log("aggregating", locations.length, "locations");
  while (locations.length) {
    aggregateLocation(locations.pop());
  }
};

const handleLevelChange = () => {
  level = Number(document.querySelector('#level').value);
  document.querySelector('#levelValue').textContent = level + "%";
  trc.cmap.level = maxSum * level / 100 + maxSum / 1000;
  trc.updateMesh(trc.cmap);
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
};

const _initAggregation = () => {
  configureROI();
  locations = [];
  initAggregateVolume();
  trc.createEmptyData([LR, PA, IS]);
  document.querySelector('#level').value = level;
  document.querySelector('#levelValue').textContent = level + "%";
  document.querySelector('#level').addEventListener('input', handleLevelChange);
};

const _aggregate = () => {
  console.log("_aggregate");
  const timer = setInterval(() => {
    aggregateLocations();
    trc.updateMesh({
      data: sum,
      dim: [LR, PA, IS],
      level: maxSum * level / 100
    });
  }, 2000);

  return timer;
};

const _stopAggregation = (timer) => {
  document.getElementById("viewer-info").textContent = "";
  clearInterval(timer);
  aggregateLocations();
  trc.updateMesh({
    data: sum,
    dim: [LR, PA, IS],
    level: maxSum * level / 100
  });
};

export const init = async () => {
  setupTouch();
  // no inline onchange in the html (Content-Security-Policy)
  document.getElementById("url").addEventListener("change", (e) => newSearch(e.target.value));
  window.newSearch = newSearch;

  await getArticleCount();
  await _initTranslucentCluster();
  _initAggregation();
  const timer = _aggregate();
  await search(params.get('q'));
  _stopAggregation(timer);

  document.addEventListener(
    'scroll',
    displayArticles
  );
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
