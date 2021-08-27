/* global Parse */

let count;

const getArticleCount = async () => {
  var Articles = Parse.Object.extend("Articles");
  var query = new Parse.Query(Articles);
  const n = await query.count();
  document.getElementById('num-articles').innerHTML = n;

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
  for(const res of await Promise.all(results)) {
    const newArticle = `
        <li>
            <span class='title'><a href='/article.html?pmid=${res.get("PMID")}'>${res.get('Title')}</a></span>
            <span class='reference'>${res.get('Reference')}</span>
        </li>`;
    document.getElementById("paper-list").innerHTML += newArticle;
  }
};

const newSearch = (query) => {
  location.href = `search.html?q=${query}`;
};

export const init = async () => {
  console.log("[init] init()");
  // Is JS enabled? Is it a touch device?
  const htmlTag = document.getElementsByTagName('html').item(0);
  htmlTag.className = (htmlTag.className + ' ' || '') + 'hasJS';
  if ('ontouchstart' in document.documentElement) {
    htmlTag.className = (htmlTag.className + ' ' || '') + 'isTouch';
  }

  count = await getArticleCount();
  getRandomArticles();

  window.newSearch = newSearch;
};
