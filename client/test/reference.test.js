import test from "node:test";
import assert from "node:assert/strict";
import {makeDocument} from "./fake-dom.js";
import {setDocument} from "../annotation/dom.js";
import {readFileSync} from "node:fs";
import {normaliseDoi, doiHref, referenceParts, referenceNodesFromText, referenceNodes, citationParts, citationNodes} from "../annotation/reference.js";

const REF = "Humphries C, Love T, Swinney D, Hickok G (2005) Hum Brain Mapp 26(2):128-38";

test("normaliseDoi: prefixes, whitespace, case", () => {
  assert.equal(normaliseDoi("10.1002/hbm.20201"), "10.1002/hbm.20201");
  assert.equal(normaliseDoi("  10.1002/hbm.20201\n"), "10.1002/hbm.20201");
  assert.equal(normaliseDoi("doi:10.1002/hbm.20201"), "10.1002/hbm.20201");
  assert.equal(normaliseDoi("DOI: 10.1002/hbm.20201"), "10.1002/hbm.20201");
  assert.equal(normaliseDoi("https://doi.org/10.1002/hbm.20201"), "10.1002/hbm.20201");
  assert.equal(normaliseDoi("HTTP://DX.DOI.ORG/10.1002/HBM.20201"), "10.1002/HBM.20201");
  assert.equal(normaliseDoi("10.1002/HBM.20201"), "10.1002/HBM.20201", "uppercase DOIs are valid and kept");
});

test("normaliseDoi rejects everything that is not a DOI", () => {
  for (const bad of [null, undefined, 5, {}, "", "   ", "Temporary DOI", "temporary doi", "javascript:alert(1)", "10.1002", "10.12/abc", "10.1002/", "10.1002/a b",
    "11.1002/abc", "http://evil.example/10.1002/abc", "https://doi.org.evil.example/10.1002/abc", "x10.1002/abc", "10.1002/a\nb"]) {
    assert.equal(normaliseDoi(bad), null, String(bad));
  }
});

