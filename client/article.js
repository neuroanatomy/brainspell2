import * as login from "./src/login.js";
import * as session from "./annotation/session.js";
import * as api from "./annotation/api.js";
import {el, setChildren, decoded} from "./annotation/dom.js";
import {createContext, loginHint, describeError} from "./annotation/context.js";
import {renderMesh, renderTableOk} from "./annotation/votes.js";
import {renderTags} from "./annotation/tags.js";
import {renderMeta} from "./annotation/meta.js";
import {renderComments} from "./annotation/comments.js";
import * as hooks from "./annotation/hooks.js";

const setupTouch = () => {
  console.log("configure touch");

  // Is JS enabled? Is it a touch device?
  const htmlTag = document.getElementsByTagName('html').item(0);
  htmlTag.className = (htmlTag.className + ' ' || '') + 'hasJS';
  if ('ontouchstart' in document.documentElement) {
    htmlTag.className = (htmlTag.className + ' ' || '') + 'isTouch';
  }
};

/** Creates and starts the 3D viewer of one experiment. Replaceable for tests. */
let viewerFactory = async (elemId, locations) => {
  const {default: TranslucentLocations} = await import("./node_modules/translucent-viewer/translucent-locations.js");
  const trl = new TranslucentLocations({
    elemId,
    assetsPath: "/node_modules/translucent-viewer/",
    backgroundColor: 0x202020,
    alpha: 1,
    brainColor: 0xffffff,
    locations
  });
  trl.init();
};

export const setViewerFactory = (fn) => {
  viewerFactory = fn;
};

const message = (cls, ...children) => el("p", {class: cls}, ...children);

const coordRow = (loc) => el("tr", null, String(loc).split(",").map((v) => el("td", null, v)));

/**
 * One experiment: title, caption, slot for the annotations, viewer and coordinate table.
 * Returns {node, annSlot, hasLocations}.
 */
const buildExperiment = (ex, i) => {
  const annSlot = el("div", {class: "exp-annotations"});
  const node = el("div", {class: "experiment"},
    el("b", null, `${i}.`), " ",
    el("b", {class: "noEmptyWithPlaceholder", placeholder: "No Title"}, decoded(ex.title)), el("br"),
    el("span", {class: "noEmptyWithPlaceholder", placeholder: "No Caption"}, decoded(ex.caption)), el("br"),
    annSlot);
  const locations = ex.locations || [];
  if (locations.length > 0) {
    node.appendChild(el("table", null, el("tr", null,
      el("td", {style: "vertical-align:top"},
        el("div", {id: `viewer${i}`, style: "width:480px;height:480px; border:1px solid #111"})),
      el("td", {style: "vertical-align:top; border:1px solid #2d2d2d"},
        el("table", {class: "coords-table"}, el("thead", null, el("tr", null,
          el("th", null, el("span", {class: "text"}, "X")),
          el("th", null, el("span", {class: "text"}, "Y")),
          el("th", null, el("span", {class: "text"}, "Z"))))),
        el("div", {id: "table-wrapper"}, el("div", {id: "table-scroll"},
          el("table", {class: "coords-table"}, el("tbody", null, locations.map(coordRow)))))))));
  } else {
    node.appendChild(el("p", {class: "muted empty-table"}, "This table has no coordinates."));
  }

  return {node, annSlot, hasLocations: locations.length > 0};
};

const startViewers = (experiments) => {
  experiments.forEach((ex, i) => {
    if ((ex.locations || []).length === 0) {
      return;
    }
    const l = ex.locations.map((o) => o.split(',').map((o2) => parseFloat(o2)));
    Promise.resolve().then(() => viewerFactory(`viewer${i}`, l)).catch((err) => {
      console.log("viewer failed", err);
    });
  });
};

let unsubscribeSession = () => {};

/**
 * Show the article (from the database) and its annotations (from getAnnotations).
 * Everything that comes from the database goes through el()/text(); titles, abstracts and
 * references also through decodeEntities (markup is dropped, entities are decoded once).
 */
