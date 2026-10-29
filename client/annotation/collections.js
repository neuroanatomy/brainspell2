/**
 * Article collections (F8): a small client for listCollections / saveCollection / deleteCollection
 * (plan 4.3) and the UI pieces used by the search page and the collections page.
 * Nothing here uses innerHTML: nodes are built with dom.js only.
 *
 * Server limits (plan 4.3): 50 collections per user, 2000 articles per collection, at most
 * 2000 PMIDs in one add/remove list, 1..100 characters for a name.
 */
import * as api from "./api.js";
import * as session from "./session.js";
import {el, setChildren} from "./dom.js";
import {describeError} from "./context.js";

export const MAX_PER_CALL = 2000;
export const MAX_COLLECTIONS = 50;
export const MAX_NAME = 100;

// ---- pure helpers ----

/** Split a list in chunks of at most n items. */
export const chunk = (list, n) => {
  const out = [];
  for (let i = 0; i < list.length; i += n) {
    out.push(list.slice(i, i + n));
  }

  return out;
};

/** Trimmed collection name if it is acceptable (1..100 characters), else null. */
export const validName = (s) => {
  const t = String(s === null || typeof s === "undefined" ? "" : s).trim();

  return t.length >= 1 && t.length <= MAX_NAME ? t : null;
};

/** Parameters of saveCollection: id (existing) or name (new), add / remove lists of PMIDs (empty lists omitted). */
export const buildSaveParams = ({id, name, add, remove} = {}) => {
  const p = {};
  if (id) {
    p.id = id;
  }
  if (typeof name !== "undefined" && name !== null) {
    p.name = name;
  }
  if (add && add.length) {
    p.add = [...add];
  }
  if (remove && remove.length) {
    p.remove = [...remove];
  }

  return p;
};

/** null if n PMIDs can go in one call, else the message to show. */
export const limitMessage = (n) =>
  n > MAX_PER_CALL ? `You selected ${n} articles; at most ${MAX_PER_CALL} can be added at once. Deselect some and try again.` : null;

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** "Added 7 articles to X" (and how many were there already). */
export const addedMessage = (requested, before, after, name) => {
  const had = new Set(before);
  const added = after.filter((p) => !had.has(p)).length;
  const already = Math.max(requested - added, 0);

  return `Added ${plural(added, "article")} to ${name}` + (already ? ` (${already} already in it)` : "");
};

/** The set of PMIDs selected in a list of results. */
export const createSelection = () => {
  const set = new Set();
  const subs = new Set();
  const notify = () => subs.forEach((fn) => fn());

  return {
    has: (p) => set.has(p),
    size: () => set.size,
    list: () => [...set],
    set: (p, on) => {
      if (on) {
        set.add(p);
      } else {
        set.delete(p);
      }
      notify();
    },
    setMany: (pmids, on) => {
      pmids.forEach((p) => (on ? set.add(p) : set.delete(p)));
      notify();
    },
    clear: () => {
      set.clear();
      notify();
    },
    subscribe: (fn) => {
      subs.add(fn);

      return () => subs.delete(fn);
    }
  };
};

// ---- server calls ----

export const listCollections = (call = api.call) => call("listCollections", {});
export const saveCollection = (params, call = api.call) => call("saveCollection", params);
export const deleteCollection = (id, call = api.call) => call("deleteCollection", {id});

// ---- header link (shared with article.html) ----

/** Show #collections-link only while somebody is logged in. Safe to call when the link is absent. */
export const initHeaderLink = () => {
  const link = typeof document !== "undefined" ? document.getElementById("collections-link") : null;
  if (!link) {
    return () => {};
  }
  const update = (user) => {
    link.hidden = !user;
  };
  update(session.current());

  return session.onChange(update);
};

// ---- add to collection (search results) ----

/**
 * The "Add to collection" button with its menu.
 *   selection   createSelection()
 *   call        (name, params) -> Promise, default api.call
 * Returns {element, close}. The menu lists the collections (fetched each time it opens) and
 * "Create new collection...", which asks the name with an in-page input.
 */
