// Enforces the rules of css/README.md: theme.css is the only place with look-and-feel values.
import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync, readdirSync} from "node:fs";

const dir = new URL("../css/", import.meta.url);
const read = (f) => readFileSync(new URL(f, dir), "utf8");
const strip = (css) => css.replace(/\/\*[\s\S]*?\*\//g, "");
const LAYERS = ["base.css", "components.css", "layout.css"];

/** Flat list of {selector, decls: [{prop, value}]} (at-rules are flattened). */
const parse = (css) => {
  const out = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  const text = strip(css);
  while ((m = re.exec(text))) {
    const selector = m[1].trim();
    const decls = m[2].split(";").map((d) => d.trim()).filter(Boolean).map((d) => {
      const i = d.indexOf(":");

      return {prop: d.slice(0, i).trim(), value: d.slice(i + 1).trim()};
    });
    out.push({selector, decls});
  }

  return out;
};

/** Remove every var(...) call (balanced). */
const withoutVars = (v) => {
  let s = v;
  for (;;) {
    const i = s.indexOf("var(");
    if (i < 0) { return s; }
    let depth = 0;
    let j = i + 3;
    for (; j < s.length; j++) {
      if (s[j] === "(") { depth++; } else if (s[j] === ")" && --depth === 0) { break; }
    }
    s = s.slice(0, i) + s.slice(j + 1);
  }
};

const NAMED = new Set(("aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown burlywood cadetblue " +
  "chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan darkgoldenrod darkgray darkgreen darkgrey darkkhaki " +
  "darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen darkslateblue darkslategray darkslategrey darkturquoise " +
  "darkviolet deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite gold goldenrod " +
  "gray green greenyellow grey honeydew hotpink indianred indigo ivory khaki lavender lavenderblush lawngreen lemonchiffon lightblue " +
  "lightcoral lightcyan lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen lightskyblue lightslategray " +
  "lightslategrey lightsteelblue lightyellow lime limegreen linen magenta maroon mediumaquamarine mediumblue mediumorchid mediumpurple " +
  "mediumseagreen mediumslateblue mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream mistyrose moccasin navajowhite navy " +
  "oldlace olive olivedrab orange orangered orchid palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum " +
  "powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown seagreen seashell sienna silver skyblue slateblue " +
  "slategray slategrey snow springgreen steelblue tan teal thistle tomato turquoise violet wheat white whitesmoke yellow yellowgreen").split(" "));
const COLOUR_PROPS = /^(color|background(-color|-image)?|border(-top|-right|-bottom|-left)?(-color)?|outline(-color)?|box-shadow|text-shadow|fill|stroke|caret-color|accent-color|text-decoration(-color)?|column-rule(-color)?)$/;
const SIZE_PROPS = /^(font-size|margin(-top|-right|-bottom|-left)?|padding(-top|-right|-bottom|-left)?|gap|row-gap|column-gap|top|right|bottom|left)$/;

test("theme.css defines the tokens; the layers contain no hard-coded colour", () => {
  for (const f of LAYERS) {
    for (const {selector, decls} of parse(read(f))) {
      for (const {prop, value} of decls) {
        const v = withoutVars(value).replace(/url\([^)]*\)/g, "");
        assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(v), `${f}: hex colour in "${selector} { ${prop}: ${value} }"`);
        assert.ok(!/\b(rgb|rgba|hsl|hsla|hwb|lab|lch|oklab|oklch|color-mix|color)\(/.test(v), `${f}: colour function in "${selector} { ${prop} }"`);
        if (COLOUR_PROPS.test(prop)) {
          for (const w of v.toLowerCase().split(/[^a-z]+/).filter(Boolean)) {
            assert.ok(!NAMED.has(w), `${f}: named colour "${w}" in "${selector} { ${prop}: ${value} }"`);
          }
        }
      }
    }
  }
});

