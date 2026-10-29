/**
 * A minimal binary glTF 2.0 (GLB) writer. No dependencies (no THREE, no DOM): it runs in the browser and in Node.
 *
 * writeGlb({meshes, asset, sceneName, sceneExtras}) -> Uint8Array
 *   meshes: [{name, positions: Float32Array|number[] (x,y,z per vertex), normals?: (same), colors?: Uint8Array|number[] (r,g,b,a 0..255 per vertex),
 *             indices: number[]|Uint16Array|Uint32Array (triangles), material: {name, baseColor: [r,g,b,a], unlit, alphaMode, doubleSided, metallic, roughness}}]
 *   asset: {extras?: object} extras go to asset.extras
 * Every mesh becomes one node with one mesh with one triangle primitive. Colours are normalised unsigned bytes (COLOR_0).
 */

/**
 * Optional licence / copyright text of the file. Leave it EMPTY unless the owner has decided on a licence: when it is not empty it is written to
 * asset.copyright. (The model contains no licence claim today.)
 */
export const LICENSE_TEXT = "";

export const GENERATOR = "Brainspell (https://brainspell.pasteur.fr)";

const FLOAT = 5126;
const UBYTE = 5121;
const USHORT = 5123;
const UINT = 5125;
const ARRAY_BUFFER = 34962;
const ELEMENT_ARRAY_BUFFER = 34963;
const MAGIC = 0x46546C67; // "glTF"
const CHUNK_JSON = 0x4E4F534A;
const CHUNK_BIN = 0x004E4942;

const pad4 = (n) => (n + 3) & ~3;

const min3 = (a) => {
  const mn = [Infinity, Infinity, Infinity];
  const mx = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < a.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      if (a[i + k] < mn[k]) { mn[k] = a[i + k]; }
      if (a[i + k] > mx[k]) { mx[k] = a[i + k]; }
    }
  }

  return [mn, mx];
};

const materialJson = (m) => {
  const j = {
    name: m.name,
    pbrMetallicRoughness: {baseColorFactor: m.baseColor || [1, 1, 1, 1], metallicFactor: m.metallic ?? 0, roughnessFactor: m.roughness ?? 1},
    alphaMode: m.alphaMode || "OPAQUE",
    doubleSided: Boolean(m.doubleSided)
  };
  if (m.unlit) {
    j.extensions = {KHR_materials_unlit: {}};
  }

  return j;
};

