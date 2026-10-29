import * as login from "./src/login.js";
import * as session from "./annotation/session.js";
import * as api from "./annotation/api.js";
import {el, setChildren, decoded, decodedOnly} from "./annotation/dom.js";
import {createContext, loginHint, describeError} from "./annotation/context.js";
import {renderMesh, renderTableOk} from "./annotation/votes.js";
import {renderTags} from "./annotation/tags.js";
import {renderMeta} from "./annotation/meta.js";
import {renderComments} from "./annotation/comments.js";
import * as hooks from "./annotation/hooks.js";
import {initHeaderLink} from "./annotation/collections.js";
import {citationNodes} from "./annotation/reference.js";
import * as tableEdit from "./annotation/table-edit.js";
import * as addArticle from "./annotation/add-article.js";

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

/** For the table editor: (re)build a viewer in an element. Goes through the replaceable factory. */
const createViewer = (elemId, locations) => viewerFactory(elemId, locations);

export const setViewerFactory = (fn) => {
  viewerFactory = fn;
};

const message = (cls, ...children) => el("p", {class: cls}, ...children);

// legacy rows may have more than three values (e.g. a z-score): x, y, z in their cells, the rest in an "Extra" cell
const coordRow = (loc, hasExtra) => {
  const v = String(loc).split(",");

  return el("tr", null, v.slice(0, 3).map((x) => el("td", null, x)),
    hasExtra ? el("td", {class: "muted"}, v.slice(3).join(", ")) : null);
};

/**
 * One experiment: title, caption, slot for the annotations, viewer and coordinate table.
 * Returns {node, annSlot, hasLocations}.
 */
const buildExperiment = (ex, i) => {
  const annSlot = el("div", {class: "exp-annotations"});
  const titleNode = el("b", {class: "noEmptyWithPlaceholder exp-title", placeholder: "No Title"}, decodedOnly(ex.title));
  const captionNode = el("span", {class: "noEmptyWithPlaceholder exp-caption", placeholder: "No Caption"}, decodedOnly(ex.caption));
  const titleBox = el("div", {class: "exp-title-box"}, el("b", {class: "exp-index"}, `${i}.`), titleNode);
  const captionBox = el("div", {class: "exp-caption-box"}, captionNode);
  const node = el("div", {class: "experiment"}, titleBox, captionBox, annSlot);
  const locations = ex.locations || [];
  // nodes the table editor (hooks) may use: title, caption (and their boxes), viewer and coordinates
  const slots = {title: titleNode, caption: captionNode, titleBox, captionBox, viewer: null, coords: null};
  const hasExtra = locations.some((l) => String(l).split(",").length > 3);
  if (locations.length > 0) {
    slots.viewer = el("div", {id: `viewer${i}`, class: "exp-viewer"});
    // exp-readonly: hidden by the table editor (components.css) while it shows its editable table
    slots.coords = el("div", {class: "exp-coords"},
      el("div", {class: "exp-readonly"}, el("div", {class: "coords-scroll"},
        el("table", {class: "coords-table"},
          el("thead", null, el("tr", null, el("th", null, "X"), el("th", null, "Y"), el("th", null, "Z"), hasExtra ? el("th", null, "Extra") : null)),
          el("tbody", null, locations.map((l) => coordRow(l, hasExtra)))))));
    node.appendChild(el("div", {class: "exp-grid"}, slots.viewer, slots.coords));
  } else {
    node.appendChild(el("p", {class: "muted empty-table exp-readonly"}, "This table has no coordinates."));
  }

  return {node, annSlot, slots, hasLocations: locations.length > 0};
};

const startViewers = (experiments) => {
  experiments.forEach((ex, i) => {
    if ((ex.locations || []).length === 0) {
      return;
    }
    const l = ex.locations.map((o) => o.split(',').slice(0, 3).map((o2) => parseFloat(o2)));
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

  // line 2: the citation from the year on ("(2008) Neuroimage 41(2):535-43", linked to the DOI); the reference already starts with the authors
  const citation = citationNodes(art.Reference || "", art.DOI, art.Authors || "");
  const citationLine = citation.length ? el("div", {class: "article-citation muted"}, citation) : null;

  setChildren(root,
    el("h2", null, decoded(art.Title)),
    el("b", {class: "article-authors"}, decoded(authors)),
    citationLine,
    el("p", null, decoded(art.Abstract)),
    annStatus, meshSlot, metaSlot, expRoot, commentsSlot);
  expShells.forEach((s) => expRoot.appendChild(s.node));
  startViewers(experiments);

  // --- annotations -----------------------------------------------------------------------------
  let ctx = null;
  let seq = 0;
  // The rev of the document the rows were rendered from (NOT the one of getAnnotations, which is read in
  // another request and may be newer than the rows on the page). Updated only by our own successful edits.
  let docRev = art.rev || 0;
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
          return docRev;
        },
        // the server's answer to a successful edit carries the new rev
        setRev: (rev) => {
          docRev = rev;
        },
        slots: shell.slots,
        createViewer,
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
    const truncated = el("p", {class: "ann-status muted"}, "Counts may be incomplete");
    const showTruncated = () => {
      truncated.hidden = !ctx.ann.truncated;
    };
    ctx.subscribe(showTruncated);
    showTruncated();
    setChildren(annStatus, loginHint(ctx), truncated);
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
  tableEdit.register();
  addArticle.register();
  try {
    await login.init();
  } catch (err) {
    console.log("login init failed", err);
  }
  initHeaderLink();
  await init();
};

// the page loads this file as a module (no inline script: Content-Security-Policy)
if (typeof document !== "undefined" && document.getElementById("article") && !globalThis.__noAutostart) {
  start();
}
