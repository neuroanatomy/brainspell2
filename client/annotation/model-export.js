/**
 * Builds the 3D model (GLB) of the coactivation map: the translucent brain of the viewer, the map as three nested surfaces (25%, 50% and 75% of the
 * strongest region) and black outlines. Pure (no DOM, no THREE): the page gives it the brain geometry taken from the live viewer scene and the volume
 * of the map; `surfaceNets` is injected (the viewer's own surfacenets.js). See docs/export-glb.md.
 *
 * SPACE. Viewer space ("scene units"): x right, y anterior (up in the top-down page view), z superior; the brain is the PLY in mm times 0.14, and
 * a blob vertex of the surface-nets output is at v * 0.5 - dim / 4. glTF space: x to the LEFT of the model's front view, y up, z front, metres.
 *   (x, y, z)_viewer -> (-x, z, y) * METRES_PER_UNIT      (a rotation, determinant +1: no mirroring)
 * 1 viewer unit = 1 / 0.14 mm of brain, so METRES_PER_UNIT = 0.001 / 0.14 (a 170 mm brain becomes about 0.17 m).
 */
import {writeGlb} from "./glb.js";

export const METRES_PER_UNIT = 0.001 / 0.14;
export const FRACTIONS = [0.25, 0.5, 0.75];
export const NOTE_ALIGNMENT = "Alignment as displayed on the Brainspell website; approximate, not for quantitative use";
export const NOTE_SOURCE = "Brainspell, activation coordinates from the Brainspell/Neurosynth-derived database";

/** viewer space -> glTF space (metres) */
export const toGltf = ([x, y, z]) => [-x * METRES_PER_UNIT, z * METRES_PER_UNIT, y * METRES_PER_UNIT];

/** Smooth vertex normals (area weighted) of an indexed triangle mesh. */
export const computeNormals = (positions, indices) => {
  const n = new Float32Array(positions.length);
  for (let t = 0; t < indices.length; t += 3) {
    const [a, b, c] = [indices[t] * 3, indices[t + 1] * 3, indices[t + 2] * 3];
    const e1 = [positions[b] - positions[a], positions[b + 1] - positions[a + 1], positions[b + 2] - positions[a + 2]];
    const e2 = [positions[c] - positions[a], positions[c + 1] - positions[a + 1], positions[c + 2] - positions[a + 2]];
    const f = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]]; // length = 2 x area
    for (const v of [a, b, c]) {
      n[v] += f[0]; n[v + 1] += f[1]; n[v + 2] += f[2];
    }
  }
  for (let i = 0; i < n.length; i += 3) {
    const l = Math.hypot(n[i], n[i + 1], n[i + 2]) || 1;
    n[i] /= l; n[i + 1] /= l; n[i + 2] /= l;
  }

  return n;
};

/** Signed volume of a closed triangle mesh: positive when the triangles are counter-clockwise seen from outside. */
export const signedVolume = (positions, indices) => {
  let v = 0;
  for (let t = 0; t < indices.length; t += 3) {
    const [a, b, c] = [indices[t] * 3, indices[t + 1] * 3, indices[t + 2] * 3];
    v += positions[a] * (positions[b + 1] * positions[c + 2] - positions[b + 2] * positions[c + 1]) -
      positions[a + 1] * (positions[b] * positions[c + 2] - positions[b + 2] * positions[c]) +
      positions[a + 2] * (positions[b] * positions[c + 1] - positions[b + 1] * positions[c]);
  }

  return v / 6;
};

export const flipWinding = (indices) => {
  const out = Array.from(indices);
  for (let t = 0; t < out.length; t += 3) {
    [out[t + 1], out[t + 2]] = [out[t + 2], out[t + 1]];
  }

  return out;
};

const unitVector = ([x, y, z]) => {
  const l = Math.hypot(x, y, z);

  return [x / l, y / l, z / l];
};

/** Direction (glTF space) from which the toon look and the brain's rim are computed: seen from above and a little from the front. */
export const VIEW_DIR = unitVector([0, 0.8, 0.6]);

const dot = (n, i, d) => n[i] * d[0] + n[i + 1] * d[1] + n[i + 2] * d[2];

/**
 * The toon shader of the viewer, baked for one viewing direction: intensity = (1 - facing)^2 quantised to 0 / 0.33 / 1;
 * colour = black * intensity + base * (1 - intensity): the centre of a surface facing the viewer is the base colour, then darker bands, then black.
 * Returns r,g,b,a (0..255) per vertex.
 */
