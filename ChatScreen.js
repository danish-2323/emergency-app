/**
 * RoadSoS — screens/ChatScreen.js
 *
 * WhatsApp-style AI emergency chatbot.
 * Guides the user through a structured conversation to assess
 * their situation and surface the right emergency service.
 *
 * Conversation flow:
 *   1. Greeting → ask what happened
 *   2. Classify input → accident / breakdown / lost
 *   3. If accident → severity questions (4 yes/no)
 *   4. Show severity result + nearest service card
 *   5. One-tap CALL button inside the chat
 *
 * All bot logic is local — no API call needed.
 * The Anthropic API is only used for free-text responses
 * when the user's message doesn't match a known pattern.
 */

import React, {
  useState, useRef, useEffect, useCallback, useMemo,
} from 'react';
import {
  View, Text, StyleSheet, FlatList, TextInput,
  TouchableOpacity, Animated, Linking, KeyboardAvoidingView,
  Platform, Keyboard,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';

import COLORS from '../constants/colors';
import { SERVICE_TYPES, SEVERITY, SEVERITY_CONFIG, UI } from '../constants/config';
import { getFullLocation, getLocationLabel } from '../services/LocationService';
import { getNearestService, getAbsoluteNearest } from '../services/SearchService';

// ─── Bot conversation state machine ──────────────────────────────────────────
const STEP = {
  GREETING:       'GREETING',
  WAITING_INPUT:  'WAITING_INPUT',
  CLASSIFYING:    'CLASSIFYING',
  Q1_CONSCIOUS:   'Q1_CONSCIOUS',   // Is anyone unconscious?
  Q2_BLEEDING:    'Q2_BLEEDING',    // Heavy bleeding?
  Q3_MOVE:        'Q3_MOVE',        // Can they move?
  Q4_FIRE:        'Q4_FIRE',        // Vehicle on fire?
  SHOWING_RESULT: 'SHOWING_RESULT',
  DONE:           'DONE',
};

// ─── Message factory helpers ──────────────────────────────────────────────────
let _msgId = 0;
const botMsg  = (text, extra = {}) => ({ id: String(++_msgId), from: 'bot',  text, ts: Date.now(), ...extra });
const userMsg = (text, extra = {}) => ({ id: String(++_msgId), from: 'user', text, ts: Date.now(), ...extra });

// ─── Keyword classifier ───────────────────────────────────────────────────────
function classifyInput(text) {
  const t = text.toLowerCase();
  if (/accident|crash|hit|collision|injured|hurt|bleeding|unconscious|fell|bang/.test(t))
    return 'accident';
  if (/breakdown|broke|puncture|flat|tyre|tire|stuck|stall|engine|start/.test(t))
    return 'breakdown';
  if (/lost|confused|where|direction|road|map/.test(t))
    return 'lost';
  return 'unknown';
}

// ─── Severity model (mirrors SeverityModel.js logic) ─────────────────────────
function computeSeverity(answers) {
  // answers: { unconscious, bleeding, cantMove, fire }
  if (answers.unconscious || answers.bleeding || answers.fire)
    return SEVERITY.CRITICAL;
  if (answers.cantMove)
    return SEVERITY.MODERATE;
  return SEVERITY.MINOR;
}

// ─── Format timestamp ─────────────────────────────────────────────────────────
function fmtTime(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

// ─── SERVICE TYPE ICON ────────────────────────────────────────────────────────
function ServiceIcon({ type, size = 20 }) {
  const props = { size, color: '#fff' };
  switch (type) {
    case SERVICE_TYPES.HOSPITAL:  return <Ionicons name="medical" {...props} />;
    case SERVICE_TYPES.POLICE:    return <Ionicons name="shield-checkmark" {...props} />;
    case SERVICE_TYPES.AMBULANCE: return <MaterialCommunityIcons name="car-emergency" {...props} />;
    case SERVICE_TYPES.TOWING:    return <MaterialCommunityIcons name="car-wrench" {...props} />;
    default:                      return <Ionicons name="location" {...props} />;
  }
}

const TYPE_COLOR = {
  [SERVICE_TYPES.HOSPITAL]:  COLORS.serviceHospital,
  [SERVICE_TYPES.POLICE]:    COLORS.servicePolice,
  [SERVICE_TYPES.AMBULANCE]: COLORS.serviceAmbulance,
  [SERVICE_TYPES.TOWING]:    COLORS.serviceTowing,
};

// ─── SERVICE CARD (inside chat) ───────────────────────────────────────────────
function ServiceCard({ service, navigation, location }) {
  if (!service) return null;
  const color = TYPE_COLOR[service.type] || COLORS.primary;

  const handleCall = () => {
    if (service.phone) {
      try { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy); } catch {}
      Linking.openURL(`tel:${service.phone}`);
    }
  };

  const handleMap = () => {
    navigation.navigate('Map', { focusService: service, location });
  };

  return (
    <View style={[sc.card, { borderColor: color + '30' }]}>
      {/* Header strip */}
      <View style={[sc.cardHeader, { backgroundColor: color }]}>
        <ServiceIcon type={service.type} size={18} />
        <Text style={sc.cardType}>{service.type?.toUpperCase()}</Text>
        {service.is24hr && <View style={sc.badge24}><Text style={sc.badge24Text}>24/7</Text></View>}
      </View>

      {/* Body */}
      <View style={sc.cardBody}>
        <Text style={sc.cardName} numberOfLines={2}>{service.name}</Text>
        {service.address && (
          <Text style={sc.cardAddress} numberOfLines={2}>{service.address}</Text>
        )}
        <View style={sc.cardMeta}>
          <Ionicons name="location-outline" size={12} color={COLORS.textMuted} />
          <Text style={[sc.cardDist, { color }]}>{service.distanceLabel} away</Text>
          {service.openNow !== null && (
            <Text style={[sc.cardOpen, {
              color: service.openNow ? COLORS.secondary : COLORS.primary,
            }]}>
              · {service.openNow ? 'Open' : 'Closed'}
            </Text>
          )}
        </View>
      </View>

      {/* Actions */}
      <View style={sc.cardActions}>
        {service.phone ? (
          <TouchableOpacity style={[sc.callBtn, { backgroundColor: color }]} onPress={handleCall}>
            <Ionicons name="call" size={16} color="#fff" />
            <Text style={sc.callBtnText}>CALL NOW</Text>
          </TouchableOpacity>
        ) : (
          <View style={[sc.callBtn, { backgroundColor: COLORS.border }]}>
            <Text style={[sc.callBtnText, { color: COLORS.textMuted }]}>No phone listed</Text>
          </View>
        )}
        <TouchableOpacity style={sc.mapBtn} onPress={handleMap}>
          <Ionicons name="map-outline" size={16} color={COLORS.textSecondary} />
        </TouchableOpacity>
      </View>
    </View>
  );
}

// ─── SEVERITY RESULT CARD (inside chat) ──────────────────────────────────────
function SeverityCard({ level, recommendation, onFindService }) {
  const cfg = SEVERITY_CONFIG[level];
  return (
    <View style={[svc.card, { borderColor: cfg.color + '40', backgroundColor: cfg.bgColor }]}>
      <Text style={svc.emoji}>{cfg.emoji}</Text>
      <Text style={[svc.level, { color: cfg.color }]}>{cfg.label}</Text>
      <Text style={svc.rec}>{recommendation}</Text>
      <TouchableOpacity
        style={[svc.btn, { backgroundColor: cfg.color }]}
        onPress={onFindService}
      >
        <Text style={svc.btnText}>Find nearest service →</Text>
      </TouchableOpacity>
    </View>
  );
}

// ─── YES / NO QUICK REPLY BUTTONS ────────────────────────────────────────────
function YesNo({ onYes, onNo }) {
  return (
    <View style={yn.row}>
      <TouchableOpacity style={[yn.btn, yn.yes]} onPress={onYes}>
        <Text style={yn.yesText}>✓  YES</Text>
      </TouchableOpacity>
      <TouchableOpacity style={[yn.btn, yn.no]} onPress={onNo}>
        <Text style={yn.noText}>✗  NO</Text>
      </TouchableOpacity>
    </View>
  );
}

// ─── TYPING INDICATOR (three dots) ───────────────────────────────────────────
function TypingIndicator() {
  const dots = [
    useRef(new Animated.Value(0)).current,
    useRef(new Animated.Value(0)).current,
    useRef(new Animated.Value(0)).current,
  ];

  useEffect(() => {
    dots.forEach((dot, i) => {
      Animated.loop(Animated.sequence([
        Animated.delay(i * 200),
        Animated.timing(dot, { toValue: 1, duration: 300, useNativeDriver: true }),
        Animated.timing(dot, { toValue: 0, duration: 300, useNativeDriver: true }),
        Animated.delay(400),
      ])).start();
    });
  }, []);

  return (
    <View style={ti.wrap}>
      <View style={ti.bubble}>
        {dots.map((dot, i) => (
          <Animated.View key={i} style={[ti.dot, {
            opacity: dot,
            transform: [{ translateY: dot.interpolate({ inputRange: [0,1], outputRange: [0, -5] }) }],
          }]} />
        ))}
      </View>
    </View>
  );
}

// ─── CHAT BUBBLE ─────────────────────────────────────────────────────────────
function ChatBubble({ msg, navigation, location }) {
  const isBot = msg.from === 'bot';
  const slideAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.spring(slideAnim, {
      toValue: 1, tension: 80, friction: 9, useNativeDriver: true,
    }).start();
  }, []);

  return (
    <Animated.View style={[
      cb.row,
      isBot ? cb.rowBot : cb.rowUser,
      {
        opacity: slideAnim,
        transform: [{
          translateY: slideAnim.interpolate({ inputRange: [0,1], outputRange: [12, 0] }),
        }],
      },
    ]}>
      {isBot && (
        <View style={cb.avatar}>
          <Ionicons name="shield" size={14} color={COLORS.primary} />
        </View>
      )}

      <View style={[
        cb.bubble,
        isBot ? cb.bubbleBot : cb.bubbleUser,
        msg.type === 'card' && { backgroundColor: 'transparent', padding: 0, maxWidth: 290 },
      ]}>

        {/* Regular text */}
        {msg.type !== 'card' && msg.type !== 'severity' && (
          <Text style={[cb.text, isBot ? cb.textBot : cb.textUser]}>
            {msg.text}
          </Text>
        )}

        {/* Yes/No quick replies */}
        {msg.showYesNo && (
          <YesNo onYes={msg.onYes} onNo={msg.onNo} />
        )}

        {/* Service card */}
        {msg.type === 'card' && (
          <ServiceCard service={msg.service} navigation={navigation} location={location} />
        )}

        {/* Severity result */}
        {msg.type === 'severity' && (
          <SeverityCard
            level={msg.level}
            recommendation={msg.recommendation}
            onFindService={msg.onFindService}
          />
        )}

        {/* Timestamp */}
        {msg.type !== 'card' && msg.type !== 'severity' && (
          <Text style={[cb.time, !isBot && cb.timeUser]}>
            {fmtTime(msg.ts)}
          </Text>
        )}
      </View>
    </Animated.View>
  );
}

