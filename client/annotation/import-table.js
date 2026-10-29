/**
 * "Import from text": a dialog (a plain element in the page) where the user pastes coordinates,
 * previews what would be imported, and replaces the table of the experiment.
 *
 * The parser follows the NORMATIVE GRAMMAR of the plan (identical to the server's):
 * one location per line; on each line the numbers are matched in order of appearance by
 * NUMBER_RE (U+2212 is converted to "-"); the first three numbers are x, y, z; lines with fewer than
 * three numbers are skipped; coordinates must be within [-200, 200] (else the line is an error that
 * names its 1-based line number); at least one valid line is required.
 * The preview is only a preview: "Replace table" sends the ORIGINAL text and the server parses again.
 */
import {el, setChildren} from "./dom.js";

export const NUMBER_RE = /[-+−]?(?:\d+(?:\.\d+)?|\.\d+)/g;
export const MAX_ABS = 200;
export const MAX_ROWS = 5000;

/**
 * parseLocations(text) -> {
 *   rows: [{line, xyz: [x, y, z]}],     accepted lines (1-based line numbers)
 *   skipped: [{line, text}],             non-blank lines with fewer than three numbers
 *   errors: [{line, message}],           lines with a coordinate out of range (and the row limit)
 *   ok, message                          ok: it can be sent (no error and at least one row)
 * }
 * Blank lines are ignored silently (they are not listed as skipped).
 */
export const parseLocations = (text) => {
  const rows = [];
  const skipped = [];
  const errors = [];
  const lines = String(text === null || typeof text === "undefined" ? "" : text).split(/\r\n|\r|\n/);
  lines.forEach((raw, i) => {
    const line = i + 1;
    const nums = (raw.match(NUMBER_RE) || []).slice(0, 3).map((s) => Number(s.replace(/−/g, "-")));
    if (nums.length < 3) {
      if (raw.trim() !== "") {
        skipped.push({line, text: raw});
      }

      return;
    }
    const bad = ["x", "y", "z"].filter((_, k) => !(Math.abs(nums[k]) <= MAX_ABS));
    if (bad.length) {
      errors.push({line, message: `line ${line}: ${bad.join(", ")} must be between -${MAX_ABS} and ${MAX_ABS}`});

      return;
    }
    rows.push({line, xyz: nums});
  });
  if (rows.length > MAX_ROWS) {
    errors.push({line: 0, message: `at most ${MAX_ROWS} locations per table (found ${rows.length})`});
  }
  let message = "";
  if (errors.length) {
    message = errors[0].message;
  } else if (rows.length === 0) {
    message = "No line with three numbers was found.";
  }

  return {rows, skipped, errors, ok: errors.length === 0 && rows.length > 0, message};
};

const shorten = (s, n = 80) => (s.length > n ? `${s.slice(0, n)}…` : s);

/**
 * Show the dialog in host (an element). Options:
 *   onReplace(text) -> Promise<{ok: true} | {ok: false, error: string}>   sends the replaceFromText op
 *   onClose()       called when the dialog is closed (Cancel or after a successful replace)
 * Returns {node, close}.
 */
export const openImportDialog = (host, {onReplace, onClose} = {}) => {
  const area = el("textarea", {class: "te-import-text", rows: 8, cols: 40, "aria-label": "Coordinates as text", placeholder: "x, y, z\n-42, 18, 24\n..."});
  const previewSlot = el("div", {class: "te-import-preview"});
  const message = el("span", {class: "ann-status", role: "status", "aria-live": "polite"});
  let previewed = null; // the text that was previewed OK
  let busy = false;

  const replaceBtn = el("button", {type: "button", disabled: true, onclick: () => replace()}, "Replace table");
  const previewBtn = el("button", {type: "button", onclick: () => preview()}, "Preview");
  const cancelBtn = el("button", {type: "button", onclick: () => close()}, "Cancel");

  const setMessage = (cls, s) => {
    message.className = `ann-status ${cls}`.trim();
    setChildren(message, s);
  };

  const preview = () => {
    const res = parseLocations(area.value);
    const kids = [];
    if (res.ok) {
      kids.push(el("p", null, `${res.rows.length} location${res.rows.length === 1 ? "" : "s"} will replace the table.`));
      kids.push(el("table", {class: "te-import-rows"},
        el("thead", null, el("tr", null, el("th", null, "Line"), el("th", null, "X"), el("th", null, "Y"), el("th", null, "Z"))),
        el("tbody", null, res.rows.map((r) => el("tr", null, el("td", null, r.line), r.xyz.map((v) => el("td", null, v)))))));
    } else {
      kids.push(el("p", {class: "error"}, res.message));
    }
    if (res.errors.length > 1) {
      kids.push(el("ul", {class: "error"}, res.errors.slice(1).map((e) => el("li", null, e.message))));
    }
    if (res.skipped.length) {
      kids.push(el("p", {class: "muted"}, `${res.skipped.length} line${res.skipped.length === 1 ? "" : "s"} skipped (fewer than three numbers):`));
      kids.push(el("ul", {class: "muted te-import-skipped"}, res.skipped.map((s) => el("li", null, `line ${s.line}: ${shorten(s.text)}`))));
    }
    setChildren(previewSlot, kids);
    previewed = res.ok ? area.value : null;
    replaceBtn.disabled = !res.ok;
    setMessage("", "");

    return res;
  };

  const replace = async () => {
    if (busy) {
      return;
    }
    if (previewed !== area.value) {
      // the text changed after the preview: show the new preview first, do not send
      preview();

      return;
    }
    busy = true;
    [replaceBtn, previewBtn, cancelBtn].forEach((b) => {
      b.disabled = true;
    });
    setMessage("pending", "Saving…");
    let res;
    try {
      res = await onReplace(area.value);
    } catch (err) {
      res = {ok: false, error: (err && err.message) || "Something went wrong."};
    }
    busy = false;
    previewBtn.disabled = false;
    cancelBtn.disabled = false;
    if (res && res.ok) {
      close();

      return;
    }
    replaceBtn.disabled = false;
    setMessage("error", (res && res.error) || "Something went wrong.");
  };

  area.addEventListener("input", () => {
    previewed = null;
    replaceBtn.disabled = true;
  });

  const node = el("div", {class: "te-import", role: "dialog", "aria-label": "Import coordinates from text"},
    el("h4", null, "Import coordinates from text"),
    el("p", {class: "muted"}, "One location per line. The first three numbers of each line are x, y, z (letters and quotes are ignored). Lines with fewer than three numbers are skipped."),
    area,
    el("div", {class: "te-buttons"}, previewBtn, replaceBtn, cancelBtn, message),
    previewSlot);

  const close = () => {
    node.remove();
    if (onClose) {
      onClose();
    }
  };

  host.appendChild(node);

  return {node, close, preview};
};
