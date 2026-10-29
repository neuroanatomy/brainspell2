/**
 * Theme switch. The look of the site is defined by tokens (css/theme.css); a theme is a file that overrides
 * tokens under :root[data-theme="<name>"] (css/theme-light.css). This module only sets that attribute:
 *
 *   ?theme=light   use the light theme and remember it (localStorage, key "brainspell-theme")
 *   ?theme=dark    back to the default (dark) and forget the choice
 *
 * Without a parameter the remembered choice is used; the default is dark. Every page loads this module.
 * Storage may be blocked or absent (private windows): every access is in try/catch and the page works
 * without it. Loaded as a module it runs after the HTML is parsed, so a light page may flash dark once.
 */

export const KEY = "brainspell-theme";
export const THEMES = ["dark", "light"];
export const DEFAULT_THEME = "dark";

const read = (storage) => {
  try {
    return storage.getItem(KEY);
  } catch (err) {
    return null;
  }
};

const write = (storage, value) => {
  try {
    if (value === null) {
      storage.removeItem(KEY);
    } else {
      storage.setItem(KEY, value);
    }
  } catch (err) {
    // blocked storage: the choice just lasts for this page
  }
};

/** Which theme to use: the URL parameter, else the remembered one, else the default. */
export const chooseTheme = (search, storage) => {
  const asked = new URLSearchParams(search || "").get("theme");
  if (THEMES.includes(asked)) {
    return {theme: asked, remember: asked === DEFAULT_THEME ? null : asked, fromUrl: true};
  }
  const stored = storage ? read(storage) : null;

  return {theme: THEMES.includes(stored) ? stored : DEFAULT_THEME, remember: undefined, fromUrl: false};
};

/** Apply the theme to <html> and return its name. */
export const init = ({search, storage, root} = {}) => {
  const s = typeof search === "undefined" ? (typeof location !== "undefined" ? location.search : "") : search;
  let st = storage;
  if (typeof st === "undefined") {
    try {
      st = typeof localStorage !== "undefined" ? localStorage : null;
    } catch (err) {
      st = null; // accessing localStorage can throw when it is blocked
    }
  }
  const r = root || (typeof document !== "undefined" ? document.documentElement : null);
  const choice = chooseTheme(s, st);
  if (choice.fromUrl && st) {
    write(st, choice.remember);
  }
  if (r) {
    r.setAttribute("data-theme", choice.theme);
  }

  return choice.theme;
};

if (typeof document !== "undefined" && !globalThis.__noAutostart) {
  init();
}
