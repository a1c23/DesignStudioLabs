/* Persistent waveform — center-outward, mic→listening→mic state machine,
 * supports multiple synchronized visual instances.
 *
 * A single state machine + AudioContext + RAF loop drives any number of
 * bar instances. Each state's omnibar has its own wave-host element with a
 * scale; this class registers an instance per host and ticks them all on
 * the same frame so they're perfectly in sync no matter which state is
 * currently visible.
 *
 * Shape lifted from Carlo's now-assist-demo:
 *   - 5 bars; tapered MIN/MAX so center bar is tallest, edges shortest
 *   - center-outward ENTER stagger (2 → 1,3 → 0,4)
 *   - reverse EXIT stagger
 *   - idle ripple (center-out propagation) + active waveform (multi-sine)
 *   - VAD with hysteresis
 */

const NUM_BARS = 5;

// Heights at scale=1 (taller MAX per design)
const BAR_MIN = [5.5, 7.5, 10.5, 7.5, 5.5];
const BAR_MAX = [14, 26, 34, 26, 14];
const BAR_REST = BAR_MIN;

// Center-outward enter/exit timing
const ENTER_ORDER = [2, 1, 3, 0, 4];
const EXIT_ORDER  = [0, 4, 1, 3, 2];
const ENTER_STAGGER = 90;
const ENTER_DURATION = 220;
const EXIT_STAGGER = 70;
const EXIT_DURATION = 180;

// Idle breathing
const RIPPLE_STAGGER = [0.18, 0.09, 0, 0.09, 0.18];
const RIPPLE_BAR_DURATION = 1.2;
const BREATHE_PAUSE = 1.5;
const BREATHE_RIPPLE = 1.6;
const BREATHE_CYCLE = BREATHE_PAUSE + BREATHE_RIPPLE;

// Active wave center-out delays
const CENTER_OUT_DELAY = [0.15, 0.08, 0, 0.08, 0.15];

// VAD
const VAD_HIGH = 30;
const VAD_LOW = 18;
const VAD_RAMP_UP = 0.12;
const VAD_RAMP_DOWN = 0.05;

export class OmniWaveform {
  constructor() {
    // List of registered visual instances. Each: { host, root, bars, scale }
    this.instances = [];

    this.state = "mic"; // "mic" | "entering" | "listening" | "exiting"

    // Animation state at scale=1; per-instance bars are sized via `style.height`
    this.currentHeights = new Array(NUM_BARS).fill(0);
    this.currentOpacities = new Array(NUM_BARS).fill(1);
    this.exitStartHeights = new Array(NUM_BARS).fill(0);

    this.audioCtx = null;
    this.analyser = null;
    this._extAnalyser = null;
    this.stream = null;
    this.freqData = new Uint8Array(128);
    this.isSpeaking = false;
    this.speakingSmoothed = 0;

    this.t = 0;
    this.lastT = performance.now();
    this.enterStart = 0;
    this.exitStart = 0;

    this._tick = this._tick.bind(this);
    this._raf = null;

    this.listeners = new Set();
    this.vadListeners = new Set();
    this._isUserSpeaking = false;
  }

  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  _emit() { this.listeners.forEach((fn) => fn(this.state)); }

  onVAD(fn) { this.vadListeners.add(fn); return () => this.vadListeners.delete(fn); }
  _emitVAD(speaking) { this.vadListeners.forEach((fn) => fn(speaking)); }

  get isUserSpeaking() { return this._isUserSpeaking; }
  get isActive() {
    return this.state === "listening" || this.state === "entering";
  }

  /** Register a host element with a scale. Creates a `.omni-wf` child
   *  containing 5 bars and adds it to the instances list. Subsequent
   *  registrations of the same host are no-ops. */
  addHost(host, scale = 1) {
    if (!host) return null;
    const existing = this.instances.find((i) => i.host === host);
    if (existing) return existing;

    const root = document.createElement("div");
    root.className = "omni-wf";
    root.setAttribute("aria-hidden", "true");
    const bars = [];
    for (let i = 0; i < NUM_BARS; i++) {
      const b = document.createElement("div");
      b.className = "omni-wf__bar";
      b.style.height = `${BAR_MAX[i] * scale}px`;
      root.appendChild(b);
      bars.push(b);
    }
    host.appendChild(root);
    const inst = { host, root, bars, scale };
    this.instances.push(inst);
    return inst;
  }

