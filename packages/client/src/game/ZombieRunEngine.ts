/**
 * @file ZombieRunEngine.ts
 * @description Root Three.js engine. Owns the renderer, scene, camera,
 * lighting, and the per-frame update loop.
 *
 * WEBGPU / WEBGL STRATEGY
 * ────────────────────────
 * Three.js r171 ships `WebGPURenderer` in the `three/webgpu` module.
 * The renderer attempts WebGPU first; if the browser or device does not
 * support it, it falls back to WebGL 2 automatically via the `forceWebGL`
 * constructor option (set to false = try WebGPU first).
 *
 * The calling code does NOT need to know which API is active — the scene
 * graph, materials, and InstancedMesh API are identical for both renderers.
 *
 * CAMERA CONTROL
 * ───────────────
 * The camera follows the survivor from behind at a fixed local offset.
 * Its FOV widens slightly with the multiplier to enhance the sense of speed.
 * There is no OrbitControls — the camera is purely scripted.
 *
 * LIGHTING
 * ─────────
 * - AmbientLight (dim, cold) — base fill
 * - DirectionalLight (warm, slightly above) — key light on survivor
 * - PointLight (red, pulsing) — "danger" light near the horde
 * - SpotLight (white, forward-facing) — survivor's torch cone
 *
 * ATMOSPHERE (fog)
 * ─────────────────
 * Exponential fog does triple duty: it hides the tile recycling at the far end
 * of the corridor, it adds depth to an otherwise flat tube, and — because both
 * its density and its COLOUR are animated — it narrates the round. Density
 * climbs with the multiplier (the world closes in as the horde gains), and the
 * colour bleeds from cold night blue to ember red while the devour sequence
 * plays.
 *
 * SCREEN SHAKE
 * ─────────────
 * The camera is never still. A tension term scales with the multiplier, and
 * discrete impulses are added on milestones (2×, 3×, 5×, 10×…) and on the
 * crash, decaying exponentially. Layered sine waves at incommensurate
 * frequencies are used instead of white noise: random jitter reads as a broken
 * camera, whereas correlated wobble reads as a handheld one.
 *
 * FRAME LOOP ARCHITECTURE
 * ────────────────────────
 *   requestAnimationFrame
 *     └─ PerformanceMonitor.tick()  ← may return shouldRender=false
 *        └─ if shouldRender:
 *              Terrain.update()
 *              Characters.update()
 *              updateCamera()
 *              renderer.render()
 */

// ⚠️ CRITICAL: both imports MUST come from `three/webgpu`, never from the raw
// `three/src/**` tree. Importing WebGPURenderer from `three/src/...` pulls in a
// SECOND, independent copy of the module graph, so the renderer's internal
// `instanceof` checks against Scene/Light/Material fail and the scene renders
// unlit (a black canvas) while logging:
//     "LightsNode.setupNodeLights: Light node not found"
// The built `three/webgpu` bundle re-uses the core `three` module internally,
// which keeps every class identity consistent.
import * as THREE from 'three/webgpu';
import { WebGPURenderer } from 'three/webgpu';

import { PerformanceMonitor } from './PerformanceMonitor';
import { Terrain }            from './Terrain';
import { Characters }         from './Characters';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface EngineCallbacks {
  onReady?:  ()     => void;
  onError?:  (err: Error) => void;
  onFpsUpdate?: (fps: number, pixelRatio: number) => void;
}

// ─── Camera Constants ──────────────────────────────────────────────────────────

// ── Camera framing ───────────────────────────────────────────────────────────
//
// These numbers are solved, not guessed. The HUD is a full-bleed overlay whose
// bottom sheet occupies roughly the lower 45% of a phone screen, so the
// survivor has to be framed in the upper half or the panel covers it.
//
// With the values below the survivor's torso lands at ~42% of the viewport
// height (it used to sit at ~67%, i.e. behind the betting panel). The camera
// rides at shoulder height and looks almost level, which also gives the
// corridor a proper vanishing point instead of a floor-heavy top-down shot.

const CAM_OFFSET_Y   = 1.0;    // eye height above the survivor's origin
const CAM_OFFSET_Z   = 5.0;    // distance behind the survivor
const CAM_LOOK_AHEAD = 2.0;    // how far in front of the survivor to aim

/**
 * Aim point relative to the survivor's origin.
 *
 * Deliberately BELOW `CAM_OFFSET_Y`. Tilting the camera down is what raises
 * the horizon in frame: the horizon always sits at the camera's eye level, so
 * it lands at the exact vertical centre whenever the camera is level — and the
 * visible band above the bottom sheet then showed nothing but the near-black
 * ceiling. This ~11° down-tilt puts the horizon at roughly a third of the
 * height, so the floor, both walls and the survivor fill the clear band.
 */