export const createAddMenu = ({selection, call = api.call}) => {
  const status = el("span", {class: "col-status", role: "status", "aria-live": "polite"});
  const panel = el("div", {class: "col-menu", hidden: true});
  const button = el("button", {type: "button", class: "col-add-button", disabled: true}, "Add to collection");
  const element = el("span", {class: "col-add"}, button, " ", status, panel);
  let busy = false;

  const say = (cls, msg) => {
    status.className = `col-status ${cls}`.trim();
    setChildren(status, msg);
  };
  const close = () => {
    panel.hidden = true;
  };
  const sync = () => {
    button.disabled = busy || selection.size() === 0;
    button.textContent = selection.size() ? `Add to collection (${selection.size()})` : "Add to collection";
  };
  selection.subscribe(sync);

  const save = async (params, name, before) => {
    const requested = params.add.length;
    busy = true;
    sync();
    say("pending", "Saving…");
    try {
      const res = await call("saveCollection", params);
      say("ok", addedMessage(requested, before, res.pmids || [], res.name || name));
      close();
      selection.clear();
    } catch (err) {
      say("error", describeError(err));
    }
    busy = false;
    sync();
  };

  const showCreate = (cols) => {
    const input = el("input", {type: "text", class: "col-name", maxlength: String(MAX_NAME), placeholder: "Collection name"});
    const create = async () => {
      const name = validName(input.value);
      if (!name) {
        say("error", `The name must have 1 to ${MAX_NAME} characters.`);

        return;
      }
      close();
      await save(buildSaveParams({name, add: selection.list()}), name, []);
    };
    const ok = el("button", {type: "button", onclick: create}, "Create");
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        create();
      }
    });
    setChildren(panel,
      el("label", null, "New collection: ", input), " ", ok, " ",
      el("button", {type: "button", onclick: () => showList(cols)}, "Back"));
    if (input.focus) {
      input.focus();
    }
  };

  const showList = (cols) => {
    const atLimit = cols.length >= MAX_COLLECTIONS;
    setChildren(panel,
      el("ul", {class: "col-menu-list"},
        cols.map((c) => el("li", null,
          el("button", {
            type: "button",
            class: "col-choice",
            onclick: async () => {
              close();
              await save(buildSaveParams({id: c.id, add: selection.list()}), c.name, c.pmids || []);
            }
          }, c.name, " ", el("span", {class: "muted"}, `(${(c.pmids || []).length})`)))),
        el("li", null, el("button", {
          type: "button",
          class: "col-new",
          disabled: atLimit,
          title: atLimit ? `At most ${MAX_COLLECTIONS} collections` : null,
          onclick: () => showCreate(cols)
        }, "Create new collection..."))),
      cols.length ? null : el("p", {class: "muted"}, "You have no collections yet."));
  };

  button.addEventListener("click", async () => {
    if (!panel.hidden) {
      close();

      return;
    }
    const msg = limitMessage(selection.size());
    if (msg) {
      say("error", msg);

      return;
    }
    say("", "");
    try {
      const cols = await call("listCollections", {});
      showList(cols);
      panel.hidden = false;
    } catch (err) {
      say("error", describeError(err));
    }
  });

  sync();

  return {element, close};
};

// ---- selection on the search results ----

/** The (empty) place of the checkbox, first child of each result item. */
export const selectSlot = () => el("span", {class: "col-select"});

/**
 * Checkboxes next to the results, "select all / none" and the add menu, for logged-in users only.
 *   list     the <ol> of results; items carry data-pmid
 *   toolbar  container for "select all / none", the counter and the menu (hidden for anonymous users)
 * Each item is an <li data-pmid="..."> that starts with selectSlot() (an empty span the checkbox goes into,
 * so anonymous visitors see nothing). Call refresh() after items were added to the list. The selection survives appends and logins.
 */
export const mountSearchSelection = ({list, toolbar, call = api.call}) => {
  const selection = createSelection();
  const counter = el("span", {class: "col-count muted"});
  const all = el("button", {type: "button"}, "Select all");
  const none = el("button", {type: "button"}, "Select none");
  const menu = createAddMenu({selection, call});
  const boxes = new Map(); // pmid -> checkbox
  const items = () => list.children.filter((li) => li.getAttribute("data-pmid"));

  const sync = () => {
    boxes.forEach((box, pmid) => {
      box.checked = selection.has(pmid);
    });
    setChildren(counter, selection.size() ? `${plural(selection.size(), "article")} selected` : "");
  };
  selection.subscribe(sync);

  all.addEventListener("click", () => selection.setMany(items().map((li) => li.getAttribute("data-pmid")), true));
  none.addEventListener("click", () => selection.clear());
  setChildren(toolbar, all, " ", none, " ", counter, " ", menu.element);

  const refresh = () => {
    const user = session.current();
    toolbar.hidden = !user;
    for (const li of items()) {
      const pmid = li.getAttribute("data-pmid");
      const slot = li.children.find((c) => c.classList.contains("col-select"));
      if (!slot) {
        continue;
      }
      if (!user) {
        setChildren(slot);
        boxes.delete(pmid);
        continue;
      }
      if (slot.children.length) {
        continue;
      }
      const box = el("input", {
        type: "checkbox",
        class: "col-box",
        "aria-label": `Select article ${pmid}`,
        checked: selection.has(pmid),
        onchange: (e) => selection.set(pmid, !!e.target.checked)
      });
      boxes.set(pmid, box);
      setChildren(slot, box);
    }
    sync();
  };

  session.onChange(() => {
    if (!session.current()) {
      menu.close();
    }
    refresh();
  });
  refresh();

  return {selection, refresh};
};
