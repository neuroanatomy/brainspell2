/**
 * "Add article" (plan 4.3 addArticle), registered through hooks.registerMissingArticle: shown by
 * article.js when the PMID is not in the database. Anonymous visitors are asked to log in; logged-in
 * users get a form with the PMID (read-only) and the number of stereotaxic tables.
 */
import {el, setChildren} from "./dom.js";
import {createStatus, describeError} from "./context.js";
import * as api from "./api.js";
import * as session from "./session.js";
import * as hooks from "./hooks.js";

export const MAX_TABLES = 50;
export const INDEX_NOTE = "Article added, but search indexing is pending; it may not be found by search yet.";

/** Text of the "Number of stereotaxic tables" field -> integer 0..50 or null. */
export const parseNTables = (s) => {
  const t = String(s === null || typeof s === "undefined" ? "" : s).trim();
  if (!/^\d{1,3}$/.test(t)) {
    return null;
  }
  const n = Number(t);

  return n >= 0 && n <= MAX_TABLES ? n : null;
};

export const validPmid = (pmid) => /^\d{1,9}$/.test(String(pmid));

/** Message for an addArticle error; null for 137 (the caller reloads). */
export const addArticleError = (err) => {
  switch (err && err.code) {
  case 137: return "This article was added meanwhile; reloading";
  case 1002: return "PubMed has no record for this PMID or is unavailable";
  default: return describeError(err);
  }
};

/**
 * deps: {call, user, subscribeUser, reload}
 */
export const renderAddArticle = (container, pmid, deps) => {
  const {call, user} = deps;
  const status = createStatus();
  let busy = false;

  const submit = async (nInput) => {
    if (busy) {
      return;
    }
    const n = parseNTables(nInput.value);
    if (!validPmid(pmid)) {
      status.error({code: 142, message: "the PMID must be a number of up to 9 digits"});

      return;
    }
    if (n === null) {
      status.error({code: 142, message: `the number of tables must be a whole number between 0 and ${MAX_TABLES}`});

      return;
    }
    busy = true;
    status.clear();
    status.pending(true);
    let res;
    try {
      res = await call("addArticle", {pmid: String(pmid), nTables: n});
    } catch (err) {
      busy = false;
      status.pending(false);
      status.error({code: err && err.code, message: addArticleError(err)});
      if (err && err.code === 137) {
        deps.reload();
      }

      return;
    }
    status.element.className = "ann-status";
    if (res && res.indexed === false) {
      // Solr was unavailable: tell the user, then reload after OK or after a few seconds
      let done = false;
      const finish = () => {
        if (!done) {
          done = true;
          deps.reload();
        }
      };
      setChildren(status.element, INDEX_NOTE, " ", el("button", {type: "button", class: "te-btn", onclick: finish}, "OK"));
      (deps.setTimer || setTimeout)(finish, deps.noteMs || 4000);

      return;
    }
    setChildren(status.element, "Added; loading the article");
    deps.reload();
  };

  const draw = () => {
    if (!user()) {
      setChildren(container, el("p", {class: "login-hint"}, "This article is not in the database yet. Log in to add it."));

      return;
    }
    const nInput = el("input", {type: "number", id: "add-ntables", min: 0, max: MAX_TABLES, step: 1, value: "1", class: "add-ntables"});
    const btn = el("button", {type: "button", class: "te-btn", onclick: () => submit(nInput)}, "Add article");
    status.watch([btn, nInput]);
    nInput.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") {
        ev.preventDefault();
        submit(nInput);
      }
    });
    setChildren(container, el("form", {class: "add-article", onsubmit: (ev) => ev.preventDefault()},
      el("p", null, "This article is not in the database yet. You can add it: its title, authors and abstract are fetched from PubMed."),
      el("p", null, el("label", {for: "add-pmid"}, "PMID "),
        el("input", {type: "text", id: "add-pmid", value: String(pmid), readOnly: true, size: 10})),
      el("p", null, el("label", {for: "add-ntables"}, "Number of stereotaxic tables "), nInput,
        el("span", {class: "muted"}, ` (0 to ${MAX_TABLES}; empty tables you fill in afterwards)`)),
      el("p", null, btn, status.element)));
  };

  if (deps.subscribeUser) {
    deps.subscribeUser(() => {
      if (!busy) {
        draw();
      }
    });
  }
  draw();

  return {draw};
};

export const register = () => {
  hooks.registerMissingArticle((container, pmid) => {
    renderAddArticle(container, pmid, {
      call: api.call,
      user: session.current,
      subscribeUser: session.onChange,
      reload: () => globalThis.location.reload()
    });
  });
};