const CAM_LOOK_Y     = -0.35;

const CAM_FOV_BASE  = 72;     // degrees at 1.00×
const CAM_FOV_MAX   = 95;     // degrees at extreme multipliers

// ── Atmosphere ───────────────────────────────────────────────────────────────

/** Night-blue fog used while the round is calm. */
const FOG_COLD      = new THREE.Color(0x000208);
/** Ember red the fog bleeds to during the devour sequence. */
const FOG_CRASH     = new THREE.Color(0x2a0404);

const FOG_DENSITY_CALM  = 0.024;   // at 1.00×
const FOG_DENSITY_FAST  = 0.046;   // at 20× and beyond

/** Screen-shake impulses are fired when the multiplier crosses these values. */
const SHAKE_MILESTONES = [2, 3, 5, 10, 25, 50, 100] as const;

// ─── ZombieRunEngine ──────────────────────────────────────────────────────────

export class ZombieRunEngine {
  private canvas:      HTMLCanvasElement;
  private renderer!:   WebGPURenderer;
  private scene:       THREE.Scene;
  private camera:      THREE.PerspectiveCamera;
  private callbacks:   EngineCallbacks;

  private perfMonitor!:  PerformanceMonitor;
  private terrain!:      Terrain;
  private characters!:   Characters;

  private rafHandle:     number | null = null;
  private currentMult:   number = 1;
  private targetMult:    number = 1;
  private isDisposed:    boolean = false;

  // Atmosphere
  private fog!:          THREE.FogExp2;
  private fogColor       = FOG_COLD.clone();

  // Screen shake
  private shakeAmplitude = 0;      // decaying impulse, world units
  private shakeClock     = 0;      // drives the wobble oscillators
  private milestoneIndex = 0;      // how many SHAKE_MILESTONES were crossed

  /**
   * True only once init() has finished building the renderer.
   * Guards resize calls that can legitimately arrive first — the
   * ResizeObserver fires as soon as it is attached, which is before the async
   * renderer init has resolved.
   */
  private isReady:       boolean = false;

  // Performance stats timer
  private fpsReportTimer: number = 0;

  // Lights
  private keyLight!:      THREE.DirectionalLight;
  private dangerLight!:   THREE.PointLight;
  private torchLight!:    THREE.SpotLight;

