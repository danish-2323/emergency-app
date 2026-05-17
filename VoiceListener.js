/**
 * RoadSoS — components/VoiceListener.js
 *
 * Always-on voice keyword detector rendered as an invisible WebView.
 * Uses the Web Speech API (SpeechRecognition) which is:
 *   - Free, no API key required
 *   - Built into Chrome/WebView on Android
 *   - Available on iOS via WKWebView (iOS 14.5+)
 *
 * How it works:
 *   1. An invisible WebView runs the Web Speech API continuously
 *   2. On transcript → postMessage back to React Native
 *   3. VoiceListener.js runs detectKeyword() on every transcript chunk
 *   4. On match → calls onKeywordDetected(keyword) → triggers SOS flow
 *   5. The mic pulse indicator is shown in HomeScreen's header
 *
 * Props:
 *   onKeywordDetected(keyword, transcript)  → called on emergency keyword
 *   onTranscript(text)                      → raw transcript updates (optional)
 *   onStatusChange(status)                  → 'listening' | 'stopped' | 'error'
 *   language                                → BCP-47 code, default 'en-IN'
 *   enabled                                 → boolean, default true
 *
 * Usage (in HomeScreen or App.js):
 *   <VoiceListener
 *     onKeywordDetected={(kw) => triggerSOS(kw)}
 *     onStatusChange={(s) => setMicStatus(s)}
 *   />
 */

import React, {
  useRef, useEffect, useState, useCallback, forwardRef, useImperativeHandle,
} from 'react';
import {
  View, Text, StyleSheet, Animated, TouchableOpacity,
} from 'react-native';
import { WebView } from 'react-native-webview';
import { Ionicons } from '@expo/vector-icons';

import COLORS from '../constants/colors';
import { VOICE } from '../constants/config';
import { detectKeyword } from '../services/VoiceService';

// ─── Web Speech API HTML page ─────────────────────────────────────────────────
/**
 * Builds the HTML that runs inside the invisible WebView.
 * The Web Speech API listens continuously and posts every interim/final
 * transcript back to React Native via postMessage.
 */
function buildSpeechHTML(language, keywords) {
  const keywordsJSON = JSON.stringify(keywords);

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
</head>
<body>
<script>
  var recognition = null;
  var isRunning   = false;
  var restartTimer = null;
  var keywords = ${keywordsJSON};

  function post(type, data) {
    window.ReactNativeWebView.postMessage(JSON.stringify({ type, ...data }));
  }

  function initRecognition() {
    var SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      post('ERROR', { message: 'SpeechRecognition not supported in this WebView' });
      return false;
    }

    recognition = new SpeechRecognition();
    recognition.continuous      = true;   // Keep listening after each result
    recognition.interimResults  = true;   // Get partial transcripts immediately
    recognition.maxAlternatives = 1;
    recognition.lang            = '${language}';

    recognition.onstart = function() {
      isRunning = true;
      post('STATUS', { status: 'listening' });
    };

    recognition.onend = function() {
      isRunning = false;
      // Auto-restart unless explicitly stopped
      if (!window._stopped) {
        restartTimer = setTimeout(function() {
          try { recognition.start(); } catch(e) {}
        }, 300);
      } else {
        post('STATUS', { status: 'stopped' });
      }
    };

    recognition.onerror = function(e) {
      isRunning = false;
      // 'no-speech' is normal — just restart
      if (e.error === 'no-speech' || e.error === 'audio-capture') {
        if (!window._stopped) {
          restartTimer = setTimeout(function() {
            try { recognition.start(); } catch(e2) {}
          }, 500);
        }
        return;
      }
      post('ERROR', { message: e.error });
    };

    recognition.onresult = function(event) {
      var transcript = '';
      for (var i = event.resultIndex; i < event.results.length; i++) {
        transcript += event.results[i][0].transcript;
      }
      transcript = transcript.trim().toLowerCase();
      if (!transcript) return;

      // Send raw transcript
      post('TRANSCRIPT', { text: transcript });

      // Check for keywords locally in the WebView too (faster than round-trip)
      for (var k = 0; k < keywords.length; k++) {
        if (transcript.indexOf(keywords[k].toLowerCase()) !== -1) {
          post('KEYWORD', { keyword: keywords[k], transcript: transcript });
          break;
        }
      }
    };

    return true;
  }

  // ── Public controls ──────────────────────────────────────────────────
  window.startListening = function() {
    window._stopped = false;
    if (recognition && isRunning) return;
    if (!recognition) {
      if (!initRecognition()) return;
    }
    try { recognition.start(); } catch(e) {}
  };

  window.stopListening = function() {
    window._stopped = true;
    if (restartTimer) clearTimeout(restartTimer);
    if (recognition && isRunning) {
      try { recognition.stop(); } catch(e) {}
    }
  };

  // Handle messages from React Native
  window.addEventListener('message', function(event) {
    try {
      var msg = JSON.parse(event.data);
      if (msg.command === 'start') window.startListening();
      if (msg.command === 'stop')  window.stopListening();
    } catch(e) {}
  });

  // Auto-start when page loads
  document.addEventListener('DOMContentLoaded', function() {
    // Small delay to let WebView fully initialise
    setTimeout(window.startListening, 800);
  });
