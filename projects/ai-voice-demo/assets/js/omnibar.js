import { OmniWaveform } from "./waveform.js";
import { VoiceClient, settings as voiceSettings, PROVIDERS } from "./voice-client.js";
import { TranscriptLog } from "./transcript-log.js";

const STATES = ["omni-hero", "omni-dock", "omni-transcript", "omni-orb"];
const SCALE_FOR_STATE = {
  "omni-hero": 1,
  "omni-dock": 1,
  "omni-transcript": 1.5, // dedicated wave area in the transcript card is bigger
  "omni-orb": 3.4,
};

export class OmnibarController {
  constructor() {
    this.root = document.documentElement;
    this.current = "omni-hero";
    this.waveform = new OmniWaveform();
    this.demoAISpeaking = false;

    // Register a wave-bar instance in every state's wave-host so all
    // instances stay perfectly in sync (driven by the single state machine).
    // `data-omni-wave-scale` overrides the per-state default scale where a
    // host needs a different size than the state's primary wave-area.
    document.querySelectorAll("[data-omni-wave-host]").forEach((el) => {
      const stateName = el.dataset.omniWaveHost;
      const override = parseFloat(el.dataset.omniWaveScale);
      const scale = Number.isFinite(override)
        ? override
        : (SCALE_FOR_STATE[stateName] || 1);
      this.waveform.addHost(el, scale);
    });

    // Voice provider (OpenAI / Gemini)
    this.voice = new VoiceClient();
    this.voice.on((s) => this._onVoiceState(s));
    this.voice.onError((m) => this._onVoiceError(m));

    // Chat log for the transcript state
    const chatHost = document.getElementById("omni-transcript-chat");
    this.transcriptLog = chatHost ? new TranscriptLog(chatHost) : null;
    if (this.transcriptLog) {
      this.voice.onTranscript((role, text, isFinal) =>
        this.transcriptLog.update(role, text, isFinal)
      );
    }

    // Track waveform state. Voice-mode stays true through the exit
    // animation so the green outer + hidden mic icons don't snap off
    // before the bars finish collapsing.
    this.waveform.on((state) => {
      this._reflectListeningState(state);
      this._updateLocalVoiceState();
      const voiceMode = state !== "mic";
      this.root.toggleAttribute("data-voice-mode", voiceMode);
    });

    // Local-mic VAD → drive voice-state attr when no API client is active.
    // (When the voice client is connected, its richer events take precedence.)
    this.waveform.onVAD(() => this._updateLocalVoiceState());

    this._bindStateButtons();
    this._bindPopover();
    this._bindOrbDismiss();
    this._bindMicButtons();
    this._bindSettingsUI();
    this._bindDemoAIButton();

    this.setState("omni-hero", { skipAnim: true });
  }

  _hasVoiceProvider() {
    return voiceSettings.hasKey();
  }

  async _toggleListening() {
    // Voice-provider mode if a key is configured
    if (this._hasVoiceProvider()) {
      if (this.voice.isActive() ||
          this.waveform.state === "listening" ||
          this.waveform.state === "entering") {
        this.voice.stop();
        this.transcriptLog?.clear();
        this.waveform.setExternalAnalyser(null);
        this.waveform.stopExiting();
        return;
      }
      try {
        // Begin animation immediately for snappy UX; analyser plugged in once available
        this.waveform.startEnteringExternal();
        await this.voice.start();
        // Default to user analyser
        const a = this.voice.analyserFor("user-speaking");
        if (a) this.waveform.setExternalAnalyser(a);
      } catch (e) {
        // Animation already started — undo it
        this.waveform.stopExiting();
      }
      return;
    }
    // Fallback: local-mic VAD only (no AI)
    this.waveform.toggle();
  }

  /** Drive the voice-state attribute from waveform state + VAD when no
   *  API client is connected. Click the arrow → mic on → "ai-speaking"
   *  (green CW). User talks → "user-speaking" (orange CCW). Stops →
   *  "ai-speaking" again. Click again → mic off → no gradient. */
  _updateLocalVoiceState() {
    if (this.voice.isActive()) return; // API events take precedence
    const wf = this.waveform;
    let next;
    if (wf.isUserSpeaking) next = "user-speaking";
    else if (this.demoAISpeaking) next = "ai-speaking";
    else next = "system-at-rest";
    this._onVoiceState(next);
  }

