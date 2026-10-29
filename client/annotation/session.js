/* global Parse, hello */
/**
 * Who is logged in. The identity shown in the UI always comes from the server's me() function,
 * never from the browser.
 *
 *   init()       restore on page load: Parse.User.current(), then verify with me()
 *   current()    -> {id, login} | null
 *   onChange(cb) cb(user) when the user changes; returns an unsubscribe function
 *   logout()
 *   refresh()    ask me() again (used by login.js right after a successful link)
 */

import * as api from "./api.js";

let user = null;
let initPromise = null;
const listeners = new Set();

const set = (u) => {
  const same = (u && u.id) === (user && user.id) && (u && u.login) === (user && user.login);
  user = u;
  if (!same) {
    listeners.forEach((cb) => {
      try {
        cb(user);
      } catch (err) {
        console.log("session listener failed", err);
      }
    });
  }
};

export const current = () => user;

export const onChange = (cb) => {
  listeners.add(cb);

  return () => listeners.delete(cb);
};

const hasParse = () => typeof Parse !== "undefined" && Parse.User && !api.isMock();

/**
 * Best effort: remove authData (it contains the GitHub access token) from the copy of the user that
 * the Parse SDK keeps in localStorage ("Parse/<appId>/currentUser"). Returns the number of entries changed.
 * Not possible: the SDK keeps the same object in memory (Parse.User.current().get("authData")) for the life of
 * the page, and rewrites the stored copy whenever it saves the current user; so this is repeated on every
 * page load and after every link. See docs/manual-tests-annotation.md.
 */
export const stripStoredToken = (storage) => {
  let changed = 0;
  try {
    const st = storage || (typeof localStorage !== "undefined" ? localStorage : null);
    if (!st) {
      return 0;
    }
    const keys = [];
    for (let i = 0; i < st.length; i++) {
      keys.push(st.key(i));
    }
    for (const k of keys) {
      if (!/^Parse\/[^/]+\/currentUser$/.test(k)) {
        continue;
      }
      const json = JSON.parse(st.getItem(k));
      if (json && typeof json === "object" && "authData" in json) {
        delete json.authData;
        st.setItem(k, JSON.stringify(json));
        changed++;
      }
    }
  } catch (err) {
    console.log("could not clean the stored user", err);
  }

  return changed;
};

/** hello.js keeps its own copy of the GitHub token in localStorage ("hello"); the app does not need it after the link. */
export const forgetHelloSession = () => {
  try {
    if (typeof hello !== "undefined") {
      hello("github").logout();
    }
  } catch (err) {
    console.log("could not clear the hello session", err);
  }
};

const clearLocal = async () => {
  if (hasParse()) {
    try {
      await Parse.User.logOut();
    } catch (err) {
      console.log("logOut failed", err);
    }
  }
  set(null);
};

/** Ask the server who we are. Dead session (206, 209) or no GitHub identity: logged out. */
export const refresh = async () => {
  if (!api.isMock() && !(hasParse() && Parse.User.current())) {
    set(null);

    return null;
  }
  try {
    const me = await api.call("me");
    if (!me) {
      await clearLocal();

      return null;
    }
    set({id: me.id, login: me.login});
    if (hasParse()) {
      stripStoredToken();
    }

    return user;
  } catch (err) {
    if (err.code === 206 || err.code === 209) {
      await clearLocal();
    } else {
      // network or server trouble: show the logged-out UI but keep the stored session for the next load
      console.log("me() failed", err);
      set(null);
    }

    return null;
  }
};

export const init = () => {
  if (!initPromise) {
    api.onSessionExpired(() => {
      clearLocal();
    });
    initPromise = refresh();
  }

  return initPromise;
};

export const logout = async () => {
  if (api.isMock()) {
    (await api.getMockBackend()).logout();
    set(null);

    return;
  }
  await clearLocal();
  forgetHelloSession();
};

/** tests only */
export const _reset = () => {
  user = null;
  initPromise = null;
  listeners.clear();
};