export const bakeToon = (normals, base, alpha = 255, dir = VIEW_DIR) => {
  const out = new Uint8Array((normals.length / 3) * 4);
  for (let v = 0, i = 0; i < normals.length; i += 3, v += 4) {
    const facing = Math.max(0, Math.min(1, dot(normals, i, dir)));
    const raw = (1 - facing) ** 2;
    const k = raw > 0.33 ? (raw > 0.66 ? 1 : 0.33) : 0;
    out[v] = Math.round(base[0] * (1 - k));
    out[v + 1] = Math.round(base[1] * (1 - k));
    out[v + 2] = Math.round(base[2] * (1 - k));
    out[v + 3] = alpha;
  }

  return out;
};

/**
 * Brain colours: light grey-white with a vertex alpha (multiplied by the material's alpha, which carries the overall transparency, because some viewers
 * ignore the alpha of vertex colours) that is low where the surface faces the (top and front) viewing directions and higher at grazing angles,
 * a static version of the viewer's glow ("(1 + N.V)^2").
 */
export const brainColors = (normals, {baseAlpha = 0.5, rimAlpha = 0.5, color = [196, 202, 212]} = {}) => {
  const top = [0, 1, 0];
  const front = [0, 0, 1];
  const out = new Uint8Array((normals.length / 3) * 4);
  for (let v = 0, i = 0; i < normals.length; i += 3, v += 4) {
    const facing = Math.max(Math.abs(dot(normals, i, top)), Math.abs(dot(normals, i, front)));
    const a = baseAlpha + rimAlpha * (1 - facing) ** 2;
    out[v] = color[0]; out[v + 1] = color[1]; out[v + 2] = color[2];
    out[v + 3] = Math.round(Math.min(1, a) * 255);
  }

  return out;
};

/**
 * glTF vertex colours (COLOR_0) are LINEAR, while the colours chosen here are the ones to appear on screen (sRGB): spec-compliant viewers encode them again
 * for display. Converts r,g,b of every vertex (alpha untouched) from sRGB to linear bytes. (A viewer that does not do the gamma step, like three.js r119,
 * shows the linear values as they are: darker, still a clear red.)
 */
