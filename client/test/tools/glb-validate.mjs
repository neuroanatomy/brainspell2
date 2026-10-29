#!/usr/bin/env node
/**
 * Validates a .glb with the Khronos glTF-Validator (npm package gltf-validator, fetched from cdn.jsdelivr.net into a temp folder).
 *   node client/test/tools/glb-validate.mjs <file.glb>
 * Prints the number of errors / warnings / infos / hints and the messages; exit code 1 on errors or warnings. Needs network access.
 */
import {mkdtempSync, writeFileSync, readFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createRequire} from "node:module";

const file = process.argv[2];
if (!file) {
  console.log("usage: node glb-validate.mjs <file.glb>");
  process.exit(2);
}
const dir = mkdtempSync(join(tmpdir(), "gltf-validator-"));
const VERSION = "2.0.0-dev.3.10";
for (const f of ["gltf_validator.dart.js", "index.js"]) {
  const res = await fetch(`https://cdn.jsdelivr.net/npm/gltf-validator@${VERSION}/${f}`);
  if (!res.ok) {
    console.log(`could not download ${f} (${res.status})`);
    process.exit(2);
  }
  writeFileSync(join(dir, f), Buffer.from(await res.arrayBuffer()));
}
writeFileSync(join(dir, "package.json"), JSON.stringify({type: "commonjs"}));
const validator = createRequire(join(dir, "x.cjs"))("./index.js");
const r = await validator.validateBytes(new Uint8Array(readFileSync(file)), {uri: file, maxIssues: 100});
const i = r.issues;
console.log(`glTF-Validator ${r.validatorVersion}: ${i.numErrors} errors, ${i.numWarnings} warnings, ${i.numInfos} infos, ${i.numHints} hints`);
console.log(`vertices ${r.info.totalVertexCount}, triangles ${r.info.totalTriangleCount}, materials ${r.info.materialCount}, extensions ${(r.info.extensionsUsed || []).join(",")}`);
i.messages.slice(0, 30).forEach((m) => console.log(`  [${["error", "warning", "info", "hint"][m.severity]}] ${m.code} ${m.pointer} ${m.message}`));
process.exit(i.numErrors || i.numWarnings ? 1 : 0);
