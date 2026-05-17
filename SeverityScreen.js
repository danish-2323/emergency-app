/**
 * RoadSoS — screens/SeverityScreen.js
 *
 * Full-screen severity assessment flow.
 * Shows 4 yes/no questions one at a time, with progress bar.
 * Computes severity using SeverityModel.js.
 * Displays result: level badge, first aid steps, and nearest service card.
 *
 * Opened from:
 *   HomeScreen → SOS button press
 *   ChatScreen → SOS mini button
 *   Navigation → 'Severity' route (modal)
 */

import React, { useState, useRef, useEffect, useCallback } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, Animated,
  ScrollView, Linking, Platform, Easing,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';

import COLORS from '../constants/colors';
import { SERVICE_TYPES, SEVERITY, SEVERITY_CONFIG, UI } from '../constants/config';
import {
  assess,
  SEVERITY_QUESTIONS,
  getSummaryText,
  getUrgencyLabel,
} from '../services/SeverityModel';
import { getNearestService } from '../services/SearchService';
import { getFullLocation } from '../services/LocationService';

// ─── Screen phases ────────────────────────────────────────────────────────────
const PHASE = {
  QUESTIONS: 'QUESTIONS',
  RESULT:    'RESULT',
};

// ─── Type color map ───────────────────────────────────────────────────────────
const TYPE_COLOR = {
  [SERVICE_TYPES.HOSPITAL]:  COLORS.serviceHospital,
  [SERVICE_TYPES.POLICE]:    COLORS.servicePolice,
  [SERVICE_TYPES.AMBULANCE]: COLORS.serviceAmbulance,
  [SERVICE_TYPES.TOWING]:    COLORS.serviceTowing,
};

// ─── Progress Bar ─────────────────────────────────────────────────────────────
function ProgressBar({ current, total }) {
  const progress = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.timing(progress, {
      toValue: current / total,
      duration: 350,
      easing: Easing.out(Easing.quad),
      useNativeDriver: false,
    }).start();
  }, [current]);

  return (
    <View style={pb.track}>
      <Animated.View
        style={[pb.fill, {
          width: progress.interpolate({
            inputRange: [0, 1],
            outputRange: ['0%', '100%'],
          }),
        }]}
      />
    </View>
  );
}

// ─── Question Card ────────────────────────────────────────────────────────────
function QuestionCard({ question, index, total, onYes, onNo, lastAnswer }) {
  const slideAnim  = useRef(new Animated.Value(50)).current;
  const fadeAnim   = useRef(new Animated.Value(0)).current;
  const yesScale   = useRef(new Animated.Value(1)).current;
  const noScale    = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    // Slide + fade in on mount / question change
    slideAnim.setValue(50);
    fadeAnim.setValue(0);
    Animated.parallel([
      Animated.spring(slideAnim, { toValue: 0, tension: 80, friction: 9, useNativeDriver: true }),
      Animated.timing(fadeAnim,  { toValue: 1, duration: 300, useNativeDriver: true }),
    ]).start();
  }, [index]);

  const animPress = (scaleRef) => {
    Animated.sequence([
      Animated.spring(scaleRef, { toValue: 0.93, useNativeDriver: true, tension: 300 }),
      Animated.spring(scaleRef, { toValue: 1.0,  useNativeDriver: true, tension: 300 }),
    ]).start();
  };

  const handleYes = () => { animPress(yesScale); onYes(); };
  const handleNo  = () => { animPress(noScale);  onNo();  };

  return (
    <Animated.View style={[
      qc.card,
      { opacity: fadeAnim, transform: [{ translateY: slideAnim }] },
    ]}>
      {/* Question number */}
      <Text style={qc.qNum}>Question {index + 1} of {total}</Text>

      {/* Icon */}
      <Text style={qc.icon}>{question.icon}</Text>

      {/* Question text */}
      <Text style={qc.text}>{question.text}</Text>

      {/* Contextual hint if previous answer was YES */}
      {lastAnswer === true && question.yesHint && (
        <View style={qc.hintBox}>
          <Ionicons name="information-circle" size={14} color={COLORS.primary} />
          <Text style={qc.hintText}>{question.yesHint}</Text>
        </View>
      )}

      {/* YES / NO buttons */}
      <View style={qc.btnRow}>
        <Animated.View style={[{ flex: 1 }, { transform: [{ scale: noScale }] }]}>
          <TouchableOpacity style={qc.noBtn} onPress={handleNo}>
            <Ionicons name="close-circle" size={22} color={COLORS.primary} />
            <Text style={qc.noBtnText}>NO</Text>
          </TouchableOpacity>
        </Animated.View>

        <Animated.View style={[{ flex: 1 }, { transform: [{ scale: yesScale }] }]}>
          <TouchableOpacity style={qc.yesBtn} onPress={handleYes}>
            <Ionicons name="checkmark-circle" size={22} color="#fff" />
            <Text style={qc.yesBtnText}>YES</Text>
          </TouchableOpacity>
        </Animated.View>
      </View>

      {/* Reassurance */}
      <Text style={qc.reassure}>Answer honestly — this helps find the right help</Text>
    </Animated.View>
  );
}

