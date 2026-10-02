#!/usr/bin/env node
/**
 * @file scripts/generate-models.mjs
 * @description Generates the game's GLB model assets with ZERO dependencies.
 *
 * WHY THIS EXISTS
 * ───────────────
 * The renderer loads characters and props through GLTFLoader (see
 * src/game/AssetLoader.ts). Real art assets need an artist; this script is the
 * stopgap that keeps the pipeline honest: it emits *real* glTF 2.0 binary
 * containers that GLTFLoader parses exactly like an exported Blender file, so
 * dropping in a professionally authored `survivor.glb` later is a file
 * replacement, not a code change.
 *
 * Two properties of the output matter to the runtime and are therefore part of
 * the contract:
 *
 *  1. NODE NAMES. The survivor hierarchy exposes `leftArm`, `rightArm`,
 *     `leftLeg`, `rightLeg`, `leftCalf`, `rightCalf` and `head` as separate
 *     nodes, pivoted exactly where `Characters.updateRunAnimation()` rotates
 *     them. Character.ts animates those nodes procedurally; a model without
 *     them still renders, it just will not move its limbs.
 *  2. PIVOT-LOCAL GEOMETRY. Every limb's vertices are baked relative to its own
 *     joint, so the mesh can be rotated around the shoulder/hip/knee without
 *     any extra compensation transform.
 *
 * WHY VERTEX COLORS
 * ─────────────────
 * `COLOR_0` lets one mesh carry skin, shirt, trousers and leather without
 * splitting into sub-materials — which is what keeps a limb a single Mesh node
 * (rotatable) and the 20-strong zombie horde a single InstancedMesh draw call.
 *
 * GEOMETRY BUDGET
 * ───────────────
 * Everything is flat-shaded low-poly (boxes, elliptical tubes, spheres), which
 * suits the grim visual target and keeps each file in the low kilobytes.
 *
 * USAGE
 * ─────
 *   node packages/client/scripts/generate-models.mjs
 * Writes packages/client/public/models/{survivor,zombie,environment}.glb
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE     = dirname(fileURLToPath(import.meta.url));
const OUT_DIR  = join(HERE, '..', 'public', 'models');

// ─── Math ─────────────────────────────────────────────────────────────────────

const D2R = Math.PI / 180;

/**
 * Builds a rigid transform: rotation applied Rz → Rx → Ry, then translation.
 * Returned as cached sin/cos pairs so a shape can transform thousands of
 * vertices without recomputing trigonometry.
 */
function frame({ rx = 0, ry = 0, rz = 0, tx = 0, ty = 0, tz = 0 } = {}) {
  return {
    sx: Math.sin(rx), cx: Math.cos(rx),
    sy: Math.sin(ry), cy: Math.cos(ry),
    sz: Math.sin(rz), cz: Math.cos(rz),
    tx, ty, tz,
  };
}

function applyFrame(f, p) {
  if (!f) return p;
  let [x, y, z] = p;

  // Rz
  const x1 = x * f.cz - y * f.sz;
  const y1 = x * f.sz + y * f.cz;

  // Rx
  const y2 = y1 * f.cx - z * f.sx;
  const z2 = y1 * f.sx + z * f.cx;

  // Ry
  const x3 = x1 * f.cy + z2 * f.sy;
  const z3 = -x1 * f.sy + z2 * f.cy;

  return [x3 + f.tx, y2 + f.ty, z3 + f.tz];
}

/** sRGB → linear. glTF COLOR_0 is defined in linear space. */
const lin = (c) => Math.pow(Math.max(0, Math.min(1, c)), 2.2);

/** Packs an sRGB triple into a linear-space color, optionally shaded. */
function col(r, g, b, shade = 1) {
  return [lin(r * shade), lin(g * shade), lin(b * shade)];
}

function faceNormal(a, b, c) {
  const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
  const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
  let nx = uy * vz - uz * vy;
  let ny = uz * vx - ux * vz;
  let nz = ux * vy - uy * vx;
  const len = Math.hypot(nx, ny, nz);
  if (len < 1e-9) return [0, 1, 0];   // degenerate face — never emit NaN
  nx /= len; ny /= len; nz /= len;
  return [nx, ny, nz];
}

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

// ─── Mesh Builder ─────────────────────────────────────────────────────────────

/**
 * Accumulates flat-shaded triangles plus per-vertex colors, then serialises
 * into tightly packed typed arrays. Flat shading is deliberate: it is what
 * gives the low-poly faceted read under the corridor's key light.
 */
