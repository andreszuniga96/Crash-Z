/**
 * @file Characters.ts
 * @description Survivor and ZombieHorde scene objects.
 *
 * ── TWO TIERS OF GEOMETRY ───────────────────────────────────────────────────
 * Every object is built TWICE-READY:
 *
 *   1. FALLBACK RIG — primitive shapes, built synchronously in the constructor.
 *      The scene is therefore complete on the first frame; there is never a
 *      moment where the player stares at an empty corridor.
 *   2. GLB MODEL — `upgradeSurvivor()` / `upgradeHorde()` load `survivor.glb`
 *      and `zombie.glb` in the background and swap them in atomically once they
 *      arrive. Failure is not exceptional: the asset loader resolves `null` and
 *      the fallback rig simply stays.
 *
 * The swap is only accepted when the model exposes the SAME RIG NODES the
 * primitive rig does (`leftArm`, `leftLeg`, `leftCalf`, …). Those nodes are what
 * `updateRunAnimation()` rotates, and the geometry of each one is authored in
 * its own joint space, so a model can be rotated around the shoulder or the
 * knee without any baking or compensation transform. A model missing a node is
 * rejected rather than half-applied — a T-posing survivor is worse than a
 * blocky one.
 *
 * ── SURVIVOR ────────────────────────────────────────────────────────────────
 * Animated procedurally with sin/cos on elapsed time. Legs and arms swing with
 * the running cadence, which scales with the multiplier.
 *
 * ── ZOMBIE HORDE ────────────────────────────────────────────────────────────
 * An InstancedMesh of N_ZOMBIES instances behind the survivor. As the
 * multiplier increases, the horde "catches up" by reducing the gap. The model
 * swap replaces the instance GEOMETRY in place, so the horde stays a single
 * draw call no matter how detailed the model is.
 *
 * The horde model is authored feet-at-origin, while the primitive box is
 * centre-origin; `hordeBaseY` carries that difference so both tiers stand on
 * the floor instead of one of them floating.
 *
 * ── CRASH ANIMATION ─────────────────────────────────────────────────────────
 *  1. Horde rushes forward (rapid Z lerp)
 *  2. Survivor mesh shakes violently (amplitude is exposed to the camera)
 *  3. Survivor falls down (Y lerp to floor)
 */

// Must match the renderer's module graph — see ZombieRunEngine.ts for why.
import * as THREE from 'three/webgpu';
import { assetLoader, applyShadowFlags, MODEL_URLS } from './AssetLoader';

// ─── Constants ────────────────────────────────────────────────────────────────

const N_ZOMBIES          = 20;
const SURVIVOR_Y         = -1.2;   // Height above corridor floor
const SURVIVOR_Z         = -8;     // Fixed Z in corridor (terrain moves, not survivor)
const HORDE_GAP_AT_1X    = 25;     // metres behind survivor at 1.00×
const HORDE_GAP_MIN      = 1.5;    // minimum gap at extreme multipliers

/** Top surface of the corridor floor. Must match Terrain's CORRIDOR_HEIGHT. */
const FLOOR_TOP_Y        = -1.925;

/** Rig nodes the procedural animation drives, in both geometry tiers. */
const RIG_NODES = ['leftArm', 'rightArm', 'leftLeg', 'rightLeg', 'leftCalf', 'rightCalf', 'head'] as const;

// ─── Fallback Survivor Builder ────────────────────────────────────────────────