// ─── Result Badge ─────────────────────────────────────────────────────────────
function SeverityBadge({ level, urgencyScore }) {
  const cfg     = SEVERITY_CONFIG[level];
  const pulse   = useRef(new Animated.Value(1)).current;
  const scaleIn = useRef(new Animated.Value(0.5)).current;
  const opIn    = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    // Pop-in entrance
    Animated.parallel([
      Animated.spring(scaleIn, { toValue: 1, tension: 80, friction: 7, useNativeDriver: true }),
      Animated.timing(opIn, { toValue: 1, duration: 300, useNativeDriver: true }),
    ]).start();

    // Pulse for critical
    if (level === SEVERITY.CRITICAL) {
      Animated.loop(
        Animated.sequence([
          Animated.timing(pulse, { toValue: 1.05, duration: 700, useNativeDriver: true }),
          Animated.timing(pulse, { toValue: 1.0,  duration: 700, useNativeDriver: true }),
        ])
      ).start();
    }
  }, [level]);

  return (
    <Animated.View style={[
      rb.wrap,
      { backgroundColor: cfg.bgColor, borderColor: cfg.color + '50' },
      { opacity: opIn, transform: [{ scale: Animated.multiply(scaleIn, pulse) }] },
    ]}>
      <Text style={rb.emoji}>
        {level === SEVERITY.CRITICAL ? '🔴' : level === SEVERITY.MODERATE ? '🟡' : '🟢'}
      </Text>
      <Text style={[rb.level, { color: cfg.color }]}>{level}</Text>
      <Text style={rb.urgency}>
        Urgency: {getUrgencyLabel(urgencyScore)} ({urgencyScore}/100)
      </Text>
      <Text style={[rb.rec, { color: cfg.color + 'CC' }]}>{cfg.recommendation}</Text>
    </Animated.View>
  );
}

// ─── First Aid Steps ──────────────────────────────────────────────────────────
function FirstAidPanel({ steps, doNotDo }) {
  const [expanded, setExpanded] = useState(false);
  const heightAnim = useRef(new Animated.Value(0)).current;

  const toggle = () => {
    const toVal = expanded ? 0 : 1;
    setExpanded(!expanded);
    Animated.spring(heightAnim, { toValue: toVal, useNativeDriver: false, tension: 60 }).start();
  };

  return (
    <View style={fa.wrap}>
      {/* Always-visible first 3 steps */}
      <Text style={fa.title}>🩺 Immediate First Aid</Text>
      {steps.slice(0, 3).map((step, i) => (
        <View key={i} style={fa.step}>
          <Text style={fa.stepText}>{step}</Text>
        </View>
      ))}

      {/* Expand button */}
      {steps.length > 3 && (
        <TouchableOpacity style={fa.expandBtn} onPress={toggle}>
          <Text style={fa.expandText}>
            {expanded ? '▲ Show less' : `▼ Show ${steps.length - 3} more steps`}
          </Text>
        </TouchableOpacity>
      )}

      {/* Additional steps (expandable) */}
      {expanded && steps.slice(3).map((step, i) => (
        <View key={i} style={fa.step}>
          <Text style={fa.stepText}>{step}</Text>
        </View>
      ))}

      {/* Do NOT section */}
      {doNotDo.length > 0 && (
        <>
          <Text style={[fa.title, { marginTop: 16, color: COLORS.primary }]}>
            🚫 Common Mistakes — Avoid These
          </Text>
          {doNotDo.map((item, i) => (
            <View key={i} style={[fa.step, fa.dontStep]}>
              <Text style={[fa.stepText, { color: COLORS.primary }]}>{item}</Text>
            </View>
          ))}
        </>
      )}
    </View>
  );
}