class Builder {
  constructor() {
    this.pos = [];
    this.nrm = [];
    this.col = [];
    this.idx = [];
    this._faces = [];   // for the convexity self-check
  }

  get vertexCount() { return this.pos.length / 3; }

  tri(a, b, c, color) {
    const n = faceNormal(a, b, c);
    const base = this.vertexCount;

    for (const p of [a, b, c]) {
      this.pos.push(p[0], p[1], p[2]);
      this.nrm.push(n[0], n[1], n[2]);
      this.col.push(color[0], color[1], color[2]);
    }
    this.idx.push(base, base + 1, base + 2);
    this._faces.push({ n, centroid: [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3] });
  }

  /** Quad in counter-clockwise (outward-normal) winding: a→b→c→d. */
  quad(a, b, c, d, color) {
    this.tri(a, b, c, color);
    this.tri(a, c, d, color);
  }

  serialise() {
    return {
      pos: new Float32Array(this.pos),
      nrm: new Float32Array(this.nrm),
      col: new Float32Array(this.col),
      idx: new Uint16Array(this.idx),
    };
  }
}

/**
 * Every primitive below is convex, so "outward" has an unambiguous meaning:
 * each face normal must point away from the shape's own centre. Verifying it
 * numerically here catches winding mistakes at build time instead of as an
 * invisible/culled mesh in the browser.
 */
function assertConvexOutward(builder, center, label) {
  let bad = 0;
  for (const f of builder._faces) {
    if (dot(f.n, sub(f.centroid, center)) <= 0) bad++;
  }
  if (bad > 0) {
    throw new Error(`${label}: ${bad} face(s) wound inward — geometry would be culled`);
  }
}

// ─── Primitive Shapes ─────────────────────────────────────────────────────────

/**
 * Axis-aligned box. Winding is derived from an orthonormal basis per face
 * (t1 × t2 = n) rather than hand-listed corners, which is what makes the
 * outward orientation provable instead of hopeful.
 */
function box(b, { w, h, d, col: color, f = null, x = 0, y = 0, z = 0 }) {
  const hx = w / 2, hy = h / 2, hz = d / 2;
  const local = new Builder();

  const faces = [
    { n: [ 1, 0, 0], t1: [0, 0, -1], t2: [0, 1, 0] },
    { n: [-1, 0, 0], t1: [0, 0,  1], t2: [0, 1, 0] },
    { n: [0,  1, 0], t1: [1, 0, 0], t2: [0, 0, -1] },
    { n: [0, -1, 0], t1: [1, 0, 0], t2: [0, 0,  1] },
    { n: [0, 0,  1], t1: [1, 0, 0], t2: [0, 1, 0] },
    { n: [0, 0, -1], t1: [-1, 0, 0], t2: [0, 1, 0] },
  ];

  const extent = (v) => Math.abs(v[0]) * hx + Math.abs(v[1]) * hy + Math.abs(v[2]) * hz;

  for (const face of faces) {
    const e = extent(face.n), e1 = extent(face.t1), e2 = extent(face.t2);
    const c = [face.n[0] * e, face.n[1] * e, face.n[2] * e];
    const corner = (s1, s2) => [
      c[0] + face.t1[0] * e1 * s1 + face.t2[0] * e2 * s2,
      c[1] + face.t1[1] * e1 * s1 + face.t2[1] * e2 * s2,
      c[2] + face.t1[2] * e1 * s1 + face.t2[2] * e2 * s2,
    ];
    // Faces away from the key light sit a touch darker — cheap AO-ish read.
    const shade = face.n[1] > 0 ? 1.12 : face.n[1] < 0 ? 0.72 : 0.94;
    const tinted = color.map((c) => c * shade);
    local.quad(corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1), tinted);
  }

  assertConvexOutward(local, [0, 0, 0], 'box');

  const t = f ? (p) => applyFrame(f, [p[0] + x, p[1] + y, p[2] + z]) : (p) => [p[0] + x, p[1] + y, p[2] + z];
  appendTransformed(b, local, t);
}

/**
 * Truncated elliptical tube along +Y — the workhorse for torsos, limbs and
 * barrels. `r0`/`r1` may be numbers or [rx, rz] pairs.
 */
