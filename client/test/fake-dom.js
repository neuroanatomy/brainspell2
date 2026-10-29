/**
 * A minimal DOM stand-in for tests: just what annotation/*.js and article.js use.
 * Elements never parse HTML, so anything that reached the page as markup would show up
 * as a tag name; database content must only ever appear in text nodes.
 */
export class FNode {
  constructor(nodeType, tagName, data) {
    this.nodeType = nodeType;
    this.tagName = tagName ? tagName.toUpperCase() : null;
    this.data = data;
    this.childNodes = [];
    this.attrs = {};
    this.listeners = {};
    this.parentNode = null;
    this.hidden = false;
    this.disabled = false;
    this.value = "";
    this.style = {};
  }

  get children() { return this.childNodes.filter((c) => c.nodeType === 1); }
  get className() { return this.attrs.class || ""; }
  set className(v) { this.attrs.class = String(v); }
  get classList() {
    const self = this;

    return {
      add: (c) => { const s = new Set(self.className.split(/\s+/).filter(Boolean)); s.add(c); self.className = [...s].join(" "); },
      remove: (c) => { self.className = self.className.split(/\s+/).filter((x) => x && x !== c).join(" "); },
      contains: (c) => self.className.split(/\s+/).includes(c)
    };
  }
  get textContent() {
    if (this.nodeType === 3) { return this.data; }

    return this.childNodes.map((c) => c.textContent).join("");
  }
  set textContent(v) {
    this.childNodes = [];
    if (v !== "") { this.appendChild(new FNode(3, null, String(v))); }
  }
  appendChild(c) {
    if (c.parentNode) { c.parentNode.childNodes.splice(c.parentNode.childNodes.indexOf(c), 1); }
    c.parentNode = this;
    this.childNodes.push(c);

    return c;
  }
  replaceChildren(...nodes) {
    this.childNodes.forEach((c) => { c.parentNode = null; });
    this.childNodes = [];
    nodes.forEach((n) => this.appendChild(typeof n === "string" ? new FNode(3, null, n) : n));
  }
  remove() { if (this.parentNode) { this.parentNode.childNodes.splice(this.parentNode.childNodes.indexOf(this), 1); this.parentNode = null; } }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); }
  /** Fire an event. Disabled buttons do not receive clicks. */
  async dispatch(type, extra = {}) {
    if (type === "click" && this.disabled) { return; }
    const ev = {type, target: this, preventDefault() {}, ...extra};
    for (const fn of this.listeners[type] || []) { await fn(ev); }
    if (type === "click" && this.onclick) { await this.onclick(ev); }
  }
  all(pred, out = []) {
    for (const c of this.childNodes) {
      if (c.nodeType === 1) {
        if (pred(c)) { out.push(c); }
        c.all(pred, out);
      }
    }

    return out;
  }
  byTag(t) { return this.all((n) => n.tagName === t.toUpperCase()); }
  /** Visible buttons whose text contains s (hidden ancestors are skipped). */
  buttons(s) {
    const visible = (n) => { for (let x = n; x; x = x.parentNode) { if (x.hidden) { return false; } } return true; };

    return this.all((n) => n.tagName === "BUTTON" && visible(n) && (s === undefined || n.textContent.includes(s)));
  }
  findClass(c) { return this.all((n) => n.classList.contains(c)); }
}

export const makeDocument = () => {
  const ids = {};
  const doc = {
    createElement: (t) => new FNode(1, t),
    createTextNode: (s) => new FNode(3, null, String(s)),
    getElementById: (id) => ids[id] || null,
    getElementsByTagName: () => ({item: () => new FNode(1, "html")}),
    documentElement: new FNode(1, "html"),
    register: (id, node) => { ids[id] = node; return node; }
  };
  doc.documentElement.hasAttribute = () => false;

  return doc;
};

/** let pending promises (microtasks and 0 ms timers) run */
export const flush = async (n = 5) => {
  for (let i = 0; i < n; i++) { await new Promise((r) => setTimeout(r, 0)); }
};