// ─── Nearest Service Card (in result) ────────────────────────────────────────
function NearestServiceCard({ service, onCall, onMap }) {
  if (!service) return (
    <View style={ns.empty}>
      <Text style={ns.emptyText}>
        No nearby service found. Call 108 (Ambulance) or 112 (Emergency).
      </Text>
    </View>
  );

  const color = TYPE_COLOR[service.type] || COLORS.primary;

  return (
    <View style={[ns.card, { borderColor: color + '35' }]}>
      <View style={[ns.header, { backgroundColor: color }]}>
        <Text style={ns.headerText}>📍 Nearest {service.type?.toUpperCase()}</Text>
        {service.is24hr && <Text style={ns.badge24}>24/7</Text>}
      </View>
      <View style={ns.body}>
        <Text style={ns.name}>{service.name}</Text>
        {service.address && <Text style={ns.address}>{service.address}</Text>}
        <Text style={[ns.dist, { color }]}>{service.distanceLabel} away</Text>
      </View>
      <View style={ns.actions}>
        <TouchableOpacity
          style={[ns.callBtn, { backgroundColor: color }, !service.phone && ns.callBtnDisabled]}
          onPress={() => service.phone && onCall(service.phone)}
          disabled={!service.phone}
        >
          <Ionicons name="call" size={18} color="#fff" />
          <Text style={ns.callBtnText}>
            {service.phone ? 'CALL NOW' : 'No number'}
          </Text>
        </TouchableOpacity>
        <TouchableOpacity style={ns.mapBtn} onPress={() => onMap(service)}>
          <Ionicons name="map-outline" size={18} color={COLORS.textSecondary} />
          <Text style={ns.mapBtnText}>Map</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

// ─── Main Screen ──────────────────────────────────────────────────────────────
export default function SeverityScreen({ navigation, route }) {
  const routeLocation = route?.params?.location  || null;
  const routeServices = route?.params?.services  || null;
  const routeAddress  = route?.params?.address   || null;

  const [phase, setPhase]               = useState(PHASE.QUESTIONS);
  const [currentQ, setCurrentQ]         = useState(0);
  const [answers, setAnswers]           = useState({
    unconscious: false, bleeding: false, cantMove: false, fire: false,
  });
  const [lastAnswer, setLastAnswer]     = useState(null);
  const [result, setResult]             = useState(null);
  const [nearestService, setNearest]    = useState(null);
  const [loadingService, setLoadingSvc] = useState(false);
  const [location, setLocation]         = useState(routeLocation);

  const resultAnim   = useRef(new Animated.Value(0)).current;
  const questions    = SEVERITY_QUESTIONS;

  // Get location if not passed
  useEffect(() => {
    if (!location) {
      getFullLocation().then(({ coords }) => {
        if (coords) setLocation(coords);
      });
    }
  }, []);

  // ── Answer handler ────────────────────────────────────────────────────
  const handleAnswer = useCallback(async (questionId, value) => {
    try { await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium); } catch {}

    setLastAnswer(value);

    const updatedAnswers = { ...answers, [questionId]: value };
    setAnswers(updatedAnswers);

    const next = currentQ + 1;

    if (next < questions.length) {
      setCurrentQ(next);
    } else {
      // All questions answered — compute result
      await showResult(updatedAnswers);
    }
  }, [answers, currentQ, questions.length]);

  // ── Show result ───────────────────────────────────────────────────────
  async function showResult(finalAnswers) {
    try { await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning); } catch {}

    const assessed = assess(finalAnswers);
    setResult(assessed);
    setPhase(PHASE.RESULT);

    // Animate result in
    Animated.spring(resultAnim, {
      toValue: 1, tension: 60, friction: 9, useNativeDriver: true,
    }).start();

    // Fetch nearest relevant service
    if (location) {
      setLoadingSvc(true);
      try {
        const svc = await getNearestService(location.lat, location.lon, assessed.serviceType);
        setNearest(svc);
      } catch {}
      setLoadingSvc(false);
    } else {
      // Try to get location now if missing
      const { coords } = await getFullLocation();
      if (coords) {
        setLocation(coords);
        setLoadingSvc(true);
        try {
          const svc = await getNearestService(coords.lat, coords.lon, assessed.serviceType);
          setNearest(svc);
        } catch {}
        setLoadingSvc(false);
      }
    }
  }

  // ── Reset ─────────────────────────────────────────────────────────────
  const handleRetake = useCallback(() => {
    setPhase(PHASE.QUESTIONS);
    setCurrentQ(0);
    setAnswers({ unconscious: false, bleeding: false, cantMove: false, fire: false });
    setLastAnswer(null);
    setResult(null);
    setNearest(null);
    resultAnim.setValue(0);
  }, []);

  // ── Navigation ────────────────────────────────────────────────────────
  const handleCall = (phone) => {
    try { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy); } catch {}
    Linking.openURL(`tel:${phone}`);
  };

  const handleMap = (service) => {
    navigation.navigate('Map', { focusService: service, location });
  };

  const handleClose = () => {
    navigation.goBack();
  };

  // ── Render ─────────────────────────────────────────────────────────────
  return (
    <SafeAreaView style={s.safe} edges={['top', 'bottom']}>

      {/* ── Header ── */}
      <View style={s.header}>
        <TouchableOpacity style={s.closeBtn} onPress={handleClose}>
          <Ionicons name="close" size={22} color={COLORS.textSecondary} />
        </TouchableOpacity>
        <View style={s.headerCenter}>
          <Text style={s.headerTitle}>
            {phase === PHASE.QUESTIONS ? 'Severity Check' : 'Assessment Result'}
          </Text>
          {phase === PHASE.QUESTIONS && (
            <Text style={s.headerSub}>
              {currentQ + 1} / {questions.length}
            </Text>
          )}
        </View>
        {/* SOS quick-call */}
        <TouchableOpacity style={s.sosQuick} onPress={() => handleCall('112')}>
          <Text style={s.sosQuickText}>112</Text>
        </TouchableOpacity>
      </View>

      {/* ── Progress bar (questions phase) ── */}
      {phase === PHASE.QUESTIONS && (
        <ProgressBar current={currentQ} total={questions.length} />
      )}

      {/* ── Questions Phase ── */}
      {phase === PHASE.QUESTIONS && (
        <View style={s.questionWrap}>
          <QuestionCard
            key={currentQ}                    // remount on question change to retrigger animation
            question={questions[currentQ]}
            index={currentQ}
            total={questions.length}
            lastAnswer={lastAnswer}
            onYes={() => handleAnswer(questions[currentQ].id, true)}
            onNo={()  => handleAnswer(questions[currentQ].id, false)}
          />

          {/* Skip to result (for rescuers in a hurry) */}
          <TouchableOpacity
            style={s.skipBtn}
            onPress={async () => await showResult(answers)}
          >
            <Text style={s.skipText}>Skip remaining questions →</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* ── Result Phase ── */}
      {phase === PHASE.RESULT && result && (
        <Animated.ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={s.resultContent}
          showsVerticalScrollIndicator={false}
        >
          {/* Severity badge */}
          <SeverityBadge
            level={result.level}
            urgencyScore={result.urgencyScore}
          />

          {/* ETA hint */}
          <View style={s.etaRow}>
            <Ionicons name="time-outline" size={14} color={COLORS.textMuted} />
            <Text style={s.etaText}>{result.estimatedETA}</Text>
          </View>

          {/* Emergency numbers strip */}
          <View style={s.numbersStrip}>
            {[
              { num: '112', label: 'Emergency' },
              { num: '108', label: 'Ambulance' },
              { num: '100', label: 'Police' },
              { num: '101', label: 'Fire' },
            ].map(({ num, label }) => (
              <TouchableOpacity
                key={num}
                style={s.numChip}
                onPress={() => handleCall(num)}
              >
                <Text style={s.numChipNum}>{num}</Text>
                <Text style={s.numChipLabel}>{label}</Text>
              </TouchableOpacity>
            ))}
          </View>

          {/* Nearest service card */}
          <Text style={s.sectionTitle}>Nearest Service</Text>
          {loadingService ? (
            <View style={s.loadingService}>
              <Text style={s.loadingServiceText}>Finding nearest {result.serviceType}...</Text>
            </View>
          ) : (
            <NearestServiceCard
              service={nearestService}
              onCall={handleCall}
              onMap={handleMap}
            />
          )}

          {/* First aid steps */}
          <Text style={s.sectionTitle}>First Aid Steps</Text>
          <FirstAidPanel
            steps={result.firstAid}
            doNotDo={result.doNotDo}
          />

          {/* Answers summary */}
          <View style={s.answerSummary}>
            <Text style={s.answerSummaryTitle}>Your answers</Text>
            {questions.map(q => (
              <View key={q.id} style={s.answerRow}>
                <Text style={s.answerQ} numberOfLines={1}>{q.text}</Text>
                <Text style={[
                  s.answerVal,
                  { color: answers[q.id] ? COLORS.primary : COLORS.secondary },
                ]}>
                  {answers[q.id] ? 'YES' : 'NO'}
                </Text>
              </View>
            ))}
          </View>

          {/* Retake / navigate buttons */}
          <View style={s.bottomActions}>
            <TouchableOpacity style={s.retakeBtn} onPress={handleRetake}>
              <Ionicons name="refresh" size={16} color={COLORS.textSecondary} />
              <Text style={s.retakeText}>Re-assess</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={s.servicesBtn}
              onPress={() => navigation.navigate('Services', {
                filterType: result.serviceType, location,
              })}
            >
              <Ionicons name="list" size={16} color="#fff" />
              <Text style={s.servicesBtnText}>All {result.serviceType}s nearby</Text>
            </TouchableOpacity>
          </View>

          <View style={{ height: 40 }} />
        </Animated.ScrollView>
      )}
    </SafeAreaView>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────
const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: COLORS.background },

  header: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 16, paddingVertical: 14,
    borderBottomWidth: 1, borderBottomColor: COLORS.navBorder,
  },
  closeBtn: {
    width: 36, height: 36, borderRadius: 18,
    backgroundColor: COLORS.backgroundCard,
    alignItems: 'center', justifyContent: 'center',
  },
  headerCenter: { flex: 1, alignItems: 'center' },
  headerTitle:  { color: COLORS.textPrimary, fontSize: 16, fontWeight: '800' },
  headerSub:    { color: COLORS.textMuted, fontSize: 12, marginTop: 2 },
  sosQuick: {
    backgroundColor: COLORS.primary,
    borderRadius: 10, paddingHorizontal: 14, paddingVertical: 8,
  },
  sosQuickText: { color: '#fff', fontSize: 14, fontWeight: '900' },

  questionWrap: { flex: 1, paddingHorizontal: 20, paddingTop: 24, justifyContent: 'center' },

  skipBtn: { alignSelf: 'center', marginTop: 24, padding: 12 },
  skipText: { color: COLORS.textMuted, fontSize: 12, textDecorationLine: 'underline' },

  resultContent: { paddingHorizontal: 16, paddingTop: 20, gap: 16 },

  sectionTitle: {
    color: COLORS.textSecondary, fontSize: 11, fontWeight: '800',
    letterSpacing: 1.5, textTransform: 'uppercase',
  },

  etaRow: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    marginTop: -8,
  },
  etaText: { color: COLORS.textMuted, fontSize: 12 },

  numbersStrip: { flexDirection: 'row', gap: 8 },
  numChip: {
    flex: 1, backgroundColor: COLORS.backgroundCard,
    borderRadius: 10, borderWidth: 1, borderColor: COLORS.border,
    alignItems: 'center', paddingVertical: 10,
  },
  numChipNum:   { color: COLORS.primary, fontSize: 16, fontWeight: '900' },
  numChipLabel: { color: COLORS.textMuted, fontSize: 9, fontWeight: '700', letterSpacing: 0.5, marginTop: 2 },

  loadingService: {
    backgroundColor: COLORS.backgroundCard, borderRadius: 14,
    padding: 20, alignItems: 'center', borderWidth: 1, borderColor: COLORS.border,
  },
  loadingServiceText: { color: COLORS.textSecondary, fontSize: 13 },

  answerSummary: {
    backgroundColor: COLORS.backgroundCard, borderRadius: 14,
    padding: 16, borderWidth: 1, borderColor: COLORS.border, gap: 10,
  },
  answerSummaryTitle: {
    color: COLORS.textMuted, fontSize: 10, fontWeight: '800',
    letterSpacing: 1.5, marginBottom: 4,
  },
  answerRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  answerQ:   { flex: 1, color: COLORS.textSecondary, fontSize: 12 },
  answerVal: { fontSize: 12, fontWeight: '800' },

  bottomActions: { flexDirection: 'row', gap: 10 },
  retakeBtn: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7,
    backgroundColor: COLORS.backgroundCard, borderRadius: 12,
    borderWidth: 1, borderColor: COLORS.border, paddingVertical: 14, minHeight: 52,
  },
  retakeText: { color: COLORS.textSecondary, fontSize: 14, fontWeight: '700' },
  servicesBtn: {
    flex: 2, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7,
    backgroundColor: COLORS.primary, borderRadius: 12, paddingVertical: 14, minHeight: 52,
  },
  servicesBtnText: { color: '#fff', fontSize: 14, fontWeight: '800' },
});

