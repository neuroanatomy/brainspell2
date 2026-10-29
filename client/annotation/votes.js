/**
 * F1 (MeSH headings) and F3 ("Table is correct"): agree / disagree / retract controls with counts.
 * Everything is read from getAnnotations (ctx.ann.votes) and updated from the answer of vote().
 */
import {el, setChildren} from "./dom.js";
import {createStatus, runAction} from "./context.js";

/** CSS class for the balance of votes (the original coloured tags by balance). */
export const balanceClass = (agree, disagree) => {
  const total = agree + disagree;
  if (total === 0) {
    return "bal-none";
  }
  const r = (agree - disagree) / total;
  if (r > 0.5) { return "bal-good"; }
  if (r > 0) { return "bal-ok"; }
  if (r === 0) { return "bal-tie"; }
  if (r >= -0.5) { return "bal-poor"; }

  return "bal-bad";
};

const sameTag = (a, b) => String(a).trim().toLowerCase() === String(b).trim().toLowerCase();

/** The entry of ann.votes for (kind, experimentId, ontology, tag), or null. */
export const findVote = (ann, kind, experimentId, ontology, tag) =>
  (ann && ann.votes || []).find((v) => v.kind === kind && v.experimentId === experimentId &&
    (v.ontology || null) === (ontology || null) && sameTag(v.tag, tag)) || null;

/**
 * Put the answer of vote() into ann.votes. Tags that fall to zero votes disappear (display rule of 3.4,
 * which the server applies on read); MeSH headings and tableOk entries stay.
 */
export const applyVoteResult = (ann, res) => {
  const entry = findVote(ann, res.kind, res.experimentId, res.ontology, res.tag);
  const next = {kind: res.kind, experimentId: res.experimentId, ontology: res.ontology || null, tag: res.tag,
    agree: res.agree, disagree: res.disagree, mine: res.mine};
  const keep = res.kind !== "tag" || res.agree + res.disagree >= 1;
  if (entry) {
    ann.votes.splice(ann.votes.indexOf(entry), 1, ...(keep ? [next] : []));
  } else if (keep) {
    ann.votes.push(next);
  }

  return ann;
};

/**
 * Agree / disagree / retract buttons for one vote key.
 * spec: {kind, experimentId, ontology?, tag}; labels: {agree, disagree}.
 * Anonymous visitors get the counts only.
 */
export const voteControls = (ctx, spec, labels = {agree: "Agree", disagree: "Disagree"}) => {
  const root = el("span", {class: "vote-controls"});
  const status = createStatus();

  const send = async (value) => {
    const params = {pmid: ctx.pmid, experimentId: spec.experimentId, kind: spec.kind, tag: spec.tag, value};
    if (spec.kind === "tag") {
      params.ontology = spec.ontology;
    }
    const res = await runAction(status, () => ctx.call("vote", params));
    if (res) {
      applyVoteResult(ctx.ann, res);
      ctx.notify();
    }
  };

  const update = () => {
    const entry = findVote(ctx.ann, spec.kind, spec.experimentId, spec.ontology, spec.tag) || {agree: 0, disagree: 0, mine: 0};
    if (!ctx.canWrite()) {
      setChildren(root,
        el("span", {class: "count agree", title: labels.agree}, `${labels.agree} ${entry.agree}`),
        el("span", {class: "count disagree", title: labels.disagree}, `${labels.disagree} ${entry.disagree}`));

      return;
    }
    const agreeBtn = el("button", {type: "button", class: `vote agree${entry.mine === 1 ? " mine" : ""}`, "aria-pressed": String(entry.mine === 1),
      title: labels.agree, onclick: () => send(entry.mine === 1 ? 0 : 1)}, `${labels.agree} ${entry.agree}`);
    const disagreeBtn = el("button", {type: "button", class: `vote disagree${entry.mine === -1 ? " mine" : ""}`, "aria-pressed": String(entry.mine === -1),
      title: labels.disagree, onclick: () => send(entry.mine === -1 ? 0 : -1)}, `${labels.disagree} ${entry.disagree}`);
    const retractBtn = el("button", {type: "button", class: "vote retract", title: "Retract my vote", hidden: entry.mine === 0,
      onclick: () => send(0)}, "Retract");
    status.watch([agreeBtn, disagreeBtn, retractBtn]);
    setChildren(root, agreeBtn, disagreeBtn, retractBtn, status.element);
  };

  ctx.subscribe(update);
  update();

  return root;
};

/** The MeSH headings section: every heading is always shown, with its counts. */
export const renderMesh = (ctx, meshHeadings) => {
  const root = el("div", {class: "mesh"});
  const header = el("h2", null, "Medical Subject Headings");
  const list = el("div", {class: "mesh-list"});
  const items = (meshHeadings || []).map((h) => {
    const name = h.name;
    const tagEl = el("span", {class: "tag"}, name);
    const controls = voteControls(ctx, {kind: "mesh", experimentId: -1, tag: name});
    const item = el("span", {class: "mesh-item"}, tagEl, controls);

    return {name, tagEl, item};
  });
  items.forEach((it) => list.appendChild(it.item));
  root.appendChild(header);
  root.appendChild(list);

  const update = () => {
    for (const it of items) {
      const e = findVote(ctx.ann, "mesh", -1, null, it.name) || {agree: 0, disagree: 0};
      it.tagEl.className = `tag ${balanceClass(e.agree, e.disagree)}`;
    }
  };
  ctx.subscribe(update);
  update();

  return root;
};

/** "Table is correct": yes / no per experiment (kind tableOk). */
export const renderTableOk = (ctx, experimentId) => {
  const spec = {kind: "tableOk", experimentId, tag: "ok"};
  const label = el("span", {class: "label"}, "Table is correct: ");
  const root = el("div", {class: "table-ok"}, label, voteControls(ctx, spec, {agree: "Yes", disagree: "No"}));
  const update = () => {
    const e = findVote(ctx.ann, "tableOk", experimentId, null, "ok") || {agree: 0, disagree: 0};
    root.className = `table-ok ${balanceClass(e.agree, e.disagree)}`;
  };
  ctx.subscribe(update);
  update();

  return root;
};