  _bindDemoAIButton() {
    // Chevron-left in the dock toggles a manual "AI speaking" demo state.
    // While on, the dock paints green/navy CW. When the mic detects user
    // audio, the orange/yellow user-speaking gradient overrides it. When
    // user audio stops, it returns to green/navy. Click again → off.
    const back = document.querySelector(".state-omni-dock__back");
    if (!back) return;
    back.addEventListener("click", (e) => {
      e.stopPropagation();
      this.demoAISpeaking = !this.demoAISpeaking;
      back.classList.toggle("is-active", this.demoAISpeaking);
      this._updateLocalVoiceState();
    });
  }

  _onVoiceState(state) {
    // Swap analyser source so bars react to whoever is talking
    if (state === "ai-speaking") {
      this.waveform.setExternalAnalyser(this.voice.analyserFor("ai-speaking"));
    } else {
      this.waveform.setExternalAnalyser(this.voice.analyserFor("user-speaking"));
    }
    // Show the assistant state class on root for any UI hooks
    this.root.setAttribute("data-voice-state", state);
  }

  _onVoiceError(msg) {
    console.warn("[voice]", msg);
    const banner = document.getElementById("voice-error");
    if (banner) {
      banner.textContent = msg;
      banner.classList.add("is-visible");
      clearTimeout(this._bannerT);
      this._bannerT = setTimeout(() => banner.classList.remove("is-visible"), 4000);
    }
  }

  _reflectListeningState(_state) {
    // No-op: voice-mode on <html> drives the global listening visuals;
    // we don't need per-host data-listening anymore.
  }

  _activeHost() {
    return document.querySelector(`[data-omni-host="${this.current}"]`);
  }

  setState(next, { skipAnim = false } = {}) {
    if (!STATES.includes(next)) return;
    // Per-host data-listening is no longer used — voice-mode on <html> drives
    // the listening visuals globally. We just update which state is active.
    this.current = next;
    this.root.setAttribute("data-omni-state", next);

    document.querySelectorAll(".state-popover__btn").forEach((b) => {
      b.classList.toggle("is-active", b.dataset.state === next);
    });

    if (!skipAnim) {
      const newEl = document.querySelector(`.state-${next}`);
      if (newEl) {
        newEl.style.animation = "none";
        void newEl.offsetWidth;
        newEl.style.animation = "";
      }
    }
  }

  _bindMicButtons() {
    document.querySelectorAll("[data-omni-host]").forEach((el) => {
      el.addEventListener("click", (e) => {
        if (e.target.closest(".state-omni-orb__dismiss")) return;
        e.preventDefault();
        this._toggleListening();
      });
    });
  }

  _bindSettingsUI() {
    const panel = document.getElementById("voice-settings");
    if (!panel) return;

    const providerInputs = panel.querySelectorAll('input[name="voice-provider"]');
    const keyInput = panel.querySelector("#voice-key-input");
    const mask = panel.querySelector("#voice-key-mask");
    const maskText = panel.querySelector("#voice-key-mask-text");
    const saveBtn = panel.querySelector("#voice-key-save");
    const clearBtn = panel.querySelector("#voice-key-clear");
    const status = panel.querySelector("#voice-key-status");

    const labelFor = (p) => (p === "gemini" ? "Gemini" : "OpenAI");

    const refreshUI = () => {
      const provider = voiceSettings.getProvider();
      providerInputs.forEach((r) => { r.checked = r.value === provider; });
      const has = voiceSettings.hasKey(provider);
      const key = voiceSettings.getKey(provider);

      // Input vs masked-key display
      if (has) {
        keyInput.setAttribute("hidden", "");
        mask.removeAttribute("hidden");
        maskText.textContent = `${key.slice(0, 5)}${"•".repeat(Math.max(8, key.length - 5))}`;
        saveBtn.setAttribute("hidden", "");
        clearBtn.removeAttribute("hidden");
      } else {
        keyInput.removeAttribute("hidden");
        mask.setAttribute("hidden", "");
        saveBtn.removeAttribute("hidden");
        clearBtn.setAttribute("hidden", "");
      }

      keyInput.value = "";
      keyInput.placeholder = `Enter ${labelFor(provider)} API key`;
      status.textContent = has ? `Key set for ${labelFor(provider)} ✓` : "No key set";
      status.dataset.has = String(has);
    };

    providerInputs.forEach((r) => {
      r.addEventListener("change", () => {
        if (r.checked) {
          voiceSettings.setProvider(r.value);
          // If provider changes mid-session, end the active session
          if (this.voice.isActive()) {
            this.voice.stop();
            this.transcriptLog?.clear();
            this.waveform.setExternalAnalyser(null);
            this.waveform.stopExiting();
          }
          refreshUI();
        }
      });
    });

    saveBtn.addEventListener("click", () => {
      const provider = voiceSettings.getProvider();
      const v = keyInput.value.trim();
      if (!v) return;
      voiceSettings.setKey(provider, v);
      refreshUI();
    });

    clearBtn.addEventListener("click", () => {
      const provider = voiceSettings.getProvider();
      voiceSettings.setKey(provider, "");
      if (this.voice.isActive()) {
        this.voice.stop();
        this.transcriptLog?.clear();
        this.waveform.setExternalAnalyser(null);
        this.waveform.stopExiting();
      }
      refreshUI();
    });

    refreshUI();
  }