// ─── Progress bar styles ──────────────────────────────────────────────────────
const pb = StyleSheet.create({
  track: { height: 4, backgroundColor: COLORS.backgroundCard, marginHorizontal: 0 },
  fill:  { height: 4, backgroundColor: COLORS.primary, borderRadius: 2 },
});

// ─── Question card styles ─────────────────────────────────────────────────────
const qc = StyleSheet.create({
  card: {
    backgroundColor: COLORS.backgroundCard,
    borderRadius: 20, borderWidth: 1, borderColor: COLORS.border,
    padding: 24, gap: 16,
  },
  qNum: { color: COLORS.textMuted, fontSize: 11, fontWeight: '700', letterSpacing: 1, textTransform: 'uppercase' },
  icon: { fontSize: 56, textAlign: 'center', marginVertical: 4 },
  text: {
    color: COLORS.textPrimary, fontSize: 20, fontWeight: '700',
    textAlign: 'center', lineHeight: 28,
  },
  hintBox: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    backgroundColor: COLORS.primary + '12',
    borderRadius: 10, borderWidth: 1, borderColor: COLORS.primary + '30',
    padding: 12,
  },
  hintText: { color: COLORS.primary, fontSize: 12, flex: 1, lineHeight: 18 },
  btnRow: { flexDirection: 'row', gap: 14, marginTop: 8 },
  noBtn: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    backgroundColor: COLORS.primary + '15',
    borderWidth: 1.5, borderColor: COLORS.primary + '50',
    borderRadius: 14, paddingVertical: 16, minHeight: 56,
  },
  noBtnText:  { color: COLORS.primary,   fontSize: 18, fontWeight: '900', letterSpacing: 1 },
  yesBtn: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    backgroundColor: COLORS.primary,
    borderRadius: 14, paddingVertical: 16, minHeight: 56,
    elevation: 6,
    shadowColor: COLORS.primary, shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.5, shadowRadius: 8,
  },
  yesBtnText: { color: '#fff', fontSize: 18, fontWeight: '900', letterSpacing: 1 },
  reassure: { color: COLORS.textMuted, fontSize: 11, textAlign: 'center' },
});