export const writeGlb = ({meshes, asset = {}, sceneName = "Brainspell", sceneExtras = null}) => {
  const json = {
    asset: {version: "2.0", generator: GENERATOR, ...(asset.extras ? {extras: asset.extras} : {})},
    scene: 0,
    scenes: [{name: sceneName, nodes: [], ...(sceneExtras ? {extras: sceneExtras} : {})}],
    nodes: [],
    meshes: [],
    materials: [],
    accessors: [],
    bufferViews: [],
    buffers: []
  };
  if (LICENSE_TEXT) {
    json.asset.copyright = LICENSE_TEXT;
  }
  const chunks = [];
  let offset = 0;
  const materialIndex = new Map();

  const addView = (bytes, target) => {
    const start = offset;
    chunks.push({start, bytes});
    offset = pad4(offset + bytes.byteLength);
    const view = {buffer: 0, byteOffset: start, byteLength: bytes.byteLength};
    if (target) {
      view.target = target;
    }
    json.bufferViews.push(view);

    return json.bufferViews.length - 1;
  };
  const addAccessor = (bufferView, componentType, count, type, extra = {}) => {
    json.accessors.push({bufferView, byteOffset: 0, componentType, count, type, ...extra});

    return json.accessors.length - 1;
  };

  for (const mesh of meshes) {
    const pos = Float32Array.from(mesh.positions);
    const n = pos.length / 3;
    if (!Number.isInteger(n) || n === 0) {
      throw new Error(`mesh ${mesh.name}: positions must be x,y,z triples`);
    }
    const idxArray = Array.from(mesh.indices);
    if (idxArray.length % 3 !== 0 || idxArray.length === 0) {
      throw new Error(`mesh ${mesh.name}: indices must be triangles`);
    }
    for (const i of idxArray) {
      if (!(i >= 0 && i < n)) {
        throw new Error(`mesh ${mesh.name}: index ${i} out of range`);
      }
    }
    const attributes = {};
    const [mn, mx] = min3(pos);
    attributes.POSITION = addAccessor(addView(new Uint8Array(pos.buffer.slice(pos.byteOffset, pos.byteOffset + pos.byteLength)), ARRAY_BUFFER), FLOAT, n, "VEC3", {min: mn, max: mx});
    if (mesh.normals) {
      const nr = Float32Array.from(mesh.normals);
      attributes.NORMAL = addAccessor(addView(new Uint8Array(nr.buffer), ARRAY_BUFFER), FLOAT, n, "VEC3");
    }
    if (mesh.colors) {
      const c = Uint8Array.from(mesh.colors);
      if (c.length !== n * 4) {
        throw new Error(`mesh ${mesh.name}: colors must be r,g,b,a per vertex`);
      }
      attributes.COLOR_0 = addAccessor(addView(c, ARRAY_BUFFER), UBYTE, n, "VEC4", {normalized: true});
    }
    const big = n > 65535;
    const ind = big ? Uint32Array.from(idxArray) : Uint16Array.from(idxArray);
    const indices = addAccessor(addView(new Uint8Array(ind.buffer), ELEMENT_ARRAY_BUFFER), big ? UINT : USHORT, ind.length, "SCALAR");

    const mat = materialJson(mesh.material);
    const key = JSON.stringify(mat);
    if (!materialIndex.has(key)) {
      materialIndex.set(key, json.materials.length);
      json.materials.push(mat);
    }
    json.meshes.push({name: mesh.name, primitives: [{attributes, indices, material: materialIndex.get(key), mode: 4}]});
    json.nodes.push({name: mesh.name, mesh: json.meshes.length - 1});
    json.scenes[0].nodes.push(json.nodes.length - 1);
  }
  if (json.materials.some((m) => m.extensions && m.extensions.KHR_materials_unlit)) {
    json.extensionsUsed = ["KHR_materials_unlit"];
  }
  json.buffers.push({byteLength: offset});

  const jsonBytes = new TextEncoder().encode(JSON.stringify(json));
  const jsonLen = pad4(jsonBytes.length);
  const binLen = pad4(offset);
  const total = 12 + 8 + jsonLen + 8 + binLen;
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, MAGIC, true);
  dv.setUint32(4, 2, true);
  dv.setUint32(8, total, true);
  dv.setUint32(12, jsonLen, true);
  dv.setUint32(16, CHUNK_JSON, true);
  out.set(jsonBytes, 20);
  out.fill(0x20, 20 + jsonBytes.length, 20 + jsonLen); // JSON chunk is padded with spaces
  const binStart = 20 + jsonLen;
  dv.setUint32(binStart, binLen, true);
  dv.setUint32(binStart + 4, CHUNK_BIN, true);
  for (const c of chunks) {
    out.set(c.bytes, binStart + 8 + c.start);
  }

  return out;
};

/** Minimal reader (for tests and the reference viewer page): {json, bin} of a GLB, with checks of the container. */
export const readGlb = (bytes) => {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (dv.getUint32(0, true) !== MAGIC) {
    throw new Error("not a glb (magic)");
  }
  if (dv.getUint32(4, true) !== 2) {
    throw new Error("glb version is not 2");
  }
  if (dv.getUint32(8, true) !== b.byteLength) {
    throw new Error("glb length does not match");
  }
  const jl = dv.getUint32(12, true);
  if (dv.getUint32(16, true) !== CHUNK_JSON) {
    throw new Error("first chunk is not JSON");
  }
  const json = JSON.parse(new TextDecoder().decode(b.subarray(20, 20 + jl)));
  const bs = 20 + jl;
  const bl = dv.getUint32(bs, true);
  if (dv.getUint32(bs + 4, true) !== CHUNK_BIN) {
    throw new Error("second chunk is not BIN");
  }

  return {json, bin: b.subarray(bs + 8, bs + 8 + bl), jsonLength: jl, binLength: bl};
};

/** Reads an accessor (floats / unsigned ints, no stride) back as a plain array of numbers. */
export const readAccessor = ({json, bin}, index) => {
  const a = json.accessors[index];
  const v = json.bufferViews[a.bufferView];
  const comps = {SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4}[a.type];
  const start = bin.byteOffset + v.byteOffset + (a.byteOffset || 0);
  const Type = {[FLOAT]: Float32Array, [UBYTE]: Uint8Array, [USHORT]: Uint16Array, [UINT]: Uint32Array}[a.componentType];

  return Array.from(new Type(bin.buffer, start, a.count * comps));
};
