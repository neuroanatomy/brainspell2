/**
 * F2: ontology tags of an experiment. Chips with counts (the server applies the display rule of
 * plan 3.4, so only tags with at least one vote come back), a popup with the vote controls and the
 * link to the term, and a picker to add a tag from the three ontologies using listConcepts.
 */
import {el, setChildren, isSafeUrl} from "./dom.js";
import {createStatus, runAction} from "./context.js";
import {applyVoteResult} from "./votes.js";
import {createVoteChip} from "./vote-chip.js";

export const ONTOLOGY_LABELS = {
  cognitive: "Cognitive Atlas concepts",
  tasks: "Cognitive Atlas tasks",
  behavioural: "BrainMap behavioural domains"
};
const ONTOLOGIES = Object.keys(ONTOLOGY_LABELS);
const MAX_LISTED = 200;

/** A parent is shown only when it differs from the name (group terms have themselves as parent). */
export const hasOwnParent = (c) => !!c.parent && c.parent.trim().toLowerCase() !== String(c.name).trim().toLowerCase();

/** Case-insensitive filter on name or parent. */
export const filterConcepts = (concepts, query) => {
  const q = String(query || "").trim().toLowerCase();
  if (!q) {
    return concepts;
  }

  return concepts.filter((c) => c.name.toLowerCase().includes(q) || (c.parent || "").toLowerCase().includes(q));
};

/** Tags of one experiment from ann.votes, ordered by ontology then name. */
export const tagsOf = (ann, experimentId) =>
  (ann.votes || []).filter((v) => v.kind === "tag" && v.experimentId === experimentId)
    .sort((a, b) => ONTOLOGIES.indexOf(a.ontology) - ONTOLOGIES.indexOf(b.ontology) || a.tag.localeCompare(b.tag));

const loadConcepts = (ctx, ontology) => {
  ctx._concepts = ctx._concepts || {};
  if (!ctx._concepts[ontology]) {
    ctx._concepts[ontology] = ctx.call("listConcepts", {ontology}).catch((err) => {
      delete ctx._concepts[ontology]; // allow a retry
      throw err;
    });
  }

  return ctx._concepts[ontology];
};

const loadConcept = (ctx, ontology, name) => {
  ctx._conceptInfo = ctx._conceptInfo || {};
  const k = `${ontology}|${name}`;
  if (!ctx._conceptInfo[k]) {
    ctx._conceptInfo[k] = ctx.call("getConcept", {name, ontology}).catch((err) => {
      delete ctx._conceptInfo[k];
      throw err;
    });
  }

  return ctx._conceptInfo[k];
};