function tube(b, {
  y0, y1, r0, r1, seg = 8, col: color,
  cx = 0, cz = 0, f = null,
  capTop = true, capBottom = true,
}) {
  // The winding rule below is defined for a shape that grows upward. Normalise
  // the arguments here so callers can describe a limb top-down (`y1 < y0`)
  // without inverting every face normal and culling the mesh.
  if (y1 < y0) {
    const swapY = y0; y0 = y1; y1 = swapY;
    const swapR = r0; r0 = r1; r1 = swapR;
  }

  const R0 = Array.isArray(r0) ? r0 : [r0, r0];
  const R1 = Array.isArray(r1) ? r1 : [r1, r1];
  const local = new Builder();

  const P = (a, y, R) => [cx + R[0] * Math.cos(a), y, cz + R[1] * Math.sin(a)];

  // Lateral surface — verified outward winding: bottom@a0 → top@a0 → top@a1 → bottom@a1
  for (let i = 0; i < seg; i++) {
    const a0 = (i / seg) * Math.PI * 2;
    const a1 = ((i + 1) / seg) * Math.PI * 2;
    const shade = 0.86 + 0.14 * Math.cos(a0 - Math.PI / 4);   // fake directional light
    local.quad(
      P(a0, y0, R0), P(a0, y1, R1), P(a1, y1, R1), P(a1, y0, R0),
      color.map((c) => c * shade),
    );
  }

  // Caps — fans whose winding follows the same rule as a fully-flat box face.
  if (capTop) {
    const top = [cx, y1, cz];
    for (let i = 0; i < seg; i++) {
      const a0 = (i / seg) * Math.PI * 2;
      const a1 = ((i + 1) / seg) * Math.PI * 2;
      local.tri(top, P(a1, y1, R1), P(a0, y1, R1), color.map((c) => c * 1.05));
    }
  }
  if (capBottom) {
    const bottom = [cx, y0, cz];
    for (let i = 0; i < seg; i++) {
      const a0 = (i / seg) * Math.PI * 2;
      const a1 = ((i + 1) / seg) * Math.PI * 2;
      local.tri(bottom, P(a0, y0, R0), P(a1, y0, R0), color.map((c) => c * 0.6));
    }
  }

  assertConvexOutward(local, [cx, (y0 + y1) / 2, cz], 'tube');
  appendTransformed(b, local, f ? (p) => applyFrame(f, p) : null);
}

/**
 * Low-poly UV sphere, optionally squashed, centred on [cx, cy, cz].
 *
 * `rings` counts latitude divisions: the interior rings sit at
 * -π/2 + i·π/rings, the bands connect consecutive interior rings, and the caps
 * are fans up to the two poles. Building the poles as fans (rather than letting
 * a band collapse to a degenerate ring of zero radius) is what keeps the face
 * normals well-defined at the top and bottom.
 */
function sphere(b, { r, seg = 10, rings = 6, col: color, cx = 0, cy = 0, cz = 0, sq = [1, 1, 1], f = null }) {
  const local = new Builder();
  const [qx, qy, qz] = sq;

  const latOf = (i) => -Math.PI / 2 + (i / rings) * Math.PI;
  const P = (a, lat) => {
    const rr = Math.cos(lat);
    return [cx + r * rr * Math.cos(a) * qx, cy + r * Math.sin(lat) * qy, cz + r * rr * Math.sin(a) * qz];
  };

  // Latitude bands between interior rings
  for (let i = 1; i < rings - 1; i++) {
    const lat0 = latOf(i);
    const lat1 = latOf(i + 1);
    for (let j = 0; j < seg; j++) {
      const a0 = (j / seg) * Math.PI * 2;
      const a1 = ((j + 1) / seg) * Math.PI * 2;
      const shade = 0.85 + 0.15 * Math.cos(a0 - Math.PI / 4);
      local.quad(
        P(a0, lat0), P(a0, lat1), P(a1, lat1), P(a1, lat0),
        color.map((c) => c * shade),
      );
    }
  }

  // Pole fans — same winding rule as a flat cap (centre, a1, a0) for the top.
  const latBottom = latOf(1);
  const latTop    = latOf(rings - 1);
  const top       = [cx, cy + r * qy, cz];
  const bottom    = [cx, cy - r * qy, cz];

  for (let j = 0; j < seg; j++) {
    const a0 = (j / seg) * Math.PI * 2;
    const a1 = ((j + 1) / seg) * Math.PI * 2;
    local.tri(top,    P(a1, latTop),    P(a0, latTop),    color.map((c) => c * 1.08));
    local.tri(bottom, P(a0, latBottom), P(a1, latBottom), color.map((c) => c * 0.62));
  }

  assertConvexOutward(local, [cx, cy, cz], 'sphere');
  appendTransformed(b, local, f ? (p) => applyFrame(f, p) : null);
}

