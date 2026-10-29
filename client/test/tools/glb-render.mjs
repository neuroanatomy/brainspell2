#!/usr/bin/env node
/**
 * Renders an exported .glb with the reference viewer page (glb-viewer.html, three.js r119 GLTFLoader) from several views and backgrounds to PNG files.
 *   node client/test/tools/glb-render.mjs <base-url> <model path served under base-url, e.g. /test/tools/_sample.glb> <out-dir> [views=front,top,side,iso] [bgs=dark,white]
 * Needs Chrome (SwiftShader) and network access to cdn.jsdelivr.net. Not part of `node --test`.
 */
import {spawn} from "node:child_process";
import {mkdtempSync, mkdirSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
const [base, model, out, views = "front,top,side,iso", bgs = "dark,white"] = process.argv.slice(2);
mkdirSync(out, {recursive: true});
const port = 9800 + Math.floor(Math.random() * 90); const dir = mkdtempSync(join(tmpdir(), "gr-"));
const chrome = spawn(process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", ["--headless=new", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist", `--remote-debugging-port=${port}`, `--user-data-dir=${dir}`, "--window-size=800,800", "about:blank"], {stdio: "ignore"});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let t; for (let i = 0; i < 60; i++) { try { t = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); if (t.find((x) => x.type === "page")) break; } catch (e) { /* retry */ } await sleep(250); }
const ws = new WebSocket(t.find((x) => x.type === "page").webSocketDebuggerUrl); await new Promise((r) => { ws.onopen = r; });
let id = 0; const pend = new Map(); const logs = [];
ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); } else if (d.method === "Runtime.consoleAPICalled" && ["error", "warning"].includes(d.params.type)) logs.push(d.params.args.map((a) => a.value || a.description).join(" ")); };
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({id: i, method, params})); });
await send("Runtime.enable"); await send("Page.enable");
const report = [];
for (const bg of bgs.split(",")) {
  for (const view of views.split(",")) {
    await send("Page.navigate", {url: `${base}/test/tools/glb-viewer.html?model=${encodeURIComponent(model)}&view=${view}&bg=${bg}`});
    let ready = false;
    for (let i = 0; i < 80 && !ready; i++) { await sleep(250); const r = await send("Runtime.evaluate", {expression: "window.__error || (window.__ready ? 'ok' : '')", returnByValue: true}); const v = r.result.result.value; if (v === "ok") ready = true; else if (v) { report.push(`${view}/${bg}: ${v}`); break; } }
    if (!ready) continue;
    const s = await send("Page.captureScreenshot", {format: "png"});
    writeFileSync(join(out, `glb-${view}-${bg}.png`), Buffer.from(s.result.data, "base64"));
    if (view === "front" && bg === "dark") { const r = await send("Runtime.evaluate", {expression: "JSON.stringify({info: window.__info, box: window.__box})", returnByValue: true}); report.push(r.result.result.value); }
  }
}
console.log(report.join("\n"));
if (logs.length) console.log("console:", logs.slice(0, 5).join(" | "));
ws.close(); chrome.kill(); process.exit(0);