// ─── MAIN SCREEN ─────────────────────────────────────────────────────────────
export default function ChatScreen({ navigation }) {
  const [messages, setMessages]   = useState([]);
  const [input, setInput]         = useState('');
  const [step, setStep]           = useState(STEP.GREETING);
  const [typing, setTyping]       = useState(false);
  const [location, setLocation]   = useState(null);
  const [address, setAddress]     = useState(null);
  const [answers, setAnswers]     = useState({
    unconscious: false, bleeding: false, cantMove: false, fire: false,
  });

  const listRef = useRef(null);

  // ─── Init ──────────────────────────────────────────────────────────────
  useEffect(() => {
    initChat();
  }, []);

  async function initChat() {
    // Get location silently
    const { coords, address: addr } = await getFullLocation();
    setLocation(coords);
    setAddress(addr);

    // Greeting sequence
    await pushBotTyping(900);
    pushBot(
      `I'm RoadSoS 🚨\n\nI'm here to help you during road emergencies. Your safety is my priority.\n\n📍 ${addr ? getLocationLabel(addr) : 'Location loading...'}`
    );

    await pushBotTyping(1200);
    pushBot('What happened? Describe your situation briefly.');
    setStep(STEP.WAITING_INPUT);
  }

  // ─── Helpers ───────────────────────────────────────────────────────────
  function pushBot(text, extra = {}) {
    const msg = botMsg(text, extra);
    setMessages(prev => [...prev, msg]);
    scrollToEnd();
    return msg;
  }

  function pushUser(text) {
    const msg = userMsg(text);
    setMessages(prev => [...prev, msg]);
    scrollToEnd();
  }

  async function pushBotTyping(ms = 1000) {
    setTyping(true);
    await delay(ms);
    setTyping(false);
  }

  function scrollToEnd() {
    setTimeout(() => listRef.current?.scrollToEnd({ animated: true }), 80);
  }

  function delay(ms) {
    return new Promise(r => setTimeout(r, ms));
  }

  // ─── User sends a message ──────────────────────────────────────────────
  const handleSend = useCallback(async () => {
    const text = input.trim();
    if (!text || step !== STEP.WAITING_INPUT) return;

    setInput('');
    Keyboard.dismiss();
    pushUser(text);
    setStep(STEP.CLASSIFYING);

    await pushBotTyping(1100);

    const category = classifyInput(text);
    await handleCategory(category, text);
  }, [input, step, location]);

  // ─── Category routing ──────────────────────────────────────────────────
  async function handleCategory(category, rawText) {
    if (category === 'accident') {
      pushBot('I understand — this is a road accident. Let me assess the situation quickly. Please answer these questions:');
      await delay(600);
      await askQ1();

    } else if (category === 'breakdown') {
      pushBot('Got it — a vehicle breakdown. Finding the nearest help for you...');
      await findAndShowService(SERVICE_TYPES.TOWING, 'towing service');

    } else if (category === 'lost') {
      pushBot('I can help you. Finding the nearest police station where you can get directions.');
      await findAndShowService(SERVICE_TYPES.POLICE, 'police station');

    } else {
      // Unknown — ask clarifying question
      pushBot(
        "I want to make sure I get you the right help.\n\nIs this:\n1️⃣  A road accident with injuries\n2️⃣  A vehicle breakdown\n3️⃣  Something else",
        { showQuickReplies: ['Accident with injuries', 'Vehicle breakdown', 'Other'] }
      );
      setStep(STEP.WAITING_INPUT);
    }
  }

  // ─── Severity question flow ────────────────────────────────────────────
  async function askQ1() {
    setStep(STEP.Q1_CONSCIOUS);
    await pushBotTyping(700);
    pushBot('❓ Is anyone unconscious or unresponsive?', {
      showYesNo: true,
      onYes: () => answerQ1(true),
      onNo:  () => answerQ1(false),
    });
  }

  async function answerQ1(val) {
    clearYesNo();
    pushUser(val ? 'Yes' : 'No');
    setAnswers(prev => ({ ...prev, unconscious: val }));
    await pushBotTyping(700);
    await askQ2();
  }

  async function askQ2() {
    setStep(STEP.Q2_BLEEDING);
    pushBot('❓ Is there heavy or uncontrolled bleeding?', {
      showYesNo: true,
      onYes: () => answerQ2(true),
      onNo:  () => answerQ2(false),
    });
  }

  async function answerQ2(val) {
    clearYesNo();
    pushUser(val ? 'Yes' : 'No');
    setAnswers(prev => ({ ...prev, bleeding: val }));
    await pushBotTyping(700);
    await askQ3();
  }

  async function askQ3() {
    setStep(STEP.Q3_MOVE);
    pushBot('❓ Can the injured person move on their own?', {
      showYesNo: true,
      onYes: () => answerQ3(false), // Can move → cantMove = false
      onNo:  () => answerQ3(true),  // Cannot move → cantMove = true
    });
  }

  async function answerQ3(cantMove) {
    clearYesNo();
    pushUser(cantMove ? 'No, cannot move' : 'Yes, can move');
    setAnswers(prev => ({ ...prev, cantMove }));
    await pushBotTyping(700);
    await askQ4();
  }

  async function askQ4() {
    setStep(STEP.Q4_FIRE);
    pushBot('❓ Is the vehicle on fire or leaking fuel?', {
      showYesNo: true,
      onYes: () => answerQ4(true),
      onNo:  () => answerQ4(false),
    });
  }

  async function answerQ4(val) {
    clearYesNo();
    pushUser(val ? 'Yes' : 'No');
    const finalAnswers = { ...answers, fire: val };
    setAnswers(finalAnswers);
    await pushBotTyping(1200);
    await showSeverityResult(finalAnswers);
  }

  // ─── Remove yes/no from last bot message ──────────────────────────────
  function clearYesNo() {
    setMessages(prev =>
      prev.map((m, i) =>
        i === prev.length - 1 ? { ...m, showYesNo: false, onYes: null, onNo: null } : m
      )
    );
  }

  // ─── Show severity result + fetch nearest service ─────────────────────
  async function showSeverityResult(finalAnswers) {
    setStep(STEP.SHOWING_RESULT);

    const level = computeSeverity(finalAnswers);
    const cfg = SEVERITY_CONFIG[level];

    // Push severity card into chat
    setMessages(prev => [...prev, {
      id: String(++_msgId),
      from: 'bot',
      ts: Date.now(),
      type: 'severity',
      level,
      recommendation: cfg.recommendation,
      onFindService: () => findAndShowService(cfg.serviceType, cfg.serviceType),
    }]);
    scrollToEnd();

    await delay(800);

    // First aid tip for critical
    if (level === SEVERITY.CRITICAL) {
      pushBot(
        '🩺 While waiting for help:\n\n• Do NOT move the person unless in danger\n• Apply firm pressure to bleeding wounds\n• If unconscious — tilt head back, check breathing\n• Keep them warm and calm'
      );
      await delay(600);
    }

    // Auto-fetch nearest relevant service
    pushBot(`Finding nearest ${cfg.serviceType} for you...`);
    await findAndShowService(cfg.serviceType, cfg.serviceType);
  }

  // ─── Fetch nearest service and show as card ───────────────────────────
  async function findAndShowService(type, typeName) {
    if (!location) {
      pushBot('⚠️ Location unavailable. Please enable GPS and try again.');
      setStep(STEP.WAITING_INPUT);
      return;
    }

    try {
      const service = await getNearestService(location.lat, location.lon, type);

      if (service) {
        // Push service card bubble
        setMessages(prev => [...prev, {
          id: String(++_msgId),
          from: 'bot',
          ts: Date.now(),
          type: 'card',
          service,
        }]);
        scrollToEnd();

        await delay(500);
        pushBot(
          `📍 Tap CALL NOW to reach them immediately.\n\nWould you need anything else?\nType your message or ask about other services.`
        );
      } else {
        pushBot(
          `No ${typeName} found within 15 km.\n\nTry calling the national number:\n🚑  Ambulance: 108\n👮  Police: 100\n🔥  Fire: 101\n📞  Unified: 112`
        );
      }
    } catch (e) {
      pushBot(
        `Couldn't fetch services right now.\n\nCall these numbers immediately:\n🚑  108 (Ambulance)\n👮  100 (Police)\n📞  112 (Unified emergency)`
      );
    }

    setStep(STEP.WAITING_INPUT);
  }

  // ─── Quick reply tap (for unknown category) ───────────────────────────
  const handleQuickReply = useCallback(async (reply) => {
    pushUser(reply);
    clearLastQuickReplies();
    await pushBotTyping(900);
    if (reply.toLowerCase().includes('accident')) {
      await handleCategory('accident', reply);
    } else if (reply.toLowerCase().includes('breakdown')) {
      await handleCategory('breakdown', reply);
    } else {
      pushBot('Please call 112 for immediate assistance, or describe your situation in more detail.');
      setStep(STEP.WAITING_INPUT);
    }
  }, [location]);

  function clearLastQuickReplies() {
    setMessages(prev =>
      prev.map((m, i) =>
        i === prev.length - 1 ? { ...m, showQuickReplies: null } : m
      )
    );
  }

  // ─── Render item ───────────────────────────────────────────────────────
  const renderItem = useCallback(({ item }) => (
    <View>
      <ChatBubble msg={item} navigation={navigation} location={location} />
      {/* Quick reply chips */}
      {item.showQuickReplies && (
        <View style={s.quickRepliesRow}>
          {item.showQuickReplies.map(r => (
            <TouchableOpacity
              key={r}
              style={s.quickReplyChip}
              onPress={() => handleQuickReply(r)}
            >
              <Text style={s.quickReplyText}>{r}</Text>
            </TouchableOpacity>
          ))}
        </View>
      )}
    </View>
  ), [navigation, location, handleQuickReply]);

  // ─── RENDER ────────────────────────────────────────────────────────────
  return (
    <SafeAreaView style={s.safe} edges={['top']}>
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={Platform.OS === 'ios' ? 0 : 0}
      >
        {/* Header */}
        <View style={s.header}>
          <View style={s.headerAvatar}>
            <Ionicons name="shield" size={18} color={COLORS.primary} />
          </View>
          <View>
            <Text style={s.headerName}>RoadSoS AI</Text>
            <Text style={s.headerSub}>
              {typing ? 'Typing...' : '● Always active'}
            </Text>
          </View>
          {/* SOS shortcut */}
          <TouchableOpacity
            style={s.sosMini}
            onPress={() => navigation.navigate('Severity', { location, address })}
          >
            <Text style={s.sosMiniText}>SOS</Text>
          </TouchableOpacity>
        </View>

        {/* Message list */}
        <FlatList
          ref={listRef}
          data={messages}
          keyExtractor={item => item.id}
          renderItem={renderItem}
          contentContainerStyle={s.listContent}
          showsVerticalScrollIndicator={false}
          onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: true })}
          ListFooterComponent={typing ? <TypingIndicator /> : null}
        />

        {/* Input row */}
        <View style={s.inputRow}>
          <TextInput
            style={s.input}
            value={input}
            onChangeText={setInput}
            placeholder="Describe what happened..."
            placeholderTextColor={COLORS.textMuted}
            multiline
            maxLength={300}
            returnKeyType="send"
            onSubmitEditing={handleSend}
            editable={step === STEP.WAITING_INPUT}
          />
          <TouchableOpacity
            style={[s.sendBtn, { opacity: input.trim() && step === STEP.WAITING_INPUT ? 1 : 0.35 }]}
            onPress={handleSend}
            disabled={!input.trim() || step !== STEP.WAITING_INPUT}
          >
            <Ionicons name="send" size={20} color="#fff" />
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────
const s = StyleSheet.create({
  safe:        { flex: 1, backgroundColor: COLORS.chatBackground },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: COLORS.navBackground,
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.navBorder,
  },
  headerAvatar: {
    width: 38, height: 38, borderRadius: 19,
    backgroundColor: COLORS.primaryGlow,
    borderWidth: 1, borderColor: COLORS.primary + '44',
    alignItems: 'center', justifyContent: 'center',
  },
  headerName:  { color: COLORS.textPrimary, fontSize: 15, fontWeight: '700' },
  headerSub:   { color: COLORS.secondary,   fontSize: 11, fontWeight: '500', marginTop: 1 },
  sosMini: {
    marginLeft: 'auto',
    backgroundColor: COLORS.primary,
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  sosMiniText: { color: '#fff', fontSize: 13, fontWeight: '900', letterSpacing: 1 },

  listContent: { paddingVertical: 12, paddingHorizontal: 12 },

  quickRepliesRow: {
    flexDirection: 'row', flexWrap: 'wrap', gap: 8,
    paddingLeft: 52, paddingBottom: 8,
  },
  quickReplyChip: {
    backgroundColor: COLORS.backgroundCard,
    borderWidth: 1, borderColor: COLORS.primary + '44',
    borderRadius: 20, paddingHorizontal: 14, paddingVertical: 8,
  },
  quickReplyText: { color: COLORS.primary, fontSize: 13, fontWeight: '600' },

  inputRow: {
    flexDirection: 'row', alignItems: 'flex-end',
    gap: 10, padding: 12,
    backgroundColor: COLORS.navBackground,
    borderTopWidth: 1, borderTopColor: COLORS.navBorder,
  },
  input: {
    flex: 1,
    backgroundColor: COLORS.backgroundInput,
    color: COLORS.textPrimary,
    borderRadius: 22,
    borderWidth: 1,
    borderColor: COLORS.border,
    paddingHorizontal: 16,
    paddingVertical: Platform.OS === 'ios' ? 12 : 10,
    fontSize: 14,
    maxHeight: 110,
  },
  sendBtn: {
    width: 44, height: 44, borderRadius: 22,
    backgroundColor: COLORS.primary,
    alignItems: 'center', justifyContent: 'center',
  },
});

