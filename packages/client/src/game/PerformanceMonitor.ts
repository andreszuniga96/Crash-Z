/**
 * @file PerformanceMonitor.ts
 * @description Adaptive performance monitor for the Three.js game loop.
 *
 * RESPONSIBILITIES
 * ─────────────────
 * 1. FPS Throttle — caps the render loop at TARGET_FPS (60) using delta-time
 *    accounting. On a 120Hz display it renders every other vsync instead of
 *    running at 120fps, protecting battery and thermals on mobile.
 *
 * 2. Dynamic Pixel Ratio — samples render-to-render intervals. If the rolling
 *    average can't sustain 60 FPS, the pixelRatio steps down; it steps back up
 *    once performance recovers. This is the main lever for keeping low-end
 *    phones cool, since fill rate scales with the square of pixelRatio.
 *
 * 3. Delta Time Clamping — clamps delta to MAX_DELTA_MS to prevent the
 *    "spiral of death" when the tab is backgrounded and requestAnimationFrame
 *    resumes with a 1000ms+ delta that would teleport every object.
 *
 * WHY THE SAMPLER NEEDS SUSPENSION DETECTION
 * ──────────────────────────────────────────
 * A backgrounded tab stops firing rAF, so the first frame after it resumes
 * reports a delta of hundreds or thousands of milliseconds. Feeding that into
 * the rolling window poisons the average for the next 60 frames, which used to
 * make the monitor degrade the pixel ratio, immediately recover, and degrade
 * again — an endless oscillation that was clearly visible in the console.
 * Suspended deltas are therefore detected and discarded, and they reset the
 * window rather than being averaged into it.
 *
 * A cooldown after every change adds hysteresis: a resolution change alters
 * frame time on its own, so the sampler needs a moment to settle before it is
 * allowed to judge the result.
 */

// ─── Constants ────────────────────────────────────────────────────────────────

const TARGET_FPS           = 60;
const TARGET_FRAME_MS      = 1000 / TARGET_FPS;     // 16.667ms
const MAX_DELTA_MS         = 100;                    // Clamp to prevent spiral-of-death

/**
 * A render-to-render gap larger than this can only mean the page was not being
 * painted (backgrounded tab, OS sleep, long GC pause). Such a sample is
 * excluded from performance accounting entirely.
 */
const SUSPEND_THRESHOLD_MS = 250;

const SAMPLE_WINDOW        = 60;                     // Frames in the rolling average

const DEGRADE_THRESHOLD_MS = TARGET_FRAME_MS * 1.35; // ~22.5ms → below 60fps
const RECOVER_THRESHOLD_MS = TARGET_FRAME_MS * 0.85; // ~14.2ms → comfortable headroom

// Consecutive out-of-band samples before a pixel ratio change is allowed.
// Recovery is deliberately much slower than degradation: it is better to stay
// slightly soft than to oscillate between resolutions.
const FRAMES_BEFORE_DEGRADE = 45;
const FRAMES_BEFORE_RECOVER = 180;

// Quiet period after a change, during which adaptation is paused.
const COOLDOWN_MS = 3_000;

// Pixel ratio bounds. Never drop below 0.9 (text becomes unreadable) and never
// exceed 2.0 (diminishing returns, quadratic fill-rate cost).
const MIN_PIXEL_RATIO = 0.9;
const MAX_PIXEL_RATIO = 2.0;

/** Discrete ladder, descending. Filtered against the device ratio at runtime. */
const LADDER_STEPS = [2, 1.75, 1.5, 1.25, 1, 0.9];

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * Minimal structural contract — keeps this module decoupled from whichever
 * renderer class is in use (WebGPURenderer or the WebGL 2 fallback backend).
 */
export interface PixelRatioTarget {
  setPixelRatio(ratio: number): void;
}

export interface TickResult {
  shouldRender: boolean;
  deltaMs:     number;
}

// ─── Class ────────────────────────────────────────────────────────────────────

export class PerformanceMonitor {
  private renderer: PixelRatioTarget;

  private frameTimes:     number[] = [];
  private lastTickAt:     number = 0;
  private accumulatedMs:  number = 0;
  private slowFrames:     number = 0;
  private fastFrames:     number = 0;
  private lastChangeAt:   number = 0;

  private readonly ladder: number[];
  private ladderIndex:     number = 0;
  private currentPixelRatio: number;

  /** Rolling-average FPS, updated once the sample window is full. */
  public fps:          number = TARGET_FPS;
  public avgFrameMs:   number = TARGET_FRAME_MS;
  public isThrottling: boolean = false;

  constructor(renderer: PixelRatioTarget) {
    this.renderer = renderer;

    const deviceRatio = Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO);

    // Keep only the steps this device can actually display, clamped so that a
    // device reporting 1.0 still has a ladder to degrade along.
    const steps = LADDER_STEPS
      .filter((r) => r <= deviceRatio + 0.001)
      .filter((r) => r >= MIN_PIXEL_RATIO);

    this.ladder = steps.length > 0 ? steps : [MIN_PIXEL_RATIO];