test("the layers contain no hard-coded font size or spacing (0, 1px, % and tokens are fine)", () => {
  for (const f of LAYERS) {
    for (const {selector, decls} of parse(read(f))) {
      for (const {prop, value} of decls) {
        if (!SIZE_PROPS.test(prop) || /calc\(|min\(|max\(|clamp\(/.test(value) && /var\(/.test(value)) {
          continue;
        }
        const v = withoutVars(value);
        for (const m of v.matchAll(/(-?\d*\.?\d+)(px|rem|em|pt|vh|vw)\b/g)) {
          const ok = Number(m[1]) === 0 || (m[1] === "1" && m[2] === "px");
          assert.ok(ok, `${f}: literal ${m[0]} in "${selector} { ${prop}: ${value} }"`);
        }
      }
    }
  }
});

test("every var(--x) is defined in theme.css", () => {
  const defined = new Set([...strip(read("theme.css")).matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]));
  assert.ok(defined.size > 40);
  for (const f of [...LAYERS, "theme-light.css"]) {
    for (const m of strip(read(f)).matchAll(/var\(\s*(--[a-z0-9-]+)/g)) {
      assert.ok(defined.has(m[1]), `${f}: ${m[1]} is not defined in theme.css`);
    }
  }
  for (const m of strip(read("theme-light.css")).matchAll(/(--[a-z0-9-]+)\s*:/g)) {
    assert.ok(defined.has(m[1]), `theme-light.css overrides unknown token ${m[1]}`);
  }
});

test("theme-light.css only overrides tokens under :root[data-theme=\"light\"]", () => {
  const rules = parse(read("theme-light.css"));
  assert.ok(rules.length >= 1);
  for (const {selector, decls} of rules) {
    assert.equal(selector, ":root[data-theme=\"light\"]");
    for (const {prop} of decls) {
      assert.ok(prop.startsWith("--") || prop === "color-scheme", `theme-light.css sets ${prop}`);
    }
  }
});

test("no !important except in the [hidden] rule", () => {
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".css"))) {
    for (const {selector, decls} of parse(read(f))) {
      for (const {prop, value} of decls) {
        if (/!\s*important/.test(value)) {
          assert.equal(selector, "[hidden]", `${f}: !important in "${selector} { ${prop} }"`);
          assert.equal(prop, "display");
        }
      }
    }
  }
});

test("the css directory holds exactly the layers (no stray legacy files)", () => {
  assert.deepEqual(readdirSync(dir).filter((n) => n.endsWith(".css")).sort(),
    ["base.css", "components.css", "layout.css", "theme-light.css", "theme.css"]);
});

test("every html page links theme, base, components, layout in this order, then theme-light, and loads theme.js", () => {
  const root = new URL("../", import.meta.url);
  for (const page of ["article.html", "collections.html", "index.html", "search.html"]) {
    const html = readFileSync(new URL(page, root), "utf8");
    const links = [...html.matchAll(/<link[^>]*rel="stylesheet"[^>]*href="\/css\/([a-z-]+\.css)"/g)].map((m) => m[1]);
    assert.deepEqual(links, ["theme.css", "base.css", "components.css", "layout.css", "theme-light.css"], page);
    assert.ok(/<script type="module" src="annotation\/theme\.js"><\/script>/.test(html), `${page} loads theme.js`);
    assert.ok(html.indexOf("theme.js") < html.indexOf("<body"), `${page}: theme.js in <head>`);
  }
});

// ---- contrast (WCAG 2.x) of both themes ----------------------------------------------------------------
const tokens = (css) => Object.fromEntries([...strip(css).matchAll(/(--[a-z0-9-]+)\s*:\s*(#[0-9a-fA-F]{3,6})\b/g)].map((m) => [m[1], m[2]]));
const lum = (hex) => {
  let h = hex.slice(1);
  if (h.length === 3) { h = [...h].map((c) => c + c).join(""); }
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));

  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
export const ratio = (a, b) => {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);

  return (x + 0.05) / (y + 0.05);
};

const TEXT = ["--color-text", "--color-text-muted", "--color-link", "--color-vote-agree", "--color-vote-tie", "--color-vote-disagree", "--color-danger", "--color-success"];
const SURFACES = ["--color-bg", "--color-surface", "--color-surface-raised", "--color-field-bg", "--color-control-bg", "--color-selected-bg", "--color-new-row-bg", "--color-header-bg"];
// pairs that do not occur are not required (e.g. coloured text on raised surfaces)
const TEXT_PAIRS = [];
for (const t of ["--color-text", "--color-text-muted"]) { for (const s of SURFACES) { TEXT_PAIRS.push([t, s]); } }
for (const t of ["--color-link", "--color-danger", "--color-success", "--color-vote-agree", "--color-vote-tie", "--color-vote-disagree"]) {
  for (const s of ["--color-bg", "--color-surface", "--color-field-bg", "--color-control-bg"]) { TEXT_PAIRS.push([t, s]); }
}
TEXT_PAIRS.push(["--color-footer-text", "--color-footer-bg"], ["--color-text-on-accent", "--color-primary-bg"], ["--color-text-on-accent", "--color-primary-bg-hover"], ["--color-text", "--color-control-bg-hover"]);
const UI_PAIRS = [];
for (const u of ["--color-border-control", "--color-accent", "--color-focus-ring", "--color-vote-agree", "--color-vote-tie", "--color-vote-disagree"]) {
  for (const s of ["--color-bg", "--color-surface", "--color-field-bg", "--color-control-bg"]) { UI_PAIRS.push([u, s]); }
}
UI_PAIRS.push(["--color-accent", "--color-selected-bg"]);

/** The header logo and icons are white SVGs; --filter-header-icon (none or invert(x)) gives their displayed grey. */
const iconGrey = (css) => {
  const m = /--filter-header-icon:\s*([^;]+);/.exec(strip(css));
  const inv = m && /invert\(([\d.]+)\)/.exec(m[1]);
  const g = Math.round(255 * (1 - (inv ? Number(inv[1]) : 0))).toString(16).padStart(2, "0");

  return `#${g}${g}${g}`;
};

export const contrastTable = () => {
  const dark = tokens(read("theme.css"));
  const light = {...dark, ...tokens(read("theme-light.css"))};
  dark["--icon-header"] = iconGrey(read("theme.css"));
  light["--icon-header"] = iconGrey(read("theme-light.css"));
  const rows = [];
  for (const [name, t] of [["dark", dark], ["light", light]]) {
    for (const [pairs, min, kind] of [[TEXT_PAIRS, 4.5, "text"], [[...UI_PAIRS, ["--icon-header", "--color-header-bg"]], 3, "ui"]]) {
      for (const [a, b] of pairs) {
        rows.push({theme: name, kind, fg: a, bg: b, fgHex: t[a], bgHex: t[b], ratio: ratio(t[a], t[b]), min});
      }
    }
  }

  return rows;
};

test("contrast: text >= 4.5:1 and UI parts >= 3:1 in the dark and the light theme", () => {
  const rows = contrastTable();
  assert.ok(rows.length > 100);
  for (const r of rows) {
    assert.ok(r.fgHex && r.bgHex, `token missing for ${r.fg} / ${r.bg}`);
    assert.ok(r.ratio >= r.min, `${r.theme}: ${r.fg} ${r.fgHex} on ${r.bg} ${r.bgHex} is ${r.ratio.toFixed(2)}:1 (needs ${r.min})`);
  }
  if (process.env.CSS_REPORT) {
    for (const r of rows) { console.log(`${r.theme}\t${r.kind}\t${r.fg} ${r.fgHex}\t${r.bg} ${r.bgHex}\t${r.ratio.toFixed(2)}`); }
  }
});

// ---- no inline styles anywhere (look and feel is central) -----------------------------------------------------
test("html pages have no style attribute, no <style> element and no colour literal in inline SVG", () => {
  const root = new URL("../", import.meta.url);
  for (const page of ["article.html", "collections.html", "index.html", "search.html"]) {
    const html = readFileSync(new URL(page, root), "utf8");
    assert.ok(!/\sstyle\s*=/i.test(html), `${page}: style attribute`);
    assert.ok(!/<style[\s>]/i.test(html), `${page}: <style> element`);
    for (const m of html.matchAll(/\b(fill|stroke|stop-color|flood-color)\s*=\s*"([^"]*)"/gi)) {
      assert.ok(/^(none|currentColor|inherit)$/.test(m[2]), `${page}: ${m[1]}="${m[2]}" (use a class and a token)`);
    }
  }
});

test("page scripts never write a style attribute (blocked by the CSP without 'unsafe-inline')", () => {
  const root = new URL("../", import.meta.url);
  const files = [...readdirSync(new URL("annotation/", root)).filter((f) => f.endsWith(".js")).map((f) => `annotation/${f}`), "article.js", "search.js", "index.js", "collections.js"];
  for (const f of files) {
    const src = readFileSync(new URL(f, root), "utf8");
    assert.ok(!/setAttribute\(\s*["']style["']/.test(src), `${f}: setAttribute("style")`);
    assert.ok(!/\bstyle:\s*["'`]/.test(src), `${f}: style attribute passed to el()`);
    assert.ok(!/\.cssText\b/.test(src), `${f}: cssText`);
  }
});

test("the CSP of the pages does not allow inline styles", () => {
  const root = new URL("../", import.meta.url);
  for (const page of ["article.html", "collections.html", "index.html", "search.html"]) {
    const csp = /http-equiv="Content-Security-Policy" content="([^"]*)"/.exec(readFileSync(new URL(page, root), "utf8"));
    assert.ok(csp, `${page}: CSP meta`);
    const style = /style-src ([^;]*)/.exec(csp[1]);
    assert.ok(style, `${page}: style-src`);
    assert.ok(!style[1].includes("unsafe-inline"), `${page}: style-src allows unsafe-inline`);
  }
});

// ---- stacking: decorative backgrounds must stay behind the content (regression: the blurred SVG covered the results) ----
test("decorative backdrops (svg.backdrop-svg, #background) sit behind the content and ignore the pointer", () => {
  const rules = parse(read("layout.css"));
  for (const sel of ["svg.backdrop-svg", "#background"]) {
    const decls = rules.filter((r) => r.selector === sel).flatMap((r) => r.decls);
    const z = decls.find((d) => d.prop === "z-index");
    assert.ok(z && z.value === "var(--z-backdrop)", `${sel}: z-index must be var(--z-backdrop)`);
    assert.ok(decls.some((d) => d.prop === "pointer-events" && d.value === "none"), `${sel}: pointer-events: none`);
  }
  assert.equal(strip(read("theme.css")).match(/--z-backdrop:\s*(-\d+)/)[1] < 0, true, "--z-backdrop is negative");
});

test("every absolutely or fixed positioned rule in layout.css has an explicit z-index token or is a positioned child of a stacking parent", () => {
  // positioned elements without z-index paint above in-flow content: list them so a new one is a conscious choice
  const known = new Set([".content", "#menu", "svg.backdrop-svg", "#background", "#viewer-info", ".search-box"]);
  for (const {selector, decls} of parse(read("layout.css"))) {
    if (decls.some((d) => d.prop === "position" && /absolute|fixed/.test(d.value))) {
      assert.ok(known.has(selector), `layout.css: new positioned rule "${selector}": check what it overlaps and add it here`);
    }
  }
});

// ---- regression: the search viewer lost its size when the style sheets were consolidated (canvas 840x0) -----------------
test("the search viewer has a CSS-defined size before it starts, and its status line is an overlay", () => {
  const rules = parse(read("layout.css"));
  const decl = (sel, prop) => rules.filter((r) => r.selector === sel).flatMap((r) => r.decls).find((d) => d.prop === prop);
  assert.ok(decl("#viewer", "aspect-ratio") || decl("#viewer", "height"), "#viewer needs aspect-ratio or height");
  assert.ok(decl("#viewer", "width"), "#viewer needs a width");
  assert.equal(decl("#viewer-info", "position").value, "absolute");
  assert.equal(decl("#viewer-info", "pointer-events").value, "none");
  assert.ok(decl("#viewer-info", "z-index"));
});