// ─── Chat bubble styles ───────────────────────────────────────────────────────
const cb = StyleSheet.create({
  row:       { flexDirection: 'row', marginBottom: 8, alignItems: 'flex-end' },
  rowBot:    { justifyContent: 'flex-start' },
  rowUser:   { justifyContent: 'flex-end' },
  avatar: {
    width: 30, height: 30, borderRadius: 15,
    backgroundColor: COLORS.primaryGlow,
    borderWidth: 1, borderColor: COLORS.primary + '40',
    alignItems: 'center', justifyContent: 'center',
    marginRight: 8, marginBottom: 2,
  },
  bubble: {
    maxWidth: '78%',
    paddingHorizontal: 14, paddingVertical: 10,
    borderRadius: 18,
  },
  bubbleBot:  {
    backgroundColor: COLORS.chatBotBubble,
    borderBottomLeftRadius: 4,
  },
  bubbleUser: {
    backgroundColor: COLORS.chatUserBubble,
    borderBottomRightRadius: 4,
  },
  text:     { fontSize: 14, lineHeight: 21 },
  textBot:  { color: COLORS.chatBotText },
  textUser: { color: COLORS.chatUserText },
  time:     { color: COLORS.chatTimestamp, fontSize: 10, marginTop: 4 },
  timeUser: { textAlign: 'right' },
});