// ─── Result badge styles ──────────────────────────────────────────────────────
const rb = StyleSheet.create({
  wrap: {
    borderRadius: 20, borderWidth: 1.5,
    padding: 24, alignItems: 'center', gap: 8,
  },
  emoji:   { fontSize: 52 },
  level:   { fontSize: 28, fontWeight: '900', letterSpacing: 3 },
  urgency: { color: COLORS.textSecondary, fontSize: 12, fontWeight: '600' },
  rec:     { fontSize: 14, textAlign: 'center', lineHeight: 20, fontWeight: '500' },
});

// ─── First aid panel styles ───────────────────────────────────────────────────
const fa = StyleSheet.create({
  wrap: {
    backgroundColor: COLORS.backgroundCard,
    borderRadius: 14, borderWidth: 1, borderColor: COLORS.border, padding: 16, gap: 10,
  },
  title:      { color: COLORS.textPrimary, fontSize: 14, fontWeight: '800', marginBottom: 4 },
  step: {
    backgroundColor: COLORS.backgroundElevated,
    borderRadius: 10, padding: 12,
  },
  dontStep:   { backgroundColor: COLORS.primary + '0E', borderWidth: 1, borderColor: COLORS.primary + '25' },
  stepText:   { color: COLORS.textSecondary, fontSize: 13, lineHeight: 19 },
  expandBtn:  { alignSelf: 'center', padding: 8 },
  expandText: { color: COLORS.primary, fontSize: 12, fontWeight: '700' },
});