  constructor(canvas: HTMLCanvasElement, callbacks: EngineCallbacks = {}) {
    this.canvas    = canvas;
    this.callbacks = callbacks;
    this.scene     = new THREE.Scene();
    this.camera    = new THREE.PerspectiveCamera(
      CAM_FOV_BASE,
      canvas.clientWidth / canvas.clientHeight,
      0.1,
      300,
    );
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  async init(): Promise<void> {
    try {
      await this.initRenderer();
      this.initScene();
      this.initLighting();
      this.terrain    = new Terrain(this.scene, this.camera);
      this.characters = new Characters(this.scene);
      this.initCamera();
      this.isReady = true;
      this.startLoop();
      this.callbacks.onReady?.();
    } catch (err) {
      this.callbacks.onError?.(err as Error);
      throw err;
    }
  }

  /** Sets the multiplier target — smoothly interpolated in the render loop */
  setMultiplier(multiplier: number): void {
    this.targetMult = multiplier;
  }

  /** Triggers the crash animation sequence */
  triggerCrash(): void {
    this.characters.triggerCrash();
    // The impact is felt through the camera before any other feedback lands.
    this.addShake(0.5);
  }

  /** Resets the scene for a new round */
  reset(): void {
    this.currentMult    = 1;
    this.targetMult     = 1;
    this.shakeAmplitude = 0;
    this.milestoneIndex = 0;
    this.characters.reset();
  }

  /**
   * Adds a discrete screen-shake impulse (world units), clamped so repeated
   * triggers cannot turn the camera into a blender.
   */
  addShake(amount: number): void {
    this.shakeAmplitude = Math.min(0.55, this.shakeAmplitude + amount);
  }

  /** Handles canvas resize (call from ResizeObserver or window resize) */
  handleResize(width: number, height: number): void {
    // Ignore events that arrive before the renderer exists.
    if (!this.isReady) return;

    // Guard against a zero-sized canvas (e.g. during a layout transition),
    // which would produce an invalid projection matrix and blank the view.
    if (width <= 0 || height <= 0) return;

    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();

    // updateStyle = false — see initRenderer() for why this matters.
    this.renderer.setSize(width, height, false);
  }

  /**
   * Re-syncs the drawing buffer to the canvas's current CSS size.
   * Used as a safety net for cases where the ResizeObserver may not fire
   * (mobile orientation changes, browser chrome collapsing, etc.).
   */
  syncSize(): void {
    if (!this.isReady) return;
    const { clientWidth, clientHeight } = this.canvas;
    this.handleResize(clientWidth, clientHeight);
  }

  dispose(): void {
    this.isDisposed = true;
    if (this.rafHandle !== null) cancelAnimationFrame(this.rafHandle);
    this.terrain.dispose();
    this.characters.dispose();
    this.renderer.dispose();
  }

  // ── Renderer Init ──────────────────────────────────────────────────────────

  private async initRenderer(): Promise<void> {
    // Do NOT pass forceWebGL: that lets WebGPURenderer install its own
    // `getFallback` hook, which swaps in the WebGL 2 backend automatically
    // when navigator.gpu is missing or adapter/device creation fails.
    this.renderer = new WebGPURenderer({
      canvas:          this.canvas,
      antialias:       true,
      powerPreference: 'high-performance',
    });

    await this.renderer.init();

    // updateStyle = false is essential, not cosmetic.
    //
    // By default setSize() writes `style.width/height` in px onto the canvas.
    // That pins the element to a fixed pixel size, so it stops following its
    // CSS (`h-full w-full`) — and because the canvas then never changes size,
    // the ResizeObserver watching it never fires again. The renderer stayed
    // locked to whatever size the viewport happened to have on first paint
    // (a 390px-wide phone view on a 1440px desktop window, for instance).
    // Passing false leaves layout entirely to CSS, which keeps the buffer and
    // the element in sync at every resolution.
    this.renderer.setSize(this.canvas.clientWidth, this.canvas.clientHeight, false);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type    = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping       = THREE.ACESFilmicToneMapping;
    // ACES crushes shadow detail hard; the corridor palette is intentionally
    // dark, so a slightly hot exposure is needed for the scene to read at all
    // on a phone screen in daylight.
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.outputColorSpace  = THREE.SRGBColorSpace;

    // PerformanceMonitor drives pixelRatio from measured frame times.
    this.perfMonitor = new PerformanceMonitor(this.renderer);

    console.info('[Engine] Renderer initialised:', this.describeBackend());
  }

  /**
   * Reports which backend actually ended up rendering.
   *
   * `isWebGPURenderer` is true for BOTH backends (it identifies the renderer
   * class, not the backend), so the active backend must be read off the
   * backend object instead.
   */
  private describeBackend(): string {
    const backend = (this.renderer as unknown as {
      backend?: { isWebGLBackend?: boolean; isWebGPUBackend?: boolean };
    }).backend;

    if (backend?.isWebGLBackend) return 'WebGL 2 (automatic fallback) 🛟';
    if (backend?.isWebGPUBackend) return 'WebGPU ⚡';
    if (!('gpu' in navigator))   return 'WebGL 2 (navigator.gpu unavailable) 🛟';
    return 'WebGPU (backend unidentified)';
  }

  // ── Scene Setup ────────────────────────────────────────────────────────────

  private initScene(): void {
    // Deep dark blue fog — prevents seeing tile recycling and adds dread.
    // Density and colour are animated per frame in updateAtmosphere().
    this.fog = new THREE.FogExp2(FOG_COLD.getHex(), FOG_DENSITY_CALM);
    this.scene.fog = this.fog;
    // The background shares the fog's colour object: whatever the fog bleeds
    // to, the void behind it matches, so the horizon never seams.
    this.scene.background = this.fogColor;
  }

  private initLighting(): void {
    // Ambient: cold fill. Raised from 0.8 → 1.6 because the surface materials
    // sit around 0x20 luminance; at the old level the whole corridor rendered
    // effectively black on a low-brightness phone display.
    const ambient = new THREE.AmbientLight(0x2a3a52, 1.6);
    this.scene.add(ambient);

    // Key light: warm, from above-front.
    //
    // Its shadow frustum is re-centred on the survivor every frame — see
    // updateShadowFrustum(). A fixed frustum cannot work here: the action
    // happens ~10 units down a corridor that the survivor never leaves, so a
    // frustum pinned at the world origin only covers ~6 units and everything
    // outside it samples the clamped edge of the shadow map, which is what
    // painted the near floor completely black.
    this.keyLight = new THREE.DirectionalLight(0xfff0d0, 2.2);
    this.keyLight.castShadow            = true;
    this.keyLight.shadow.mapSize.width  = 1024;
    this.keyLight.shadow.mapSize.height = 1024;
    this.keyLight.shadow.camera.near    = 0.5;
    this.keyLight.shadow.camera.far     = 40;
    this.keyLight.shadow.camera.left    = -9;
    this.keyLight.shadow.camera.right   = 9;
    this.keyLight.shadow.camera.top     = 9;
    this.keyLight.shadow.camera.bottom  = -9;
    this.keyLight.shadow.bias           = -0.0005;
    // Normal-offset bias is the robust fix for shadow acne on the moving
    // instanced tiles; the plain depth bias alone flickers as they scroll.
    this.keyLight.shadow.normalBias     = 0.02;
    this.scene.add(this.keyLight);
    this.scene.add(this.keyLight.target);

    // Danger light: pulsing red near the horde
    this.dangerLight = new THREE.PointLight(0xff1010, 3.0, 20);
    this.dangerLight.position.set(0, 1, -20);
    this.scene.add(this.dangerLight);

    // Survivor's torch: white cone pointing forward
    this.torchLight = new THREE.SpotLight(0xfff8e0, 4.0, 35, Math.PI / 9, 0.5, 1.5);
    this.torchLight.position.set(0, 1.5, -7);
    this.torchLight.target.position.set(0, 0, -30);
    this.scene.add(this.torchLight);
    this.scene.add(this.torchLight.target);

    // Rim light: from behind the camera. This is the light that actually
    // illuminates the survivor's back (the surface facing the player), so it
    // does the heavy lifting for the character read.
    const rimLight = new THREE.DirectionalLight(0x6b86b8, 1.5);
    rimLight.position.set(0, 2, 15);
    this.scene.add(rimLight);
  }

  private initCamera(): void {
    const sp = this.characters.survivor.position;
    this.camera.position.set(sp.x, sp.y + CAM_OFFSET_Y, sp.z + CAM_OFFSET_Z);
    this.camera.lookAt(sp.x, sp.y + CAM_LOOK_Y, sp.z - CAM_LOOK_AHEAD);
  }

  // ── Game Loop ──────────────────────────────────────────────────────────────

  private startLoop(): void {
    const loop = (timestamp: number) => {
      if (this.isDisposed) return;
      this.rafHandle = requestAnimationFrame(loop);

      const { shouldRender, deltaMs } = this.perfMonitor.tick(timestamp);
      if (!shouldRender) return;

      // Smoothly interpolate multiplier (prevents jitter from network ticks)
      this.currentMult += (this.targetMult - this.currentMult) * 0.12;

      // Update subsystems
      this.terrain.update(deltaMs, this.currentMult);
      this.characters.update(deltaMs, this.currentMult);
      this.updateMilestoneShake();
      this.updateCamera(deltaMs);
      this.updateShadowFrustum();
      this.updateLighting(deltaMs);
      this.updateAtmosphere(deltaMs);

      // Render
      this.renderer.render(this.scene, this.camera);

      // Report FPS every second
      this.fpsReportTimer += deltaMs;
      if (this.fpsReportTimer >= 1000) {
        this.fpsReportTimer = 0;
        this.callbacks.onFpsUpdate?.(this.perfMonitor.fps, this.perfMonitor.getPixelRatio());
      }
    };

    this.rafHandle = requestAnimationFrame(loop);
  }

  // ── Camera Update ──────────────────────────────────────────────────────────

  private updateCamera(deltaMs: number): void {
    const sp    = this.characters.survivor.position;
    const dt    = deltaMs / 1000;

    // FOV grows with multiplier for speed sensation
    const targetFov = Math.min(CAM_FOV_MAX, CAM_FOV_BASE + (this.currentMult - 1) * 1.8);
    this.camera.fov += (targetFov - this.camera.fov) * Math.min(1, dt * 3);
    this.camera.updateProjectionMatrix();

    // Camera position: fixed offset from survivor
    const targetPos = new THREE.Vector3(
      sp.x * 0.5,
      sp.y + CAM_OFFSET_Y,
      sp.z + CAM_OFFSET_Z,
    );
    this.camera.position.lerp(targetPos, Math.min(1, dt * 8));

    // Look-at: slightly ahead of survivor
    const lookTarget = new THREE.Vector3(sp.x, sp.y + CAM_LOOK_Y, sp.z - CAM_LOOK_AHEAD);
    this.camera.lookAt(lookTarget);

    // Shake is applied AFTER lookAt: rotating the camera afterwards would
    // otherwise be undone by the next frame's lookAt call.
    this.updateShake(dt);
  }

  // ── Screen Shake ───────────────────────────────────────────────────────────

  /**
   * Fires an impulse for every milestone the multiplier has crossed this round.
   * A `while` loop (not an `if`) so a burst of ticks arriving at once — e.g.
   * after a tab was backgrounded — still fires each crossed milestone exactly
   * once, without ever replaying one.
   */
  private updateMilestoneShake(): void {
    while (
      this.milestoneIndex < SHAKE_MILESTONES.length &&
      this.currentMult >= SHAKE_MILESTONES[this.milestoneIndex]!
    ) {
      this.addShake(0.05 + this.milestoneIndex * 0.012);
      this.milestoneIndex++;
    }
  }

  private updateShake(dt: number): void {
    this.shakeClock += dt;

    // Continuous tension: grows with the multiplier but saturates well below
    // the crash impulse, so a 100× round stays playable.
    const tension = Math.min(0.02, Math.max(0, this.currentMult - 1) * 0.0024);
    // The devour sequence drives its own violent shake inside Characters.
    const crash = this.characters.isCrashing ? this.characters.shakeAmplitude * 0.55 : 0;
    const amp   = tension + this.shakeAmplitude + crash;

    if (amp > 0.0004) {
      const t  = this.shakeClock;
      const nx = Math.sin(t * 41.3) * 0.62 + Math.sin(t * 17.7) * 0.38;
      const ny = Math.sin(t * 57.1 + 1.3) * 0.62 + Math.sin(t * 23.9 + 0.7) * 0.38;

      this.camera.position.x += nx * amp;
      this.camera.position.y += ny * amp * 0.7;
      // Roll is what actually sells an impact: ~0.35 rad per unit of amplitude
      // puts a full crash impulse at a violent-but-readable ~10°.
      this.camera.rotateZ(nx * amp * 0.35);
    }

    // Exponential-ish decay of the impulse term only; tension is re-added each
    // frame from the live multiplier.
    this.shakeAmplitude = Math.max(0, this.shakeAmplitude - dt * 0.85);
  }

  // ── Atmosphere ─────────────────────────────────────────────────────────────

  private updateAtmosphere(deltaMs: number): void {
    const dt = deltaMs / 1000;

    // Density: the world closes in as the horde gains.
    const speedFactor    = Math.min(1, Math.max(0, (this.currentMult - 1) / 20));
    const targetDensity  = FOG_DENSITY_CALM + speedFactor * (FOG_DENSITY_FAST - FOG_DENSITY_CALM);
    this.fog.density    += (targetDensity - this.fog.density) * Math.min(1, dt * 1.6);

    // Colour: cold night blue, bleeding to ember red while being devoured.
    const target = this.characters.isCrashing ? FOG_CRASH : FOG_COLD;
    this.fogColor.lerp(target, Math.min(1, dt * 2.2));
    this.fog.color.copy(this.fogColor);
  }

  // ── Shadow Frustum ─────────────────────────────────────────────────────────

  /**
   * Keeps the sun's shadow camera centred on the survivor.
   *
   * Both the light and its target are moved together, so the light DIRECTION
   * stays constant (the scene never appears re-lit) while the shadow frustum
   * travels with the action. Without this, geometry more than ~6 units from the
   * world origin fell outside the frustum and sampled the clamped edge of the
   * shadow map, rendering it fully shadowed.
   */
  private updateShadowFrustum(): void {
    const sp = this.characters.survivor.position;

    this.keyLight.position.set(sp.x + 3, sp.y + 8, sp.z + 5);
    this.keyLight.target.position.set(sp.x, sp.y, sp.z - 7);

    // The target's world matrix must be current before the shadow pass reads it.
    this.keyLight.target.updateMatrixWorld();
    this.keyLight.updateMatrixWorld();
  }

  // ── Lighting Update ────────────────────────────────────────────────────────

  private updateLighting(_deltaMs: number): void {
    const t = Date.now() / 1000;

    // Danger light pulses faster and brighter as multiplier increases
    const pulseFreq   = 1.0 + this.currentMult * 0.15;
    const pulseAmp    = 1.5 + (this.currentMult - 1) * 0.4;
    this.dangerLight.intensity = pulseAmp + Math.sin(t * pulseFreq * Math.PI * 2) * (pulseAmp * 0.4);

    // Danger light follows the horde Z position
    const hordeZ = -8 - Math.max(1.5, 25 / Math.sqrt(Math.max(1, this.currentMult)));
    this.dangerLight.position.z += (hordeZ - this.dangerLight.position.z) * 0.05;

    // Torch flickers slightly
    this.torchLight.intensity = 4.0 + Math.sin(t * 7.3) * 0.3 + Math.sin(t * 13.7) * 0.15;
  }
}