test("doiHref: encoded, stays under doi.org, passes isSafeUrl", () => {
  assert.equal(doiHref("10.1002/hbm.20201"), "https://doi.org/10.1002/hbm.20201");
  assert.equal(doiHref("10.1002/(SICI)1097-0193(1999)7:1<1::AID-HBM1>3.0.CO;2-N"), "https://doi.org/10.1002/(SICI)1097-0193(1999)7:1%3C1::AID-HBM1%3E3.0.CO;2-N");
  assert.equal(doiHref("10.1000/a#b?c"), "https://doi.org/10.1000/a%23b%3Fc");
  assert.equal(doiHref("10.1000/a\"b"), "https://doi.org/10.1000/a%22b");
  assert.equal(doiHref("10.1000/éü"), "https://doi.org/10.1000/%C3%A9%C3%BC");
  assert.equal(doiHref("10.1000/50%"), "https://doi.org/10.1000/50%25");
  assert.equal(doiHref("10.1000/a\\b"), "https://doi.org/10.1000/a%5Cb");
  for (const d of ["10.1000/a#b?c<>\"'`{}|^", "10.1000/..%2f..", "10.1000/x‮y"]) {
    const h = doiHref(d);
    assert.ok(h.startsWith("https://doi.org/10.1000/"));
    assert.ok(!/[#?<>" ]/.test(h.slice("https://doi.org/".length)), h);
  }
  assert.equal(doiHref("javascript:alert(1)"), null);
  assert.equal(doiHref("Temporary DOI"), null);
});

test("referenceParts: the link is the part after the year group", () => {
  const p = referenceParts(REF, "10.1002/hbm.20201");
  assert.equal(p.before, "Humphries C, Love T, Swinney D, Hickok G (2005) ");
  assert.equal(p.linkText, "Hum Brain Mapp 26(2):128-38");
  assert.equal(p.href, "https://doi.org/10.1002/hbm.20201");
  assert.equal(p.before + p.linkText, REF);
});

test("referenceParts: no year group links the whole reference; no valid DOI no link; empty reference", () => {
  const w = referenceParts("Mock J Neurosci 2020; 1:1-10", "10.1000/x");
  assert.deepEqual(w, {before: "", linkText: "Mock J Neurosci 2020; 1:1-10", href: "https://doi.org/10.1000/x"});
  assert.deepEqual(referenceParts("Smith (2001) ", "10.1000/x").linkText, "Smith (2001) ", "nothing after the year: whole reference");
  for (const bad of ["Temporary DOI", "", null, undefined, "javascript:alert(1)"]) {
    assert.deepEqual(referenceParts(REF, bad), {before: REF, linkText: "", href: null});
  }
  assert.deepEqual(referenceParts("", "10.1000/x"), {before: "", linkText: "", href: null});
  assert.deepEqual(referenceParts(null, "10.1000/x"), {before: "", linkText: "", href: null});
  const multi = referenceParts("A (1999) B\n(2000) C", "10.1000/x");
  assert.equal(multi.before, "A (1999) ");
});

test("DOM: exactly one link with the expected attributes; plain text without a DOI; no innerHTML", () => {
  setDocument(makeDocument());
  const holder = (nodes) => { const d = makeDocument().createElement("span"); nodes.forEach((n) => d.appendChild(n)); return d; };
  const withDoi = holder(referenceNodesFromText(REF, "10.1002/hbm.20201"));
  assert.equal(withDoi.textContent, REF);
  const links = withDoi.byTag("a");
  assert.equal(links.length, 1);
  const a = links[0];
  assert.equal(a.getAttribute("href"), "https://doi.org/10.1002/hbm.20201");
  assert.equal(a.getAttribute("target"), "_blank");
  assert.equal(a.getAttribute("rel"), "noopener noreferrer");
  assert.equal(a.getAttribute("title"), "Open the paper via its DOI (doi.org)");
  assert.match(a.getAttribute("aria-label"), /new tab/);
  assert.equal(a.textContent, "Hum Brain Mapp 26(2):128-38");
  assert.equal(a.getAttribute("style"), null);
  const none = holder(referenceNodesFromText(REF, "Temporary DOI"));
  assert.equal(none.byTag("a").length, 0);
  assert.equal(none.textContent, REF);
  assert.ok(!/innerHTML|insertAdjacentHTML/.test(readFileSync(new URL("../annotation/reference.js", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "")));
});

test("referenceNodes decodes entities and drops markup before linking; hostile text stays text", () => {
  globalThis.DOMParser = class {
    parseFromString(s) { return {querySelectorAll: () => ({forEach() {}}), documentElement: {textContent: String(s).replace(/<[^>]*>/g, "").replace(/&amp;/g, "&")}}; }
  };
  setDocument(makeDocument());
  const d = makeDocument().createElement("span");
  referenceNodes("Tom &amp; Jerry (2001) <img src=x onerror=alert(1)>J Neuro 1:2", "10.1000/x").forEach((n) => d.appendChild(n));
  assert.equal(d.textContent, "Tom & Jerry (2001) J Neuro 1:2");
  assert.equal(d.byTag("img").length, 0);
  assert.equal(d.byTag("a").length, 1);
  assert.equal(d.byTag("a")[0].textContent, "J Neuro 1:2");
});

// real shapes of the database: the reference starts with the (abbreviated) authors
const FULL = "Berkowitz AL, Ansari D (2008) Neuroimage 41(2):535-43";
const ETAL = "Humphries C, Love T, Swinney D, Hickok G, Smith J et al. (2005) Hum Brain Mapp 26(2):128-38";

test("citationParts: from the year group on, authors are not repeated", () => {
  const p = citationParts(FULL, "10.1016/j.neuroimage.2008.01.001", "Berkowitz AL, Ansari D");
  assert.equal(p.before, "(2008) ");
  assert.equal(p.linkText, "Neuroimage 41(2):535-43");
  assert.equal(p.href, "https://doi.org/10.1016/j.neuroimage.2008.01.001");
  const q = citationParts(ETAL, "10.1002/hbm.20148", "Humphries C, Love T, Swinney D, Hickok G, Smith J, Doe A, Roe B");
  assert.equal(q.before, "(2005) ");
  assert.equal(q.linkText, "Hum Brain Mapp 26(2):128-38");
});

test("citationParts: without a DOI the citation is plain text; without a year group the whole reference unless it repeats the authors; empty and () show nothing", () => {
  assert.deepEqual(citationParts(FULL, "Temporary DOI", "Berkowitz AL, Ansari D"), {before: "(2008) Neuroimage 41(2):535-43", linkText: "", href: null});
  const whole = citationParts("Mock J Neurosci 2020; 1:1-10", "10.1000/x", "Smith J, Doe A");
  assert.deepEqual(whole, {before: "", linkText: "Mock J Neurosci 2020; 1:1-10", href: "https://doi.org/10.1000/x"});
  const none = {before: "", linkText: "", href: null};
  assert.deepEqual(citationParts("Berkowitz AL, Ansari D", "10.1000/x", "Berkowitz AL, Ansari D, Roe B"), none, "only the authors");
  assert.deepEqual(citationParts("Berkowitz AL, Ansari D et al.", "10.1000/x", "Berkowitz AL, Ansari D, Roe B"), none, "authors with et al.");
  for (const empty of ["", "  ", "()", " ( ) ", null, undefined]) {
    assert.deepEqual(citationParts(empty, "10.1000/x", "A B"), none, String(empty));
  }
});

test("citationNodes / referenceNodesFromText: nothing for empty or ()", () => {
  setDocument(makeDocument());
  assert.deepEqual(citationNodes("()", "10.1000/x", "A B"), []);
  assert.deepEqual(referenceNodesFromText("()", "10.1000/x"), []);
  assert.deepEqual(referenceNodesFromText("", null), []);
  const d = makeDocument().createElement("div");
  citationNodes(FULL, "10.1000/x", "Berkowitz AL, Ansari D").forEach((n) => d.appendChild(n));
  assert.equal(d.textContent, "(2008) Neuroimage 41(2):535-43");
  assert.equal(d.byTag("a").length, 1);
});
