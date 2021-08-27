/* global Parse */
import TranslucentCluster from "translucent-viewer/translucent-cluster";

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
  document.getElementById('num-articles').innerHTML = n;

  return n;
};

const displayMoreArticles = () => {
  const batchSize = 20;
  const narticles = Math.min(searchResults.length - articlesDisplayed, batchSize);

  if (narticles === 0) {
    return;
  }

  console.log("append more articles", articlesDisplayed);

  let str = "";
  for(let i=0; i<narticles; i++) {
    const {pmid, title, reference, score} = searchResults[articlesDisplayed + i];
    const newArticle = `
        <li>
            <span class='title'><a href='/article.html?pmid=${pmid}'>${title}</a></span>
            <span class='reference'>${reference}</span>
            <span class='score'>(${score}%)</span>
        </li>`;
    str += newArticle;
  }
  articlesDisplayed += narticles;
  console.log(articlesDisplayed);

  document.getElementById("paper-list").innerHTML += str;
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

  document.getElementById("viewer-info").innerHTML =
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
    document.getElementById("paper-list").innerHTML = "";
    document.getElementById("num-found").innerHTML = `${res.numFound} articles found`;
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
  location.href = `search.html?q=${query}`;
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
  document.querySelector('#levelValue').innerText = level + "%";
  trc.cmap.level = maxSum * level / 100 + maxSum / 1000;
  trc.updateMesh(trc.cmap);
};

const _initTranslucentCluster = async () => {
  trc = new TranslucentCluster({
    elemId: 'viewer',
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
  document.querySelector('#levelValue').innerText = level + "%";
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
  document.getElementById("viewer-info").innerHTML = "";
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