const displayArticle = (root, art) => {
  const pmid = art.PMID;
  const experiments = art.Experiments || [];
  const meshHeadings = (art.Metadata && art.Metadata.meshHeadings) || [];
  const authors = String(art.Authors || "").replace(/,/g, ', ').replace(/ {2}/g, ' ');

  const annStatus = el("div", {class: "ann-load"});
  const metaSlot = el("div");
  const meshSlot = el("div");
  const commentsSlot = el("div");
  const expShells = experiments.map(buildExperiment);
  const expRoot = el("div", {class: "experiments"}, el("h2", null, "Experiments"));

  setChildren(root,
    el("h2", null, decoded(art.Title)),
    el("b", null, decoded(`${authors} ${art.Reference || ""}`)),
    el("p", null, decoded(art.Abstract)),
    annStatus, meshSlot, metaSlot, expRoot, commentsSlot);
  expShells.forEach((s) => expRoot.appendChild(s.node));
  startViewers(experiments);

  // --- annotations -----------------------------------------------------------------------------
  let ctx = null;
  let seq = 0;
  const toolsDone = new Set();

  const callTools = () => {
    experiments.forEach((ex, i) => {
      const shell = expShells[i];
      if (toolsDone.has(i) || (!shell.hasLocations && !session.current())) {
        return;
      }
      toolsDone.add(i);
      hooks.runExperimentTools(shell.node, ex, {
        pmid,
        get rev() {
          return ctx ? ctx.ann.rev : 0;
        },
        reload: () => loadPage(root, pmid)
      });
    });
  };

  const toggleEmpty = () => {
    expShells.forEach((s) => {
      s.node.hidden = !s.hasLocations && !session.current();
    });
    callTools();
  };

  const mount = (ann) => {
    ctx = createContext({pmid, ann, call: api.call, user: session.current});
    setChildren(annStatus, loginHint(ctx));
    setChildren(meshSlot, renderMesh(ctx, meshHeadings));
    setChildren(metaSlot, renderMeta(ctx));
    expShells.forEach((s, i) => {
      setChildren(s.annSlot, renderTableOk(ctx, experiments[i].id), renderTags(ctx, experiments[i].id));
    });
    setChildren(commentsSlot, renderComments(ctx));
    ctx.subscribe(toggleEmpty);
    toggleEmpty();
  };

  const loadAnnotations = async () => {
    const mine = ++seq;
    try {
      const ann = await api.call("getAnnotations", {pmid});
      if (mine !== seq) {
        return; // a newer request is in flight
      }
      if (ctx) {
        ctx.setAnnotations(ann);
      } else {
        mount(ann);
      }
    } catch (err) {
      if (mine !== seq || ctx) {
        if (ctx) {
          console.log("could not refresh annotations", err);
        }

        return;
      }
      setChildren(annStatus, el("p", {class: "ann-status error"}, `Annotations could not be loaded: ${describeError(err)} `,
        el("button", {type: "button", onclick: loadAnnotations}, "Retry")));
    }
  };

  unsubscribeSession();
  unsubscribeSession = session.onChange(() => {
    if (ctx) {
      ctx.notify(); // show or hide the write controls at once
      loadAnnotations(); // "mine" depends on who is logged in
    }
  });
  toggleEmpty();
  loadAnnotations();
};

const loadPage = async (root, pmid) => {
  unsubscribeSession();
  unsubscribeSession = () => {};
  setChildren(root, message("muted", "Loading…"));
  let art;
  try {
    art = await api.getArticle(pmid);
  } catch (err) {
    setChildren(root, message("error", `The article could not be loaded: ${describeError(err)}`));

    return;
  }
  if (!art) {
    const slot = el("div", {class: "missing-article"});
    setChildren(root, message("muted", `Article ${pmid} is not in the database.`), slot);
    hooks.runMissingArticle(slot, pmid);

    return;
  }
  displayArticle(root, art);
};

export const init = () => {
  setupTouch();

  const params = new URLSearchParams(location.search);
  const root = document.getElementById('article');

  if (params.has('pmid')) {
    return loadPage(root, params.get('pmid'));
  }
  setChildren(root, message("muted", "No article selected."));

  return Promise.resolve();
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
if (typeof document !== "undefined" && document.getElementById("article") && !globalThis.__noAutostart) {
  start();
}