// ─── Nearest service card styles ──────────────────────────────────────────────
const ns = StyleSheet.create({
  card:   { borderRadius: 14, borderWidth: 1, overflow: 'hidden' },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 16, paddingVertical: 12,
  },
  headerText: { color: '#fff', fontSize: 13, fontWeight: '800', flex: 1 },
  badge24:    { color: '#fff', fontSize: 10, fontWeight: '800', backgroundColor: 'rgba(255,255,255,0.2)', borderRadius: 5, paddingHorizontal: 6, paddingVertical: 2 },
  body:    { backgroundColor: COLORS.backgroundCard, padding: 16, gap: 4 },
  name:    { color: COLORS.textPrimary, fontSize: 16, fontWeight: '800' },
  address: { color: COLORS.textSecondary, fontSize: 12 },
  dist:    { fontSize: 14, fontWeight: '700', marginTop: 4 },
  actions: {
    flexDirection: 'row', gap: 10,
    backgroundColor: COLORS.backgroundCard,
    paddingHorizontal: 16, paddingBottom: 16,
  },
  callBtn: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    borderRadius: 12, paddingVertical: 14, minHeight: 52,
  },
  callBtnDisabled: { opacity: 0.5 },
  callBtnText: { color: '#fff', fontSize: 14, fontWeight: '900', letterSpacing: 0.5 },
  mapBtn: {
    width: 52, height: 52, borderRadius: 12,
    backgroundColor: COLORS.backgroundElevated, borderWidth: 1, borderColor: COLORS.border,
    alignItems: 'center', justifyContent: 'center', gap: 2,
  },
  mapBtnText: { color: COLORS.textMuted, fontSize: 9, fontWeight: '600' },
  empty: {
    backgroundColor: COLORS.backgroundCard, borderRadius: 14,
    padding: 20, alignItems: 'center', borderWidth: 1, borderColor: COLORS.border,
  },
  emptyText: { color: COLORS.textSecondary, fontSize: 13, textAlign: 'center', lineHeight: 20 },
});
