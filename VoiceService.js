/**
 * RoadSoS — services/VoiceService.js
 *
 * Handles all voice I/O for the app:
 *  1. Speech recognition — listen for emergency keywords
 *  2. Text-to-speech — speak results back to user
 *  3. SOS trigger — auto-run emergency flow on keyword match
 *
 * Uses expo-av for recording + expo-speech for TTS.
 * Recognition is done via the Web Speech API inside a WebView
 * (the only free, no-key approach on React Native / Expo).
 *
 * Exports:
 *   startListening(onKeywordDetected)  → start background mic
 *   stopListening()                    → stop mic
 *   speak(text, options)               → TTS output
 *   stopSpeaking()                     → cancel TTS
 *   isListening()                      → boolean
 *   isSpeaking()                       → boolean
 */

import * as Speech from 'expo-speech';
import { Audio } from 'expo-av';
import { Platform } from 'react-native';
import { VOICE } from '../constants/config';

// ─── State ────────────────────────────────────────────────────────────────────
let _listening   = false;
let _speaking    = false;
let _recording   = null;   // expo-av Recording instance
let _keywordCb   = null;   // callback(matchedKeyword, transcript)
let _pollInterval = null;  // polling timer for simulated detection

// ─── Keyword list (from config + extras) ─────────────────────────────────────
const KEYWORDS = [
  ...VOICE.TRIGGER_KEYWORDS,
  // Additional phonetic variants that STT often returns
  'help me',
  'please help',
  'call ambulance',
  'call police',
  'i had an accident',
  'there was an accident',
  'somebody is hurt',
  'someone is hurt',
  'emergency',
  'mayday',
  '911', '999', '112', '108',
];

// ─── Permission Helpers ───────────────────────────────────────────────────────

/**
 * Request microphone permission.
 * @returns {Promise<boolean>}
 */
export async function requestMicPermission() {
  try {
    const { status } = await Audio.requestPermissionsAsync();
    return status === 'granted';
  } catch {
    return false;
  }
}

/**
 * Check if mic permission is already granted.
 * @returns {Promise<boolean>}
 */
export async function checkMicPermission() {
  try {
    const { status } = await Audio.getPermissionsAsync();
    return status === 'granted';
  } catch {
    return false;
  }
}

// ─── Keyword Matcher ──────────────────────────────────────────────────────────

/**
 * Check if a transcript string contains any emergency keyword.
 * Case-insensitive, handles partial matches.
 *
 * @param {string} transcript
 * @returns {{ matched: boolean, keyword: string | null }}
 */
export function detectKeyword(transcript) {
  if (!transcript) return { matched: false, keyword: null };
  const lower = transcript.toLowerCase().trim();

  for (const kw of KEYWORDS) {
    if (lower.includes(kw.toLowerCase())) {
      return { matched: true, keyword: kw };
    }
  }
  return { matched: false, keyword: null };
}

// ─── Audio Mode Setup ─────────────────────────────────────────────────────────

/**
 * Configure expo-av audio session for recording.
 * Must be called before starting any recording.
 */
async function setupAudioMode() {
  await Audio.setAudioModeAsync({
    allowsRecordingIOS: true,
    playsInSilentModeIOS: true,
    staysActiveInBackground: true,     // Critical for background listening
    interruptionModeIOS: 1,            // DoNotMix
    interruptionModeAndroid: 1,        // DoNotMix
    shouldDuckAndroid: false,
    playThroughEarpieceAndroid: false,
  });
}

// ─── Recording Options ────────────────────────────────────────────────────────
const RECORDING_OPTIONS = {
  android: {
    extension: '.m4a',
    outputFormat: Audio.RECORDING_OPTION_ANDROID_OUTPUT_FORMAT_MPEG_4,
    audioEncoder: Audio.RECORDING_OPTION_ANDROID_AUDIO_ENCODER_AAC,
    sampleRate: 16000,
    numberOfChannels: 1,
    bitRate: 64000,
  },
  ios: {
    extension: '.caf',
    audioQuality: Audio.RECORDING_OPTION_IOS_AUDIO_QUALITY_MEDIUM,
    sampleRate: 16000,
    numberOfChannels: 1,
    bitRate: 64000,
    linearPCMBitDepth: 16,
    linearPCMIsBigEndian: false,
    linearPCMIsFloat: false,
  },
  web: {},
};

// ─── Start Listening ──────────────────────────────────────────────────────────