/** Copies a built shape into the destination builder, applying an optional transform. */
function appendTransformed(dest, src, transform) {
  const base = dest.vertexCount;
  for (let i = 0; i < src.vertexCount; i++) {
    const p = [src.pos[i * 3], src.pos[i * 3 + 1], src.pos[i * 3 + 2]];
    const q = transform ? transform(p) : p;
    dest.pos.push(q[0], q[1], q[2]);
    dest.nrm.push(src.nrm[i * 3], src.nrm[i * 3 + 1], src.nrm[i * 3 + 2]);
    dest.col.push(src.col[i * 3], src.col[i * 3 + 1], src.col[i * 3 + 2]);
  }
  for (const index of src.idx) dest.idx.push(base + index);
  dest._faces.push(...src._faces.map((face) => ({
    n: face.n,
    centroid: transform ? transform(face.centroid) : face.centroid,
  })));
}

/** Deterministic PRNG so regenerating the models produces identical bytes. */
function makeRandom(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

// ─── GLB Writer ───────────────────────────────────────────────────────────────

const COMPONENT_FLOAT  = 5126;
const COMPONENT_USHORT = 5123;
const TARGET_ARRAY     = 34962;
const TARGET_INDEX     = 34963;

/**
 * Serialises meshes + a node hierarchy into a glTF 2.0 binary container.
 * The JSON and BIN chunks are each padded to a 4-byte boundary, as the spec
 * requires, and every accessor's byteOffset lands on its component size.
 */
function buildGLB({ name, materials, meshes, nodes, root = 0 }) {
  const binParts  = [];
  const bufferViews = [];
  const accessors   = [];
  let byteLength = 0;

  const pushView = (buffer, target) => {
    const pad = (4 - (buffer.length % 4)) % 4;
    bufferViews.push({ buffer: 0, byteOffset: byteLength, byteLength: buffer.length, target });
    binParts.push(buffer);
    if (pad) binParts.push(Buffer.alloc(pad, 0));
    byteLength += buffer.length + pad;
    return bufferViews.length - 1;
  };

  const gltfMeshes = meshes.map((mesh, meshIndex) => {
    const g = mesh.builder.serialise();

    const posView = pushView(Buffer.from(g.pos.buffer, g.pos.byteOffset, g.pos.byteLength), TARGET_ARRAY);
    const nrmView = pushView(Buffer.from(g.nrm.buffer, g.nrm.byteOffset, g.nrm.byteLength), TARGET_ARRAY);
    const colView = pushView(Buffer.from(g.col.buffer, g.col.byteOffset, g.col.byteLength), TARGET_ARRAY);
    const idxView = pushView(Buffer.from(g.idx.buffer, g.idx.byteOffset, g.idx.byteLength), TARGET_INDEX);

    // POSITION accessors are required to declare their bounding box.
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < g.pos.length; i += 3) {
      for (let axis = 0; axis < 3; axis++) {
        min[axis] = Math.min(min[axis], g.pos[i + axis]);
        max[axis] = Math.max(max[axis], g.pos[i + axis]);
      }
    }

    const posAcc = accessors.push({
      bufferView: posView, componentType: COMPONENT_FLOAT, count: g.pos.length / 3, type: 'VEC3', min, max,
    }) - 1;
    const nrmAcc = accessors.push({
      bufferView: nrmView, componentType: COMPONENT_FLOAT, count: g.nrm.length / 3, type: 'VEC3',
    }) - 1;
    const colAcc = accessors.push({
      bufferView: colView, componentType: COMPONENT_FLOAT, count: g.col.length / 3, type: 'VEC3',
    }) - 1;
    const idxAcc = accessors.push({
      bufferView: idxView, componentType: COMPONENT_USHORT, count: g.idx.length, type: 'SCALAR',
    }) - 1;

    return {
      name: mesh.name,
      primitives: [{
        attributes: { POSITION: posAcc, NORMAL: nrmAcc, COLOR_0: colAcc },
        indices: idxAcc,
        material: mesh.material ?? 0,
        mode: 4,
      }],
      extras: { meshIndex },
    };
  });

  const gltf = {
    asset: { version: '2.0', generator: 'zombierun generate-models.mjs' },
    scene: 0,
    scenes: [{ name, nodes: [root] }],
    nodes,
    meshes: gltfMeshes,
    materials,
    accessors,
    bufferViews,
    buffers: [{ byteLength }],
  };

  // ── Chunk assembly ─────────────────────────────────────────────────────────
  let json = Buffer.from(JSON.stringify(gltf), 'utf8');
  if (json.length % 4 !== 0) json = Buffer.concat([json, Buffer.alloc(4 - (json.length % 4), 0x20)]);
  const bin = Buffer.concat(binParts);
  const binPadded = bin.length % 4 === 0 ? bin : Buffer.concat([bin, Buffer.alloc(4 - (bin.length % 4), 0)]);

  const total = 12 + 8 + json.length + 8 + binPadded.length;
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0);   // 'glTF'
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(total, 8);

  const jsonHeader = Buffer.alloc(8);
  jsonHeader.writeUInt32LE(json.length, 0);
  jsonHeader.writeUInt32LE(0x4e4f534a, 4);   // 'JSON'

  const binHeader = Buffer.alloc(8);
  binHeader.writeUInt32LE(binPadded.length, 0);
  binHeader.writeUInt32LE(0x004e4942, 4);    // 'BIN'

  return Buffer.concat([header, jsonHeader, json, binHeader, binPadded]);
}

