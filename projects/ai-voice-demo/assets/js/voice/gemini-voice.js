// Google Gemini 2.0 Multimodal Live API Integration
// Real-time bidirectional voice conversation

class GeminiVoice {
  constructor() {
    this.ws = null;
    this.apiKey = null;
    this.isConnected = false;
    this.mediaStream = null;

    // Dual AudioContext setup
    // Input: 16kHz for sending to Gemini
    // Output: 24kHz for playing Gemini's audio
    this.inputAudioContext = null;  // 16kHz
    this.outputAudioContext = null; // 24kHz

    this.activeSources = [];
    this.nextPlayTime = 0;

    // State tracking
    this.isUserSpeaking = false;
    this.isAISpeaking = false;

    // Transcript tracking
    this.currentUserTranscript = '';
    this.currentAITranscript = '';

    // Timing controls
    this.speechStoppedTimeout = null;
    this.thinkingDelay = 1700; // 1.7 seconds thinking pause
    this.isInThinkingDelay = false;
    this.audioBuffer = []; // Buffer audio during thinking delay

    // Callbacks for state changes
    this.onStateChange = null;
    this.onError = null;
    this.onStatusUpdate = null;
    // Streaming transcript callback: (role, text, isFinal) => void
    this.onTranscript = null;
  }

  // Initialize with API key
  init(apiKey) {
    this.apiKey = apiKey;
  }