// ─── ServiceCard styles ───────────────────────────────────────────────────────
const sc = StyleSheet.create({
  card: {
    backgroundColor: COLORS.backgroundCard,
    borderRadius: 14, borderWidth: 1,
    overflow: 'hidden', width: 270,
  },
  cardHeader: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingHorizontal: 14, paddingVertical: 10,
  },
  cardType:   { color: '#fff', fontSize: 11, fontWeight: '800', letterSpacing: 1, flex: 1 },
  badge24: {
    backgroundColor: 'rgba(255,255,255,0.25)',
    borderRadius: 6, paddingHorizontal: 6, paddingVertical: 2,
  },
  badge24Text: { color: '#fff', fontSize: 9, fontWeight: '800' },
  cardBody:    { padding: 14 },
  cardName:    { color: COLORS.textPrimary, fontSize: 14, fontWeight: '700', marginBottom: 4 },
  cardAddress: { color: COLORS.textSecondary, fontSize: 12, marginBottom: 8 },
  cardMeta:    { flexDirection: 'row', alignItems: 'center', gap: 4 },
  cardDist:    { fontSize: 12, fontWeight: '700' },
  cardOpen:    { fontSize: 12, fontWeight: '600' },
  cardActions: {
    flexDirection: 'row', gap: 8,
    paddingHorizontal: 14, paddingBottom: 14,
  },
  callBtn: {
    flex: 1, flexDirection: 'row', alignItems: 'center',
    justifyContent: 'center', gap: 7,
    borderRadius: 10, paddingVertical: 12,
    minHeight: 48,
  },
  callBtnText: { color: '#fff', fontSize: 13, fontWeight: '800', letterSpacing: 0.5 },
  mapBtn: {
    width: 44, height: 44, borderRadius: 10,
    backgroundColor: COLORS.backgroundElevated,
    alignItems: 'center', justifyContent: 'center',
    borderWidth: 1, borderColor: COLORS.border,
  },
});