function buildPrimitiveSurvivor(): THREE.Group {
  const group = new THREE.Group();

  // Albedo raised alongside the terrain palette — at the previous values the
  // survivor was indistinguishable from the corridor behind it.
  const skinMat  = new THREE.MeshStandardMaterial({ color: 0xe8b184, roughness: 0.75, emissive: 0x3a2412, emissiveIntensity: 0.35 });
  const shirtMat = new THREE.MeshStandardMaterial({ color: 0x5aa03f, roughness: 0.85, emissive: 0x14290d, emissiveIntensity: 0.4 }); // olive green
  const pantsMat = new THREE.MeshStandardMaterial({ color: 0x32324e, roughness: 0.9 });
  const bootMat  = new THREE.MeshStandardMaterial({ color: 0x6b4d33, roughness: 0.95 });

  // Torso
  const torsoGeo = new THREE.BoxGeometry(0.45, 0.55, 0.22);
  const torso    = new THREE.Mesh(torsoGeo, shirtMat);
  torso.position.set(0, 0.27, 0);
  group.add(torso);

  // Head
  const headGeo = new THREE.BoxGeometry(0.32, 0.32, 0.32);
  const head    = new THREE.Mesh(headGeo, skinMat);
  head.position.set(0, 0.74, 0);
  group.add(head);

  // ── Arms (pivot at shoulder) ────────────────────────────────────────────────
  const armGeo  = new THREE.BoxGeometry(0.12, 0.42, 0.12);

  const leftArm  = new THREE.Group();
  const leftArmMesh = new THREE.Mesh(armGeo, shirtMat);
  leftArmMesh.position.y = -0.21; // pivot at top
  leftArm.add(leftArmMesh);
  leftArm.position.set(-0.285, 0.54, 0);
  leftArm.name = 'leftArm';
  group.add(leftArm);

  const rightArm  = new THREE.Group();
  const rightArmMesh = new THREE.Mesh(armGeo, shirtMat);
  rightArmMesh.position.y = -0.21;
  rightArm.add(rightArmMesh);
  rightArm.position.set(0.285, 0.54, 0);
  rightArm.name = 'rightArm';
  group.add(rightArm);

  // ── Legs (pivot at hip) ─────────────────────────────────────────────────────
  const thighGeo = new THREE.BoxGeometry(0.16, 0.38, 0.16);
  const calfGeo  = new THREE.BoxGeometry(0.13, 0.36, 0.13);

  const leftLeg = new THREE.Group();
  leftLeg.name  = 'leftLeg';
  const leftThigh = new THREE.Mesh(thighGeo, pantsMat);
  leftThigh.position.y = -0.19;
  leftLeg.add(leftThigh);

  const leftCalf = new THREE.Group();
  leftCalf.name  = 'leftCalf';
  const leftCalfMesh = new THREE.Mesh(calfGeo, pantsMat);
  leftCalfMesh.position.y = -0.18;
  leftCalf.add(leftCalfMesh);
  const leftBoot = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.12, 0.22), bootMat);
  leftBoot.position.set(0, -0.36, 0.04);
  leftCalf.add(leftBoot);
  leftCalf.position.y = -0.38;
  leftLeg.add(leftCalf);

  leftLeg.position.set(-0.14, 0, 0);
  group.add(leftLeg);

  const rightLeg = new THREE.Group();
  rightLeg.name  = 'rightLeg';
  const rightThigh = new THREE.Mesh(thighGeo, pantsMat);
  rightThigh.position.y = -0.19;
  rightLeg.add(rightThigh);

  const rightCalf = new THREE.Group();
  rightCalf.name  = 'rightCalf';
  const rightCalfMesh = new THREE.Mesh(calfGeo, pantsMat);
  rightCalfMesh.position.y = -0.18;
  rightCalf.add(rightCalfMesh);
  const rightBoot = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.12, 0.22), bootMat);
  rightBoot.position.set(0, -0.36, 0.04);
  rightCalf.add(rightBoot);
  rightCalf.position.y = -0.38;
  rightLeg.add(rightCalf);

  rightLeg.position.set(0.14, 0, 0);
  group.add(rightLeg);

  // Tag all user data
  group.userData['leftArm']   = leftArm;
  group.userData['rightArm']  = rightArm;
  group.userData['leftLeg']   = leftLeg;
  group.userData['rightLeg']  = rightLeg;
  group.userData['leftCalf']  = leftCalf;
  group.userData['rightCalf'] = rightCalf;
  group.userData['head']      = head;

  return group;
}

/** Frees the geometries and materials of a discarded subtree. */
function disposeSubtree(root: THREE.Object3D): void {
  root.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh) return;

    const geometry = mesh.geometry as THREE.BufferGeometry | undefined;
    if (geometry) {
      geometry.dispose();
    }

    const material = mesh.material as THREE.Material | THREE.Material[] | undefined;
    if (Array.isArray(material)) material.forEach((m) => m.dispose());
    else material?.dispose();
  });
}

// ─── Characters Class ─────────────────────────────────────────────────────────

export class Characters {
  private scene:         THREE.Scene;
  public  survivor:      THREE.Group;
  private zombieHorde:   THREE.InstancedMesh;

  // Animation state
  private runClock:      number   = 0;
  private crashState:    'none' | 'crashing' | 'done' = 'none';
  private crashProgress: number   = 0;
  private crashShakeAmp: number   = 0;