/**
 * Start background voice keyword detection.
 *
 * On Android/iOS with Expo:
 *   - Records audio in 5-second chunks
 *   - Simulates keyword detection via volume threshold (real STT needs a paid API)
 *   - In a production build, swap the chunk analyser for a Whisper API call
 *
 * The Web Speech API approach (via WebView) is used in VoiceListener.js
 * for the actual recogniser — this module handles the Expo-native side.
 *
 * @param {(keyword: string, transcript: string) => void} onKeywordDetected
 * @returns {Promise<boolean>} true if listening started
 */
export async function startListening(onKeywordDetected) {
  if (_listening) return true; // Already running

  const hasPermission = await checkMicPermission();
  if (!hasPermission) {
    const granted = await requestMicPermission();
    if (!granted) {
      console.warn('[VoiceService] Mic permission denied');
      return false;
    }
  }

  try {
    await setupAudioMode();
    _keywordCb = onKeywordDetected;
    _listening = true;

    // Start the recording loop
    await startRecordingChunk();

    console.info('[VoiceService] Listening started');
    return true;

  } catch (error) {
    console.error('[VoiceService] startListening failed:', error.message);
    _listening = false;
    return false;
  }
}

/**
 * Record a 5-second audio chunk, then analyse it.
 * Loops until stopListening() is called.
 */
async function startRecordingChunk() {
  if (!_listening) return;

  try {
    const { recording } = await Audio.Recording.createAsync(RECORDING_OPTIONS);
    _recording = recording;

    // Record for 5 seconds
    await new Promise(resolve => setTimeout(resolve, 5000));

    if (!_listening) {
      await recording.stopAndUnloadAsync();
      return;
    }

    await recording.stopAndUnloadAsync();
    const uri = recording.getURI();
    _recording = null;

    // Analyse the audio chunk
    // In production: send URI to Whisper API or Google STT for transcription
    // For hackathon: analyse audio level as a proxy for "speech detected"
    await analyseChunk(uri);

    // Loop
    if (_listening) {
      await startRecordingChunk();
    }

  } catch (error) {
    if (_listening) {
      console.warn('[VoiceService] Recording chunk error:', error.message);
      // Brief pause before retrying to avoid crash loop
      await new Promise(r => setTimeout(r, 1000));
      if (_listening) await startRecordingChunk();
    }
  }
}

/**
 * Analyse a recorded audio chunk.
 *
 * Production path: send to Whisper / Google STT → get transcript → detectKeyword().
 * Hackathon path: use metering data as a "someone is shouting" heuristic.
 *
 * @param {string} uri  Local file URI
 */
async function analyseChunk(uri) {
  if (!uri || !_keywordCb) return;

  try {
    // ── Metering-based heuristic (works offline, no API key) ──
    // expo-av provides peak metering during recording.
    // We check if peak level was above -20dB (loud speech / shouting).
    // This is not real speech recognition — it's a "loud event" detector.
    // Real STT integration: see sendToWhisper() below.

    const status = await _recording?.getStatusAsync?.();
    const peakPower = status?.metering ?? -60;

    // If audio was loud (> -20 dB) during the chunk, simulate a keyword match
    // In a real build, replace this with actual STT transcript analysis
    if (peakPower > -20) {
      console.info('[VoiceService] Loud audio detected — possible emergency call');
      // In production this would be: const transcript = await sendToWhisper(uri);
      // For the demo, trigger with a placeholder transcript
      simulateKeywordCheck('help accident emergency');
    }

  } catch (error) {
    console.warn('[VoiceService] analyseChunk error:', error.message);
  }
}

/**
 * Simulate keyword detection for demo purposes.
 * Replace with real STT transcript in production.
 */
function simulateKeywordCheck(simulatedTranscript) {
  const { matched, keyword } = detectKeyword(simulatedTranscript);
  if (matched && _keywordCb) {
    console.info(`[VoiceService] Keyword detected: "${keyword}"`);
    _keywordCb(keyword, simulatedTranscript);
  }
}

/**
 * Production: send audio to OpenAI Whisper API for transcription.
 * Uncomment and replace OPENAI_API_KEY when available.
 *
 * @param {string} uri  Local file URI
 * @returns {Promise<string>}  Transcript text
 */
async function sendToWhisper(uri) {
  // const formData = new FormData();
  // formData.append('file', { uri, type: 'audio/m4a', name: 'audio.m4a' });
  // formData.append('model', 'whisper-1');
  // formData.append('language', 'en');
  //
  // const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
  //   method: 'POST',
  //   headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
  //   body: formData,
  // });
  // const data = await response.json();
  // return data.text || '';
  return '';
}

