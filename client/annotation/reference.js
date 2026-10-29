/**
 * The journal part of a reference ("Hum Brain Mapp 26(2):128-38" in "Humphries C, Love T (2005) Hum Brain Mapp
 * 26(2):128-38") is a link to the paper through its DOI. The DOI comes from the database, so it is validated and
 * percent-encoded here and only ever used as a URL attribute (never as HTML).
 */
import {el, text, isSafeUrl, decodeEntities} from "./dom.js";

const PREFIX = /^(?:doi:\s*|https?:\/\/(?:dx\.)?doi\.org\/)/i;
const SHAPE = /^10\.\d{4,9}\/\S+$/;
const YEAR = /^(.*?\(\d{4}\)\s+)(.+)$/s;

/** The DOI without whitespace or a doi:/doi.org prefix, or null when it is not a DOI (placeholders such as "Temporary DOI", empty, ...). */
export const normaliseDoi = (doi) => {
  if (typeof doi !== "string") {
    return null;
  }
  const d = doi.trim().replace(PREFIX, "").trim();

  return SHAPE.test(d) ? d : null;
};

/** https://doi.org/<DOI> with everything that could leave the path percent-encoded; null for an invalid DOI. */
export const doiHref = (doi) => {
  const d = normaliseDoi(doi);
  if (!d) {
    return null;
  }
  const href = `https://doi.org/${encodeURI(d).replace(/#/g, "%23").replace(/\?/g, "%3F")}`;

  return isSafeUrl(href) ? href : null;
};

/**
 * {before, linkText, href}: the text before the link, the text of the link, the URL (null: no link, `before` is the whole
 * reference). The link is the part after the "(YYYY) " year group, or the whole reference when there is none.
 */
export const referenceParts = (reference, doi) => {
  const ref = reference === null || typeof reference === "undefined" ? "" : String(reference);
  const href = doiHref(doi);
  if (!href || ref.trim() === "") {
    return {before: ref, linkText: "", href: null};
  }
  const m = YEAR.exec(ref);

  return m ? {before: m[1], linkText: m[2], href} : {before: "", linkText: ref, href};
};

const norm = (s) => String(s || "").toLowerCase().replace(/et al\.?/g, "").replace(/[^\p{L}\p{N}]/gu, "");

/** True when the reference is nothing but (a start of) the author list. */
const repeatsAuthors = (ref, authors) => {
  const n = norm(ref);
  const a = norm(authors);

  return n === "" || (a !== "" && (a.startsWith(n) || n.startsWith(a)));
};

/**
 * What to show under the authors on the article page. In the database the reference already starts with the (abbreviated)
 * author list: "Berkowitz AL, Ansari D (2008) Neuroimage 41(2):535-43". The citation is the part from the "(YYYY)" group on, with the
 * DOI link on what follows the year. Without a year group the whole reference is shown, unless it only repeats the authors.
 * Empty or "()" gives nothing ({before: "", linkText: "", href: null}).
 */
export const citationParts = (reference, doi, authors) => {
  const ref = reference === null || typeof reference === "undefined" ? "" : String(reference).trim();
  const none = {before: "", linkText: "", href: null};
  if (/^[()\s]*$/.test(ref)) {
    return none;
  }
  const m = /\(\d{4}\)/.exec(ref);
  if (m) {
    return referenceParts(ref.slice(m.index), doi);
  }

  return repeatsAuthors(ref, authors) ? none : referenceParts(ref, doi);
};

const partsToNodes = (p) => {
  if (!p.href) {
    return p.before ? [text(p.before)] : [];
  }

  return [text(p.before), linkNode(p)];
};

const linkNode = (p) => el("a", {
  class: "ref-link",
  href: p.href,
  target: "_blank",
  rel: "noopener noreferrer",
  title: "Open the paper via its DOI (doi.org)",
  "aria-label": `${p.linkText} (opens the paper via its DOI in a new tab)`
}, p.linkText);

/** Nodes of the citation line of the article page (entities decoded and markup dropped first); [] when there is nothing to show. */
export const citationNodes = (rawReference, doi, rawAuthors) =>
  partsToNodes(citationParts(decodeEntities(rawReference), doi, decodeEntities(rawAuthors)));

/** Child nodes for a reference (already plain text). */
export const referenceNodesFromText = (reference, doi) => {
  const ref = reference === null || typeof reference === "undefined" ? "" : String(reference);
  if (/^[()\s]*$/.test(ref)) {
    return []; // empty or "()": nothing to show
  }

  return partsToNodes(referenceParts(ref, doi));
};

/** Child nodes for a reference as it comes from the database: entities decoded and markup dropped first. */
export const referenceNodes = (rawReference, doi) => referenceNodesFromText(decodeEntities(rawReference), doi);