  // Horde state
  private hordeGap:      number   = HORDE_GAP_AT_1X;
  private hordePositions: THREE.Vector3[] = [];

  /**
   * Base Y of each horde instance.
   *
   * The primitive box is CENTRE-origin (its feet sit half a box below its
   * origin, hence `SURVIVOR_Y + 0.5`), whereas the GLB zombie is authored
   * FEET-at-origin so it can simply stand on the floor. Keeping the value in a
   * field lets the model swap move the whole horde onto the ground plane
   * without touching the formation logic.
   */
  private hordeBaseY:    number   = SURVIVOR_Y + 0.5;

  private disposed       = false;

  constructor(scene: THREE.Scene) {
    this.scene = scene;

    // ── Survivor (fallback rig) ────────────────────────────────────────────
    this.survivor = buildPrimitiveSurvivor();
    this.survivor.position.set(0, SURVIVOR_Y, SURVIVOR_Z);
    // Enable shadow casting on every descendant mesh — setting it on the
    // Group alone is a no-op, which is why the survivor previously threw no
    // shadow and blended into the near-black background.
    this.survivor.traverse((child) => {
      if ((child as THREE.Mesh).isMesh) child.castShadow = true;
    });
    scene.add(this.survivor);

    // ── Zombie Horde (fallback box geometry) ───────────────────────────────
    const zombieGeo = new THREE.BoxGeometry(0.42, 1.0, 0.22);
    const zombieMat = new THREE.MeshStandardMaterial({
      color:     0x3f7a35,
      roughness: 0.95,
      metalness: 0.1,
      emissive:  0x16290f,
      emissiveIntensity: 0.45,
    });

    this.zombieHorde = new THREE.InstancedMesh(zombieGeo, zombieMat, N_ZOMBIES);
    this.zombieHorde.castShadow    = true;
    this.zombieHorde.frustumCulled = false;
    scene.add(this.zombieHorde);

    // Initialise zombie positions in a loose formation behind the survivor
    const dummy = new THREE.Object3D();
    this.hordePositions = [];

    for (let i = 0; i < N_ZOMBIES; i++) {
      const col     = i % 5;
      const row     = Math.floor(i / 5);
      const xOffset = (col - 2) * 0.9;
      const zOffset = SURVIVOR_Z - HORDE_GAP_AT_1X - row * 1.5;
      const pos     = new THREE.Vector3(xOffset, this.hordeBaseY, zOffset);
      this.hordePositions.push(pos);
      dummy.position.copy(pos);
      dummy.updateMatrix();
      this.zombieHorde.setMatrixAt(i, dummy.matrix);
    }
    this.zombieHorde.instanceMatrix.needsUpdate = true;

    // ── Upgrade to GLB models in the background ────────────────────────────
    void this.upgradeSurvivor();
    void this.upgradeHorde();
  }

  // ── Model Upgrades ─────────────────────────────────────────────────────────

  /**
   * Replaces the primitive survivor with `survivor.glb`.
   *
   * The swap is transactional: the model's rig nodes are looked up FIRST and,
   * if any is missing, nothing is touched. On success the primitive rig is
   * removed from the scene and disposed, and `userData` is re-tagged with the
   * model's own nodes so `updateRunAnimation()` drives them unchanged.
   */
  private async upgradeSurvivor(): Promise<void> {
    const model = await assetLoader.load(MODEL_URLS.survivor);
    if (!model || this.disposed) return;

    const nodes = RIG_NODES.map((name) => [name, model.getObjectByName(name)] as const);
    const missing = nodes.filter(([, node]) => !node).map(([name]) => name);

    if (missing.length > 0) {
      console.warn(`[Characters] survivor.glb has no rig node(s): ${missing.join(', ')} — keeping fallback rig.`);
      disposeSubtree(model);
      return;
    }

    applyShadowFlags(model);
    model.position.set(0, SURVIVOR_Y, SURVIVOR_Z);
    model.rotation.set(0, 0, 0);

    // Swap
    this.scene.remove(this.survivor);
    disposeSubtree(this.survivor);
    this.survivor = model;
    this.scene.add(model);

    for (const [name, node] of nodes) model.userData[name] = node;

    console.info('[Characters] Survivor model active.');
  }

