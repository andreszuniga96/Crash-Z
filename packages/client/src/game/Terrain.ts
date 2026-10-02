/**
 * @file Terrain.ts
 * @description Infinite procedurally-scrolling corridor using InstancedMesh,
 * dressed with props loaded from `environment.glb`.
 *
 * ARCHITECTURE
 * ─────────────
 * The corridor is built from a fixed pool of tile instances arranged in a
 * ring buffer. Each instance is a slab of geometry (floor tile or wall segment).
 * On each update tick, tiles that scroll behind the camera are recycled to the
 * front of the corridor, giving the illusion of infinite forward movement.
 *
 * PERFORMANCE
 * ────────────
 * - Floor: single InstancedMesh with N_FLOOR_TILES instances
 *   → 1 draw call for all floor tiles regardless of count
 * - Left wall: 1 InstancedMesh, Right wall: 1 InstancedMesh
 * - Ceiling strips: 1 InstancedMesh
 * - Total static scene draw calls for the corridor structure: 4
 *
 * ── PROPS (the prop tier is deliberately NOT instanced) ─────────────────────
 * Barrels, crates, ducts and ceiling lamps are individual cloned objects rather
 * than instances. Cloning costs a handful of extra draw calls, but it buys the
 * one thing instances cannot give: a prop made of SEVERAL meshes with different
 * materials (a lamp is a steel housing plus an emissive glass tube). It also
 * lets each prop be rotated and scaled on its own. With N_PROPS = 30 the total
 * is ~40 draw calls, which is nothing next to the shadow pass.
 *
 * Props start life as primitive stand-ins and are replaced in place by the GLB
 * versions as soon as the model arrives — same trick as the characters, so the
 * corridor is never empty and an asset failure is invisible to the player.
 *
 * SCROLL SPEED MAPPING
 * ─────────────────────
 * The scroll speed is driven by the multiplier received from the server:
 *
 *   baseSpeed = TILE_SIZE × 0.9   (units/sec at 1.00×)
 *   scrollSpeed = baseSpeed × sqrt(multiplier)
 *
 * sqrt() gives a pleasing sub-linear growth — early multipliers feel fast
 * enough to be exciting, but extreme multipliers (50×+) don't become
 * nauseating. The camera FOV also widens slightly with multiplier.
 */

// Must match the renderer's module graph — see ZombieRunEngine.ts for why.
import * as THREE from 'three/webgpu';
import { assetLoader, applyShadowFlags, MODEL_URLS } from './AssetLoader';

// ─── Constants ────────────────────────────────────────────────────────────────

const TILE_SIZE          = 8;    // metres per tile
const CORRIDOR_WIDTH     = 6;    // metres
const CORRIDOR_HEIGHT    = 4;    // metres
const N_FLOOR_TILES      = 30;   // visible pool (ring buffer)
const N_WALL_TILES       = 30;   // per side
const N_CEIL_TILES       = 30;
const N_PROPS            = 30;   // decorative objects (clones)

// Speed at multiplier 1.00× (units per second)
const BASE_SPEED         = TILE_SIZE * 0.9;

// How far forward from the camera origin tiles begin
const SPAWN_Z            = -TILE_SIZE * 2;

/** Y of the floor's top surface — also where props and characters stand. */
const FLOOR_TOP_Y        = -(CORRIDOR_HEIGHT / 2 - 0.075);
const CEIL_BOTTOM_Y      =   CORRIDOR_HEIGHT / 2 - 0.14;
const WALL_X             =   CORRIDOR_WIDTH / 2 - 0.25;

/** Repeating role pattern for the prop ring. */
const PROP_PATTERN = ['cluster', 'conduit', 'cluster', 'lamp'] as const;
type PropRole = (typeof PROP_PATTERN)[number];

// ─── Material Palette ──────────────────────────────────────────────────────────

