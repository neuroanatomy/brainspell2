/**
 * F1 (MeSH headings) and F3 ("Table is correct"). A MeSH heading is a chip with a vote popup (vote-chip.js);
 * "Table is correct" is a segmented two-button control. Everything is read from getAnnotations (ctx.ann.votes)
 * and updated from the answer of vote(): the UI is never optimistic.
 */
import {el, setChildren} from "./dom.js";
import {createStatus, runAction} from "./context.js";
import {createVoteChip} from "./vote-chip.js";
import {balanceClass, findVote, applyVoteResult} from "./votes-state.js";

export {balanceClass, findVote, applyVoteResult};

/**
 * A segmented control [ A n | B n ] of two toggle buttons (aria-pressed). Clicking the pressed one retracts.
 * spec: {kind, experimentId, tag, ...}; labels: {agree: "✓ Yes", disagree: "✗ No"}; name: accessible name of the group.
 * Anonymous visitors get the counts as plain text.
 */
export const segmentedVote = (ctx, spec, labels, name) => {
  const root = el("span", {class: "segmented-wrap"});
  const status = createStatus();

  const send = async (value) => {
    const params = {pmid: ctx.pmid, experimentId: spec.experimentId, kind: spec.kind, tag: spec.tag, value};
    const res = await runAction(status, () => ctx.call("vote", params));
    if (res) {
      applyVoteResult(ctx.ann, res);
      ctx.notify();
    }
  };

  const update = () => {
    const e = findVote(ctx.ann, spec.kind, spec.experimentId, spec.ontology, spec.tag) || {agree: 0, disagree: 0, mine: 0};
    if (!ctx.canWrite()) {
      setChildren(root, el("span", {class: "count"}, `${labels.agree} ${e.agree}`), el("span", {class: "count"}, `${labels.disagree} ${e.disagree}`));

      return;
    }
    const a = el("button", {type: "button", class: `seg agree${e.mine === 1 ? " pressed" : ""}`, "aria-pressed": String(e.mine === 1),
      title: e.mine === 1 ? "Click to retract your vote" : labels.agree, onclick: () => send(e.mine === 1 ? 0 : 1)}, `${labels.agree} ${e.agree}`);
    const d = el("button", {type: "button", class: `seg disagree${e.mine === -1 ? " pressed" : ""}`, "aria-pressed": String(e.mine === -1),
      title: e.mine === -1 ? "Click to retract your vote" : labels.disagree, onclick: () => send(e.mine === -1 ? 0 : -1)}, `${labels.disagree} ${e.disagree}`);
    status.watch([a, d]);
    setChildren(root, el("span", {class: "segmented", role: "group", "aria-label": name}, a, d), status.element);
  };

  ctx.subscribe(update);
  update();

  return root;
};

/** The MeSH headings section: every heading is always shown, as a chip. */
export const renderMesh = (ctx, meshHeadings) => {
  const root = el("div", {class: "mesh"});
  const header = el("h2", null, "Medical Subject Headings");
  const list = el("div", {class: "mesh-list chips"});
  const chips = (meshHeadings || []).map((h) => createVoteChip(ctx, {kind: "mesh", experimentId: -1, tag: h.name}, {subtitle: "MeSH heading"}));
  chips.forEach((c) => list.appendChild(c.node));
  root.appendChild(header);
  root.appendChild(list);
  ctx.subscribe(() => chips.forEach((c) => c.update()));

  return root;
};

/** "Table is correct": yes / no per experiment (kind tableOk). */
export const renderTableOk = (ctx, experimentId) => {
  const spec = {kind: "tableOk", experimentId, tag: "ok"};

  return el("div", {class: "table-ok"}, el("span", {class: "label"}, "Table is correct: "),
    segmentedVote(ctx, spec, {agree: "\u2713 Yes", disagree: "\u2717 No"}, "Table is correct"));
};
