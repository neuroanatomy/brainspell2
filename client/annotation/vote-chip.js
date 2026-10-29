/**
 * A chip (MeSH heading or ontology tag) and its vote popup. Follows the original Brainspell's pattern: the chip
 * shows only the label, a coloured band on its left for the balance of votes, and a small count "+a −d" when
 * there are votes; the vote buttons live in ONE small popup anchored under the chip.
 *
 * Popup behaviour: one popup open at a time (opening another closes it); closes on Escape, on a click outside,
 * and with its Close button; focus moves into it when it opens and returns to the chip when it closes;
 * aria-haspopup / aria-expanded on the chip, role="dialog" with an accessible name on the popup.
 * Server calls and the no-optimistic-update rule are the same as before: ctx.ann changes only with the answer.
 */
import {el, setChildren, getDocument} from "./dom.js";
import {createStatus, runAction} from "./context.js";
import {balanceClass, findVote, applyVoteResult} from "./votes-state.js";

let current = null; // the chip whose popup is open
let listeningOn = null;

const inside = (root, node) => {
  for (let x = node; x; x = x.parentNode) {
    if (x === root) {
      return true;
    }
  }

  return false;
};

const onDocClick = (ev) => {
  if (current && !inside(current.node, ev.target)) {
    current.close({restoreFocus: false});
  }
};

const onDocKey = (ev) => {
  if (current && ev.key === "Escape") {
    current.close({restoreFocus: true});
  }
};

const listen = () => {
  const d = getDocument();
  if (!d || !d.addEventListener || listeningOn === d) {
    return;
  }
  d.addEventListener("click", onDocClick);
  d.addEventListener("keydown", onDocKey);
  listeningOn = d;
};

/** tests only */
export const _reset = () => {
  current = null;
  listeningOn = null;
};

export const openChip = () => current;

const MINUS = "−";

/**
 * spec: {kind, experimentId, ontology?, tag}; opts: {label?, subtitle?, loadInfo?: () => Promise<{definition?, url?}>,
 * renderInfo?: (info) => nodes}. Returns {node, chip, update, close, destroy, isOpen}.
 * The caller calls update() whenever ctx.ann changed.
 */
export const createVoteChip = (ctx, spec, opts = {}) => {
  const label = opts.label || spec.tag;
  const status = createStatus();
  const infoSlot = el("div", {class: "vote-info"});
  let open = false;
  let infoLoaded = false;
  let refocus = null; // which popup button gets the focus after a redraw

  const chipLabel = el("span", {class: "chip-label"}, label);
  const chipCounts = el("span", {class: "counts"});
  const chip = el("button", {type: "button", class: "tag chip bal-none", "aria-haspopup": "dialog", "aria-expanded": "false",
    onclick: () => (open ? api.close({restoreFocus: true}) : api.open())}, chipLabel, chipCounts);
  const popup = el("div", {class: "vote-popup", role: "dialog", tabindex: "-1", "aria-label": `${label}: votes`});
  popup.hidden = true;
  const node = el("span", {class: "chip-wrap"}, chip, popup);

  const entry = () => findVote(ctx.ann, spec.kind, spec.experimentId, spec.ontology, spec.tag) || {agree: 0, disagree: 0, mine: 0};

  const send = async (value, which) => {
    const params = {pmid: ctx.pmid, experimentId: spec.experimentId, kind: spec.kind, tag: spec.tag, value};
    if (spec.kind === "tag") {
      params.ontology = spec.ontology;
    }
    refocus = which;
    const res = await runAction(status, () => ctx.call("vote", params));
    if (res) {
      applyVoteResult(ctx.ann, res);
      ctx.notify();
    }
  };

  const drawPopup = () => {
    const e = entry();
    const kids = [
      el("div", {class: "vote-popup-head"}, el("strong", null, label), opts.subtitle ? el("span", {class: "muted"}, ` ${opts.subtitle}`) : null),
      el("div", {class: "vote-counts"},
        el("span", {class: "count-up"}, el("span", {"aria-hidden": "true"}, "▲ "), `${e.agree} agree`),
        el("span", {class: "count-down"}, el("span", {"aria-hidden": "true"}, "▼ "), `${e.disagree} disagree`),
        e.mine !== 0 ? el("span", {class: "muted"}, "including you") : null)
    ];
    const buttons = [];
    if (ctx.canWrite()) {
      const agree = el("button", {type: "button", class: `vote-btn agree${e.mine === 1 ? " pressed" : ""}`, "aria-pressed": String(e.mine === 1),
        onclick: () => send(e.mine === 1 ? 0 : 1, "agree")}, el("span", {"aria-hidden": "true"}, "▲ "), "Agree");
      const disagree = el("button", {type: "button", class: `vote-btn disagree${e.mine === -1 ? " pressed" : ""}`, "aria-pressed": String(e.mine === -1),
        onclick: () => send(e.mine === -1 ? 0 : -1, "disagree")}, el("span", {"aria-hidden": "true"}, "▼ "), "Disagree");
      const retract = el("button", {type: "button", class: "vote-btn retract", disabled: e.mine === 0, title: e.mine === 0 ? "You have not voted" : "Retract my vote",
        onclick: () => send(0, "retract")}, "Retract");
      buttons.push(agree, disagree, retract);
      kids.push(el("div", {class: "vote-actions", role: "group", "aria-label": "Your vote"}, agree, disagree, retract));
    } else {
      kids.push(el("p", {class: "muted vote-login"}, "Log in to vote"));
    }
    const close = el("button", {type: "button", class: "vote-close btn-quiet", onclick: () => api.close({restoreFocus: true})}, "Close");
    buttons.push(close);
    status.watch(buttons);
    kids.push(infoSlot, el("div", {class: "vote-foot"}, status.element, close));
    setChildren(popup, kids);
    const target = refocus && buttons.find((b) => b.className.includes(refocus) && !b.disabled);
    refocus = null;
    if (target && target.focus) {
      target.focus();
    }
  };

  const loadInfo = () => {
    if (infoLoaded || !opts.loadInfo) {
      return;
    }
    infoLoaded = true;
    Promise.resolve().then(opts.loadInfo).then((info) => {
      setChildren(infoSlot, opts.renderInfo(info));
    }).catch(() => {
      infoLoaded = false;
      setChildren(infoSlot, el("span", {class: "muted"}, "Term details not available"));
    });
  };

  const update = () => {
    const e = entry();
    chip.className = `tag chip ${balanceClass(e.agree, e.disagree)}${e.mine ? " mine" : ""}`;
    setChildren(chipCounts, e.agree + e.disagree > 0 ? `+${e.agree} ${MINUS}${e.disagree}` : "");
    chipCounts.hidden = e.agree + e.disagree === 0;
    if (open) {
      drawPopup();
    }
  };

  const api = {
    node, chip, popup, update, status,
    isOpen: () => open,
    open: () => {
      listen();
      if (current && current !== api) {
        current.close({restoreFocus: false});
      }
      current = api;
      open = true;
      chip.setAttribute("aria-expanded", "true");
      popup.hidden = false;
      drawPopup();
      loadInfo();
      popup.focus();
    },
    close: ({restoreFocus = false} = {}) => {
      if (!open) {
        return;
      }
      open = false;
      if (current === api) {
        current = null;
      }
      chip.setAttribute("aria-expanded", "false");
      popup.hidden = true;
      setChildren(popup);
      if (restoreFocus && chip.focus) {
        chip.focus();
      }
    },
    /** The chip is removed from the page: close without moving the focus. */
    destroy: () => api.close({restoreFocus: false})
  };
  update();

  return api;
};