  // Start voice conversation
  async start() {
    try {
      // Request microphone access
      this.mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        }
      });

      // Initialize dual audio contexts
      // Input at 16kHz for Gemini, Output at 24kHz for playback
      this.inputAudioContext = new AudioContext({ sampleRate: 16000 });
      this.outputAudioContext = new AudioContext({ sampleRate: 24000 });

      // Create analyser for AI audio output visualization
      this.aiAnalyser = this.outputAudioContext.createAnalyser();
      this.aiAnalyser.fftSize = 64;
      this.aiAnalyser.connect(this.outputAudioContext.destination);

      // Create analyser for user microphone input visualization
      this.userAnalyser = this.inputAudioContext.createAnalyser();
      this.userAnalyser.fftSize = 64;

      // Connect to Gemini Live API
      await this.connectToRealtimeAPI();

      // Start streaming audio
      this.startAudioStream();

      this.setState('system-at-rest');
    } catch (error) {
      this.handleError(`Failed to start: ${error.message}`);
    }
  }

  // Connect to Gemini Multimodal Live API via WebSocket
  async connectToRealtimeAPI() {
    return new Promise((resolve, reject) => {
      // Gemini Live API endpoint — v1beta (v1alpha is deprecated as of 2025).
      const url = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${this.apiKey}`;

      this.ws = new WebSocket(url);

      this.ws.onopen = () => {
        console.log('✅ Connected to Gemini Live API');
        this.isConnected = true;

        // Send setup message immediately (REQUIRED).
        // Per Gemini deprecation docs: gemini-2.0-flash-live-001 and the older
        // -exp variants are retired; replace with gemini-3.1-flash-live-preview.
        // Alternates if your key doesn't have access to 3.1:
        //   models/gemini-live-2.5-flash-preview
        //   models/gemini-2.5-flash-preview-native-audio-dialog
        //   models/gemini-2.5-flash-exp-native-audio-thinking-dialog
        const setupMessage = {
          setup: {
            model: "models/gemini-3.1-flash-live-preview",
            generationConfig: {
              responseModalities: ["audio"],
              speechConfig: {
                voiceConfig: {
                  prebuiltVoiceConfig: {
                    voiceName: "Puck" // Options: Puck, Charon, Kore, Fenrir, Aoede
                  }
                }
              }
            },
            systemInstruction: {
              parts: [{
                text: `You are called Otto (pronounced "awe-t-owe"), an HR and workplace assistant helping employees with workplace-related tasks, policies, and questions. You have access to my personnel files.

The user you're speaking with is "the employee" who works at the company.

For every question, acknowledge with "Give me a moment" or "Let me check that" before providing your answer.

Keep responses conversational, friendly, helpful, and professional.`
              }]
            }
          }
        };

        console.log('📤 Sending setup message...');
        this.ws.send(JSON.stringify(setupMessage));
        resolve();
      };

      this.ws.onmessage = async (event) => {
        try {
          // Handle Blob responses (Gemini sends Blobs, not text)
          let messageText;
          if (event.data instanceof Blob) {
            messageText = await event.data.text();
          } else {
            messageText = event.data;
          }
          const data = JSON.parse(messageText);
          this.handleRealtimeEvent(data);
        } catch (error) {
          console.error('Error parsing message:', error);
        }
      };

      this.ws.onerror = (error) => {
        console.error('WebSocket error:', error);
        reject(error);
      };

      this.ws.onclose = (event) => {
        console.log('Disconnected from Gemini:', event.code, event.reason);
        this.isConnected = false;
        this.cleanup();
      };
    });
  }

  // Handle events from Gemini Live API
  handleRealtimeEvent(event) {
    // Setup complete - ready for conversation
    if (event.setupComplete) {
      console.log('✅ Setup complete - ready for conversation');
      return;
    }

    // Server content - contains audio, transcripts, turn status
    if (event.serverContent) {
      const { serverContent } = event;

      // Handle audio output
      if (serverContent.modelTurn && serverContent.modelTurn.parts) {
        serverContent.modelTurn.parts.forEach(part => {
          if (part.inlineData && part.inlineData.mimeType === 'audio/pcm;rate=24000') {
            // Buffer ALL AI audio while user is speaking OR during thinking delay
            if (this.isUserSpeaking || this.isInThinkingDelay) {
              console.log('🤔 Buffering audio (user speaking or thinking)');
              this.audioBuffer.push(part.inlineData.data);
            } else {
              // Play only after user done speaking AND thinking delay complete
              if (!this.isAISpeaking) {
                this.isAISpeaking = true;
                this.setState('ai-speaking');
              }
              this.playAudioChunk(part.inlineData.data);
            }
          }
        });
      }

      // Handle AI output transcription. Hold emission until audio is actually
      // playing — Gemini sends the full transcript ahead of speech, so without
      // this gate the text would arrive seconds before the user hears it.
      if (serverContent.outputTranscription) {
        const text = serverContent.outputTranscription.text;
        console.log('AI said:', text);
        this.currentAITranscript += text;
        if (!this.isUserSpeaking && !this.isInThinkingDelay) {
          this.onTranscript?.('ai', this.currentAITranscript, false);
        }
      }

      // Handle user input transcription
      if (serverContent.inputTranscription) {
        const text = serverContent.inputTranscription.text;
        console.log('User said:', text);
        this.currentUserTranscript = text;
        this.onTranscript?.('user', this.currentUserTranscript, false);

        // Set to user-speaking when we get user transcript
        if (!this.isUserSpeaking && !this.isAISpeaking) {
          this.isUserSpeaking = true;
          this.setState('user-speaking');
        }
      }

      // Handle turn completion - reset to rest
      if (serverContent.turnComplete) {
        console.log('✅ Turn complete');
        if (this.currentUserTranscript) {
          this.onTranscript?.('user', this.currentUserTranscript, true);
        }
        if (this.currentAITranscript) {
          this.onTranscript?.('ai', this.currentAITranscript, true);
          this.currentAITranscript = '';
        }
        this.isUserSpeaking = false;
        this.currentUserTranscript = '';
      }

      // Handle interruption
      if (serverContent.interrupted) {
        console.log('🛑 Response was interrupted');
        this.stopAllAudio();
        if (this.currentUserTranscript) {
          this.onTranscript?.('user', this.currentUserTranscript, true);
        }
        if (this.currentAITranscript) {
          this.onTranscript?.('ai', this.currentAITranscript, true);
          this.currentAITranscript = '';
        }
        this.audioBuffer = [];
        this.isInThinkingDelay = false;
        this.isUserSpeaking = false;
        this.currentUserTranscript = '';
      }

      // Handle generation completion
      if (serverContent.generationComplete) {
        console.log('✅ Generation complete');
      }
    }

    // Handle tool calls (function calling)
    if (event.toolCall) {
      console.log('🔧 Tool call requested:', event.toolCall);
    }

    // Handle disconnection warning
    if (event.goAway) {
      console.warn('⚠️ Server signaled disconnect:', event.goAway);
    }
  }

  // Start thinking delay after user stops speaking
  startThinkingDelay() {
    console.log('🤔 Starting 1.7-second thinking delay...');
    console.log('📦 Currently buffered chunks:', this.audioBuffer.length);

    // DON'T clear audio buffer - it may already have AI audio from while user was speaking!
    this.isInThinkingDelay = true;
    this.setState('system-thinking');

    // After 1.7 seconds, play buffered audio or return to rest
    setTimeout(() => {
      console.log('✅ Thinking complete, playing buffered audio');
      console.log('📦 Buffered chunks to play:', this.audioBuffer.length);
      this.isInThinkingDelay = false;

      // Play any buffered audio chunks from AI
      if (this.audioBuffer.length > 0) {
        this.isAISpeaking = true;
        this.setState('ai-speaking');
        // Release any transcript that built up during the thinking pause
        // so the text shows up at the same moment the audio starts.
        if (this.currentAITranscript) {
          this.onTranscript?.('ai', this.currentAITranscript, false);
        }
        this.audioBuffer.forEach(chunk => {
          this.playAudioChunk(chunk);
        });
        this.audioBuffer = [];
      } else {
        // No AI response yet, return to rest
        this.setState('system-at-rest');
      }
    }, this.thinkingDelay);
  }

  // Start streaming microphone audio to API
  startAudioStream() {
    // Use inputAudioContext at 16kHz for microphone
    const source = this.inputAudioContext.createMediaStreamSource(this.mediaStream);
    const processor = this.inputAudioContext.createScriptProcessor(4096, 1, 1);

    // Connect microphone to user analyser for visualization
    source.connect(this.userAnalyser);

    source.connect(processor);
    processor.connect(this.inputAudioContext.destination);

    // Voice activity detection variables
    this.silenceTimeout = null;
    const SPEECH_THRESHOLD = 0.01; // Amplitude threshold for speech detection
    const SILENCE_DURATION = 1700; // 1.7 seconds of silence to allow pauses

    processor.onaudioprocess = (e) => {
      if (!this.isConnected) return;

      const inputData = e.inputBuffer.getChannelData(0);

      // Detect voice activity based on audio level
      let sum = 0;
      for (let i = 0; i < inputData.length; i++) {
        sum += Math.abs(inputData[i]);
      }
      const average = sum / inputData.length;

      // Check if user is speaking (and AI is not)
      if (average > SPEECH_THRESHOLD && !this.isAISpeaking) {
        // Clear any pending silence timeout
        if (this.silenceTimeout) {
          clearTimeout(this.silenceTimeout);
          this.silenceTimeout = null;
        }

        // Switch to user-speaking if not already
        if (!this.isUserSpeaking && !this.isInThinkingDelay) {
          this.isUserSpeaking = true;
          this.setState('user-speaking');
          this.currentUserTranscript = '';
        }
      } else if (this.isUserSpeaking && !this.isAISpeaking && !this.isInThinkingDelay) {
        // User stopped speaking - start 1.7s silence timeout
        if (!this.silenceTimeout) {
          this.silenceTimeout = setTimeout(() => {
            console.log('🤔 User finished speaking (1.7s silence), starting thinking mode');
            this.isUserSpeaking = false;
            this.startThinkingDelay();
            this.silenceTimeout = null;
          }, SILENCE_DURATION);
        }
      }

      const pcm16 = this.floatTo16BitPCM(inputData);
      const base64Audio = this.arrayBufferToBase64(pcm16);

      // Send audio to Gemini using the current realtimeInput.audio shape.
      // (mediaChunks was deprecated in 2025 — use audio, video, or text.)
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({
          realtimeInput: {
            audio: {
              mimeType: "audio/pcm;rate=16000",
              data: base64Audio
            }
          }
        }));
      }
    };
  }

  // Play audio chunk
  playAudioChunk(base64Audio) {
    try {
      const audioData = this.base64ToArrayBuffer(base64Audio);
      const float32Array = this.pcm16ToFloat(new Int16Array(audioData));

      // Use outputAudioContext at 24kHz for playback
      const audioBuffer = this.outputAudioContext.createBuffer(1, float32Array.length, 24000);
      audioBuffer.getChannelData(0).set(float32Array);

      const source = this.outputAudioContext.createBufferSource();
      source.buffer = audioBuffer;

      // Connect to analyser for visualization
      source.connect(this.aiAnalyser);

      const currentTime = this.outputAudioContext.currentTime;
      const startTime = Math.max(currentTime, this.nextPlayTime);

      source.start(startTime);
      source.onended = () => {
        const index = this.activeSources.indexOf(source);
        if (index > -1) {
          this.activeSources.splice(index, 1);
        }

        // Check if all audio has finished playing
        if (this.activeSources.length === 0) {
          this.isAISpeaking = false;
          this.setState('system-at-rest');
        }
      };

      this.activeSources.push(source);
      this.nextPlayTime = startTime + audioBuffer.duration;
    } catch (error) {
      console.error('Error playing audio:', error);
    }
  }

  // Stop all currently playing audio
  stopAllAudio() {
    this.activeSources.forEach(source => {
      try {
        source.stop();
        source.disconnect();
      } catch (e) {
        // Source may have already stopped
      }
    });

    // Clear the array and reset timing
    if (this.activeSources.length > 0) {
      this.activeSources = [];
    }

    this.nextPlayTime = 0;
    this.isAISpeaking = false;
  }

  // Stop voice conversation
  stop() {
    // Clear any pending timeouts
    if (this.speechStoppedTimeout) {
      clearTimeout(this.speechStoppedTimeout);
      this.speechStoppedTimeout = null;
    }

    // Stop all audio playback
    this.stopAllAudio();

    // Close WebSocket
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }

    // Stop microphone stream
    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach(track => track.stop());
      this.mediaStream = null;
    }

    // Close audio contexts
    if (this.inputAudioContext) {
      this.inputAudioContext.close();
      this.inputAudioContext = null;
    }

    if (this.outputAudioContext) {
      this.outputAudioContext.close();
      this.outputAudioContext = null;
    }

    this.aiAnalyser = null;
    this.isConnected = false;
    this.isUserSpeaking = false;
    this.isAISpeaking = false;
    this.isInThinkingDelay = false;
    this.audioBuffer = [];
    this.nextPlayTime = 0;
    this.setState('system-at-rest');
  }

  // Set animation state
  setState(state) {
    if (this.onStateChange) {
      this.onStateChange(state);
    }
  }

  // Get AI audio analyser for visualization
  getAIAnalyser() {
    return this.aiAnalyser;
  }

  // Get user microphone analyser for visualization
  getUserAnalyser() {
    return this.userAnalyser;
  }

  // Handle errors
  handleError(message) {
    console.error('Gemini Voice Error:', message);
    if (this.onError) {
      this.onError(message);
    }
  }

  // Clean up resources
  cleanup() {
    this.stopAllAudio();

    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach(track => track.stop());
      this.mediaStream = null;
    }

    if (this.inputAudioContext) {
      this.inputAudioContext.close();
      this.inputAudioContext = null;
    }

    if (this.outputAudioContext) {
      this.outputAudioContext.close();
      this.outputAudioContext = null;
    }

    this.isConnected = false;
    this.isUserSpeaking = false;
    this.isAISpeaking = false;
    this.isInThinkingDelay = false;
    this.audioBuffer = [];
  }

  // Convert Float32Array to 16-bit PCM
  floatTo16BitPCM(float32Array) {
    const buffer = new ArrayBuffer(float32Array.length * 2);
    const view = new DataView(buffer);
    let offset = 0;
    for (let i = 0; i < float32Array.length; i++, offset += 2) {
      const s = Math.max(-1, Math.min(1, float32Array[i]));
      view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
    }
    return buffer;
  }

  // Convert 16-bit PCM to Float32Array
  pcm16ToFloat(pcm16) {
    const float32 = new Float32Array(pcm16.length);
    for (let i = 0; i < pcm16.length; i++) {
      float32[i] = pcm16[i] / (pcm16[i] < 0 ? 0x8000 : 0x7FFF);
    }
    return float32;
  }

  // Convert ArrayBuffer to Base64
  arrayBufferToBase64(buffer) {
    let binary = '';
    const bytes = new Uint8Array(buffer);
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }

  // Convert Base64 to ArrayBuffer
  base64ToArrayBuffer(base64) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes.buffer;
  }
}

// Create global instance
window.geminiVoice = new GeminiVoice();