function buildMaterials() {
  // NOTE ON ALBEDO
  // ──────────────
  // These colours were previously pitched at ~0x18 luminance (0x1a1a20 and
  // friends). Combined with ACES tone mapping that rendered as pure black, so
  // the corridor was invisible no matter how the lights were tuned. They are
  // now roughly twice as bright, which keeps the grimy mood while letting the
  // geometry actually read on screen.

  // Floor: cracked asphalt
  const floorMat = new THREE.MeshStandardMaterial({
    color:     0x3a3a46,
    roughness: 0.9,
    metalness: 0.1,
  });

  // Wall variants
  const wallMats = [
    new THREE.MeshStandardMaterial({ color: 0x5a4436, roughness: 0.9,  metalness: 0.1 }), // rust
    new THREE.MeshStandardMaterial({ color: 0x41465a, roughness: 0.85, metalness: 0.2 }), // concrete
    new THREE.MeshStandardMaterial({ color: 0x36405a, roughness: 0.7,  metalness: 0.5 }), // steel
  ];

  // Ceiling: dark, with emissive strip lights so the top of the frame is not
  // a dead black void (the ceiling occupies the visible band above the
  // horizon once the camera tilts down).
  const ceilMat = new THREE.MeshStandardMaterial({
    color:      0x26263a,
    roughness:  0.9,
    metalness:  0.3,
    emissive:   new THREE.Color(0x0a2a5a),
    emissiveIntensity: 1.0,
  });

  // Prop fallbacks — replaced by the GLB materials when the model loads.
  const propMat     = new THREE.MeshStandardMaterial({ color: 0x4a3626, roughness: 0.9,  metalness: 0.15 });
  const propSteel   = new THREE.MeshStandardMaterial({ color: 0x3d414a, roughness: 0.65, metalness: 0.5 });
  const lampGlass   = new THREE.MeshStandardMaterial({
    color:     0xfff0c0,
    roughness: 0.35,
    emissive:  new THREE.Color(0xffd489),
    emissiveIntensity: 1.6,
  });

  return { floorMat, wallMats, ceilMat, propMat, propSteel, lampGlass };
}

// ─── Props ────────────────────────────────────────────────────────────────────

interface Prop {
  obj:           THREE.Object3D;
  role:          PropRole;
  rotationY:     number;
}

// ─── Terrain Class ────────────────────────────────────────────────────────────

export class Terrain {
  private scene:      THREE.Scene;
  private materials:  ReturnType<typeof buildMaterials>;

  private floorMesh:  THREE.InstancedMesh;
  private leftMesh:   THREE.InstancedMesh;
  private rightMesh:  THREE.InstancedMesh;
  private ceilMesh:   THREE.InstancedMesh;

  // Z positions of each tile instance (ring buffer)
  private floorZ:     number[];
  private leftZ:      number[];
  private rightZ:     number[];
  private ceilZ:      number[];

  // Decorative props (clones, upgraded to GLB models)
  private props:      Prop[] = [];

  // Scroll state
  private scrollAccum: number = 0;
  private multiplier:  number = 1;

  // Camera reference for recycle threshold
  private camera: THREE.PerspectiveCamera;

  private disposed = false;

  constructor(scene: THREE.Scene, camera: THREE.PerspectiveCamera) {
    this.scene   = scene;
    this.camera  = camera;
    this.materials = buildMaterials();

    // ── Geometry ─────────────────────────────────────────────────────────────
    const floorGeo = new THREE.BoxGeometry(CORRIDOR_WIDTH, 0.15, TILE_SIZE);
    const wallGeo  = new THREE.BoxGeometry(0.2, CORRIDOR_HEIGHT, TILE_SIZE);
    const ceilGeo  = new THREE.BoxGeometry(CORRIDOR_WIDTH, 0.12, TILE_SIZE);

    // ── InstancedMesh pool ─────────────────────────────────────────────────
    this.floorMesh  = new THREE.InstancedMesh(floorGeo, this.materials.floorMat, N_FLOOR_TILES);
    this.leftMesh   = new THREE.InstancedMesh(wallGeo,   this.materials.wallMats[0]!, N_WALL_TILES);
    this.rightMesh  = new THREE.InstancedMesh(wallGeo,   this.materials.wallMats[1]!, N_WALL_TILES);
    this.ceilMesh   = new THREE.InstancedMesh(ceilGeo,   this.materials.ceilMat, N_CEIL_TILES);

    [this.floorMesh, this.leftMesh, this.rightMesh, this.ceilMesh].forEach((m) => {
      m.castShadow    = true;
      m.receiveShadow = true;
      m.frustumCulled = false; // We manage culling manually via recycling
      scene.add(m);
    });

    // ── Initial tile positions ─────────────────────────────────────────────
    this.floorZ  = this.initPositions(this.floorMesh,  N_FLOOR_TILES, 0,                    FLOOR_TOP_Y - 0.075);
    this.leftZ   = this.initPositions(this.leftMesh,   N_WALL_TILES,  -(CORRIDOR_WIDTH / 2 + 0.1), CORRIDOR_HEIGHT / 2 - 2);
    this.rightZ  = this.initPositions(this.rightMesh,  N_WALL_TILES,   (CORRIDOR_WIDTH / 2 + 0.1), CORRIDOR_HEIGHT / 2 - 2);
    this.ceilZ   = this.initPositions(this.ceilMesh,   N_CEIL_TILES,   0,                    CEIL_BOTTOM_Y + 0.06);

    // ── Props (primitive stand-ins, upgraded to GLB in the background) ─────
    this.buildProps();
    void this.upgradeProps();
  }

