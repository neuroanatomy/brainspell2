/**
 * F4: stereotaxic space (MNI / Talairach) and number of subjects. One vote per user each;
 * the counts come from getAnnotations and the UI is updated from the answer of the server.
 */
import {el, setChildren} from "./dom.js";
import {createStatus, runAction} from "./context.js";

export const SPACES = ["MNI", "Talairach"];

/** Parse the content of the number box. Returns an integer 1..100000 or null when invalid. */
export const parseSubjects = (s) => {
  const t = String(s).trim();
  if (!/^\d{1,6}$/.test(t)) {
    return null;
  }
  const n = Number(t);

  return n >= 1 && n <= 100000 ? n : null;
};

export const renderMeta = (ctx) => {
  const spaceRow = el("div", {class: "meta-row meta-space"});
  const nRow = el("div", {class: "meta-row meta-nsubjects"});
  const root = el("div", {class: "meta"}, el("h2", null, "Study details"), spaceRow, nRow);
  const spaceStatus = createStatus();
  const nStatus = createStatus();
  const input = el("input", {type: "number", min: "1", max: "100000", step: "1", class: "nsubjects-input", "aria-label": "Number of subjects"});

  const setSpace = async (space) => {
    const res = await runAction(spaceStatus, () => ctx.call("setStereoSpace", {pmid: ctx.pmid, space}));
    if (res) {
      ctx.ann.stereo = res;
      ctx.notify();
    }
  };

  const setN = async (n) => {
    const res = await runAction(nStatus, () => ctx.call("setNSubjects", {pmid: ctx.pmid, n}));
    if (res) {
      ctx.ann.nsubjects = res;
      ctx.notify();
    }
  };

  const drawSpace = () => {
    const st = ctx.ann.stereo || {MNI: 0, Talairach: 0, mine: null};
    if (!ctx.canWrite()) {
      setChildren(spaceRow, el("span", {class: "label"}, "Stereotaxic space: "),
        SPACES.map((s) => el("span", {class: "count"}, `${s} ${st[s] || 0}`)));

      return;
    }
    const buttons = SPACES.map((s) => el("button", {type: "button", class: `vote${st.mine === s ? " mine" : ""}`,
      "aria-pressed": String(st.mine === s), title: st.mine === s ? "Click to retract" : `Vote ${s}`,
      onclick: () => setSpace(st.mine === s ? null : s)}, `${s} ${st[s] || 0}`));
    spaceStatus.watch(buttons);
    setChildren(spaceRow, el("span", {class: "label"}, "Stereotaxic space: "), buttons, spaceStatus.element);
  };

  const drawN = () => {
    const ns = ctx.ann.nsubjects || {value: null, values: [], mine: null};
    const summary = ns.value === null || typeof ns.value === "undefined" ? "unknown" : String(ns.value);
    const others = (ns.values || []).map((v) => `${v.n} (${v.count})`).join(", ");
    const parts = [el("span", {class: "label"}, "Number of subjects: "), el("span", {class: "value"}, summary)];
    if (others) {
      parts.push(el("span", {class: "muted"}, ` votes: ${others}`));
    }
    if (ctx.canWrite()) {
      input.value = ns.mine === null || typeof ns.mine === "undefined" ? "" : String(ns.mine);
      const save = el("button", {type: "button", class: "vote", onclick: () => {
        const n = parseSubjects(input.value);
        if (n === null) {
          nStatus.error({code: 142, message: "enter a whole number between 1 and 100000"});

          return;
        }
        setN(n);
      }}, "Save");
      const buttons = [save];
      if (ns.mine !== null && typeof ns.mine !== "undefined") {
        buttons.push(el("button", {type: "button", class: "vote retract", onclick: () => setN(null)}, "Retract"));
      }
      nStatus.watch([...buttons, input]);
      parts.push(" ", input, buttons, nStatus.element);
    }
    setChildren(nRow, parts);
  };

  const update = () => {
    drawSpace();
    drawN();
  };
  ctx.subscribe(update);
  update();

  return root;
};
