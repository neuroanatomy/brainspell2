/* global Parse */
/**
 * "My collections" page: the user's collections, each expandable to its articles, with
 * removal of single articles and deletion of a whole collection.
 * Renaming is not available: it is not part of the frozen interface (plan 4), so it is not offered.
 */
import * as login from "./src/login.js";
import * as session from "./annotation/session.js";
import * as api from "./annotation/api.js";
import {el, setChildren, decoded} from "./annotation/dom.js";
import {describeError} from "./annotation/context.js";
import {
  listCollections, saveCollection, deleteCollection, chunk, buildSaveParams, initHeaderLink
} from "./annotation/collections.js";

export {initHeaderLink};

const TITLE_CHUNK = 100;

/** pmid -> title for the PMIDs found, from the Articles class (mock mode: from the mock). */
const defaultFetchTitles = async (pmids) => {
  const titles = {};
  if (api.isMock()) {
    for (const pmid of pmids) {
      const a = await api.getArticle(pmid);
      if (a) {
        titles[pmid] = a.Title;
      }
    }

    return titles;
  }
  for (const part of chunk(pmids, TITLE_CHUNK)) {
    const query = new Parse.Query(Parse.Object.extend("Articles"));
    query.containedIn("PMID", part);
    query.limit(TITLE_CHUNK);
    query.select("PMID", "Title");
    for (const a of await query.find()) {
      titles[a.get("PMID")] = a.get("Title");
    }
  }

  return titles;
};

let fetchTitles = defaultFetchTitles;
/** Replace the title lookup (tests). */
export const setTitleFetcher = (fn) => {
  fetchTitles = fn || defaultFetchTitles;
};

const day = (iso) => (typeof iso === "string" && /^\d{4}-\d\d-\d\d/.test(iso) ? iso.slice(0, 10) : "");

const buildCollection = (col, {onChange, onDelete, call}) => {
  let open = false;
  let confirming = false;
  const status = el("span", {class: "col-status", role: "status", "aria-live": "polite"});
  const body = el("div", {class: "col-body", hidden: true});
  const head = el("div", {class: "col-head"});
  const say = (cls, msg) => {
    status.className = `col-status ${cls}`.trim();
    setChildren(status, msg);
  };

  const removeOne = async (pmid) => {
    say("pending", "Saving…");
    try {
      const res = await saveCollection(buildSaveParams({id: col.id, remove: [pmid]}), call);
      col = {...col, ...res};
      say("", "");
      drawHead();
      await drawBody();
      onChange(col);
    } catch (err) {
      say("error", describeError(err));
    }
  };

  const doDelete = async () => {
    say("pending", "Deleting…");
    try {
      await deleteCollection(col.id, call);
      onDelete(col);
    } catch (err) {
      confirming = false;
      drawHead();
      say("error", describeError(err));
    }
  };

  const drawBody = async () => {
    body.hidden = !open;
    if (!open) {
      return;
    }
    const pmids = col.pmids || [];
    if (!pmids.length) {
      setChildren(body, el("p", {class: "muted"}, "This collection is empty."));

      return;
    }
    setChildren(body, el("p", {class: "muted"}, "Loading titles…"));
    let titles = {};
    try {
      titles = await fetchTitles(pmids);
    } catch (err) {
      say("error", `Titles could not be loaded: ${describeError(err)}`);
    }
    setChildren(body, el("ol", {class: "col-articles"}, pmids.map((pmid) => el("li", {dataset: {pmid}},
      el("a", {href: `article.html?pmid=${encodeURIComponent(pmid)}`}, titles[pmid] ? decoded(titles[pmid]) : `PMID ${pmid}`),
      " ", el("span", {class: "muted"}, `PMID ${pmid}`),
      " ", el("button", {type: "button", class: "col-remove", onclick: () => removeOne(pmid)}, "remove")))));
  };

  function drawHead() {
    const n = (col.pmids || []).length;
    setChildren(head,
      el("button", {type: "button", class: "col-toggle", "aria-expanded": String(open), onclick: async () => {
        open = !open;
        drawHead();
        await drawBody();
      }}, open ? "▾ " : "▸ ", el("b", null, col.name)),
      " ", el("span", {class: "muted"}, `${n} article${n === 1 ? "" : "s"}`),
      day(col.updatedAt) ? el("span", {class: "muted"}, `, updated ${day(col.updatedAt)}`) : null,
      " ",
      confirming
        ? [el("span", {class: "error"}, `Delete "${col.name}"? `),
          el("button", {type: "button", class: "col-confirm-delete", onclick: doDelete}, "Yes, delete"), " ",
          el("button", {type: "button", onclick: () => { confirming = false; drawHead(); }}, "Cancel")]
        : el("button", {type: "button", class: "col-delete", onclick: () => { confirming = true; drawHead(); }}, "Delete collection"),
      " ", status);
  }

  drawHead();

  return el("section", {class: "collection", dataset: {id: col.id}}, head, body);
};

/** Draw the page into #collections for the current user. */
export const render = async (call = api.call) => {
  const root = document.getElementById("collections");
  if (!session.current()) {
    setChildren(root, el("p", {class: "muted"}, "Log in to see your collections"));

    return;
  }
  setChildren(root, el("p", {class: "muted"}, "Loading…"));
  let cols;
  try {
    cols = await listCollections(call);
  } catch (err) {
    setChildren(root, el("p", {class: "error"}, describeError(err)));

    return;
  }
  const draw = () => {
    if (!cols.length) {
      setChildren(root, el("p", {class: "muted"}, "You have no collections yet. Select articles in the search results and use \"Add to collection\"."));

      return;
    }
    setChildren(root, cols.map((c) => buildCollection(c, {
      call,
      onChange: (updated) => {
        cols = cols.map((x) => (x.id === updated.id ? {...x, ...updated} : x));
      },
      onDelete: (gone) => {
        cols = cols.filter((x) => x.id !== gone.id);
        draw();
      }
    })));
  };
  draw();
};

export const init = async () => {
  initHeaderLink();
  session.onChange(() => render());
  await render();
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
if (typeof document !== "undefined" && document.getElementById("collections") && !globalThis.__noAutostart) {
  start();
}
