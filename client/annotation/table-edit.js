/**
 * Table editing for logged-in users (plan 3.5, 4.3 editExperiment), registered through
 * hooks.registerExperimentTools. Anonymous visitors see nothing new.
 *
 * Every change is one editExperiment({pmid, experimentId, rev, ops}) call. There are no optimistic
 * updates: the page shows what the server returned. Code 1001 (conflict) reloads the page; the other
 * errors are shown next to the controls.
 *
 * Part 1 (pure, unit tested): validation and the construction of ops from user actions.
 * Part 2: the editor of one experiment (DOM).
 */
import {el, setChildren, text, decodeEntitiesOnly, encodeUserText} from "./dom.js";
import {createStatus} from "./context.js";
import {parseLocations, openImportDialog, MAX_ROWS} from "./import-table.js";
import * as api from "./api.js";
import * as session from "./session.js";
import * as hooks from "./hooks.js";

export const LIMITS = {title: 1000, caption: 5000, coord: 200, rows: MAX_ROWS};

// ---- Part 1: pure functions -----------------------------------------------------------------

const NUM_RE = /^[-+]?(?:\d+(?:\.\d*)?|\.\d+)$/;

/** One coordinate typed by the user -> {ok: true, value} | {ok: false, error}. */
export const parseCoordinate = (s, name) => {
  const t = String(s === null || typeof s === "undefined" ? "" : s).trim().replace(/−/g, "-");
  if (!NUM_RE.test(t)) {
    return {ok: false, error: `${name} must be a number`};
  }
  const v = Number(t);
  if (!Number.isFinite(v) || Math.abs(v) > LIMITS.coord) {
    return {ok: false, error: `${name} must be between -${LIMITS.coord} and ${LIMITS.coord}`};
  }

  return {ok: true, value: v};
};

/** ["x", "y", "z"] as typed -> {ok: true, xyz: [x, y, z]} | {ok: false, error} (the first problem). */
export const parseXyz = (strings) => {
  const xyz = [];
  for (const [k, name] of ["x", "y", "z"].entries()) {
    const r = parseCoordinate(strings[k], name);
    if (!r.ok) {
      return r;
    }
    xyz.push(r.value);
  }

  return {ok: true, xyz};
};

/** "x,y,z" (as stored) -> [x, y, z]; legacy rows may have more values ("x,y,z,zscore"), all are returned. */
export const parseLocation = (loc) => String(loc).split(",").map((v) => parseFloat(v));

const isIndex = (i, max) => Number.isInteger(i) && i >= 0 && i <= max;

/**
 * Builders: each returns {ok: true, ops, confirm?} or {ok: false, error}. `confirm`, when present, is
 * the question the UI must ask before sending.
 */
export const opSetTitle = (s) => {
  if (typeof s !== "string") {
    return {ok: false, error: "The title must be text"};
  }
  if (s.length > LIMITS.title) {
    return {ok: false, error: `The title is too long (${s.length} of at most ${LIMITS.title} characters)`};
  }

  return {ok: true, ops: [{op: "setTitle", text: s}]};
};

export const opSetCaption = (s) => {
  if (typeof s !== "string") {
    return {ok: false, error: "The caption must be text"};
  }
  if (s.length > LIMITS.caption) {
    return {ok: false, error: `The caption is too long (${s.length} of at most ${LIMITS.caption} characters)`};
  }

  return {ok: true, ops: [{op: "setCaption", text: s}]};
};

export const opUpdateRow = (index, strings, nRows) => {
  if (!isIndex(index, nRows - 1)) {
    return {ok: false, error: "That row does not exist"};
  }
  const r = parseXyz(strings);

  return r.ok ? {ok: true, ops: [{op: "updateRow", index, xyz: r.xyz}]} : r;
};

