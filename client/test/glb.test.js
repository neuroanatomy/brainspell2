import test from "node:test";
import assert from "node:assert/strict";
import {writeGlb, readGlb, readAccessor, LICENSE_TEXT, GENERATOR} from "../annotation/glb.js";
import {
  toGltf, METRES_PER_UNIT, computeNormals, signedVolume, flipWinding, bakeToon, brainColors, outlineHull, slug, exportFilename, levelSurface, levelValue,
  buildMeshes, buildGlb, boundingBox, FRACTIONS, VIEW_DIR
} from "../annotation/model-export.js";
import * as sn from "../node_modules/translucent-viewer/surfacenets.js";

const surfaceNets = (args) => sn.init(args);

const triangle = () => ({
  name: "tri", positions: [0, 0, 0, 1, 0, 0, 0, 1, 0.5], normals: [0, 0, 1, 0, 0, 1, 0, 0, 1], colors: [255, 0, 0, 255, 0, 255, 0, 128, 0, 0, 255, 255], indices: [0, 1, 2],
  material: {name: "m", baseColor: [1, 1, 1, 1], unlit: true, alphaMode: "BLEND", doubleSided: true}
});

test("glb: container is valid (magic, version, length, chunks padded to 4)", () => {
  const bytes = writeGlb({meshes: [triangle()], asset: {extras: {query: "q"}}});
  const dv = new DataView(bytes.buffer);
  assert.equal(dv.getUint32(0, true), 0x46546C67);
  assert.equal(dv.getUint32(4, true), 2);
  assert.equal(dv.getUint32(8, true), bytes.length);
  assert.equal(bytes.length % 4, 0);
  const g = readGlb(bytes);
  assert.equal(g.jsonLength % 4, 0);
  assert.equal(g.binLength % 4, 0);
  assert.equal(g.json.asset.version, "2.0");
  assert.equal(g.json.asset.generator, GENERATOR);
  assert.equal(g.json.asset.extras.query, "q");
  assert.equal(g.json.buffers[0].byteLength <= g.binLength, true);
  assert.equal(LICENSE_TEXT, "", "no licence claim in the file");
  assert.equal("copyright" in g.json.asset, false);
});

test("glb: accessors, bufferViews, references and extensions are consistent", () => {
  const g = readGlb(writeGlb({meshes: [triangle(), {...triangle(), name: "tri2", material: {name: "o", baseColor: [0, 0, 0, 1], unlit: false, alphaMode: "OPAQUE", doubleSided: false}}]}));
  const {json} = g;
  assert.deepEqual(json.extensionsUsed, ["KHR_materials_unlit"]);
  assert.equal(json.materials.length, 2);
  assert.equal(json.materials[0].extensions.KHR_materials_unlit !== undefined, true);
  assert.equal(json.materials[1].extensions, undefined);
  for (const a of json.accessors) {
    const v = json.bufferViews[a.bufferView];
    const size = {5126: 4, 5121: 1, 5123: 2, 5125: 4}[a.componentType] * {SCALAR: 1, VEC3: 3, VEC4: 4}[a.type];
    assert.ok(a.byteOffset + a.count * size <= v.byteLength, "accessor inside its bufferView");
    assert.ok(v.byteOffset + v.byteLength <= json.buffers[0].byteLength);
    assert.equal(v.byteOffset % 4, 0);
  }
  json.nodes.forEach((n) => assert.ok(json.meshes[n.mesh]));
  json.meshes.forEach((m) => m.primitives.forEach((p) => { assert.ok(json.materials[p.material]); assert.equal(p.mode, 4); assert.ok(json.accessors[p.indices]); }));
  json.scenes[0].nodes.forEach((i) => assert.ok(json.nodes[i]));
  const pos = json.accessors[json.meshes[0].primitives[0].attributes.POSITION];
  assert.deepEqual(pos.min, [0, 0, 0]);
  assert.deepEqual(pos.max, [1, 1, 0.5]);
  assert.equal(pos.componentType, 5126);
  assert.equal(json.accessors[json.meshes[0].primitives[0].attributes.COLOR_0].normalized, true);
  const target = (i) => json.bufferViews[json.accessors[i].bufferView].target;
  assert.equal(target(json.meshes[0].primitives[0].attributes.POSITION), 34962);
  assert.equal(target(json.meshes[0].primitives[0].indices), 34963);
});