  /**
   * Swaps the horde's instance geometry and material for the zombie model.
   *
   * An InstancedMesh draws exactly one geometry, which is why the zombie is
   * authored as a single merged mesh (its vertex colors carry the skin, cloth
   * and blood variation). Swapping the two properties keeps the horde at one
   * draw call and needs no change to the formation or the crash code.
   */
  private async upgradeHorde(): Promise<void> {
    const model = await assetLoader.load(MODEL_URLS.zombie);
    if (!model || this.disposed) return;

    // The zombie GLB is a single mesh; tolerate any node name it arrives under.
    const meshes: THREE.Mesh[] = [];
    model.traverse((child) => {
      const mesh = child as THREE.Mesh;
      if (mesh.isMesh && mesh.geometry) meshes.push(mesh);
    });

    const source = meshes[0];
    if (!source) {
      console.warn('[Characters] zombie.glb contains no mesh — keeping fallback geometry.');
      return;
    }

    const previousGeometry = this.zombieHorde.geometry;
    const previousMaterial = this.zombieHorde.material as THREE.Material;

    this.zombieHorde.geometry = source.geometry;
    this.zombieHorde.material = source.material as THREE.Material;
    // The instance matrices are unchanged, so only the base height moves.
    this.hordeBaseY = FLOOR_TOP_Y;

    previousGeometry.dispose();
    previousMaterial.dispose();

    console.info('[Characters] Zombie horde model active.');
  }

  // ── Update ─────────────────────────────────────────────────────────────────

  update(deltaMs: number, multiplier: number): void {
    const dt = deltaMs / 1000;

    if (this.crashState === 'none') {
      this.updateRunAnimation(dt, multiplier);
      this.updateHorde(dt, multiplier);
    } else if (this.crashState === 'crashing') {
      this.updateCrashAnimation(dt);
    }
  }

  // ── Animation state for the camera ─────────────────────────────────────────

  /** True while the devour sequence plays — drives the engine's screen shake. */
  get isCrashing(): boolean {
    return this.crashState === 'crashing';
  }

  /** Remaining shake amplitude of the crash sequence, in world units. */
  get shakeAmplitude(): number {
    return this.crashShakeAmp;
  }

  // ── Running Animation ──────────────────────────────────────────────────────

  private updateRunAnimation(dt: number, multiplier: number): void {
    // Cadence scales with multiplier — faster multiplier = faster legs
    const cadence  = 7 + Math.sqrt(multiplier) * 1.5; // radians/sec
    this.runClock += dt * cadence;
    const t        = this.runClock;

    const la  = this.survivor.userData['leftArm']   as THREE.Object3D;
    const ra  = this.survivor.userData['rightArm']  as THREE.Object3D;
    const ll  = this.survivor.userData['leftLeg']   as THREE.Object3D;
    const rl  = this.survivor.userData['rightLeg']  as THREE.Object3D;
    const lc  = this.survivor.userData['leftCalf']  as THREE.Object3D;
    const rc  = this.survivor.userData['rightCalf'] as THREE.Object3D;
    const hd  = this.survivor.userData['head']      as THREE.Object3D;

    const swing  = 0.55;  // max limb swing amplitude (radians)
    const calf   = 0.4;   // additional knee bend

    la.rotation.x  =  Math.sin(t) * swing;
    ra.rotation.x  = -Math.sin(t) * swing;
    ll.rotation.x  = -Math.sin(t) * swing;
    rl.rotation.x  =  Math.sin(t) * swing;

    // Knee bend: calves fold back on the "up" stride
    lc.rotation.x  = Math.max(0, -Math.sin(t + 0.5)) * calf;
    rc.rotation.x  = Math.max(0, -Math.sin(t - 0.5)) * calf;

    // Torso bob
    this.survivor.position.y = SURVIVOR_Y + Math.abs(Math.sin(t)) * 0.04;

    // Head look-ahead (slight forward tilt)
    hd.rotation.x = -0.15;

    // Lean INTO the run as the multiplier climbs. The survivor faces -Z, so a
    // forward lean is a negative rotation about X (the old positive value tipped
    // the body backwards, away from the run).
    this.survivor.rotation.x = -Math.min(0.18, (multiplier - 1) * 0.015);
  }

  // ── Horde Update ───────────────────────────────────────────────────────────