  async toggle() {
    if (this.state === "mic") await this.startListening();
    else if (this.state === "listening") this.stopListening();
  }

  setExternalAnalyser(analyser) { this._extAnalyser = analyser || null; }
  startEnteringExternal() { if (this.state === "mic") this._startEntering(); }
  stopExiting() { if (this.state === "listening") this._startExiting(); }

  async startListening() {
    if (this.state !== "mic") return;
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const source = this.audioCtx.createMediaStreamSource(this.stream);
      this.analyser = this.audioCtx.createAnalyser();
      this.analyser.fftSize = 256;
      this.analyser.smoothingTimeConstant = 0.8;
      source.connect(this.analyser);
    } catch (err) {
      console.warn("Mic access denied — running without VAD:", err);
    }
    this._startEntering();
  }

  stopListening() {
    if (this.state !== "listening") return;
    this._startExiting();
  }

  _startEntering() {
    this.state = "entering";
    this.enterStart = performance.now();
    this.currentHeights.fill(0);
    this._startLoop();
    this._emit();
  }

  _startExiting() {
    this.state = "exiting";
    this.exitStart = performance.now();
    for (let i = 0; i < NUM_BARS; i++) {
      this.exitStartHeights[i] = this.currentHeights[i];
      this.currentOpacities[i] = 1;
    }
    if (this.stream) { this.stream.getTracks().forEach((t) => t.stop()); this.stream = null; }
    if (this.audioCtx) { try { this.audioCtx.close(); } catch (_) {} this.audioCtx = null; this.analyser = null; }
    this.isSpeaking = false;
    this.speakingSmoothed = 0;
    this._emit();
  }

  _startLoop() {
    if (this._raf) return;
    this.lastT = performance.now();
    this.t = 0;
    this._raf = requestAnimationFrame(this._tick);
  }

  _stopLoop() {
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = null;
  }

  _tick(now) {
    const dt = (now - this.lastT) / 1000;
    this.lastT = now;
    this.t += dt;

    this._updateVAD();

    if (this.state === "entering") this._tickEntering(now);
    else if (this.state === "listening") this._tickListening();
    else if (this.state === "exiting") this._tickExiting(now);

    // Apply to every registered instance — all stay in sync per frame.
    for (const inst of this.instances) {
      for (let i = 0; i < NUM_BARS; i++) {
        const max = BAR_MAX[i]; // reference at scale=1; bar `style.height` already encodes the per-instance scale
        const ratio = max > 0 ? Math.max(0, this.currentHeights[i]) / max : 0;
        const inset = (1 - Math.min(1, ratio)) * 50;
        inst.bars[i].style.clipPath = `inset(${inset}% 0 ${inset}% 0 round 5px)`;
        inst.bars[i].style.opacity = this.currentOpacities[i];
      }
    }

    if (this.state === "mic") this._stopLoop();
    else this._raf = requestAnimationFrame(this._tick);
  }

  _updateVAD() {
    const a = this._extAnalyser || this.analyser;
    if (!a) {
      if (this._isUserSpeaking) {
        this._isUserSpeaking = false;
        this._emitVAD(false);
      }
      return;
    }
    if (this.freqData.length < a.frequencyBinCount) {
      this.freqData = new Uint8Array(a.frequencyBinCount);
    }
    a.getByteFrequencyData(this.freqData);
    let sum = 0;
    for (let i = 0; i < 64; i++) sum += this.freqData[i];
    const avg = sum / 64;
    if (this.isSpeaking) this.isSpeaking = avg > VAD_LOW;
    else this.isSpeaking = avg > VAD_HIGH;
    const target = this.isSpeaking ? 1 : 0;
    const speed = target > this.speakingSmoothed ? VAD_RAMP_UP : VAD_RAMP_DOWN;
    this.speakingSmoothed += (target - this.speakingSmoothed) * speed;
    if (this.speakingSmoothed < 0.01) this.speakingSmoothed = 0;
    if (this.speakingSmoothed > 0.99) this.speakingSmoothed = 1;

    if (!this._isUserSpeaking && this.speakingSmoothed > 0.6) {
      this._isUserSpeaking = true;
      this._emitVAD(true);
    } else if (this._isUserSpeaking && this.speakingSmoothed < 0.15) {
      this._isUserSpeaking = false;
      this._emitVAD(false);
    }
  }

  _tickEntering(now) {
    const elapsed = now - this.enterStart;
    let allDone = true;
    for (let step = 0; step < NUM_BARS; step++) {
      const idx = ENTER_ORDER[step];
      const barElapsed = elapsed - step * ENTER_STAGGER;
      const rest = BAR_REST[idx];
      if (barElapsed <= 0) { this.currentHeights[idx] = 0; allDone = false; }
      else if (barElapsed < ENTER_DURATION) {
        const eased = 1 - Math.pow(1 - barElapsed / ENTER_DURATION, 3);
        this.currentHeights[idx] = rest * eased;
        allDone = false;
      } else this.currentHeights[idx] = rest;
    }
    if (allDone) { this.state = "listening"; this._emit(); }
  }

  _tickListening() {
    const cyclePos = this.t % BREATHE_CYCLE;
    for (let i = 0; i < NUM_BARS; i++) {
      const min = BAR_MIN[i];
      const max = BAR_MAX[i];
      const rest = BAR_REST[i];
      const amplitude = max - min;
      const breatheAmp = amplitude * 0.4;

      // Idle ripple (center-out)
      let idleOffset = 0;
      let barOpacity = 1;
      const barRippleTime = cyclePos - BREATHE_PAUSE - RIPPLE_STAGGER[i];
      if (barRippleTime > 0 && barRippleTime < RIPPLE_BAR_DURATION) {
        const p = barRippleTime / RIPPLE_BAR_DURATION;
        idleOffset = Math.sin(p * Math.PI) * breatheAmp;
        if (p < 0.5) barOpacity = 1 - 0.5 * Math.pow(p / 0.5, 1.5);
        else barOpacity = 0.5 + 0.5 * Math.pow((p - 0.5) / 0.5, 0.6);
      }
      idleOffset *= (1 - this.speakingSmoothed);
      this.currentOpacities[i] = this.speakingSmoothed > 0.01 ? 1 : barOpacity;

      // Active wave (center-out delays)
      const tDelayed = this.t - CENTER_OUT_DELAY[i];
      const wave =
        Math.sin(tDelayed * 2.8 * Math.PI * 2) * 0.5 +
        Math.sin(tDelayed * 1.6 * Math.PI * 2 + 1.2) * 0.35 +
        Math.sin(tDelayed * 4.1 * Math.PI * 2 + 0.5) * 0.15;
      const normalized = (wave + 1) * 0.5;
      const activeHeight = min + normalized * amplitude;
      const activeOffset = (activeHeight - rest) * this.speakingSmoothed;

      let target = rest + idleOffset + activeOffset;
      target = Math.max(min, Math.min(max, target));

      if (this.speakingSmoothed < 0.01) this.currentHeights[i] = target;
      else this.currentHeights[i] += (target - this.currentHeights[i]) * 0.18;
    }
  }

  _tickExiting(now) {
    const elapsed = now - this.exitStart;
    let allDone = true;
    for (let step = 0; step < NUM_BARS; step++) {
      const idx = EXIT_ORDER[step];
      const barElapsed = elapsed - step * EXIT_STAGGER;
      if (barElapsed <= 0) allDone = false;
      else if (barElapsed < EXIT_DURATION) {
        const eased = Math.pow(barElapsed / EXIT_DURATION, 2.5);
        this.currentHeights[idx] = this.exitStartHeights[idx] * (1 - eased);
        allDone = false;
      } else this.currentHeights[idx] = 0;
    }
    if (allDone) { this.state = "mic"; this._emit(); }
  }
}