  // ── Initialise tile positions along the corridor ────────────────────────────

  private initPositions(
    mesh:  THREE.InstancedMesh,
    count: number,
    xOff:  number,
    yOff:  number,
  ): number[] {
    const dummy   = new THREE.Object3D();
    const zPositions: number[] = [];

    for (let i = 0; i < count; i++) {
      const z = SPAWN_Z - i * TILE_SIZE;
      zPositions.push(z);

      dummy.position.set(xOff, yOff, z);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
    }
    mesh.instanceMatrix.needsUpdate = true;
    return zPositions;
  }

  // ── Props ──────────────────────────────────────────────────────────────────

  /**
   * Creates the prop ring out of primitives: crates/pallets on the floor, ducts
   * along the walls, and lamps overhead. Each prop keeps a fixed lateral offset
   * and Y rotation so recycling only ever changes its Z.
   */
  private buildProps(): void {
    for (let i = 0; i < N_PROPS; i++) {
      const role      = PROP_PATTERN[i % PROP_PATTERN.length]!;
      const rotationY = (i % 2 === 0 ? 1 : -1) * (i % 3 === 0 ? 0.35 : 0.12);

      const obj = role === 'cluster' ? this.buildClusterFallback(i)
                : role === 'conduit' ? this.buildConduitFallback()
                :                      this.buildLampFallback();

      obj.position.set(this.propLateralOffset(role, i), this.propHeight(role), SPAWN_Z - i * TILE_SIZE);
      obj.rotation.y = rotationY;
      if (role === 'conduit') obj.scale.set(1, 1, 1.5);

      this.scene.add(obj);
      this.props.push({ obj, role, rotationY });
    }
  }

  /** Lateral (X) offset of a prop — floor clutter hugs the walls, lamps hang centre. */
  private propLateralOffset(role: PropRole, index: number): number {
    const side = index % 2 === 0 ? -1 : 1;
    if (role === 'lamp')    return side * 0.6;
    if (role === 'conduit') return side * WALL_X;
    return side * (2.1 + (index % 3) * 0.25);
  }

  /** Y of a prop's origin — model origins are at their base. */
  private propHeight(role: PropRole): number {
    if (role === 'lamp')    return CEIL_BOTTOM_Y;
    if (role === 'conduit') return -0.35;
    return FLOOR_TOP_Y;
  }