// ─── Severity card styles ─────────────────────────────────────────────────────
const svc = StyleSheet.create({
  card: {
    borderRadius: 14, borderWidth: 1,
    padding: 16, alignItems: 'center', width: 260,
  },
  emoji: { fontSize: 36, marginBottom: 8 },
  level: { fontSize: 22, fontWeight: '900', letterSpacing: 2, marginBottom: 8 },
  rec:   { color: COLORS.textSecondary, fontSize: 13, textAlign: 'center', lineHeight: 19, marginBottom: 14 },
  btn:   { borderRadius: 10, paddingVertical: 12, paddingHorizontal: 20, minHeight: 48 },
  btnText: { color: '#fff', fontSize: 13, fontWeight: '800' },
});

// ─── Yes/No styles ────────────────────────────────────────────────────────────
const yn = StyleSheet.create({
  row: { flexDirection: 'row', gap: 10, marginTop: 10 },
  btn: { flex: 1, borderRadius: 10, paddingVertical: 12, alignItems: 'center', minHeight: 48 },
  yes: { backgroundColor: COLORS.secondary + '22', borderWidth: 1, borderColor: COLORS.secondary + '60' },
  no:  { backgroundColor: COLORS.primary  + '18', borderWidth: 1, borderColor: COLORS.primary  + '50' },
  yesText: { color: COLORS.secondary, fontSize: 14, fontWeight: '800' },
  noText:  { color: COLORS.primary,   fontSize: 14, fontWeight: '800' },
});

// ─── Typing indicator styles ──────────────────────────────────────────────────
const ti = StyleSheet.create({
  wrap:   { flexDirection: 'row', paddingLeft: 50, marginBottom: 8 },
  bubble: {
    flexDirection: 'row', alignItems: 'center', gap: 5,
    backgroundColor: COLORS.chatBotBubble,
    borderRadius: 18, borderBottomLeftRadius: 4,
    paddingHorizontal: 16, paddingVertical: 14,
  },
  dot: {
    width: 7, height: 7, borderRadius: 4,
    backgroundColor: COLORS.textMuted,
  },
});
