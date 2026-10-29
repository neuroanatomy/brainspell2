/**
 * Safe DOM construction. Nothing in the client may put database or user content in the page
 * with innerHTML or template strings: build nodes with el() and text() instead.
 */

let doc = typeof document !== "undefined" ? document : null;

/** Replace the document used to create nodes (tests only). */
export const setDocument = (d) => {
  doc = d;
};

const PROPS = new Set(["disabled", "value", "checked", "hidden", "selected", "readOnly"]);
const FORBIDDEN = new Set(["innerHTML", "outerHTML", "srcdoc"]);
const URL_ATTRS = new Set(["href", "src", "action", "formaction", "xlink:href"]);

/**
 * Only relative URLs, anchors, mailto and http(s) are accepted in URL attributes
 * (rejects javascript:, data:, vbscript:).
 */
export const isSafeUrl = (u) => {
  const s = String(u).replace(/[\u0000- \u007f-\u009f]/g, "");
  const m = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(s);

  return !m || ["http", "https", "mailto"].includes(m[1].toLowerCase());
};

/** A text node. null and undefined give an empty text node. */
export const text = (s) => doc.createTextNode(s === null || typeof s === "undefined" ? "" : String(s));

const isNode = (c) => c && typeof c === "object" && typeof c.nodeType === "number";

const append = (parent, child) => {
  if (child === null || typeof child === "undefined" || child === false || child === true) {
    return;
  }
  if (Array.isArray(child)) {
    child.forEach((c) => append(parent, c));
  } else if (isNode(child)) {
    parent.appendChild(child);
  } else {
    parent.appendChild(text(child));
  }
};

/**
 * el("button", {class: "x", onclick: fn, disabled: true}, "label", childNode, [more])
 * Strings and numbers become text nodes. Event handlers are given as on<event> functions.
 */
export const el = (tag, attrs, ...children) => {
  const node = doc.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || typeof v === "undefined" || v === false && !PROPS.has(k)) {
      continue;
    }
    if (FORBIDDEN.has(k)) {
      throw new Error(`dom.el: attribute ${k} is not allowed`);
    }
    if (k.startsWith("on")) {
      if (typeof v !== "function") {
        throw new Error(`dom.el: ${k} must be a function`);
      }
      node.addEventListener(k.slice(2).toLowerCase(), v);
    } else if (k === "class") {
      node.className = String(v);
    } else if (PROPS.has(k)) {
      node[k] = v;
    } else if (k === "dataset") {
      for (const [dk, dv] of Object.entries(v)) {
        node.setAttribute(`data-${dk}`, String(dv));
      }
    } else if (URL_ATTRS.has(k) && !isSafeUrl(v)) {
      throw new Error(`dom.el: unsafe URL in ${k}`);
    } else {
      node.setAttribute(k, v === true ? "" : String(v));
    }
  }
  children.forEach((c) => append(node, c));

  return node;
};

/** Remove the children of node and put new ones. */
export const setChildren = (node, ...children) => {
  node.replaceChildren();
  children.forEach((c) => append(node, c));

  return node;
};

/**
 * Decode HTML entities and drop markup with an inert parser (DOMParser never runs scripts or
 * loads resources), e.g. "&lt;i&gt;a&lt;/i&gt; <b>b</b>" gives "<i>a</i> b". The result is plain text
 * and must be inserted with text()/textContent.
 */
export const decodeEntities = (s) => {
  if (s === null || typeof s === "undefined") {
    return "";
  }
  const parsed = new DOMParser().parseFromString(String(s), "text/html");

  if (parsed.querySelectorAll) {
    parsed.querySelectorAll("script, style, template").forEach((n) => n.remove());
  }

  return parsed.documentElement.textContent || "";
};

/** decodeEntities, then a text node. */
export const decoded = (s) => text(decodeEntities(s));

/**
 * Decode ONLY character references ("&amp;", "&lt;", "&#233;"...); nothing is treated as markup. For text
 * the user can edit (experiment titles and captions): "Faces<Houses contrast" stays as it is, "&lt;b&gt;"
 * becomes the text "<b>". Every "<" is escaped before the inert parser sees the string, so no tag can form.
 */
export const decodeEntitiesOnly = (s) => {
  if (s === null || typeof s === "undefined") {
    return "";
  }
  const parsed = new DOMParser().parseFromString(String(s).replace(/</g, "&lt;"), "text/html");

  return parsed.documentElement.textContent || "";
};

/** decodeEntitiesOnly, then a text node. */
export const decodedOnly = (s) => text(decodeEntitiesOnly(s));

/**
 * What to store for text typed by the user so that decodeEntitiesOnly gives back exactly the typed text:
 * "&" becomes "&amp;" ("<" needs no encoding).
 */
export const encodeUserText = (s) => String(s).replace(/&/g, "&amp;");