/** Insert a row at `index` (0..nRows; nRows appends). */
export const opAddRow = (index, strings, nRows) => {
  if (!isIndex(index, nRows)) {
    return {ok: false, error: "That position does not exist"};
  }
  if (nRows >= LIMITS.rows) {
    return {ok: false, error: `A table can have at most ${LIMITS.rows} rows`};
  }
  const r = parseXyz(strings);

  return r.ok ? {ok: true, ops: [{op: "addRow", index, xyz: r.xyz}]} : r;
};

export const opDeleteRow = (index, nRows) => {
  if (!isIndex(index, nRows - 1)) {
    return {ok: false, error: "That row does not exist"};
  }
  const res = {ok: true, ops: [{op: "deleteRow", index}]};
  if (nRows === 1) {
    res.confirm = "Delete the last row? The table will be empty.";
  }

  return res;
};

/** Split before row `index` (rows index.. move to a new table). The first row cannot be the split point. */
export const opSplit = (index, nRows) => {
  if (index === null || typeof index === "undefined") {
    return {ok: false, error: "Select a row first (click on it), then split"};
  }
  if (!isIndex(index, nRows - 1)) {
    return {ok: false, error: "That row does not exist"};
  }
  if (index === 0) {
    return {ok: false, error: "Select a row after the first one: splitting at the first row would leave this table empty"};
  }

  return {
    ok: true,
    ops: [{op: "split", index}],
    confirm: `Split the table here? Rows ${index + 1} to ${nRows} will move to a new table (same title and caption, no tags).`
  };
};

/** The ORIGINAL text is sent; the preview only decides whether it is worth sending. */
export const opReplaceFromText = (s) => {
  const res = parseLocations(s);

  return res.ok ? {ok: true, ops: [{op: "replaceFromText", text: String(s)}]} : {ok: false, error: res.message};
};

export const sameXyz = (loc, xyz) => {
  const a = parseLocation(loc);

  return a.length >= 3 && [0, 1, 2].every((k) => a[k] === xyz[k]);
};

// ---- Part 2: the editor ---------------------------------------------------------------------

// titles and captions: only character references are decoded, never markup ("Faces<Houses" stays)
const plain = (s) => {
  try {
    return decodeEntitiesOnly(s);
  } catch (err) {
    return String(s === null || typeof s === "undefined" ? "" : s);
  }
};

const defaultConfirm = (q) => typeof globalThis.confirm === "function" && globalThis.confirm(q);

/**
 * deps: {container, experiment, info, call, user, subscribeUser, confirm?, openImport?}
 *   info: what article.js gives the hooks: {pmid, rev, reload, setRev?, annotationsLoaded?, slots?, createViewer?}
 * Returns {render, dispose, state}.
 */