export const srgbToLinearColors = (colors) => {
  const out = Uint8Array.from(colors);
  for (let i = 0; i < out.length; i += 4) {
    for (let k = 0; k < 3; k++) {
      const c = out[i + k] / 255;
      out[i + k] = Math.round(255 * (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    }
  }

  return out;
};

/** Inverted hull: the mesh pushed out along its vertex normals by `distance`, with the winding reversed (seen from outside only the far side shows). */
export const outlineHull = (positions, normals, indices, distance) => {
  const p = new Float32Array(positions.length);
  for (let i = 0; i < p.length; i++) {
    p[i] = positions[i] + normals[i] * distance;
  }

  return {positions: p, indices: flipWinding(indices)};
};

export const slug = (query, max = 40) => {
  const s = String(query === null || typeof query === "undefined" ? "" : query)
    .normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, max).replace(/-+$/g, "");

  return s || "search";
};

/** brainspell-<slug>-<N>papers.glb : letters, digits and hyphens only */
export const exportFilename = (query, papers) => `brainspell-${slug(query)}-${Math.max(0, Number(papers) || 0)}papers.glb`;

const toGltfArray = (positions) => {
  const out = new Float32Array(positions.length);
  for (let i = 0; i < positions.length; i += 3) {
    const g = toGltf([positions[i], positions[i + 1], positions[i + 2]]);
    out[i] = g[0]; out[i + 1] = g[1]; out[i + 2] = g[2];
  }

  return out;
};

/**
 * One level of the map: the surface-nets mesh of the volume at `level`, in viewer scene units (v * 0.5 - dim / 4), outward oriented.
 * Returns null when the level has no surface.
 */
export const levelSurface = ({data, dim, level, surfaceNets}) => {
  const res = surfaceNets({dim, datatype: undefined, pixdim: [1, 1, 1], level, data});
  if (!res.faces.length) {
    return null;
  }
  const positions = new Float32Array(res.vertices.length * 3);
  res.vertices.forEach((v, i) => {
    positions[i * 3] = v[0] * 0.5 - dim[0] / 4;
    positions[i * 3 + 1] = v[1] * 0.5 - dim[1] / 4;
    positions[i * 3 + 2] = v[2] * 0.5 - dim[2] / 4;
  });
  let indices = res.faces.filter((f) => f.length === 3).flat();
  res.faces.filter((f) => f.length === 4).forEach((f) => indices.push(f[0], f[1], f[2], f[0], f[2], f[3]));
  if (signedVolume(positions, indices) < 0) {
    indices = flipWinding(indices);
  }

  return {positions, indices};
};

/** The level of a fraction of the strongest region, as the viewer computes it. */
export const levelValue = (max, fraction) => max * fraction + max / 1000;

const REDS = {
  25: {base: [255, 150, 150], alpha: 0.22},
  50: {base: [235, 20, 20], alpha: 1},
  75: {base: [190, 0, 0], alpha: 1}
};

/**
 * The meshes of the model.
 *   brain: {positions: Float32Array (viewer units), indices}
 *   field: {data, dim, max}  (the smoothed volume of the map and the strongest count)
 *   surfaceNets: ({dim, datatype, pixdim, level, data}) -> {vertices, faces}
 * Throws when the map is empty.
 */
export const buildMeshes = ({brain, field, surfaceNets, fractions = FRACTIONS, outlineDistance = 0.03}) => {
  if (!field || !(field.max > 0)) {
    throw new Error("The map is empty: there is nothing to export");
  }
  const meshes = [];
  const brainNormals = computeNormals(brain.positions, brain.indices);
  const bp = toGltfArray(brain.positions);
  const bn = toGltfArray(brainNormals); // normals rotate like positions (scale does not change the direction)
  const bnUnit = new Float32Array(bn.length);
  for (let i = 0; i < bn.length; i += 3) {
    const l = Math.hypot(bn[i], bn[i + 1], bn[i + 2]) || 1;
    bnUnit[i] = bn[i] / l; bnUnit[i + 1] = bn[i + 1] / l; bnUnit[i + 2] = bn[i + 2] / l;
  }
  for (const fraction of fractions) {
    const pct = Math.round(fraction * 100);
    const surface = levelSurface({data: field.data, dim: field.dim, level: levelValue(field.max, fraction), surfaceNets});
    if (!surface) {
      continue;
    }
    const normals = computeNormals(surface.positions, surface.indices);
    const look = REDS[pct] || REDS[50];
    const gp = toGltfArray(surface.positions);
    const gn = toGltfArray(normals);
    for (let i = 0; i < gn.length; i += 3) {
      const l = Math.hypot(gn[i], gn[i + 1], gn[i + 2]) || 1;
      gn[i] /= l; gn[i + 1] /= l; gn[i + 2] /= l;
    }
    const transparent = look.alpha < 1;
    meshes.push({
      name: `level_${pct}`, positions: gp, indices: surface.indices, colors: srgbToLinearColors(bakeToon(gn, look.base, 255)),
      material: {name: `level_${pct}`, baseColor: [1, 1, 1, look.alpha], unlit: true, alphaMode: transparent ? "BLEND" : "OPAQUE", doubleSided: transparent}
    });
    if (!transparent) {
      const hull = outlineHull(surface.positions, normals, surface.indices, outlineDistance);
      const black = new Uint8Array((hull.positions.length / 3) * 4);
      for (let i = 3; i < black.length; i += 4) {
        black[i] = 255;
      }
      meshes.push({
        name: `level_${pct}_outline`, positions: toGltfArray(hull.positions), indices: hull.indices, colors: black,
        material: {name: "outline", baseColor: [1, 1, 1, 1], unlit: true, alphaMode: "OPAQUE", doubleSided: false}
      });
    }
  }

  // The brain is the LAST node: transparent objects with the same distance are drawn in file order, and a viewer that writes depth for transparent
  // surfaces (three.js does) would hide the inner shell behind the brain if the brain came first.
  meshes.push({
    name: "brain", positions: bp, indices: Array.from(brain.indices), colors: srgbToLinearColors(brainColors(bnUnit)),
    material: {name: "brain", baseColor: [1, 1, 1, 0.4], unlit: true, alphaMode: "BLEND", doubleSided: true}
  });

  return meshes;
};

/** Everything: meshes, extras and the GLB bytes. meta: {query, papers, total, sliderPercent, created?: Date} */
export const buildGlb = ({brain, field, surfaceNets, meta, fractions = FRACTIONS}) => {
  const meshes = buildMeshes({brain, field, surfaceNets, fractions});
  const extras = {
    query: String(meta.query || ""),
    papersUsed: meta.papers,
    papersMatching: meta.total,
    sliderLevelPercent: meta.sliderPercent,
    levelFractions: fractions,
    created: (meta.created || new Date()).toISOString(),
    alignment: NOTE_ALIGNMENT,
    source: NOTE_SOURCE,
    units: "metres; +Y up (superior), +Z front (anterior), +X to the model's left (the subject's right)"
  };

  return writeGlb({meshes, asset: {extras}, sceneName: "Brainspell coactivation map", sceneExtras: extras});
};

/** The bounding box of all meshes, [min, max] in metres */
export const boundingBox = (meshes) => {
  const mn = [Infinity, Infinity, Infinity];
  const mx = [-Infinity, -Infinity, -Infinity];
  for (const m of meshes) {
    for (let i = 0; i < m.positions.length; i += 3) {
      for (let k = 0; k < 3; k++) {
        mn[k] = Math.min(mn[k], m.positions[i + k]);
        mx[k] = Math.max(mx[k], m.positions[i + k]);
      }
    }
  }

  return [mn, mx];
};