  private buildClusterFallback(index: number): THREE.Object3D {
    const group = new THREE.Group();

    const crate = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.7, 0.7), this.materials.propMat);
    crate.position.set(0.35, 0.35, 0);
    crate.rotation.y = index % 2 === 0 ? 0.3 : -0.2;
    group.add(crate);

    const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.28, 0.86, 10), this.materials.propSteel);
    barrel.position.set(-0.45, 0.43, 0.2);
    group.add(barrel);

    const rubble = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.22, 0.3), this.materials.propSteel);
    rubble.position.set(0.1, 0.11, -0.5);
    rubble.rotation.y = 0.8;
    group.add(rubble);

    return group;
  }

  private buildConduitFallback(): THREE.Object3D {
    const group = new THREE.Group();
    const duct = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.16, 6.4), this.materials.propSteel);
    duct.position.y = 0.08;
    group.add(duct);
    return group;
  }

  private buildLampFallback(): THREE.Object3D {
    const group = new THREE.Group();
    const housing = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.1, 0.3), this.materials.propSteel);
    housing.position.y = -0.05;
    group.add(housing);
    const glass = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.05, 0.2), this.materials.lampGlass);
    glass.position.y = -0.12;
    group.add(glass);
    return group;
  }

  /**
   * Replaces every prop with its GLB counterpart in place — position, rotation
   * and scale are copied from the stand-in, so the ring keeps its rhythm.
   */
  private async upgradeProps(): Promise<void> {
    const model = await assetLoader.load(MODEL_URLS.environment);
    if (!model || this.disposed) return;

    const sources: Record<PropRole, THREE.Object3D | undefined> = {
      cluster: model.getObjectByName('cluster'),
      conduit: model.getObjectByName('conduit'),
      lamp:    model.getObjectByName('lamp'),
    };

    const missing = PROP_PATTERN.filter((role) => !sources[role]);
    if (missing.length > 0) {
      console.warn(`[Terrain] environment.glb is missing: ${missing.join(', ')} — keeping fallback props.`);
    }

    for (const prop of this.props) {
      const source = sources[prop.role];
      if (!source || this.disposed) continue;

      // clone(true): the copy shares geometry and materials with the source,
      // so 30 props cost one geometry, not thirty.
      const clone = source.clone(true);
      clone.position.copy(prop.obj.position);
      clone.rotation.copy(prop.obj.rotation);
      clone.rotation.y = prop.rotationY;
      clone.scale.copy(prop.obj.scale);

      applyShadowFlags(clone);

      this.scene.remove(prop.obj);
      this.disposeObject(prop.obj);
      prop.obj = clone;
      this.scene.add(clone);
    }

    console.info('[Terrain] Environment props active.');
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /** Called once per rendered frame with the current game multiplier */
  update(deltaMs: number, multiplier: number): void {
    this.multiplier = multiplier;

    // Speed scaling: sqrt gives pleasing sub-linear growth
    const speed     = BASE_SPEED * Math.sqrt(Math.max(1, this.multiplier));
    const deltaSecs = deltaMs / 1000;
    const dz        = speed * deltaSecs;   // how many units to scroll this frame

    this.scrollAccum += dz;

    // Recycle threshold: 2 tiles behind the camera
    const recycleZ = this.camera.position.z + TILE_SIZE * 2;

    this.scrollTiles(this.floorMesh,  this.floorZ,  dz, recycleZ, 0,   FLOOR_TOP_Y - 0.075, false);
    this.scrollTiles(this.leftMesh,   this.leftZ,   dz, recycleZ, -(CORRIDOR_WIDTH / 2 + 0.1), CORRIDOR_HEIGHT / 2 - 2, false);
    this.scrollTiles(this.rightMesh,  this.rightZ,  dz, recycleZ,  (CORRIDOR_WIDTH / 2 + 0.1), CORRIDOR_HEIGHT / 2 - 2, false);
    this.scrollTiles(this.ceilMesh,   this.ceilZ,   dz, recycleZ, 0,   CEIL_BOTTOM_Y + 0.06, false);
    this.scrollProps(dz, recycleZ);
  }

  /**
   * Scrolls all tiles in a pool toward the camera (+Z direction)
   * and recycles any that pass the camera to the far end.
   */
  private scrollTiles(
    mesh:     THREE.InstancedMesh,
    zArr:     number[],
    dz:       number,
    recycleZ: number,
    xOff:     number,
    yOff:     number,
    addJitter: boolean,
  ): void {
    const dummy   = new THREE.Object3D();
    const count   = zArr.length;
    let   updated = false;

    // Find the furthest-back tile Z for recycling
    let minZ = Infinity;
    for (let i = 0; i < count; i++) {
      if (zArr[i]! < minZ) minZ = zArr[i]!;
    }

    for (let i = 0; i < count; i++) {
      zArr[i]! += dz;

      // Recycle: tile has scrolled past the camera
      if (zArr[i]! >= recycleZ) {
        zArr[i] = minZ - TILE_SIZE;
        minZ    = zArr[i]!;
      }

      const jitter = addJitter ? (Math.random() - 0.5) * 0.1 : 0;
      dummy.position.set(xOff, yOff + jitter, zArr[i]!);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
      updated = true;
    }

    if (updated) mesh.instanceMatrix.needsUpdate = true;
  }

  /**
   * Props scroll exactly like tiles; only their Z changes, so the lateral
   * offsets and rotations set up in buildProps() survive every lap.
   */
  private scrollProps(dz: number, recycleZ: number): void {
    let minZ = Infinity;
    for (const prop of this.props) {
      if (prop.obj.position.z < minZ) minZ = prop.obj.position.z;
    }

    for (const prop of this.props) {
      prop.obj.position.z += dz;

      if (prop.obj.position.z >= recycleZ) {
        // Even spacing keeps the ring gap-free: a recycled prop lands one tile
        // beyond the current rearmost one.
        minZ -= TILE_SIZE;
        prop.obj.position.z = minZ;
      }
    }
  }

  /**
   * Frees a prop's geometry and materials. GLB clones share theirs with the
   * source model, and three's `dispose()` is idempotent, so releasing the same
   * geometry from several props is safe — the last one wins.
   */
  private disposeObject(root: THREE.Object3D): void {
    root.traverse((child) => {
      const mesh = child as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.geometry?.dispose();
      const material = mesh.material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(material)) material.forEach((m) => m.dispose());
      else material?.dispose();
    });
  }

  dispose(): void {
    this.disposed = true;

    [this.floorMesh, this.leftMesh, this.rightMesh, this.ceilMesh].forEach((m) => {
      m.geometry.dispose();
      this.scene.remove(m);
    });

    for (const prop of this.props) {
      this.scene.remove(prop.obj);
      this.disposeObject(prop.obj);
    }
    this.props = [];

    Object.values(this.materials).flat().forEach((mat) => {
      if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
      else (mat as THREE.Material).dispose();
    });
  }
}