test("glb: parse back what was written (vertices, indices, colours); uint32 indices for big meshes; refuses bad input", () => {
  const t = triangle();
  const g = readGlb(writeGlb({meshes: [t]}));
  const p = g.json.meshes[0].primitives[0];
  assert.deepEqual(readAccessor(g, p.attributes.POSITION), t.positions);
  assert.deepEqual(readAccessor(g, p.attributes.NORMAL), t.normals);
  assert.deepEqual(readAccessor(g, p.attributes.COLOR_0), t.colors);
  assert.deepEqual(readAccessor(g, p.indices), [0, 1, 2]);
  assert.equal(g.json.accessors[p.indices].componentType, 5123);
  const n = 70000;
  const positions = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { positions[i * 3] = i; }
  const big = readGlb(writeGlb({meshes: [{name: "big", positions, indices: [0, 69999, 5], material: {name: "m"}}]}));
  assert.equal(big.json.accessors[big.json.meshes[0].primitives[0].indices].componentType, 5125);
  assert.deepEqual(readAccessor(big, big.json.meshes[0].primitives[0].indices), [0, 69999, 5]);
  assert.throws(() => writeGlb({meshes: [{name: "x", positions: [0, 0, 0], indices: [0, 0, 7], material: {name: "m"}}]}), /out of range/);
  assert.throws(() => writeGlb({meshes: [{name: "x", positions: [0, 0], indices: [0, 0, 0], material: {name: "m"}}]}));
  assert.throws(() => readGlb(new Uint8Array(20)), /magic/);
});

// ---- orientation and units -----------------------------------------------------------------------------------------------------------------
test("orientation: x -> -X, anterior (y) -> +Z, superior (z) -> +Y, proper rotation, metres", () => {
  const s = METRES_PER_UNIT;
  assert.ok(Math.abs(s - 0.001 / 0.14) < 1e-15);
  const [x, y, z] = toGltf([10, 20, 30]);
  assert.ok(Math.abs(x - -10 * s) < 1e-12 && Math.abs(y - 30 * s) < 1e-12 && Math.abs(z - 20 * s) < 1e-12);
  assert.ok(toGltf([0, 1, 0])[2] > 0, "anterior goes to +Z (the front)");
  assert.ok(toGltf([0, 0, 1])[1] > 0, "superior goes to +Y (up)");
  assert.ok(toGltf([1, 0, 0])[0] < 0, "viewer-right goes to -X: seen from the front the subject's right is on the viewer's left");
  // det = +1: the image of x cross y equals the image of z
  const ex = toGltf([1, 0, 0]); const ey = toGltf([0, 1, 0]); const ez = toGltf([0, 0, 1]);
  const cross = [ex[1] * ey[2] - ex[2] * ey[1], ex[2] * ey[0] - ex[0] * ey[2], ex[0] * ey[1] - ex[1] * ey[0]];
  assert.ok(ez[1] > 0 && Math.abs(cross[0]) < 1e-18 && Math.abs(cross[2]) < 1e-18);
  assert.ok(cross[1] > 0, "(x cross y) points to +Y like z does");
});

// ---- geometry --------------------------------------------------------------------------------------------------------------------------------
const sphereVolume = (dim, c, r) => {
  const v = new Float32Array(dim[0] * dim[1] * dim[2]);
  for (let z = 0; z < dim[2]; z++) { for (let y = 0; y < dim[1]; y++) { for (let x = 0; x < dim[0]; x++) {
    const d = Math.hypot(x - c[0], y - c[1], z - c[2]);
    v[z * dim[0] * dim[1] + y * dim[0] + x] = Math.max(0, 100 * (1 - d / r));
  } } }

  return v;
};
const DIM = [45, 54, 45];
const bboxOf = (positions) => { const mn = [Infinity, Infinity, Infinity]; const mx = [-Infinity, -Infinity, -Infinity]; for (let i = 0; i < positions.length; i += 3) { for (let k = 0; k < 3; k++) { mn[k] = Math.min(mn[k], positions[i + k]); mx[k] = Math.max(mx[k], positions[i + k]); } } return [mn, mx]; };
const inside = (a, b) => [0, 1, 2].every((k) => a[0][k] >= b[0][k] - 1e-9 && a[1][k] <= b[1][k] + 1e-9);

test("levels: nested surfaces of a spherical volume, outward oriented, non-empty", () => {
  const data = sphereVolume(DIM, [22, 27, 22], 14);
  const s = FRACTIONS.map((f) => levelSurface({data, dim: DIM, level: levelValue(100, f), surfaceNets}));
  s.forEach((x) => { assert.ok(x && x.indices.length > 0); assert.ok(signedVolume(x.positions, x.indices) > 0, "outward"); });
  const [b25, b50, b75] = s.map((x) => bboxOf(x.positions));
  assert.ok(inside(b75, b50) && inside(b50, b25));
  assert.ok(b75[1][0] - b75[0][0] < b50[1][0] - b50[0][0] && b50[1][0] - b50[0][0] < b25[1][0] - b25[0][0]);
  assert.equal(levelSurface({data: new Float32Array(DIM[0] * DIM[1] * DIM[2]), dim: DIM, level: 1, surfaceNets}), null);
});

test("outline hull: reversed winding and slightly larger", () => {
  const data = sphereVolume(DIM, [22, 27, 22], 14);
  const s = levelSurface({data, dim: DIM, level: 50, surfaceNets});
  const n = computeNormals(s.positions, s.indices);
  const h = outlineHull(s.positions, n, s.indices, 0.03);
  assert.ok(signedVolume(h.positions, h.indices) < 0, "reversed");
  assert.ok(signedVolume(s.positions, s.indices) > 0);
  const [a, b] = [bboxOf(s.positions), bboxOf(h.positions)];
  assert.ok(b[1][0] - b[0][0] > a[1][0] - a[0][0]);
  assert.ok(b[1][0] - b[0][0] < a[1][0] - a[0][0] + 0.5, "only a small fraction of a voxel");
  assert.deepEqual(flipWinding(flipWinding(s.indices)), Array.from(s.indices));
});

