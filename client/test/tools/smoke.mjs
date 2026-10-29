#!/usr/bin/env node
/**
 * Pre-deployment smoke test in a real browser (outside `node --test`: it needs Chrome and, for the search page,
 * a server that answers).
 *
 *   node client/test/tools/smoke.mjs <base-url> [--theme=dark|light|both] [--shots=<dir>] [--chrome=<path>]
 *   e.g. node client/test/tools/smoke.mjs http://127.0.0.1:8000
 *        node client/test/tools/smoke.mjs https://brainspell.pasteur.fr --shots=/tmp/shots
 *
 * Serve `client/` with a config.json that points to a real Parse server first (see docs/manual-tests-annotation.md, section D).
 * For each page (home, search ?q=prosodic, article ?pmid=18420426, collections) in the chosen theme(s) it starts headless Chrome with
 * SwiftShader (software WebGL, so the 3D viewers initialise), waits for the page and FAILS (exit code 1) on:
 *   - an uncaught JS exception;
 *   - a Content-Security-Policy violation;
 *   - a console error that is not in the allow-list below;
 *   - the search page without "N articles found", without result items, with a zero-size #viewer or canvas, or whose map is not complete
 *     ("Map from N papers" in #viewer-info, N = the number found) within 10 s (searches: prosodic, "cognition" = 445 papers);
 *   - any visible link, button, input, heading, list item or table cell that is covered by another element (stacking bugs);
 *   - the article page without a title, the collections page without its heading.
 * Prints a PASS/FAIL table with the reasons. Needs Node >= 22 (global fetch and WebSocket) and Google Chrome.
 */
import {spawn} from "node:child_process";
import {mkdtempSync, mkdirSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";

const args = process.argv.slice(2);
const base = (args.find((a) => /^https?:/.test(a)) || "").replace(/\/+$/, "");
const opt = (name, def) => (args.find((a) => a.startsWith(`--${name}=`)) || `--${name}=${def}`).split("=").slice(1).join("=");
if (!base) {
  console.log("usage: node smoke.mjs <base-url> [--theme=dark|light|both] [--shots=<dir>] [--chrome=<path>]");
  process.exit(2);
}
const themes = opt("theme", "both") === "both" ? ["dark", "light"] : [opt("theme", "dark")];
const shots = opt("shots", "");
const chromePath = opt("chrome", process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
if (shots) {
  mkdirSync(shots, {recursive: true});
}

// console messages that are known and harmless
const ALLOW = [
  /THREE\./, // three.js deprecation warnings of the 3D viewer
  /GPU stall/, // software WebGL
  /favicon\.ico/,
  /WebGL: CONTEXT_LOST|WEBGL_debug_renderer_info|Automatic fallback to software WebGL|swiftshader/i
];

const PAGES = [
  {name: "home", path: "/index.html", wait: 4000},
  {name: "search", path: "/search.html?q=prosodic", wait: 20000, search: true},
  {name: "search-big", path: "/search.html?q=%22cognition%22", wait: 25000, search: true, bigMap: true},
  {name: "article", path: "/article.html?pmid=18420426", wait: 8000, article: true},
  {name: "collections", path: "/collections.html", wait: 3000, collections: true}
];

const COVER = `(() => { const bad = []; let n = 0;
for (const e of document.querySelectorAll("a, button, input, textarea, h1, h2, h3, li, label, th, td")) {
  const r = e.getBoundingClientRect(); if (!r.width || !r.height || r.bottom < 0 || r.top > innerHeight || getComputedStyle(e).visibility === "hidden") continue;
  let hidden = false; for (let x = e; x; x = x.parentElement) { if (x.hidden || getComputedStyle(x).display === "none") { hidden = true; break; } } if (hidden) continue;
  const top = document.elementFromPoint(r.left + r.width / 2, r.top + Math.min(r.height / 2, 12)); n++;
  if (top && !(e === top || e.contains(top) || top.contains(e))) bad.push((e.tagName + "." + e.className).slice(0, 40) + " covered by " + top.tagName + "." + (top.getAttribute("class") || top.id));
}
return {checked: n, covered: bad.slice(0, 5), count: bad.length}; })()`;

const STATE = `(() => { const q = (s) => document.querySelector(s); const v = q("#viewer"); const c = v && v.querySelector("canvas");
return {found: (q("#num-found") || {}).textContent || "", items: document.querySelectorAll("#paper-list li").length,
  viewerH: v ? v.clientHeight : -1, viewerW: v ? v.clientWidth : -1, canvasH: c ? c.height : -1, canvasW: c ? c.width : -1,
  info: (q("#viewer-info") || {}).textContent || "", legend: (q("#levelValue") || {}).textContent || "", title: (q("h2") || {}).textContent || "", h2: [...document.querySelectorAll("h2")].map((h) => h.textContent), theme: document.documentElement.getAttribute("data-theme") }; })()`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const launch = async () => {
  const port = 9600 + Math.floor(Math.random() * 300);
  const dir = mkdtempSync(join(tmpdir(), "smoke-"));
  const chrome = spawn(chromePath, ["--headless=new", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist", "--hide-scrollbars",
    `--remote-debugging-port=${port}`, `--user-data-dir=${dir}`, "--window-size=1000,1000", "about:blank"], {stdio: "ignore"});
  let targets = null;
  for (let i = 0; i < 60 && !targets; i++) {
    try {
      const t = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      targets = t.find((x) => x.type === "page") ? t : null;
    } catch (e) { /* not up yet */ }
    if (!targets) { await sleep(250); }
  }
  if (!targets) { chrome.kill(); throw new Error("Chrome did not start (use --chrome=<path>)"); }
  const ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
  await new Promise((r) => { ws.onopen = r; });
  let id = 0;
  const pending = new Map();
  const logs = [];
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); return; }
    if (d.method === "Runtime.consoleAPICalled" && d.params.type === "error") { logs.push({kind: "console", text: d.params.args.map((a) => a.value || a.description).join(" ")}); }
    if (d.method === "Runtime.exceptionThrown") { const e = d.params.exceptionDetails; logs.push({kind: "exception", text: e.exception ? e.exception.description : e.text}); }
    if (d.method === "Log.entryAdded" && d.params.entry.level === "error") { logs.push({kind: "log", text: `${d.params.entry.text} ${d.params.entry.url || ""}`}); }
  };
  const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({id: i, method, params})); });
  await send("Page.enable"); await send("Runtime.enable"); await send("Log.enable");

  return {send, logs, close: () => { ws.close(); chrome.kill(); }};
};