export const createEditor = (deps) => {
  const {container, info, call, user} = deps;
  const confirmFn = deps.confirm || defaultConfirm;
  const openImport = deps.openImport || openImportDialog;
  const slots = info.slots || {};
  let ex = deps.experiment;
  let selected = null; // index of the selected row
  let editing = null; // index of the row being edited
  let adding = null; // position (0..n) of the row being added
  let textEdit = null; // "title" | "caption"
  let importing = false;
  let busy = false;
  let disposed = false;
  let focusEl = null;
  let viewerKey = JSON.stringify(ex.locations || []);
  let ownViewer = null;

  const status = createStatus();
  const viewerSlot = el("div", {class: "te-viewer-slot"});
  const main = el("div", {class: "te-main"});
  const importSlot = el("div");
  const root = el("div", {class: "te-root"}, viewerSlot, main);
  root.hidden = true;
  (slots.coords || container).appendChild(root);

  const rowsOf = () => ex.locations || [];
  const showMessage = (msg) => status.error({code: 142, message: msg});

  // ---- the viewer ----------------------------------------------------------------------------
  const refreshViewer = () => {
    const key = JSON.stringify(rowsOf());
    if (key === viewerKey) {
      return;
    }
    viewerKey = key;
    let host = slots.viewer || ownViewer;
    if (rowsOf().length === 0) {
      if (host) {
        setChildren(host);
      }

      return;
    }
    if (!info.createViewer) {
      return;
    }
    if (!host) {
      host = el("div", {id: `viewer-te-${ex.id}`, class: "te-own-viewer", style: "width:480px;height:480px; border:1px solid #111"});
      ownViewer = host;
      setChildren(viewerSlot, host);
    }
    setChildren(host); // rebuild: the viewer has no update API
    const locations = rowsOf().map((l) => parseLocation(l).slice(0, 3));
    Promise.resolve().then(() => info.createViewer(host.getAttribute("id"), locations)).catch((err) => {
      console.log("viewer failed", err);
    });
  };

  const showTexts = () => {
    if (slots.title) {
      setChildren(slots.title, text(plain(ex.title)));
    }
    if (slots.caption) {
      setChildren(slots.caption, text(plain(ex.caption)));
    }
  };

  // ---- talking to the server -------------------------------------------------------------------
  const dispose = () => {
    disposed = true;
    if (typeof unsubscribe === "function") {
      unsubscribe();
    }
  };

  const reloadPage = () => {
    dispose();
    info.reload();
  };

  /**
   * Send ops. Resolves to {ok: true} or {ok: false, error: string}. quiet: the caller shows the error itself.
   */
  const send = async (ops, {quiet = false} = {}) => {
    if (busy) {
      return {ok: false, error: "Please wait for the previous change to finish."};
    }
    if (info.annotationsLoaded === false) {
      const error = "The page is still loading, try again in a moment.";
      if (!quiet) {
        showMessage(error);
      }

      return {ok: false, error};
    }
    busy = true;
    status.clear();
    status.pending(true);
    let res;
    try {
      res = await call("editExperiment", {pmid: info.pmid, experimentId: ex.id, rev: info.rev, ops});
    } catch (err) {
      busy = false;
      status.pending(false);
      if (err && err.code === 1001) {
        const error = "This article changed meanwhile; reloading";
        status.error({code: 1001, message: error});
        reloadPage();

        return {ok: false, error, conflict: true};
      }
      status.error(err);
      const error = status.element.textContent;
      if (quiet) {
        status.clear();
      }

      return {ok: false, error};
    }
    busy = false;
    status.pending(false);
    applyResult(res, ops);

    return {ok: true};
  };

  const applyResult = (res, ops) => {
    if (info.setRev && res && Number.isInteger(res.rev)) {
      info.setRev(res.rev);
    }
    if (res && Array.isArray(res.experiments) && res.experiments.length === 0) {
      // the server found nothing to change (no new rev): close the editor, keep the page as it is
      selected = null;
      editing = null;
      adding = null;
      textEdit = null;
      render();

      return;
    }
    const mine = res && Array.isArray(res.experiments) ? res.experiments.find((e) => e.id === ex.id) : null;
    if (!mine) {
      reloadPage();

      return;
    }
    ex = mine;
    selected = null;
    editing = null;
    adding = null;
    textEdit = null;
    render();
    showTexts();
    refreshViewer();
    if (ops.some((o) => o.op === "split")) {
      // the new table has no page elements yet (tags, votes, viewer): the reload builds them
      reloadPage();
    }
  };

  // ---- actions ------------------------------------------------------------------------------------
  const cancelEdits = () => {
    editing = null;
    adding = null;
    textEdit = null;
    status.clear();
  };

  const startEdit = (i) => {
    if (busy) {
      return;
    }
    selected = i;
    cancelEdits();
    editing = i;
    render();
  };

  const startAdd = (at) => {
    if (busy) {
      return;
    }
    cancelEdits();
    adding = at;
    render();
  };

  const cancelAll = () => {
    cancelEdits();
    render();
  };

  const commitEdit = async (inputs) => {
    const strings = inputs.map((i) => i.value);
    const built = adding !== null ? opAddRow(adding, strings, rowsOf().length) : opUpdateRow(editing, strings, rowsOf().length);
    if (!built.ok) {
      showMessage(built.error);

      return;
    }
    if (adding === null && sameXyz(rowsOf()[editing], built.ops[0].xyz)) {
      cancelAll();

      return;
    }
    await send(built.ops);
  };

  const doDelete = async (i) => {
    if (busy) {
      return;
    }
    cancelEdits();
    const built = opDeleteRow(i, rowsOf().length);
    if (!built.ok) {
      showMessage(built.error);

      return;
    }
    if (built.confirm && !confirmFn(built.confirm)) {
      render();

      return;
    }
    await send(built.ops);
  };

  const doSplit = async () => {
    if (busy) {
      return;
    }
    cancelEdits();
    const built = opSplit(selected, rowsOf().length);
    if (!built.ok) {
      showMessage(built.error);
      render();

      return;
    }
    if (!confirmFn(built.confirm)) {
      render();

      return;
    }
    await send(built.ops);
  };

  const saveText = async (field, value) => {
    const current = plain(ex[field]);
    if (value === current) {
      cancelAll();

      return;
    }
    // stored with "&" encoded so that the page shows exactly what was typed (legacy values hold entities)
    const stored = encodeUserText(value);
    const built = field === "title" ? opSetTitle(stored) : opSetCaption(stored);
    if (!built.ok) {
      showMessage(built.error);

      return;
    }
    await send(built.ops);
  };

  const doImport = () => {
    if (busy || importing) {
      return;
    }
    cancelEdits();
    importing = true;
    render();
    openImport(importSlot, {
      onReplace: async (txt) => {
        const built = opReplaceFromText(txt);
        if (!built.ok) {
          return built;
        }

        return send(built.ops, {quiet: true});
      },
      onClose: () => {
        importing = false;
      }
    });
  };

  // ---- drawing ------------------------------------------------------------------------------------
  const button = (label, onclick, attrs) => el("button", {type: "button", class: "te-btn", onclick, ...attrs}, label);

  const onKey = (inputs, last) => (ev) => {
    if (ev.key === "Enter" || (ev.key === "Tab" && !ev.shiftKey && last)) {
      ev.preventDefault();
      commitEdit(inputs);
    } else if (ev.key === "Escape") {
      ev.preventDefault();
      cancelAll();
    }
  };

  /** Three inputs in cells + Save/Cancel, for an edited or a new row. */
  const rowInputs = (initial) => {
    const inputs = ["x", "y", "z"].map((name, k) => el("input", {
      type: "text", class: "te-cell", inputmode: "decimal", size: 6, "aria-label": name.toUpperCase(),
      value: initial ? initial[k] : ""
    }));
    inputs.forEach((inp, k) => inp.addEventListener("keydown", onKey(inputs, k === 2)));
    focusEl = inputs[0];

    return {
      inputs,
      cells: inputs.map((inp) => el("td", null, inp)),
      actions: el("td", {class: "te-actions"},
        button("Save", () => commitEdit(inputs), {title: "Save the row (Enter)"}),
        button("Cancel", cancelAll, {title: "Cancel (Esc)"}))
    };
  };

  const textForm = () => {
    const field = textEdit;
    const isTitle = field === "title";
    const max = isTitle ? LIMITS.title : LIMITS.caption;
    const initial = plain(ex[field]);
    const input = isTitle
      ? el("input", {type: "text", class: "te-text", maxlength: max, value: initial, "aria-label": "Title"})
      : el("textarea", {class: "te-text", rows: 5, maxlength: max, "aria-label": "Caption"});
    if (!isTitle) {
      input.value = initial;
    }
    input.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape") {
        ev.preventDefault();
        cancelAll();
      } else if (isTitle && ev.key === "Enter") {
        ev.preventDefault();
        saveText(field, input.value);
      }
    });
    focusEl = input;

    return el("div", {class: "te-textform"},
      el("label", null, isTitle ? "Title" : "Caption", " (at most ", max, " characters, plain text)"), el("br"),
      input, el("br"),
      button("Save", () => saveText(field, input.value)), button("Cancel", cancelAll));
  };

  const bar = () => {
    if (textEdit) {
      return textForm();
    }
    const rows = rowsOf();
    const kids = [
      button("Edit title", () => {
        cancelEdits();
        textEdit = "title";
        render();
      }),
      button("Edit caption", () => {
        cancelEdits();
        textEdit = "caption";
        render();
      }),
      button("Import from text", doImport)
    ];
    if (rows.length > 1) {
      kids.push(button("Split here", doSplit, {
        title: "Select a row (click on it); the table is cut before that row",
        disabled: selected === null || selected === 0
      }));
    }

    return el("div", {class: "te-bar"}, kids);
  };

  const table = () => {
    const rows = rowsOf();
    if (rows.length === 0 && adding === null) {
      return el("div", {class: "te-empty"},
        el("p", {class: "muted"}, "This table has no coordinates."),
        button("Add row", () => startAdd(0)), " ", button("Import from text", doImport));
    }
    const trs = [];
    // legacy rows may carry extra values (e.g. a z-score): shown read-only in one more column, only if some row has one
    const hasExtra = rows.some((l) => parseLocation(l).length > 3);
    const extraCell = (vals) => (hasExtra ? el("td", {class: "te-extra muted", title: "Not editable; kept when the row is edited"}, vals.join(", ")) : null);
    const addRowTr = () => {
      const r = rowInputs(null);

      return el("tr", {class: "te-new"}, r.cells, extraCell([]), r.actions);
    };
    if (adding === 0) {
      trs.push(addRowTr());
    }
    rows.forEach((loc, i) => {
      if (editing === i) {
        const vals = parseLocation(loc);
        const r = rowInputs(vals.slice(0, 3));
        trs.push(el("tr", {class: "te-selected te-editing"}, r.cells, extraCell(vals.slice(3)), r.actions));
      } else {
        const xyz = parseLocation(loc);
        trs.push(el("tr", {class: selected === i ? "te-selected" : "", onclick: () => startEdit(i), title: "Click to select and edit"},
          xyz.slice(0, 3).map((v) => el("td", null, v)),
          extraCell(xyz.slice(3)),
          el("td", {class: "te-actions", onclick: (ev) => ev.stopPropagation && ev.stopPropagation()},
            button("+", () => startAdd(i + 1), {title: "Insert a row after this one", "aria-label": `Insert a row after row ${i + 1}`}),
            button("-", () => doDelete(i), {title: "Delete this row", "aria-label": `Delete row ${i + 1}`}))));
      }
      if (adding === i + 1) {
        trs.push(addRowTr());
      }
    });

    return el("div", {class: "te-scroll"}, el("table", {class: "te-table"},
      el("thead", null, el("tr", null,
        el("th", null, "X"), el("th", null, "Y"), el("th", null, "Z"),
        hasExtra ? el("th", {title: "Extra values of the original data (read-only)"}, "Extra") : null,
        el("th", {class: "te-actions"}, button("+", () => startAdd(rows.length), {title: "Add a row at the end", "aria-label": "Add a row at the end"})))),
      el("tbody", null, trs)));
  };

  const render = () => {
    if (disposed) {
      return;
    }
    if (!user()) {
      root.hidden = true;
      container.classList.remove("te-active");
      cancelEdits();
      importing = false;

      return;
    }
    root.hidden = false;
    container.classList.add("te-active");
    focusEl = null;
    setChildren(main, bar(), status.element, table(), importSlot);
    status.watch(main.querySelectorAll ? Array.from(main.querySelectorAll("button")) : main.all((n) => n.tagName === "BUTTON"));
    if (focusEl && focusEl.focus) {
      focusEl.focus();
    }
  };

  const unsubscribe = deps.subscribeUser ? deps.subscribeUser(() => render()) : null;
  render();

  return {render, dispose, root, state: () => ({ex, selected, editing, adding, busy})};
};

/** Hook for the experiment container: called by article.js through hooks.runExperimentTools. */
export const register = () => {
  hooks.registerExperimentTools((container, experiment, info) => {
    createEditor({container, experiment, info, call: api.call, user: session.current, subscribeUser: session.onChange});
  });
};