// ─── Stop Listening ───────────────────────────────────────────────────────────

/**
 * Stop background voice listening.
 */
export async function stopListening() {
  _listening = false;
  _keywordCb = null;

  if (_pollInterval) {
    clearInterval(_pollInterval);
    _pollInterval = null;
  }

  if (_recording) {
    try {
      await _recording.stopAndUnloadAsync();
    } catch {}
    _recording = null;
  }

  // Reset audio mode
  try {
    await Audio.setAudioModeAsync({
      allowsRecordingIOS: false,
      staysActiveInBackground: false,
    });
  } catch {}

  console.info('[VoiceService] Listening stopped');
}

// ─── Text-to-Speech ───────────────────────────────────────────────────────────

/**
 * Speak a text string aloud using the device's TTS engine.
 * Interrupts any currently playing speech.
 *
 * @param {string} text
 * @param {{ rate?: number, pitch?: number, language?: string, onDone?: () => void }} options
 */
export async function speak(text, options = {}) {
  if (!text) return;

  // Stop any ongoing speech
  await stopSpeaking();

  const {
    rate     = VOICE.SPEECH_RATE,
    pitch    = VOICE.SPEECH_PITCH,
    language = VOICE.SPEECH_LANGUAGE,
    onDone   = null,
  } = options;

  try {
    _speaking = true;
    await Speech.speak(text, {
      language,
      rate,
      pitch,
      onDone: () => {
        _speaking = false;
        if (onDone) onDone();
      },
      onStopped: () => { _speaking = false; },
      onError:   () => { _speaking = false; },
    });
  } catch (error) {
    _speaking = false;
    console.warn('[VoiceService] speak() failed:', error.message);
  }
}

/**
 * Stop any currently playing speech.
 */
export async function stopSpeaking() {
  try {
    const available = await Speech.isSpeakingAsync();
    if (available) await Speech.stop();
  } catch {}
  _speaking = false;
}

// ─── TTS Template Builder ─────────────────────────────────────────────────────

/**
 * Build and speak the standard SOS result announcement.
 * e.g. "CRITICAL emergency detected. Nearest hospital is Apollo Hospital,
 *       1.2 kilometres away. Calling now."
 *
 * @param {{ level, serviceType }} severityResult
 * @param {{ name, distanceLabel, phone }} nearestService
 */
export async function speakSOSResult(severityResult, nearestService) {
  const { level } = severityResult;

  let text = '';

  if (level === 'CRITICAL') {
    text += 'Critical emergency detected. ';
  } else if (level === 'MODERATE') {
    text += 'Moderate injuries detected. ';
  } else {
    text += 'Minor incident detected. ';
  }

  if (nearestService) {
    const dist = nearestService.distanceLabel?.replace('km', 'kilometres').replace('m', 'metres');
    text += `Nearest ${nearestService.type} is ${nearestService.name}, ${dist} away.`;
    if (nearestService.phone) {
      text += ' Tap the call button to reach them immediately.';
    }
  } else {
    text += 'Call 1 0 8 for ambulance or 1 1 2 for unified emergency.';
  }

  await speak(text, { rate: 0.85 });
}

/**
 * Speak a keyword trigger acknowledgement.
 * Short and immediate — doesn't wait for location/service.
 */
export async function speakTriggerAck() {
  await speak(
    VOICE.TTS_SOS_TRIGGERED || 'Emergency SOS triggered. Finding nearest services.',
    { rate: 0.9 }
  );
}

/**
 * Speak offline mode notification.
 */
export async function speakOfflineNotice() {
  await speak(
    VOICE.TTS_OFFLINE || 'No internet connection. Loading last saved emergency contacts.',
    { rate: 0.9 }
  );
}

// ─── State Getters ────────────────────────────────────────────────────────────

/** @returns {boolean} */
export function isListening() { return _listening; }

/** @returns {boolean} */
export function isSpeaking() { return _speaking; }

// ─── Default Export ───────────────────────────────────────────────────────────
export default {
  startListening,
  stopListening,
  speak,
  stopSpeaking,
  speakSOSResult,
  speakTriggerAck,
  speakOfflineNotice,
  detectKeyword,
  requestMicPermission,
  checkMicPermission,
  isListening,
  isSpeaking,
};
