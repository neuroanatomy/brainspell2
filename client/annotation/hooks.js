/**
 * Integration points for later work packages (plan 4.5). WP5 registers table editing and the
 * "add article" flow here; article.js calls them.
 *
 *   registerExperimentTools(fn)  fn(experimentContainer, experiment, {pmid, rev, reload})
 *                                is called for each rendered experiment (also empty ones when logged in)
 *   registerMissingArticle(fn)   fn(container, pmid) is called when the PMID is not in the database
 */
const experimentTools = [];
const missingArticle = [];

export const registerExperimentTools = (fn) => {
  experimentTools.push(fn);
};

export const registerMissingArticle = (fn) => {
  missingArticle.push(fn);
};

const safely = (name, fn, args) => {
  try {
    fn(...args);
  } catch (err) {
    console.log(`hook ${name} failed`, err);
  }
};

/** Called by article.js. A failing hook never breaks the page. */
export const runExperimentTools = (container, experiment, info) => {
  experimentTools.forEach((fn) => safely("experimentTools", fn, [container, experiment, info]));
};

/** Called by article.js. Returns true if at least one hook is registered. */
export const runMissingArticle = (container, pmid) => {
  missingArticle.forEach((fn) => safely("missingArticle", fn, [container, pmid]));

  return missingArticle.length > 0;
};

/** tests only */
export const _clear = () => {
  experimentTools.length = 0;
  missingArticle.length = 0;
};