// ─── Shared materials ─────────────────────────────────────────────────────────

const MAT_CHARACTER = {
  name: 'character_mat',
  pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 1], metallicFactor: 0.05, roughnessFactor: 0.82 },
  // A whisper of emissive keeps the characters readable in the deliberately
  // near-black corridor without washing the vertex colors out.
  emissiveFactor: [0.045, 0.04, 0.035],
};

const MAT_PROP = {
  name: 'env_prop_mat',
  pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 1], metallicFactor: 0.25, roughnessFactor: 0.85 },
  emissiveFactor: [0.02, 0.02, 0.025],
};

const MAT_LAMP = {
  name: 'lamp_glass_mat',
  pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 1], metallicFactor: 0.0, roughnessFactor: 0.35 },
  emissiveFactor: [1.0, 0.82, 0.45],
};

// ─── Survivor ─────────────────────────────────────────────────────────────────

const SKIN  = col(0.91, 0.69, 0.52);
const SHIRT = col(0.33, 0.55, 0.27);
const PANTS = col(0.20, 0.20, 0.31);
const BOOT  = col(0.40, 0.28, 0.18);
const GEAR  = col(0.19, 0.20, 0.22);
const HAIR  = col(0.14, 0.10, 0.08);

/**
 * Pivots are copied verbatim from the retired primitive rig so that the camera
 * framing, the ground contact and the limb animation amplitudes all remain
 * exactly as tuned.
 */
