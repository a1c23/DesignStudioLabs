// ChatGPT Voice Integration using OpenAI Realtime API
class ChatGPTVoice {
  constructor() {
    this.apiKey = null;
    this.ws = null;
    this.audioContext = null;
    this.mediaStream = null;
    this.isConnected = false;
    this.isUserSpeaking = false;
    this.isAISpeaking = false;
    this.nextPlayTime = 0; // Track when to play next audio chunk
    this.activeSources = []; // Track active audio sources for interruption
    this.aiAnalyser = null; // Analyser for AI audio output

    // Transcript tracking
    this.currentUserTranscript = '';
    this.currentAITranscript = '';

    // Timing controls
    this.speechStoppedTimeout = null;
    this.thinkingDelay = 1700; // 1.7 seconds thinking pause before AI responds (matches speech stopped delay)
    this.isInThinkingDelay = false;
    this.audioBuffer = []; // Simple buffer for audio during thinking delay

    // Callbacks for state changes
    this.onStateChange = null;
    this.onError = null;
    this.onStatusUpdate = null; // Callback for thinking status updates
    // Streaming transcript callback: (role, text, isFinal) => void
    this.onTranscript = null;
  }

  // Initialize with API key
  init(apiKey) {
    this.apiKey = apiKey;
  }

  // Start voice conversation
  async start() {
    if (!this.apiKey) {
      this.handleError('API key not set');
      return;
    }

    try {
      // Request microphone access
      this.mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        }
      });

      // Initialize audio context
      this.audioContext = new AudioContext({ sampleRate: 24000 });

      // Create analyser for AI audio output visualization
      this.aiAnalyser = this.audioContext.createAnalyser();
      this.aiAnalyser.fftSize = 64;
      this.aiAnalyser.connect(this.audioContext.destination);

      // Create analyser for user microphone input visualization
      this.userAnalyser = this.audioContext.createAnalyser();
      this.userAnalyser.fftSize = 64;

      // Connect to OpenAI Realtime API
      await this.connectToRealtimeAPI();

      // Start streaming audio
      this.startAudioStream();

      this.setState('system-at-rest');
    } catch (error) {
      this.handleError(`Failed to start: ${error.message}`);
    }
  }

  // Connect to OpenAI Realtime API via WebSocket
  async connectToRealtimeAPI() {
    return new Promise((resolve, reject) => {
      const url = 'wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview';

      this.ws = new WebSocket(url, ['realtime', `openai-insecure-api-key.${this.apiKey}`]);

      this.ws.onopen = () => {
        console.log('Connected to OpenAI Realtime API');
        this.isConnected = true;

        // Don't send session.update immediately - let session.created happen first

        resolve();
      };

      this.ws.onerror = (error) => {
        reject(error);
      };

      this.ws.onmessage = (event) => {
        this.handleRealtimeEvent(JSON.parse(event.data));
      };

      this.ws.onclose = (event) => {
        console.log('Disconnected from OpenAI Realtime API', event);
        this.isConnected = false;
        this.setState('system-at-rest');
      };
    });
  }

  // Handle events from OpenAI Realtime API
  handleRealtimeEvent(event) {
    // Log ALL events - comprehensive
    console.log('📡 Event:', event.type);
    if (event.type.includes('audio')) {
      console.log('🔊 AUDIO EVENT FULL DATA:', event);
    }
    if (event.delta) {
      console.log('📦 Has delta property:', event.delta);
    }

    switch (event.type) {
      case 'session.created':
        console.log('Session created:', event);
        console.log('Session object keys:', Object.keys(event.session));
        console.log('Full session:', JSON.stringify(event.session, null, 2));

        // Use the ACTUAL structure from the session object
        this.ws.send(JSON.stringify({
          type: 'session.update',
          session: {
            type: 'realtime',
            output_modalities: ['audio'],
            instructions: `You are called Otto (pronounced "awe-t-owe"), an HR and workplace assistant helping employees with workplace-related tasks, policies, and questions. You have access to my personnel files.

The user you're speaking with is "the employee" who works at the company.

For every question, acknowledge with "Give me a moment" or "Let me check that" before providing your answer.

Keep responses conversational, friendly, helpful, and professional.`,
            audio: {
              input: {
                transcription: {
                  model: 'whisper-1'
                },
                turn_detection: {
                  type: 'server_vad',
                  threshold: 0.5,
                  prefix_padding_ms: 300,
                  silence_duration_ms: 1500,
                  create_response: true
                }
              },
              output: {
                voice: 'alloy',
                format: {
                  type: 'audio/pcm',
                  rate: 24000
                }
              }
            }
          }
        }));
        break;

      case 'session.updated':
        console.log('Session updated successfully:', event);
        break;

      case 'input_audio_buffer.speech_started':
        this.isUserSpeaking = true;

        // Clear any pending speech stopped timeout
        if (this.speechStoppedTimeout) {
          clearTimeout(this.speechStoppedTimeout);
          this.speechStoppedTimeout = null;
        }

        // Clear previous transcripts
        this.currentUserTranscript = '';
        this.currentAITranscript = '';

        // INTERRUPT: Stop all AI audio immediately
        this.stopAllAudio();
        this.audioBuffer = []; // Clear audio buffer
        this.isInThinkingDelay = false;

        // Send response.cancel to interrupt the AI mid-response
        if (this.ws && this.ws.readyState === WebSocket.OPEN && this.isAISpeaking) {
          this.ws.send(JSON.stringify({
            type: 'response.cancel'
          }));
          console.log('🛑 Interrupting AI response');
        }

        this.setState('user-speaking');
        break;

      case 'input_audio_buffer.speech_stopped':
        this.isUserSpeaking = false;
        // Add 1.7 second delay before transitioning to allow user to finish their thought
        this.speechStoppedTimeout = setTimeout(() => {
          if (!this.isAISpeaking && !this.isUserSpeaking) {
            this.setState('system-at-rest');
          }
          this.speechStoppedTimeout = null;
        }, 1700);
        break;

      case 'response.created':
        console.log('Response created:', event);

        // Clear any pending speech stopped timeout
        if (this.speechStoppedTimeout) {
          clearTimeout(this.speechStoppedTimeout);
          this.speechStoppedTimeout = null;
        }

        // Reset audio queue and transcript for new response
        this.nextPlayTime = 0;
        this.activeSources = [];
        this.currentAITranscript = '';
        this.audioBuffer = []; // Clear audio buffer

        // Start 1.7-second thinking delay
        console.log('🤔 Starting 1.7-second thinking delay...');
        this.isInThinkingDelay = true;
        this.setState('system-thinking');

        // After 1.7 seconds, start playing audio
        setTimeout(() => {
          console.log('✅ Thinking complete, playing buffered audio');
          this.isInThinkingDelay = false;

          // Play any buffered audio chunks
          if (this.audioBuffer.length > 0) {
            this.setState('ai-speaking');
            // Release the held transcript at the same moment audio starts
            if (this.currentAITranscript) {
              this.onTranscript?.('ai', this.currentAITranscript, false);
            }
            this.audioBuffer.forEach(chunk => {
              this.playAudioChunk(chunk);
            });
            this.audioBuffer = [];
          }
        }, this.thinkingDelay);
        break;

      case 'response.done':
        console.log('Response done:', event);
        if (event.response && event.response.status === 'failed') {
          console.error('Response failed:', event.response.status_details);
        } else if (event.response && event.response.status === 'completed') {
          console.log('Response completed successfully');
          console.log('Response output:', event.response.output);
        }
        break;

      case 'response.output_item.added':
        console.log('Output item added:', event);
        break;

      case 'response.output_item.done':
        console.log('Output item done:', event);
        break;

      case 'response.text.delta':
        console.log('📝 Text delta received:', event.delta);
        break;

      case 'response.text.done':
        console.log('📝 Text complete:', event.text);
        break;

      case 'response.output_audio.delta':
        if (event.delta) {
          // During thinking delay, buffer the audio
          if (this.isInThinkingDelay) {
            console.log('🤔 Buffering audio during thinking delay');
            this.audioBuffer.push(event.delta);
          } else {
            // Normal playback after thinking delay
            if (!this.isAISpeaking) {
              this.isAISpeaking = true;
              this.setState('ai-speaking');
            }
            this.playAudioChunk(event.delta);
          }
        }
        break;

      case 'response.output_audio.done':
        console.log('✅ Output audio complete (API done sending)');
        // Don't immediately stop - wait for actual playback to finish
        // The last audio source will handle cleanup when it ends
        break;

      case 'response.content_part.added':
        console.log('Content part added:', event);
        break;

      case 'response.content_part.done':
        console.log('Content part done:', event);
        break;

      case 'response.audio_transcript.delta':
        console.log('Audio transcript delta:', event.delta);
        // Accumulate AI transcript. Hold UI emission until the thinking
        // pause is over so text doesn't race ahead of speech.
        this.currentAITranscript += event.delta;
        if (!this.isInThinkingDelay) {
          this.onTranscript?.('ai', this.currentAITranscript, false);
        }
        break;

      case 'response.audio_transcript.done':
        console.log('Audio transcript done:', event);
        // Transcript is complete — finalize the AI bubble
        if (this.currentAITranscript) {
          this.onTranscript?.('ai', this.currentAITranscript, true);
        }
        break;


      case 'conversation.item.created':
        console.log('Conversation item created:', event.item);
        break;

      case 'conversation.item.input_audio_transcription.completed':
        console.log('User said:', event.transcript);
        this.currentUserTranscript = event.transcript;
        this.onTranscript?.('user', event.transcript, true);
        break;

      case 'response.cancelled':
        console.log('🛑 Response cancelled by user interruption');
        this.stopAllAudio();
        this.audioBuffer = []; // Clear audio buffer
        this.isInThinkingDelay = false;
        break;

      case 'error':
        console.error('API Error:', event.error);
        this.handleError(event.error.message);
        break;

      default:
        console.log('Unhandled event type:', event.type);
        // Check if this event has audio data
        if (event.audio || event.delta || (event.item && event.item.content)) {
          console.log('⚠️ UNHANDLED EVENT WITH POTENTIAL AUDIO DATA:', event);
        }
        break;
    }
  }

  // Update status display
  updateStatus(message) {
    const statusEl = document.getElementById('status-display');
    if (statusEl) {
      statusEl.textContent = message;
    }
  }

  // Start streaming microphone audio to API
  startAudioStream() {
    const source = this.audioContext.createMediaStreamSource(this.mediaStream);
    const processor = this.audioContext.createScriptProcessor(4096, 1, 1);

    // Connect microphone to user analyser for visualization
    source.connect(this.userAnalyser);

    source.connect(processor);
    processor.connect(this.audioContext.destination);

    processor.onaudioprocess = (e) => {
      if (!this.isConnected) return;

      const inputData = e.inputBuffer.getChannelData(0);
      const pcm16 = this.floatTo16BitPCM(inputData);
      const base64Audio = this.arrayBufferToBase64(pcm16);

      // Send audio to API
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({
          type: 'input_audio_buffer.append',
          audio: base64Audio
        }));
      }
    };
  }

  // Play audio chunk from API
  playAudioChunk(base64Audio) {
    try {
      const audioData = this.base64ToArrayBuffer(base64Audio);
      const float32Array = this.pcm16ToFloat(new Int16Array(audioData));

      const audioBuffer = this.audioContext.createBuffer(1, float32Array.length, 24000);
      audioBuffer.getChannelData(0).set(float32Array);

      const source = this.audioContext.createBufferSource();
      source.buffer = audioBuffer;

      // Connect to both the analyser (for visualization) and destination (for playback)
      if (this.aiAnalyser) {
        source.connect(this.aiAnalyser);
      } else {
        source.connect(this.audioContext.destination);
      }

      // Schedule audio to play after previous chunk
      const currentTime = this.audioContext.currentTime;
      const startTime = Math.max(currentTime, this.nextPlayTime);
      source.start(startTime);

      // Track source for interruption
      this.activeSources.push(source);

      // Clean up when done
      source.onended = () => {
        const index = this.activeSources.indexOf(source);
        if (index > -1) {
          this.activeSources.splice(index, 1);
        }

        // If this was the last source and we're done receiving audio, transition to rest
        if (this.activeSources.length === 0 && this.isAISpeaking) {
          console.log('🔇 All audio playback complete');
          this.isAISpeaking = false;
          this.nextPlayTime = 0;
          if (!this.isUserSpeaking) {
            this.setState('system-at-rest');
          }
        }
      };

      // Update next play time
      this.nextPlayTime = startTime + audioBuffer.duration;

      console.log(`🔊 Scheduled audio chunk at ${startTime.toFixed(3)}s, duration: ${audioBuffer.duration.toFixed(3)}s`);
    } catch (error) {
      console.error('Error playing audio:', error);
    }
  }

  // Stop all playing audio (for interruptions)
  stopAllAudio() {
    if (this.activeSources.length > 0) {
      console.log('🛑 Stopping all audio sources:', this.activeSources.length);

      // Stop all active audio sources
      this.activeSources.forEach(source => {
        try {
          source.stop();
        } catch (e) {
          // Source may already be stopped or context closed
        }
      });

      // Clear the array and reset timing
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

    // Stop all audio first
    this.stopAllAudio();

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }

    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach(track => track.stop());
      this.mediaStream = null;
    }

    if (this.audioContext) {
      this.audioContext.close();
      this.audioContext = null;
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
    console.error('ChatGPT Voice Error:', message);
    if (this.onError) {
      this.onError(message);
    }
  }

  // Audio conversion utilities
  floatTo16BitPCM(float32Array) {
    const int16Array = new Int16Array(float32Array.length);
    for (let i = 0; i < float32Array.length; i++) {
      const s = Math.max(-1, Math.min(1, float32Array[i]));
      int16Array[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
    }
    return int16Array.buffer;
  }

  pcm16ToFloat(int16Array) {
    const float32Array = new Float32Array(int16Array.length);
    for (let i = 0; i < int16Array.length; i++) {
      float32Array[i] = int16Array[i] / (int16Array[i] < 0 ? 0x8000 : 0x7FFF);
    }
    return float32Array;
  }

  arrayBufferToBase64(buffer) {
    let binary = '';
    const bytes = new Uint8Array(buffer);
    for (let i = 0; i < bytes.byteLength; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }

  base64ToArrayBuffer(base64) {
    const binaryString = atob(base64);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    return bytes.buffer;
  }
}

// Global instance
window.chatGPTVoice = new ChatGPTVoice();