  _bindStateButtons() {
    // Map state options to the view that naturally hosts that omnibar shape.
    // Hero ↔ home, Dock ↔ inbox (the email page). Transcript & Orb are
    // overlays that don't imply a particular view.
    const stateToView = {
      "omni-hero": "home",
      "omni-dock": "inbox",
      "omni-transcript": "canvas",
    };
    document.querySelectorAll(".state-popover__btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const s = btn.dataset.state;
        if (!s) return;
        const view = stateToView[s];
        const currentView = window.__currentView?.();
        // Only route through showView when the view actually changes;
        // otherwise just flip the omnibar state in place. Without this
        // guard, clicking Dock while already on the inbox view would
        // early-return and never switch back from transcript to dock.
        if (view && view !== currentView && typeof window.__showView === "function") {
          window.__showView(view);
        } else {
          this.setState(s);
        }
        this._closePopover();
      });
    });
  }

  _bindPopover() {
    const trigger = document.getElementById("omni-state-trigger");
    const pop = document.getElementById("omni-state-popover");
    if (!trigger || !pop) return;

    trigger.addEventListener("click", (e) => {
      e.stopPropagation();
      const open = !pop.hasAttribute("hidden");
      if (open) this._closePopover(); else this._openPopover();
    });
    document.addEventListener("click", (e) => {
      if (!pop.contains(e.target) && e.target !== trigger) this._closePopover();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") this._closePopover();
    });
  }

  _openPopover() {
    const trigger = document.getElementById("omni-state-trigger");
    const pop = document.getElementById("omni-state-popover");
    if (!trigger || !pop) return;
    const r = trigger.getBoundingClientRect();
    // Initial position to the right of the trigger
    pop.style.top = `${Math.round(r.top)}px`;
    pop.style.left = `${Math.round(r.right + 8)}px`;
    pop.removeAttribute("hidden");
    trigger.setAttribute("aria-expanded", "true");
    requestAnimationFrame(() => {
      pop.classList.add("is-open");
      // If the popover would overflow the bottom of the viewport, align its
      // bottom edge with the trigger's bottom edge instead.
      const popRect = pop.getBoundingClientRect();
      if (popRect.bottom > window.innerHeight - 16) {
        pop.style.top = `${Math.round(r.bottom - popRect.height)}px`;
      }
    });
  }

  _closePopover() {
    const trigger = document.getElementById("omni-state-trigger");
    const pop = document.getElementById("omni-state-popover");
    if (!pop) return;
    pop.classList.remove("is-open");
    pop.setAttribute("hidden", "");
    if (trigger) trigger.setAttribute("aria-expanded", "false");
  }

  _bindOrbDismiss() {
    const dismiss = document.querySelector(".state-omni-orb__dismiss");
    if (!dismiss) return;
    dismiss.addEventListener("click", (e) => {
      e.stopPropagation();
      // Closing the orb never stops the audio — the conversation keeps
      // going in whichever omnibar is appropriate for the current view.
      const onHome = window.__currentView?.() === "home";
      this.setState(onHome ? "omni-hero" : "omni-dock");
    });
  }
}