  private updateHorde(dt: number, multiplier: number): void {
    // Target gap shrinks as multiplier grows
    const targetGap = Math.max(
      HORDE_GAP_MIN,
      HORDE_GAP_AT_1X / Math.sqrt(multiplier),
    );

    // Smoothly lerp the gap
    this.hordeGap += (targetGap - this.hordeGap) * Math.min(1, dt * 1.5);

    const dummy   = new THREE.Object3D();
    const baseZ   = SURVIVOR_Z - this.hordeGap;
    const bobTime = Date.now() / 800;

    for (let i = 0; i < N_ZOMBIES; i++) {
      const col   = i % 5;
      const row   = Math.floor(i / 5);
      const xOff  = (col - 2) * 0.9 + Math.sin(bobTime + i) * 0.08;
      const zPos  = baseZ - row * 1.5;
      const yBob  = this.hordeBaseY + Math.sin(bobTime * 1.3 + i * 0.7) * 0.045;

      this.hordePositions[i]!.set(xOff, yBob, zPos);
      dummy.position.copy(this.hordePositions[i]!);
      // Zombies shamble: random slight rotation
      dummy.rotation.set(Math.sin(bobTime * 0.9 + i * 1.7) * 0.06, Math.sin(bobTime + i) * 0.15, 0);
      // Per-instance size variation stops the horde reading as a cloned stamp;
      // the pattern is index-derived so a zombie never changes size mid-round.
      dummy.scale.setScalar(0.94 + (i % 3) * 0.045);
      dummy.updateMatrix();
      this.zombieHorde.setMatrixAt(i, dummy.matrix);
    }
    this.zombieHorde.instanceMatrix.needsUpdate = true;
  }

  // ── Crash Sequence ─────────────────────────────────────────────────────────

  triggerCrash(): void {
    if (this.crashState !== 'none') return;
    this.crashState    = 'crashing';
    this.crashProgress = 0;
    this.crashShakeAmp = 0.3;
  }

  private updateCrashAnimation(dt: number): void {
    this.crashProgress += dt * 1.5;

    // Phase 1 (0→0.4): horde rushes in
    if (this.crashProgress < 0.4) {
      const t     = this.crashProgress / 0.4;
      const dummy = new THREE.Object3D();

      for (let i = 0; i < N_ZOMBIES; i++) {
        const col  = i % 5;
        const row  = Math.floor(i / 5);
        const xOff = (col - 2) * 0.9;
        const targetZ = SURVIVOR_Z + 0.2 - row * 0.3;
        const startZ  = SURVIVOR_Z - HORDE_GAP_MIN - row * 1.5;
        dummy.position.set(xOff, this.hordeBaseY, THREE.MathUtils.lerp(startZ, targetZ, t));
        dummy.scale.setScalar(0.94 + (i % 3) * 0.045);
        dummy.updateMatrix();
        this.zombieHorde.setMatrixAt(i, dummy.matrix);
      }
      this.zombieHorde.instanceMatrix.needsUpdate = true;
    }

    // Phase 2 (0.4→1.0): survivor falls and shakes
    if (this.crashProgress >= 0.4) {
      const t       = Math.min(1, (this.crashProgress - 0.4) / 0.6);
      const fallY   = THREE.MathUtils.lerp(SURVIVOR_Y, SURVIVOR_Y - 0.8, t);
      const shakeX  = (Math.random() - 0.5) * this.crashShakeAmp * (1 - t);
      const shakeZ  = (Math.random() - 0.5) * this.crashShakeAmp * (1 - t);

      this.crashShakeAmp = Math.max(0, this.crashShakeAmp - dt * 0.8);
      this.survivor.position.set(shakeX, fallY, SURVIVOR_Z + shakeZ);
      this.survivor.rotation.x = t * 1.4;  // fall forward
      this.survivor.rotation.z = t * 0.4;  // tilt sideways

      if (this.crashProgress >= 1.0) {
        this.crashState = 'done';
      }
    }
  }

  reset(): void {
    this.crashState    = 'none';
    this.crashProgress = 0;
    this.hordeGap      = HORDE_GAP_AT_1X;
    this.runClock      = 0;
    this.survivor.position.set(0, SURVIVOR_Y, SURVIVOR_Z);
    this.survivor.rotation.set(0, 0, 0);
  }

  dispose(): void {
    this.disposed = true;
    this.scene.remove(this.survivor);
    this.scene.remove(this.zombieHorde);
    this.zombieHorde.geometry.dispose();
    (this.zombieHorde.material as THREE.Material).dispose();
  }
}