    // Start at the sharpest ratio this device supports.
    this.ladderIndex       = 0;
    this.currentPixelRatio = this.ladder[0]!;
    this.renderer.setPixelRatio(this.currentPixelRatio);
  }

  /**
   * Call at the TOP of each requestAnimationFrame callback.
   *
   * @returns `deltaMs` is the interval since the last RENDERED frame, which is
   *          the correct value for animation. When `shouldRender` is false the
   *          frame must be skipped entirely (no physics, no render).
   */
  tick(timestamp: number): TickResult {
    // First tick: establish the baseline without emitting a bogus delta.
    if (this.lastTickAt === 0) {
      this.lastTickAt = timestamp;
      return { shouldRender: true, deltaMs: TARGET_FRAME_MS };
    }

    const tickDelta = timestamp - this.lastTickAt;
    this.lastTickAt = timestamp;
    this.accumulatedMs += tickDelta;

    // ── FPS throttle: not enough time banked for a full frame yet ────────────
    if (this.accumulatedMs < TARGET_FRAME_MS) {
      this.isThrottling = true;
      return { shouldRender: false, deltaMs: 0 };
    }

    this.isThrottling = false;

    // True render-to-render interval, clamped for safe physics.
    const renderDeltaMs = Math.min(this.accumulatedMs, MAX_DELTA_MS);
    const wasSuspended  = this.accumulatedMs >= SUSPEND_THRESHOLD_MS;

    // Drain one frame's worth of budget; clear the rest if we were suspended so
    // the loop doesn't try to "catch up" with a burst of frames.
    this.accumulatedMs = wasSuspended
      ? 0
      : this.accumulatedMs - TARGET_FRAME_MS;

    // ── Frame-time sampling ──────────────────────────────────────────────────
    if (wasSuspended) {
      // The page was not being painted. Discard the poisoned window instead of
      // averaging a 2-second gap together with real 16ms frames.
      this.frameTimes.length = 0;
      this.slowFrames = 0;
      this.fastFrames = 0;
    } else {
      this.frameTimes.push(renderDeltaMs);
      if (this.frameTimes.length > SAMPLE_WINDOW) this.frameTimes.shift();

      if (this.frameTimes.length >= SAMPLE_WINDOW) {
        let sum = 0;
        for (const t of this.frameTimes) sum += t;
        this.avgFrameMs = sum / this.frameTimes.length;
        this.fps        = Math.round(1000 / this.avgFrameMs);

        this.adaptPixelRatio(timestamp);
      }
    }

    return { shouldRender: true, deltaMs: renderDeltaMs };
  }

  /**
   * Steps the pixel ratio down under sustained load, or back up once the
   * renderer has proven it can sustain the higher resolution.
   */
  private adaptPixelRatio(timestamp: number): void {
    // Let the pipeline settle after a resolution change before re-judging it.
    if (timestamp - this.lastChangeAt < COOLDOWN_MS) return;

    if (this.avgFrameMs > DEGRADE_THRESHOLD_MS) {
      this.fastFrames = 0;
      this.slowFrames++;

      if (this.slowFrames >= FRAMES_BEFORE_DEGRADE && this.canDegrade()) {
        this.applyLadderIndex(this.ladderIndex + 1, timestamp, 'degraded');
      }
      return;
    }

    if (this.avgFrameMs < RECOVER_THRESHOLD_MS) {
      this.slowFrames = 0;
      this.fastFrames++;

      if (this.fastFrames >= FRAMES_BEFORE_RECOVER && this.canRecover()) {
        this.applyLadderIndex(this.ladderIndex - 1, timestamp, 'recovered');
      }
      return;
    }

    // Comfortably inside the target band — nothing to correct.
    this.slowFrames = 0;
    this.fastFrames = 0;
  }

  private canDegrade(): boolean {
    return this.ladderIndex < this.ladder.length - 1;
  }

  private canRecover(): boolean {
    return this.ladderIndex > 0;
  }

  private applyLadderIndex(nextIndex: number, timestamp: number, action: string): void {
    this.ladderIndex       = nextIndex;
    this.currentPixelRatio = this.ladder[nextIndex]!;
    this.renderer.setPixelRatio(this.currentPixelRatio);

    // Reset both the counters and the sample window: frame times measured at
    // the old resolution say nothing about the new one.
    this.slowFrames        = 0;
    this.fastFrames        = 0;
    this.frameTimes.length = 0;
    this.lastChangeAt      = timestamp;

    console.info(
      `[Perf] PixelRatio ${action} to ${this.currentPixelRatio.toFixed(2)} ` +
      `(avg frame: ${this.avgFrameMs.toFixed(1)}ms)`,
    );
  }

  /** Forces a specific pixel ratio (e.g. from a user quality setting). */
  forcePixelRatio(ratio: number): void {
    const clamped = Math.min(MAX_PIXEL_RATIO, Math.max(MIN_PIXEL_RATIO, ratio));

    this.currentPixelRatio = clamped;
    this.renderer.setPixelRatio(clamped);

    // Snap the ladder index to the closest step at or below the forced ratio.
    let index = this.ladder.findIndex((r) => r <= clamped);
    if (index < 0) index = this.ladder.length - 1;
    this.ladderIndex = index;

    this.frameTimes.length = 0;
    this.slowFrames        = 0;
    this.fastFrames        = 0;
  }

  getPixelRatio(): number {
    return this.currentPixelRatio;
  }

  getFps(): number {
    return this.fps;
  }
}
