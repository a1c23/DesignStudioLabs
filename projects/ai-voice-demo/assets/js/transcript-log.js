/* Live chat-log renderer for the transcript omnibar state.
 *
 * Receives streaming transcript events from VoiceClient and paints them as
 * alternating bubbles in `host`. AI bubbles align left, user bubbles right.
 * The host's max-height jumps from 220px to 330px the first time content
 * overflows, then native scrollbar handles further growth.
 */

export class TranscriptLog {
  constructor(host) {
    if (!host) throw new Error("TranscriptLog needs a host element");
    this.host = host;
    this.host.classList.add("chat-log");
    this.liveUser = null; // ref to the in-progress user bubble (or null)
    this.liveAI = null;   // ref to the in-progress AI bubble (or null)
    // Per-bubble typewriter state: { target, current, scheduled, isFinal }
    this.typeQueue = new Map();
  }

  /** Update or finalize a turn.
   *  @param {'user'|'ai'} role
   *  @param {string} text — the complete current text for this turn
   *  @param {boolean} isFinal — true when the turn is locked
   */
  update(role, text, isFinal) {
    if (typeof text !== "string") return;
    const liveRef = role === "user" ? "liveUser" : "liveAI";
    let bubble = this[liveRef];

    if (!bubble) {
      bubble = document.createElement("div");
      bubble.className = `chat-bubble chat-bubble--${role}`;
      this.host.appendChild(bubble);
      this[liveRef] = bubble;
    }
    this._typewriter(bubble, text, isFinal);

    if (isFinal) this[liveRef] = null;
  }

  /** Wipe all messages and reset the live refs. Called when voice session ends. */
  clear() {
    // Cancel any in-flight typewriter timers
    this.typeQueue.forEach((state) => {
      if (state.timeoutId) clearTimeout(state.timeoutId);
    });
    this.typeQueue.clear();
    this.host.replaceChildren();
    this.liveUser = null;
    this.liveAI = null;
    this.host.classList.remove("is-tall");
  }

  /** Reveal `target` one character at a time on `bubble`. New chunks just
   *  extend the target — the running loop catches up. Adaptive delay:
   *  fast when backlog is large so audio never overtakes the text. */
  _typewriter(bubble, target, isFinal) {
    let state = this.typeQueue.get(bubble);
    if (!state) {
      state = { current: "", target: "", scheduled: false, isFinal: false, timeoutId: null };
      this.typeQueue.set(bubble, state);
    }
    state.target = target;
    state.isFinal = state.isFinal || isFinal;

    // If already at the target, just finalize and bail
    if (state.current.length >= state.target.length) {
      bubble.textContent = state.target;
      if (state.isFinal) this.typeQueue.delete(bubble);
      return;
    }
    // Otherwise start (or keep running) the step loop
    if (!state.scheduled) this._step(bubble, state);
  }

  _step(bubble, state) {
    state.scheduled = true;
    const tick = () => {
      // Caught up — pause until update() pushes more text
      if (state.current.length >= state.target.length) {
        bubble.textContent = state.target;
        state.scheduled = false;
        state.timeoutId = null;
        if (state.isFinal) this.typeQueue.delete(bubble);
        return;
      }

      // Advance by a few chars for big backlogs (keeps up with rapid API chunks).
      // The "natural" rate is paced near speech tempo (~18 cps) so the trailing
      // edge of a sentence stays in sync with the audio.
      const remaining = state.target.length - state.current.length;
      let step;
      let delay;
      if (remaining > 120) { step = 4; delay = 16; }       // very behind — burst (~250 cps)
      else if (remaining > 40) { step = 2; delay = 22; }   // catching up (~90 cps)
      else { step = 1; delay = 55; }                       // natural speech pace (~18 cps)

      state.current = state.target.slice(0, state.current.length + step);
      bubble.textContent = state.current;
      this._maybeGrow();
      this._scrollToBottom();
      state.timeoutId = setTimeout(tick, delay);
    };
    tick();
  }

  _maybeGrow() {
    if (this.host.classList.contains("is-tall")) return;
    if (this.host.scrollHeight > this.host.clientHeight) {
      this.host.classList.add("is-tall");
    }
  }

  _scrollToBottom() {
    this.host.scrollTop = this.host.scrollHeight;
  }
}