function buildSurvivor() {
  const torso = new Builder();

  // Hips → chest, elliptical (0.45 wide × 0.22 deep at the shoulders).
  tube(torso, { y0: 0.02, y1: 0.53, r0: [0.185, 0.10], r1: [0.225, 0.11], seg: 10, col: SHIRT });
  // Neck
  tube(torso, { y0: 0.53, y1: 0.63, r0: 0.062, r1: 0.058, seg: 8, col: SKIN });
  // Harness / backpack — silhouette interest over the torso
  box(torso, { w: 0.30, h: 0.34, d: 0.14, col: GEAR, y: 0.35, z: -0.16 });
  box(torso, { w: 0.36, h: 0.06, d: 0.20, col: GEAR, y: 0.45, z: -0.09, f: frame({ rx: 4 * D2R }) });
  // Shoulder pads
  box(torso, { w: 0.13, h: 0.07, d: 0.20, col: GEAR, x: -0.235, y: 0.52 });
  box(torso, { w: 0.13, h: 0.07, d: 0.20, col: GEAR, x:  0.235, y: 0.52 });
  // Chest strap
  box(torso, { w: 0.07, h: 0.42, d: 0.03, col: col(0.35, 0.24, 0.15), x: -0.06, y: 0.30, z: -0.115, f: frame({ rz: 18 * D2R }) });

  const head = new Builder();
  sphere(head, { r: 0.155, seg: 12, rings: 7, cy: 0.79, sq: [0.98, 1.10, 1.04], col: SKIN });
  box(head, { w: 0.20, h: 0.09, d: 0.19, col: SKIN, y: 0.685, z: 0.02 });          // jaw
  box(head, { w: 0.24, h: 0.08, d: 0.22, col: HAIR, y: 0.90 });                    // cropped hair
  box(head, { w: 0.26, h: 0.05, d: 0.18, col: GEAR, y: 0.885, z: -0.03, f: frame({ rx: 6 * D2R }) }); // bandana
  box(head, { w: 0.05, h: 0.05, d: 0.05, col: SKIN, x: 0, y: 0.775, z: 0.155 });   // nose

  /** Arm: joint at the shoulder, geometry hanging along -Y in joint space. */
  function buildArm(side) {
    const arm = new Builder();
    sphere(arm, { r: 0.072, seg: 10, rings: 6, sq: [1, 0.9, 1], col: SHIRT });
    tube(arm, { y0: -0.03, y1: -0.235, r0: 0.062, r1: 0.052, seg: 8, col: SHIRT });  // upper arm
    tube(arm, { y0: -0.24, y1: -0.44, r0: 0.049, r1: 0.043, seg: 8, col: SKIN });    // forearm (rolled sleeve)
    box(arm, { w: 0.085, h: 0.10, d: 0.06, col: col(0.24, 0.16, 0.10), y: -0.475 });  // fist / glove
    box(arm, { w: 0.075, h: 0.05, d: 0.09, col: col(0.30, 0.32, 0.34), y: -0.30, x: side * 0.02, z: 0.055 }); // wrist guard
    return arm;
  }

  /** Thigh in hip-joint space. */
  function buildThigh() {
    const thigh = new Builder();
    sphere(thigh, { r: 0.088, seg: 10, rings: 6, sq: [1, 0.85, 1], col: PANTS });
    tube(thigh, { y0: -0.02, y1: -0.38, r0: 0.086, r1: 0.068, seg: 8, col: PANTS });
    return thigh;
  }

  /** Calf + boot in knee-joint space. */
  function buildCalf() {
    const calf = new Builder();
    tube(calf, { y0: 0.01, y1: -0.36, r0: 0.069, r1: 0.052, seg: 8, col: PANTS });
    box(calf, { w: 0.155, h: 0.13, d: 0.235, col: BOOT, y: -0.395, z: 0.035 });       // boot
    box(calf, { w: 0.16, h: 0.045, d: 0.30, col: col(0.12, 0.11, 0.11), y: -0.465, z: 0.045 }); // sole
    return calf;
  }

  // Mesh order defines the node/mesh indices below.
  const meshes = [
    { name: 'survivor_torso', builder: torso },
    { name: 'survivor_head',  builder: head },
    { name: 'survivor_arm_L', builder: buildArm(-1) },
    { name: 'survivor_arm_R', builder: buildArm(1) },
    { name: 'survivor_thigh_L', builder: buildThigh() },
    { name: 'survivor_thigh_R', builder: buildThigh() },
    { name: 'survivor_calf_L', builder: buildCalf() },
    { name: 'survivor_calf_R', builder: buildCalf() },
  ];

  // Node indices: 0 root, 1 torso, 2 head, 3 armL, 4 armR, 5 legL, 6 legR, 7 calfL, 8 calfR
  const nodes = [
    { name: 'survivor',      children: [1, 2, 3, 4, 5, 6] },
    { name: 'torso',         mesh: 0 },
    { name: 'head',          mesh: 1 },
    { name: 'leftArm',       mesh: 2, translation: [-0.285, 0.54, 0] },
    { name: 'rightArm',      mesh: 3, translation: [ 0.285, 0.54, 0] },
    { name: 'leftLeg',       mesh: 4, translation: [-0.14, 0, 0], children: [7] },
    { name: 'rightLeg',      mesh: 5, translation: [ 0.14, 0, 0], children: [8] },
    { name: 'leftCalf',      mesh: 6, translation: [0, -0.38, 0] },
    { name: 'rightCalf',     mesh: 7, translation: [0, -0.38, 0] },
  ];

  return buildGLB({ name: 'survivor', materials: [MAT_CHARACTER], meshes, nodes, root: 0 });
}

// ─── Zombie ───────────────────────────────────────────────────────────────────

const Z_SKIN  = col(0.42, 0.55, 0.30);
const Z_ROT   = col(0.30, 0.36, 0.22);
const Z_CLOTH = col(0.24, 0.25, 0.30);
const Z_BLOOD = col(0.34, 0.08, 0.07);

/**
 * The horde renders from a single InstancedMesh, so the zombie has to be ONE
 * merged mesh. Feet sit at local y = 0 (the instance matrix places the horde on
 * the floor) and it faces +Z — the direction it shambles in.
 */
