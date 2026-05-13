/* Voice provider wrapper
 *
 * Carlo's chatgpt-voice.js / gemini-voice.js attach singletons to window:
 *   window.chatGPTVoice    (class ChatGPTVoice)
 *   window.geminiVoice     (class GeminiVoice)
 *
 * Both expose:
 *   init(apiKey)
 *   start()                          → opens mic + websocket
 *   stop()
 *   onStateChange(state)             → 'user-speaking' | 'ai-speaking' |
 *                                      'system-thinking' | 'system-at-rest'
 *   onError(msg)
 *   getAIAnalyser()                  → AnalyserNode for assistant audio
 *   getUserAnalyser()                → AnalyserNode for mic audio
 *
 * This module exposes a unified facade over both, plus localStorage-backed
 * settings (provider + key).
 */

const STORAGE = {
  provider: "ai-voice.provider",
  keyOpenAI: "ai-voice.key.openai",
  keyGemini: "ai-voice.key.gemini",
};

export const PROVIDERS = ["openai", "gemini"];

export const settings = {
  getProvider() {
    return localStorage.getItem(STORAGE.provider) || "openai";
  },
  setProvider(p) {
    if (!PROVIDERS.includes(p)) return;
    localStorage.setItem(STORAGE.provider, p);
  },
  getKey(provider = settings.getProvider()) {
    const k = provider === "gemini" ? STORAGE.keyGemini : STORAGE.keyOpenAI;
    return localStorage.getItem(k) || "";
  },
  setKey(provider, key) {
    const k = provider === "gemini" ? STORAGE.keyGemini : STORAGE.keyOpenAI;
    if (key) localStorage.setItem(k, key);
    else localStorage.removeItem(k);
  },
  hasKey(provider = settings.getProvider()) {
    return Boolean(settings.getKey(provider));
  },
};

export class VoiceClient {
  constructor() {
    this.session = null;     // active provider instance
    this.providerName = null;
    this.listeners = new Set();
    this.errorListeners = new Set();
    this.transcriptListeners = new Set();
  }

  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  onError(fn) { this.errorListeners.add(fn); return () => this.errorListeners.delete(fn); }
  /** Subscribe to live transcript events: (role, text, isFinal) => void */
  onTranscript(fn) { this.transcriptListeners.add(fn); return () => this.transcriptListeners.delete(fn); }

  _resolveSingleton(provider) {
    if (provider === "openai") return window.chatGPTVoice;
    if (provider === "gemini") return window.geminiVoice;
    return null;
  }

  isReady() {
    return settings.hasKey();
  }

  isActive() {
    return Boolean(this.session && this.session.isConnected);
  }

  async start() {
    if (this.session) return; // already running
    const provider = settings.getProvider();
    const key = settings.getKey(provider);
    if (!key) {
      this._fireError("No API key set. Open settings and add one.");
      throw new Error("missing_api_key");
    }

    const inst = this._resolveSingleton(provider);
    if (!inst) {
      this._fireError(`Voice client for "${provider}" not loaded.`);
      throw new Error("missing_provider");
    }

    inst.init(key);
    inst.onStateChange = (state) => this._fire(state);
    inst.onError = (msg) => this._fireError(msg);
    inst.onTranscript = (role, text, isFinal) =>
      this._fireTranscript(role, text, isFinal);
    this.session = inst;
    this.providerName = provider;

    await inst.start();
  }

  stop() {
    if (!this.session) return;
    try { this.session.stop(); } catch (_) {}
    // Detach callbacks so the singleton can be safely re-used later
    this.session.onStateChange = null;
    this.session.onError = null;
    this.session.onTranscript = null;
    this.session = null;
    this.providerName = null;
  }

  /** Returns the analyser appropriate to the current speaking state. */
  analyserFor(state) {
    if (!this.session) return null;
    if (state === "ai-speaking") return this.session.getAIAnalyser?.() || null;
    return this.session.getUserAnalyser?.() || null;
  }

  _fire(state) { this.listeners.forEach((fn) => fn(state)); }
  _fireError(msg) { this.errorListeners.forEach((fn) => fn(msg)); }
  _fireTranscript(role, text, isFinal) {
    this.transcriptListeners.forEach((fn) => fn(role, text, isFinal));
  }
}
