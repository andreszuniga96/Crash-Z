/**
 * @file game/AssetLoader.ts
 * @description GLTF/GLB loading for the scene — one shared loader, one cache.
 *
 * ── MODULE GRAPH ─────────────────────────────────────────────────────────────
 * Everything here imports from `three/webgpu`, never from `three/src/**`. The
 * GLTFLoader and DRACOLoader addons (from `three/examples/jsm`) import from
 * `'three'`, which resolves to `three.module.js` → `three.core.js`; the
 * `three/webgpu` bundle imports that very same `three.core.js`. All three
 * therefore share ONE copy of every class, so `instanceof` checks inside the
 * renderer keep working. See the long note in ZombieRunEngine.ts.
 *
 * ── GRACEFUL DEGRADATION ─────────────────────────────────────────────────────
 * `load()` NEVER rejects. The 3D scene must not be held hostage by an asset:
 * if a model is missing, truncated or fails to parse, the loaders log one
 * warning and return `null`, and the callers (Characters, Terrain) keep their
 * procedural fallback geometry on screen. A user on a flaky mobile connection
 * sees the game, not a blank canvas.
 *
 * ── DRACO ────────────────────────────────────────────────────────────────────
 * Meshes compressed with `KHR_draco_mesh_compression` are decoded in a worker
 * from `/draco/` (the decoder shipped by three, copied into `public/draco/`).
 * That path is a runtime URL, relative to the site root, so it keeps working
 * behind nginx, on a sub-path deployment, and in the Vite dev server alike.
 */

import * as THREE from 'three/webgpu';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';

/** URLs of the shipped models — relative so sub-path deployments work. */
export const MODEL_URLS = {
  survivor:    'models/survivor.glb',
  zombie:      'models/zombie.glb',
  environment: 'models/environment.glb',
} as const;

/** Draco decoder assets, served straight out of `packages/client/public/draco/`. */
const DRACO_DECODER_PATH = 'draco/';

class AssetLoader {
  private loader!: GLTFLoader;
  private draco:   DRACOLoader | null = null;

  /** In-flight/complete loads, keyed by URL — a model is fetched at most once. */
  private cache = new Map<string, Promise<THREE.Group | null>>();

  private initialised = false;

  private init(): void {
    if (this.initialised) return;
    this.initialised = true;

    this.loader = new GLTFLoader();

    // Draco is optional: if the worker fails to spawn (old browser, blocked
    // wasm), the loader still parses uncompressed glTF and only compressed
    // payloads fail — and those failures are caught per-URL below.
    try {
      this.draco = new DRACOLoader();
      this.draco.setDecoderPath(DRACO_DECODER_PATH);
      this.loader.setDRACOLoader(this.draco);
    } catch (err) {
      console.warn('[Assets] Draco decoder unavailable, plain glTF only:', err);
      this.draco = null;
    }
  }

  /**
   * Loads a GLB and resolves with its scene graph, or `null` when the asset is
   * unavailable. `onProgress` receives 0..1 when the server reports a
   * Content-Length (nginx does; the dev server does not).
   */
  load(url: string, onProgress?: (fraction: number) => void): Promise<THREE.Group | null> {
    this.init();

    const cached = this.cache.get(url);
    if (cached) return cached;

    const promise = new Promise<THREE.Group | null>((resolve) => {
      this.loader.load(
        url,
        (gltf) => {
          console.info(`[Assets] Loaded ${url} (${countTriangles(gltf.scene)} tris)`);
          resolve(gltf.scene);
        },
        (event) => {
          if (!onProgress || !event.total) return;
          onProgress(Math.min(1, event.loaded / event.total));
        },
        (err) => {
          // Expected whenever the assets have not been generated yet — the
          // scene falls back to its primitive rig, so this is a warning.
          console.warn(`[Assets] Could not load ${url} — using fallback geometry.`, err);
          resolve(null);
        },
      );
    });

    this.cache.set(url, promise);
    return promise;
  }

  dispose(): void {
    this.draco?.dispose();
    this.draco = null;
    this.cache.clear();
    this.initialised = false;
  }
}

/** Triangle count of a scene graph — logged so a "0 tris" model is obvious. */
function countTriangles(root: THREE.Object3D): number {
  let triangles = 0;
  root.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh || !mesh.geometry) return;
    const geometry = mesh.geometry as THREE.BufferGeometry;
    const index = geometry.getIndex();
    if (index) triangles += index.count / 3;
    else if (geometry.getAttribute('position')) {
      triangles += geometry.getAttribute('position').count / 3;
    }
  });
  return Math.round(triangles);
}

/** Marks every mesh in a loaded subtree as a shadow caster and receiver. */
export function applyShadowFlags(root: THREE.Object3D): void {
  root.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.castShadow    = true;
    mesh.receiveShadow = true;
    // Loaded geometry is authored in placeholder space; nothing to cull here
    // because these are all single-object props or rigs with tiny bounds.
    mesh.frustumCulled = false;
  });
}

export const assetLoader = new AssetLoader();
