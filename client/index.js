/* global Parse */
import * as login from "./src/login.js";
import {el, setChildren, decoded} from "./annotation/dom.js";
import {referenceNodes} from "./annotation/reference.js";
import {initHeaderLink} from "./annotation/collections.js";

let count;

const getArticleCount = async () => {
  var Articles = Parse.Object.extend("Articles");
  var query = new Parse.Query(Articles);
  const n = await query.count();
  document.getElementById('num-articles').textContent = String(n);

  return n;
};

const getRandomArticles = async () => {

  if (count < 5) {
    return;
  }

  var Articles = Parse.Object.extend("Articles");
  var query = new Parse.Query(Articles);

  const s = new Set();
  while (s.size < 5) {
    s.add((count * Math.random()) | 0);
  }
  const results = [];
  for (const i of (Array.from(s)).sort()) {
    query.skip(i);
    results.push(query.first());
  }
  const list = document.getElementById("paper-list");
  for(const res of await Promise.all(results)) {
    if (!res) {
      continue;
    }
    list.appendChild(el("li", null,
      el("span", {class: "title"},
        el("a", {href: `/article.html?pmid=${encodeURIComponent(res.get("PMID"))}`}, decoded(res.get('Title')))),
      " ",
      el("span", {class: "reference"}, referenceNodes(res.get('Reference'), res.get('DOI')))));
  }
};

const newSearch = (query) => {
  location.href = `search.html?q=${encodeURIComponent(query)}`;
};

export const init = async () => {
  console.log("[init] init()");
  // Is JS enabled? Is it a touch device?
  const htmlTag = document.getElementsByTagName('html').item(0);
  htmlTag.className = (htmlTag.className + ' ' || '') + 'hasJS';
  if ('ontouchstart' in document.documentElement) {
    htmlTag.className = (htmlTag.className + ' ' || '') + 'isTouch';
  }

  // no inline onchange in the html (Content-Security-Policy)
  document.getElementById("url").addEventListener("change", (e) => newSearch(e.target.value));
  window.newSearch = newSearch;

  initHeaderLink();
  count = await getArticleCount();
  getRandomArticles();
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