const evalJs = async (b, expr) => {
  const r = await b.send("Runtime.evaluate", {expression: expr, returnByValue: true, awaitPromise: true});

  return r.result && r.result.result ? r.result.result.value : undefined;
};

const results = [];
const b = await launch();
try {
  for (const theme of themes) {
    for (const p of PAGES) {
      b.logs.length = 0;
      const sep = p.path.includes("?") ? "&" : "?";
      const url = `${base}${p.path}${sep}theme=${theme}`;
      await b.send("Page.navigate", {url});
      const fails = [];
      // wait until the page is ready (search: results counted) or the time is up
      const t0 = Date.now();
      while (Date.now() - t0 < p.wait) {
        await sleep(500);
        if (p.search) {
          const s = await evalJs(b, STATE);
          if (s && /articles found/.test(s.found) && s.items > 0 && /^Map from \d+ papers$/.test(s.info) && Date.now() - t0 > 400) { break; }
        }
      }
      const elapsed = Date.now() - t0;
      await sleep(1500);
      const state = await evalJs(b, STATE);
      const cover = await evalJs(b, COVER);
      if (p.search) {
        if (!/^\d+ articles found/.test(state.found)) { fails.push(`no "N articles found" (got "${state.found}")`); }
        if (!(state.items > 0)) { fails.push("no result items"); }
        if (!(state.viewerH > 0 && state.viewerW > 0)) { fails.push(`#viewer size ${state.viewerW}x${state.viewerH}`); }
        if (!(state.canvasH > 0 && state.canvasW > 0)) { fails.push(`canvas size ${state.canvasW}x${state.canvasH}`); }
        const m = /^Map from (\d+) papers$/.exec(state.info);
        const n = Number((/^(\d+) articles found/.exec(state.found) || [])[1]);
        if (!m) { fails.push(`the map is not complete (status "${state.info}")`); } else if (Number(m[1]) !== n) { fails.push(`map from ${m[1]} papers but ${n} found`); }
        if (!/overlapping peaks/.test(state.legend)) { fails.push(`no legend for the level ("${state.legend}")`); }
        if (elapsed > 10000) { fails.push(`map took ${(elapsed / 1000).toFixed(1)} s (limit 10 s)`); }
      }
      if (p.article && !state.h2.length) { fails.push("article has no title"); }
      if (p.collections && !state.h2.some((t) => /collections/i.test(t))) { fails.push("no collections heading"); }
      if (state.theme !== theme) { fails.push(`theme is ${state.theme}, wanted ${theme}`); }
      if (cover && cover.count) { fails.push(`${cover.count} element(s) covered: ${cover.covered.join("; ")}`); }
      for (const l of b.logs) {
        if (l.kind === "exception") { fails.push(`exception: ${l.text.split("\n")[0]}`); }
        else if (/Content Security Policy|Refused to|violates the following/i.test(l.text)) { fails.push(`CSP: ${l.text.slice(0, 160)}`); }
        else if (!ALLOW.some((re) => re.test(l.text))) { fails.push(`console error: ${l.text.slice(0, 160)}`); }
      }
      if (shots) {
        const s = await b.send("Page.captureScreenshot", {format: "png"});
        writeFileSync(join(shots, `${p.name}-${theme}.png`), Buffer.from(s.result.data, "base64"));
      }
      results.push({page: p.name, theme, fails, info: p.search ? `${state.found}; ${state.items} items; ${state.info} in ${(elapsed / 1000).toFixed(1)} s; viewer ${state.viewerW}x${state.viewerH}` : `${cover ? cover.checked : 0} elements checked`});
    }
  }
} finally {
  b.close();
}

console.log("\nPAGE         THEME  RESULT  DETAILS");
for (const r of results) {
  console.log(`${r.page.padEnd(12)} ${r.theme.padEnd(6)} ${r.fails.length ? "FAIL  " : "PASS  "} ${r.fails.length ? r.fails.join(" | ") : r.info}`);
}
const failed = results.filter((r) => r.fails.length).length;
console.log(`\n${failed ? "FAIL" : "PASS"}: ${results.length - failed} of ${results.length} page checks passed`);
process.exit(failed ? 1 : 0);
