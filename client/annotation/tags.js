/**
 * F2: ontology tags of an experiment. Chips with counts (the server applies the display rule of
 * plan 3.4, so only tags with at least one vote come back), a popup with the vote controls and the
 * link to the term, and a picker to add a tag from the three ontologies using listConcepts.
 */
import {el, setChildren, text, isSafeUrl} from "./dom.js";
import {createStatus, runAction} from "./context.js";
import {balanceClass, voteControls, applyVoteResult} from "./votes.js";

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
  const ui = {open: null, picker: false, ontology: "cognitive", filter: "", concepts: null, conceptsError: null};
  const chips = el("div", {class: "tag-chips"});
  const popup = el("div", {class: "tag-popup"});
  const picker = el("div", {class: "tag-picker"});
  const addBtn = el("button", {type: "button", class: "tag-add", onclick: () => {
    ui.picker = !ui.picker;
    if (ui.picker) {
      loadList();
    }
    update();
  }}, "Add tag");
  const pickerStatus = createStatus();
  const root = el("div", {class: "tags"}, el("span", {class: "label"}, "Tags: "), chips, addBtn, popup, picker);

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

  // --- chips and popup -------------------------------------------------------------------------
  const drawPopup = (entry) => {
    if (!entry) {
      popup.hidden = true;
      setChildren(popup);

      return;
    }
    popup.hidden = false;
    const info = el("div", {class: "tag-info"});
    setChildren(popup,
      el("strong", null, entry.tag), " ", el("span", {class: "muted"}, ONTOLOGY_LABELS[entry.ontology] || entry.ontology),
      el("div", null, voteControls(ctx, {kind: "tag", experimentId, ontology: entry.ontology, tag: entry.tag})),
      info,
      el("button", {type: "button", class: "close", onclick: () => {
        ui.open = null;
        update();
      }}, "Close"));
    const key = ui.open;
    loadConcept(ctx, entry.ontology, entry.tag).then((c) => {
      if (ui.open !== key) {
        return;
      }
      setChildren(info,
        c.definition ? el("p", null, c.definition) : null,
        c.url && /^https?:/i.test(c.url) && isSafeUrl(c.url) ? el("a", {href: c.url, target: "_blank", rel: "noopener"}, "Term page") : null);
    }).catch(() => {
      setChildren(info, el("span", {class: "muted"}, "Term details not available"));
    });
  };

  const update = () => {
    const tags = tagsOf(ctx.ann, experimentId);
    const openEntry = tags.find((t) => `${t.ontology}|${t.tag}` === ui.open) || null;
    if (!openEntry) {
      ui.open = null;
    }
    setChildren(chips,
      tags.length ? tags.map((t) => el("button", {type: "button",
        class: `tag chip ${balanceClass(t.agree, t.disagree)}${t.mine ? " mine" : ""}`,
        title: `${ONTOLOGY_LABELS[t.ontology] || t.ontology}: ${t.agree} agree, ${t.disagree} disagree`,
        "aria-expanded": String(`${t.ontology}|${t.tag}` === ui.open),
        onclick: () => {
          const k = `${t.ontology}|${t.tag}`;
          ui.open = ui.open === k ? null : k;
          update();
        }}, t.tag, text(" "), el("span", {class: "counts"}, `+${t.agree} -${t.disagree}`)))
        : el("span", {class: "muted"}, "none"));
    drawPopup(openEntry);
    addBtn.hidden = !ctx.canWrite();
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
