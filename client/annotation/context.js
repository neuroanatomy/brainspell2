/**
 * Shared state of the annotation UI of one article page, and small UI helpers shared by votes.js,
 * tags.js, meta.js and comments.js. (Not in the plan's module list: it holds what those modules
 * have in common instead of duplicating it.)
 *
 * The UI is never updated optimistically: a module changes ctx.ann only with the answer of the
 * server, then calls ctx.notify() so every module redraws.
 */
import {el, setChildren} from "./dom.js";

export const createContext = ({pmid, ann, call, user}) => {
  const subs = new Set();
  const ctx = {
    pmid,
    ann,
    call,
    user, // () -> {id, login} | null
    canWrite: () => !!user(),
    subscribe: (fn) => {
      subs.add(fn);

      return () => subs.delete(fn);
    },
    notify: () => subs.forEach((fn) => fn()),
    setAnnotations: (a) => {
      ctx.ann = a;
      ctx.notify();
    }
  };

  return ctx;
};

/** Human message for a mapped error {code, message}. The UI switches on the code only. */
export const describeError = (err) => {
  const msg = err && err.message ? err.message : "";
  switch (err && err.code) {
  case 155: return `Too many actions, please wait. ${msg}`.trim();
  case 142: return `Not accepted: ${msg}`;
  case 206:
  case 209: return "Your session has expired. Please log in again.";
  case 119: return "You are not allowed to do this.";
  case 101: return "Not found.";
  case 100: return "Cannot reach the server.";
  case 1003: return "The server did not answer. Please try again.";
  default: return msg || "Something went wrong.";
  }
};

/**
 * A status line for one action: pending(true/false) and error(err)/clear().
 * pending also disables the given buttons.
 */
export const createStatus = () => {
  const element = el("span", {class: "ann-status", role: "status", "aria-live": "polite"});
  let buttons = [];

  return {
    element,
    watch: (list) => {
      buttons = list;
    },
    pending: (on) => {
      element.className = on ? "ann-status pending" : "ann-status";
      setChildren(element, on ? "Saving…" : "");
      buttons.forEach((b) => {
        b.disabled = on;
      });
    },
    error: (err) => {
      element.className = "ann-status error";
      setChildren(element, describeError(err));
    },
    clear: () => {
      element.className = "ann-status";
      setChildren(element);
    }
  };
};

/** Run an async server action with pending/error handling. Resolves to the result, or undefined on error. */
export const runAction = async (status, fn) => {
  status.clear();
  status.pending(true);
  try {
    const res = await fn();
    status.pending(false);

    return res;
  } catch (err) {
    status.pending(false);
    status.error(err);

    return undefined;
  }
};

/** "Log in to contribute" hint, shown only to anonymous visitors. */
export const loginHint = (ctx) => {
  const element = el("p", {class: "login-hint"}, "Log in to contribute");
  const update = () => {
    element.hidden = ctx.canWrite();
  };
  ctx.subscribe(update);
  update();

  return element;
};