function buildZombie() {
  const b = new Builder();

  // Hunched torso — the forward lean is baked into the geometry.
  tube(b, { y0: 0.86, y1: 1.44, r0: [0.20, 0.11], r1: [0.235, 0.115], seg: 10, col: Z_CLOTH, f: frame({ rx: -9 * D2R }) });
  // Ribcage hump so the silhouette is not a straight tube
  sphere(b, { r: 0.16, seg: 10, rings: 6, cy: 1.40, cz: -0.02, sq: [1.25, 0.8, 0.95], col: Z_SKIN });
  // Hips
  tube(b, { y0: 0.72, y1: 0.88, r0: [0.17, 0.105], r1: [0.19, 0.11], seg: 10, col: Z_CLOTH });
  // Torn shirt patches / exposed flesh
  box(b, { w: 0.30, h: 0.22, d: 0.05, col: Z_BLOOD, y: 1.20, z: 0.115 });
  box(b, { w: 0.16, h: 0.14, d: 0.05, col: Z_SKIN,  y: 1.05, z: 0.10 });

  // Head, thrown forward
  sphere(b, { r: 0.145, seg: 10, rings: 6, cy: 1.60, cz: 0.10, sq: [0.95, 1.02, 0.98], col: Z_ROT });
  box(b, { w: 0.19, h: 0.09, d: 0.17, col: Z_ROT, y: 1.50, z: 0.155 });            // slack jaw
  box(b, { w: 0.05, h: 0.05, d: 0.03, col: col(0.85, 0.88, 0.72), x: -0.055, y: 1.625, z: 0.235 }); // eye
  box(b, { w: 0.05, h: 0.05, d: 0.03, col: col(0.85, 0.88, 0.72), x:  0.055, y: 1.625, z: 0.235 });

  // Arms reaching forward (+Z), slightly down
  for (const side of [-1, 1]) {
    const armFrame = frame({ rx: -72 * D2R, ry: side * 12 * D2R, tx: side * 0.27, ty: 1.38, tz: 0.02 });
    tube(b, { y0: 0, y1: -0.33, r0: 0.062, r1: 0.055, seg: 8, col: Z_SKIN, f: armFrame });
    tube(b, { y0: -0.33, y1: -0.62, r0: 0.052, r1: 0.045, seg: 8, col: Z_ROT, f: armFrame });
    box(b,  { w: 0.085, h: 0.14, d: 0.075, col: Z_ROT, f: frame({ rx: -72 * D2R, ry: side * 12 * D2R, tx: side * 0.27, ty: 1.38, tz: 0.02, rz: 0 }), y: -0.70 });
  }

  // Legs: bent knee, wide shamble stance
  for (const side of [-1, 1]) {
    const hipX = side * 0.115;
    tube(b, { y0: 0.75, y1: 0.36, r0: 0.095, r1: 0.075, seg: 8, col: Z_CLOTH, f: frame({ rx: 10 * D2R, rz: side * -4 * D2R, tx: hipX }) });
    tube(b, { y0: 0.36, y1: 0.06, r0: 0.076, r1: 0.058, seg: 8, col: Z_ROT,   f: frame({ rx: -12 * D2R, tx: hipX, tz: 0.03 }) });
    box(b,  { w: 0.15, h: 0.070, d: 0.27, col: col(0.13, 0.12, 0.12), x: hipX, y: 0.035, z: 0.05 });
  }

  return buildGLB({
    name: 'zombie',
    materials: [MAT_CHARACTER],
    meshes: [{ name: 'zombie_body', builder: b }],
    nodes: [{ name: 'zombie', mesh: 0 }],
    root: 0,
  });
}

// ─── Environment ──────────────────────────────────────────────────────────────

const RUST     = col(0.45, 0.26, 0.16);
const RUST_DK  = col(0.28, 0.18, 0.13);
const WOOD     = col(0.44, 0.31, 0.18);
const WOOD_DK  = col(0.30, 0.21, 0.13);
const CONCRETE = col(0.42, 0.42, 0.45);
const STEEL    = col(0.34, 0.36, 0.41);

/**
 * Three reusable props, exported as separate named meshes so Terrain can drive
 * each one from its own InstancedMesh pool:
 *   - `cluster`  floor clutter (barrel + crate + rubble) — 1 draw call
 *   - `conduit`  long wall duct
 *   - `lamp`     ceiling light housing (own emissive material)
 */