</script>
</body>
</html>`;
}

// ─── MicPulse — standalone indicator component ────────────────────────────────
/**
 * Animated mic icon that pulses when listening.
 * Used in HomeScreen header and as standalone indicator.
 */
export function MicPulseIndicator({ listening, style }) {
  const pulse = useRef(new Animated.Value(1)).current;
  const ring  = useRef(new Animated.Value(1)).current;
  const ringOpacity = useRef(new Animated.Value(0.6)).current;

  useEffect(() => {
    if (listening) {
      // Breathe animation for the icon
      Animated.loop(
        Animated.sequence([
          Animated.timing(pulse, { toValue: 1.15, duration: 800, useNativeDriver: true }),
          Animated.timing(pulse, { toValue: 1.0,  duration: 800, useNativeDriver: true }),
        ])
      ).start();

      // Ring radiates outward
      Animated.loop(
        Animated.sequence([
          Animated.parallel([
            Animated.timing(ring,        { toValue: 1.8,  duration: 1200, useNativeDriver: true }),
            Animated.timing(ringOpacity, { toValue: 0,    duration: 1200, useNativeDriver: true }),
          ]),
          Animated.parallel([
            Animated.timing(ring,        { toValue: 1,    duration: 0,    useNativeDriver: true }),
            Animated.timing(ringOpacity, { toValue: 0.5,  duration: 0,    useNativeDriver: true }),
          ]),
        ])
      ).start();
    } else {
      pulse.setValue(1);
      ring.setValue(1);
      ringOpacity.setValue(0);
    }
  }, [listening]);

  return (
    <View style={[mi.wrap, style]}>
      {/* Pulse ring */}
      <Animated.View style={[mi.ring, {
        transform: [{ scale: ring }],
        opacity: ringOpacity,
      }]} />

      {/* Icon */}
      <Animated.View style={[mi.icon, {
        transform: [{ scale: pulse }],
        backgroundColor: listening ? COLORS.primaryGlow : COLORS.backgroundCard,
        borderColor: listening ? COLORS.primary + '50' : COLORS.border,
      }]}>
        <Ionicons
          name={listening ? 'mic' : 'mic-off-outline'}
          size={16}
          color={listening ? COLORS.primary : COLORS.textMuted}
        />
        {listening && <View style={mi.activeDot} />}
      </Animated.View>
    </View>
  );
}

// ─── VoiceListener Component ──────────────────────────────────────────────────
const VoiceListener = forwardRef(function VoiceListener(
  {
    onKeywordDetected,
    onTranscript,
    onStatusChange,
    language    = VOICE.SPEECH_LANGUAGE || 'en-IN',
    enabled     = true,
  },
  ref
) {
  const webViewRef   = useRef(null);
  const [status, setStatus] = useState('stopped');  // 'listening' | 'stopped' | 'error'
  const [lastTranscript, setLastTranscript] = useState('');
  const [errorMsg, setErrorMsg] = useState(null);

  // Build HTML once
  const html = React.useMemo(
    () => buildSpeechHTML(language, VOICE.TRIGGER_KEYWORDS),
    [language]
  );

  // ── Imperative API (for parent to control) ──────────────────────────
  useImperativeHandle(ref, () => ({
    startListening: () => sendCommand('start'),
    stopListening:  () => sendCommand('stop'),
    getStatus:      () => status,
    getLastTranscript: () => lastTranscript,
  }));

  // ── Enable/disable effect ────────────────────────────────────────────
  useEffect(() => {
    if (enabled) {
      sendCommand('start');
    } else {
      sendCommand('stop');
    }
  }, [enabled]);

  // ── Send command to WebView ──────────────────────────────────────────
  const sendCommand = useCallback((command) => {
    webViewRef.current?.injectJavaScript(
      `window.${command === 'start' ? 'startListening' : 'stopListening'}(); true;`
    );
  }, []);

  // ── Handle messages from WebView ─────────────────────────────────────
  const handleMessage = useCallback((event) => {
    try {
      const msg = JSON.parse(event.nativeEvent.data);

      switch (msg.type) {
        case 'STATUS':
          setStatus(msg.status);
          setErrorMsg(null);
          onStatusChange?.(msg.status);
          break;

        case 'TRANSCRIPT':
          setLastTranscript(msg.text);
          onTranscript?.(msg.text);

          // Double-check keywords on the RN side too (belt-and-braces)
          const { matched, keyword } = detectKeyword(msg.text);
          if (matched) {
            console.info(`[VoiceListener] Keyword matched in RN: "${keyword}"`);
            onKeywordDetected?.(keyword, msg.text);
          }
          break;

        case 'KEYWORD':
          // WebView-side match (faster path)
          console.info(`[VoiceListener] Keyword matched in WebView: "${msg.keyword}"`);
          onKeywordDetected?.(msg.keyword, msg.transcript);
          break;

        case 'ERROR':
          setStatus('error');
          setErrorMsg(msg.message);
          onStatusChange?.('error');
          console.warn('[VoiceListener] WebView error:', msg.message);
          break;
      }
    } catch {}
  }, [onKeywordDetected, onTranscript, onStatusChange]);

  // ── Render ─────────────────────────────────────────────────────────
  // The WebView is 0x0 — invisible, just runs the Speech API
  return (
    <View style={vl.container} pointerEvents="none">
      <WebView
        ref={webViewRef}
        source={{ html }}
        style={vl.webview}
        onMessage={handleMessage}
        javaScriptEnabled
        mediaPlaybackRequiresUserAction={false}
        allowsInlineMediaPlayback
        originWhitelist={['*']}
        onError={(e) => {
          console.warn('[VoiceListener] WebView error:', e.nativeEvent?.description);
          setStatus('error');
        }}
      />
    </View>
  );
});

export default VoiceListener;

// ─── Keyword Alert Banner ─────────────────────────────────────────────────────
/**
 * Slide-down banner shown when a keyword is detected.
 * Disappears after 4 seconds or on tap.
 * Place at the top of HomeScreen / App root.
 */
export function KeywordAlertBanner({ keyword, onDismiss, onAction }) {
  const slideY  = useRef(new Animated.Value(-80)).current;
  const opacity = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (!keyword) return;

    // Slide in
    Animated.parallel([
      Animated.spring(slideY,  { toValue: 0, tension: 70, friction: 9, useNativeDriver: true }),
      Animated.timing(opacity, { toValue: 1, duration: 200, useNativeDriver: true }),
    ]).start();

    // Auto-dismiss after 4 seconds
    const timer = setTimeout(() => dismiss(), 4000);
    return () => clearTimeout(timer);
  }, [keyword]);

  function dismiss() {
    Animated.parallel([
      Animated.timing(slideY,  { toValue: -80, duration: 250, useNativeDriver: true }),
      Animated.timing(opacity, { toValue: 0,   duration: 250, useNativeDriver: true }),
    ]).start(() => onDismiss?.());
  }

  if (!keyword) return null;

  return (
    <Animated.View style={[
      kb.banner,
      { transform: [{ translateY: slideY }], opacity },
    ]}>
      <View style={kb.left}>
        <Ionicons name="mic" size={18} color={COLORS.primary} />
        <View>
          <Text style={kb.title}>Keyword detected: "{keyword}"</Text>
          <Text style={kb.sub}>Tap SOS to trigger emergency response</Text>
        </View>
      </View>
      <TouchableOpacity style={kb.actionBtn} onPress={onAction}>
        <Text style={kb.actionText}>SOS</Text>
      </TouchableOpacity>
    </Animated.View>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────
const vl = StyleSheet.create({
  container: {
    position: 'absolute',
    width: 0,
    height: 0,
    overflow: 'hidden',
    opacity: 0,
  },
  webview: {
    width: 1,
    height: 1,
    opacity: 0,
  },
});

const mi = StyleSheet.create({
  wrap: {
    width: 44, height: 44,
    alignItems: 'center', justifyContent: 'center',
  },
  ring: {
    position: 'absolute',
    width: 44, height: 44,
    borderRadius: 22,
    borderWidth: 1.5,
    borderColor: COLORS.primary,
  },
  icon: {
    width: 40, height: 40, borderRadius: 20,
    borderWidth: 1,
    alignItems: 'center', justifyContent: 'center',
  },
  activeDot: {
    position: 'absolute',
    top: 8, right: 8,
    width: 7, height: 7, borderRadius: 4,
    backgroundColor: COLORS.secondary,
    borderWidth: 1.5, borderColor: COLORS.background,
  },
});

const kb = StyleSheet.create({
  banner: {
    position: 'absolute', top: 0, left: 0, right: 0,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    backgroundColor: COLORS.backgroundCard,
    borderBottomWidth: 1, borderBottomColor: COLORS.primary + '40',
    paddingHorizontal: 16, paddingVertical: 12,
    zIndex: 9999, elevation: 9999,
  },
  left: { flexDirection: 'row', alignItems: 'center', gap: 10, flex: 1 },
  title: { color: COLORS.textPrimary, fontSize: 13, fontWeight: '700' },
  sub:   { color: COLORS.textMuted,   fontSize: 11, marginTop: 1 },
  actionBtn: {
    backgroundColor: COLORS.primary,
    borderRadius: 8, paddingHorizontal: 16, paddingVertical: 8,
  },
  actionText: { color: '#fff', fontSize: 13, fontWeight: '900', letterSpacing: 1 },
});