test("baked toon colours: bands from the facing direction", () => {
  const facing = VIEW_DIR; // surface facing the viewing direction: the base colour
  const grazing = [VIEW_DIR[1], -VIEW_DIR[0], 0]; // perpendicular: black
  const mid = [0, 0, 0];
  const c = bakeToon(new Float32Array([...facing, ...grazing]), [200, 20, 20], 255);
  assert.deepEqual(Array.from(c.slice(0, 4)), [200, 20, 20, 255]);
  assert.deepEqual(Array.from(c.slice(4, 8)), [0, 0, 0, 255]);
  const bands = new Set();
  for (let a = 0; a <= 90; a += 5) { const r = a * Math.PI / 180; const n = [VIEW_DIR[0] * Math.cos(r) + 0, VIEW_DIR[1] * Math.cos(r) - VIEW_DIR[2] * Math.sin(r), VIEW_DIR[2] * Math.cos(r) + VIEW_DIR[1] * Math.sin(r)]; bands.add(bakeToon(new Float32Array(n), [255, 0, 0])[0]); }
  assert.ok(bands.size === 3, `three tone bands, got ${[...bands]}`);
  assert.equal(mid.length, 3);
  const a = brainColors(new Float32Array([0, 1, 0, 1, 0, 0]));
  assert.ok(a[7] > a[3], "more opaque where the surface is seen at a grazing angle");
});

test("export: refuses an empty map; builds named nested levels and outlines; the GLB parses back", () => {
  const brain = {positions: new Float32Array([0, 0, 0, 10, 0, 0, 0, 10, 0, 0, 0, 10]), indices: [0, 1, 2, 0, 2, 3, 0, 3, 1, 1, 3, 2]};
  assert.throws(() => buildMeshes({brain, field: {data: new Float32Array(DIM[0] * DIM[1] * DIM[2]), dim: DIM, max: 0}, surfaceNets}), /empty/);
  const data = sphereVolume(DIM, [22, 27, 22], 14);
  const field = {data, dim: DIM, max: 100};
  const meshes = buildMeshes({brain, field, surfaceNets});
  assert.deepEqual(meshes.map((m) => m.name), ["level_25", "level_50", "level_50_outline", "level_75", "level_75_outline", "brain"]);
  const byName = Object.fromEntries(meshes.map((m) => [m.name, m]));
  assert.equal(byName.level_25.material.alphaMode, "BLEND");
  assert.equal(byName.level_50.material.alphaMode, "OPAQUE");
  assert.equal(byName.level_50_outline.material.doubleSided, false);
  assert.ok(inside(bboxOf(byName.level_75.positions), bboxOf(byName.level_50.positions)));
  assert.ok(inside(bboxOf(byName.level_50.positions), bboxOf(byName.level_25.positions)));
  const bytes = buildGlb({brain, field, surfaceNets, meta: {query: "a & b", papers: 12, total: 15, sliderPercent: 50, created: new Date("2026-01-02T03:04:05Z")}});
  const g = readGlb(bytes);
  assert.equal(g.json.nodes.length, 6);
  assert.equal(g.json.nodes[5].name, "brain", "the brain is the last node");
  assert.equal(g.json.asset.extras.papersUsed, 12);
  assert.equal(g.json.asset.extras.created, "2026-01-02T03:04:05.000Z");
  assert.match(g.json.asset.extras.alignment, /not for quantitative use/);
  assert.deepEqual(g.json.scenes[0].extras.levelFractions, [0.25, 0.5, 0.75]);
  // vertices of the brain survive the mapping: viewer (0,10,0) -> (-0, 0, 10*s)
  const brainPos = readAccessor(g, g.json.meshes[5].primitives[0].attributes.POSITION);
  assert.ok(Math.abs(brainPos[3 + 0] - -10 * METRES_PER_UNIT) < 1e-7);
  assert.ok(Math.abs(brainPos[6 + 2] - 10 * METRES_PER_UNIT) < 1e-7);
  const [mn, mx] = boundingBox(meshes);
  assert.ok(mx[0] > mn[0]);
});

test("filename sanitiser", () => {
  assert.equal(exportFilename("working memory", 1753), "brainspell-working-memory-1753papers.glb");
  assert.equal(exportFilename("\"cognition\" & Émotion/../x", 5), "brainspell-cognition-emotion-x-5papers.glb");
  assert.equal(exportFilename("", 0), "brainspell-search-0papers.glb");
  assert.equal(exportFilename("日本語", 3), "brainspell-search-3papers.glb");
  assert.match(exportFilename("x".repeat(100), 1), /^brainspell-x{40}-1papers\.glb$/);
  assert.match(exportFilename("<script>alert(1)</script>", 2), /^[a-z0-9-]+\.glb$/);
  assert.equal(slug("a--b  c"), "a-b-c");
});