function buildEnvironment() {
  // ── cluster ────────────────────────────────────────────────────────────────
  const cluster = new Builder();
  const rnd = makeRandom(0x5eed);

  // Barrel
  tube(cluster, { y0: 0.02, y1: 0.86, r0: 0.29, r1: 0.29, seg: 12, col: RUST, cx: 0.52, cz: 0.0 });
  tube(cluster, { y0: 0.16, y1: 0.26, r0: 0.305, r1: 0.305, seg: 12, col: RUST_DK, cx: 0.52, cz: 0.0 });
  tube(cluster, { y0: 0.60, y1: 0.70, r0: 0.305, r1: 0.305, seg: 12, col: RUST_DK, cx: 0.52, cz: 0.0 });
  tube(cluster, { y0: 0.86, y1: 0.90, r0: 0.30, r1: 0.24, seg: 12, col: col(0.30, 0.19, 0.13), cx: 0.52, cz: 0.0 });

  // Crate (rotated so repeated instances do not read as a grid)
  const crateFrame = frame({ ry: -24 * D2R, tx: -0.42, ty: 0.36, tz: 0.18 });
  box(cluster, { w: 0.70, h: 0.70, d: 0.70, col: WOOD, f: crateFrame });
  for (const s of [-1, 1]) {
    box(cluster, { w: 0.72, h: 0.07, d: 0.07, col: WOOD_DK, f: crateFrame, y: 0.30 * s });
    box(cluster, { w: 0.07, h: 0.07, d: 0.72, col: WOOD_DK, f: crateFrame, y: 0.30 * s });
  }

  // Rubble: deterministic scatter of chunks
  for (let i = 0; i < 9; i++) {
    const s = 0.10 + rnd() * 0.16;
    box(cluster, {
      w: s, h: s * 0.75, d: s,
      col: CONCRETE.map((c) => c * (0.7 + rnd() * 0.5)),
      x: -1.0 + rnd() * 2.0,
      y: s * 0.4,
      z: -0.55 + rnd() * 1.1,
      f: frame({ ry: rnd() * Math.PI, rx: rnd() * 0.3 }),
    });
  }

  // ── conduit ────────────────────────────────────────────────────────────────
  const conduit = new Builder();
  // Built along +Y then rotated flat so it runs down the corridor (Z).
  tube(conduit, { y0: -3.2, y1: 3.2, r0: 0.075, r1: 0.075, seg: 8, col: STEEL, f: frame({ rx: -90 * D2R }) });
  for (const z of [-2.2, 0, 2.2]) {
    tube(conduit, { y0: z - 0.06, y1: z + 0.06, r0: 0.10, r1: 0.10, seg: 8, col: RUST_DK, f: frame({ rx: -90 * D2R }) });
  }

  // ── lamp ───────────────────────────────────────────────────────────────────
  const lampBody  = new Builder();
  const lampGlass = new Builder();
  box(lampBody, { w: 0.62, h: 0.10, d: 0.30, col: STEEL, f: frame({ rx: 32 * D2R }) });
  box(lampBody, { w: 0.10, h: 0.26, d: 0.10, col: RUST_DK, y: 0.16 });
  // The glass tube faces down; its material carries the emissive factor.
  box(lampGlass, { w: 0.50, h: 0.045, d: 0.20, col: col(1.0, 0.93, 0.78), y: -0.055, f: frame({ rx: 32 * D2R }) });
  box(lampGlass, { w: 0.05, h: 0.05, d: 0.05, col: col(1.0, 0.95, 0.85), x: -0.20, y: -0.055 });
  box(lampGlass, { w: 0.05, h: 0.05, d: 0.05, col: col(1.0, 0.95, 0.85), x:  0.20, y: -0.055 });

  return buildGLB({
    name: 'environment',
    materials: [MAT_PROP, MAT_LAMP],
    meshes: [
      { name: 'cluster', builder: cluster, material: 0 },
      { name: 'conduit', builder: conduit, material: 0 },
      { name: 'lamp_body', builder: lampBody, material: 0 },
      { name: 'lamp_glass', builder: lampGlass, material: 1 },
    ],
    nodes: [
      { name: 'environment', children: [1, 2, 3] },
      { name: 'cluster',     mesh: 0 },
      { name: 'conduit',     mesh: 1 },
      { name: 'lamp',        children: [4, 5] },
      { name: 'lamp_body',   mesh: 2 },
      { name: 'lamp_glass',  mesh: 3 },
    ],
    root: 0,
  });
}

// ─── Entry point ──────────────────────────────────────────────────────────────

const OUTPUTS = [
  ['survivor.glb',    buildSurvivor()],
  ['zombie.glb',      buildZombie()],
  ['environment.glb', buildEnvironment()],
];

mkdirSync(OUT_DIR, { recursive: true });

for (const [file, buffer] of OUTPUTS) {
  writeFileSync(join(OUT_DIR, file), buffer);
  console.log(`✔ ${file.padEnd(16)} ${(buffer.length / 1024).toFixed(1)} kB`);
}

console.log(`\nModels written to ${OUT_DIR}`);