export const renderTags = (ctx, experimentId) => {
  const ui = {picker: false, ontology: "cognitive", filter: "", concepts: null, conceptsError: null};
  const chips = el("div", {class: "tag-chips"});
  const picker = el("div", {class: "tag-picker"});
  const addBtn = el("button", {type: "button", class: "tag-add chip-add btn-quiet", "aria-expanded": "false", onclick: () => {
    ui.picker = !ui.picker;
    if (ui.picker) {
      loadList();
    }
    update();
  }}, "+ Add tag");
  const pickerStatus = createStatus();
  const root = el("div", {class: "tags"}, el("span", {class: "label"}, "Tags: "), chips, addBtn, picker);

  // --- picker (built once; only the list is redrawn while typing) ---------------------------
  const filterInput = el("input", {type: "text", class: "tag-filter", placeholder: "Filter terms…", "aria-label": "Filter terms",
    oninput: (e) => {
      ui.filter = e.target.value;
      drawList();
    }});
  const ontoBar = el("div", {class: "tag-ontologies"});
  const list = el("ul", {class: "tag-concepts"});
  setChildren(picker, ontoBar, filterInput, list, pickerStatus.element);

  const drawOntoBar = () => {
    setChildren(ontoBar, ONTOLOGIES.map((o) => el("button", {type: "button", class: `onto${o === ui.ontology ? " active" : ""}`,
      "aria-pressed": String(o === ui.ontology), onclick: () => {
        ui.ontology = o;
        ui.filter = "";
        filterInput.value = "";
        loadList();
        drawOntoBar();
      }}, ONTOLOGY_LABELS[o])));
  };

  const addTag = async (concept) => {
    const res = await runAction(pickerStatus, () => ctx.call("vote", {
      pmid: ctx.pmid, experimentId, kind: "tag", ontology: ui.ontology, tag: concept.name, value: 1
    }));
    if (res) {
      applyVoteResult(ctx.ann, res);
      ui.picker = false;
      ctx.notify();
    }
  };

  const drawList = () => {
    if (ui.conceptsError) {
      setChildren(list, el("li", {class: "error"}, "Could not load the terms. Close and reopen to retry."));

      return;
    }
    if (!ui.concepts) {
      setChildren(list, el("li", {class: "muted"}, "Loading…"));

      return;
    }
    const found = filterConcepts(ui.concepts, ui.filter);
    const shown = found.slice(0, MAX_LISTED);
    setChildren(list,
      shown.map((c) => el("li", null, el("button", {type: "button", class: "concept", onclick: () => addTag(c)},
        c.name, hasOwnParent(c) ? el("span", {class: "muted"}, ` (${c.parent})`) : null))),
      found.length > shown.length ? el("li", {class: "muted"}, `${found.length - shown.length} more, type to filter`) : null,
      found.length === 0 ? el("li", {class: "muted"}, "No term matches") : null);
  };

  const loadList = async () => {
    const onto = ui.ontology;
    ui.concepts = null;
    ui.conceptsError = null;
    drawList();
    try {
      const concepts = await loadConcepts(ctx, onto);
      if (onto === ui.ontology) {
        ui.concepts = concepts;
      }
    } catch (err) {
      if (onto === ui.ontology) {
        ui.conceptsError = err;
      }
    }
    drawList();
  };

  // --- chips and their popups (a chip keeps its popup state across redraws: they are cached by key) ---------
  const comps = new Map();
  const keyOf = (t) => `${t.ontology}|${t.tag}`;
  const chipFor = (t) => {
    const k = keyOf(t);
    if (!comps.has(k)) {
      comps.set(k, createVoteChip(ctx, {kind: "tag", experimentId, ontology: t.ontology, tag: t.tag}, {
        subtitle: ONTOLOGY_LABELS[t.ontology] || t.ontology,
        loadInfo: () => loadConcept(ctx, t.ontology, t.tag),
        renderInfo: (c) => [
          c.definition ? el("p", null, c.definition) : null,
          c.url && /^https?:/i.test(c.url) && isSafeUrl(c.url) ? el("a", {href: c.url, target: "_blank", rel: "noopener"}, "Term page") : null
        ]
      }));
    }

    return comps.get(k);
  };

  const update = () => {
    const tags = tagsOf(ctx.ann, experimentId);
    const keys = new Set(tags.map(keyOf));
    for (const [k, comp] of comps) {
      if (!keys.has(k)) {
        comp.destroy(); // the tag fell to zero votes: it is not shown any more
        comps.delete(k);
      }
    }
    tags.forEach((t) => chipFor(t).update());
    setChildren(chips, tags.length ? tags.map((t) => chipFor(t).node) : el("span", {class: "muted"}, "none"));
    addBtn.hidden = !ctx.canWrite();
    addBtn.setAttribute("aria-expanded", String(ctx.canWrite() && ui.picker));
    picker.hidden = !(ctx.canWrite() && ui.picker);
  };

  drawOntoBar();
  drawList();
  ctx.subscribe(() => {
    if (!ctx.canWrite()) {
      ui.picker = false;
    }
    // do not redraw the popup (and lose a pending state) while a vote is in flight: notify is only
    // called with a server answer, so a redraw here is safe
    update();
  });
  update();

  return root;
};
