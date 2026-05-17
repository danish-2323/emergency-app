/**
 * RoadSoS — services/SeverityModel.js
 *
 * Pure logic module — no React, no UI.
 * Takes answers to 4 yes/no questions and returns:
 *   - Severity level  (CRITICAL / MODERATE / MINOR)
 *   - Recommended service type
 *   - First aid steps (shown while waiting for help)
 *   - Whether to auto-call ambulance
 *   - Urgency score   (0–100, for ranking)
 *
 * Used by:
 *   SeverityScreen.js  (UI flow)
 *   ChatScreen.js      (embedded severity check in chat)
 *   VoiceService.js    (spoken result after keyword trigger)
 */

import { SEVERITY, SEVERITY_CONFIG, SERVICE_TYPES } from '../constants/config';

// ─── Question Definitions ─────────────────────────────────────────────────────
// Exported so SeverityScreen can render them from a single source of truth.
export const SEVERITY_QUESTIONS = [
  {
    id: 'unconscious',
    text: 'Is anyone unconscious or unresponsive?',
    yesWeight: 40,   // Points added to urgency score if YES
    icon: '😵',
    yesHint: 'Check for breathing immediately.',
    noHint:  'Good — keep them calm and seated.',
  },
  {
    id: 'bleeding',
    text: 'Is there heavy or uncontrolled bleeding?',
    yesWeight: 35,
    icon: '🩸',
    yesHint: 'Apply firm pressure with cloth/hand.',
    noHint:  'Check for any minor cuts or bruises.',
  },
  {
    id: 'cantMove',
    text: 'Is the injured person unable to move on their own?',
    yesWeight: 20,
    icon: '🦽',
    yesHint: 'Do NOT move them — possible spinal injury.',
    noHint:  'Help them to a safe spot away from traffic.',
  },
  {
    id: 'fire',
    text: 'Is the vehicle on fire or leaking fuel?',
    yesWeight: 50,   // Highest weight — immediate danger
    icon: '🔥',
    yesHint: 'Move everyone 50m away IMMEDIATELY.',
    noHint:  'Turn off ignition if safe to do so.',
  },
];

// ─── Core Classifier ──────────────────────────────────────────────────────────

/**
 * Compute severity level from answers object.
 *
 * @param {{ unconscious: boolean, bleeding: boolean, cantMove: boolean, fire: boolean }} answers
 * @returns {{
 *   level:          'CRITICAL' | 'MODERATE' | 'MINOR',
 *   urgencyScore:   number,       // 0–100
 *   serviceType:    string,       // SERVICE_TYPES constant
 *   callAmbulance:  boolean,
 *   config:         object,       // from SEVERITY_CONFIG
 *   firstAid:       string[],     // ordered first aid steps
 *   doNotDo:        string[],     // common mistakes to avoid
 *   estimatedETA:   string,       // rough ambulance ETA hint
 * }}
 */
export function assess(answers) {
  const { unconscious = false, bleeding = false, cantMove = false, fire = false } = answers;

  // ── Urgency score (additive weights) ──
  let score = 0;
  if (unconscious) score += 40;
  if (bleeding)    score += 35;
  if (cantMove)    score += 20;
  if (fire)        score += 50;

  // Cap at 100
  score = Math.min(score, 100);

  // ── Level classification ──
  let level;
  if (unconscious || bleeding || fire) {
    level = SEVERITY.CRITICAL;
  } else if (cantMove) {
    level = SEVERITY.MODERATE;
  } else {
    level = SEVERITY.MINOR;
  }

  const config = SEVERITY_CONFIG[level];

  // ── First aid steps (context-sensitive) ──
  const firstAid = buildFirstAidSteps({ unconscious, bleeding, cantMove, fire });
  const doNotDo  = buildDoNotDoList({ unconscious, bleeding, cantMove, fire });

  // ── ETA hint ──
  const estimatedETA = level === SEVERITY.CRITICAL
    ? 'Ambulance typically arrives in 8–15 minutes in urban areas'
    : 'Drive to nearest hospital or call 108';

  return {
    level,
    urgencyScore: score,
    serviceType:  config.serviceType,
    callAmbulance: config.callAmbulance,
    config,
    firstAid,
    doNotDo,
    estimatedETA,
  };
}

// ─── First Aid Step Builder ───────────────────────────────────────────────────

/**
 * Build a prioritised list of first aid steps based on the answers.
 * Steps are ordered from most urgent to least.
 */
function buildFirstAidSteps({ unconscious, bleeding, cantMove, fire }) {
  const steps = [];

  // ── Fire / fuel — always first ──
  if (fire) {
    steps.push(
      '🔥 Move ALL people at least 50 metres from the vehicle NOW',
      '📵 Do NOT use mobile phones near leaking fuel',
      '🚒 Call 101 (Fire) immediately after 108 (Ambulance)',
    );
  }

  // ── Unconscious person ──
  if (unconscious) {
    steps.push(
      '😵 Check if the person is breathing — tilt head back, lift chin',
      '👂 Place ear near mouth and look for chest rise for 10 seconds',
      '🫁 If not breathing, begin CPR: 30 chest compressions then 2 breaths',
      '🔄 Place in recovery position if breathing but unconscious (on their side)',
      '🧠 Do NOT leave them alone — stay with them',
    );
  }

  // ── Heavy bleeding ──
  if (bleeding) {
    steps.push(
      '🩸 Apply FIRM direct pressure on the wound using a cloth, shirt, or bandage',
      '⏱️ Hold pressure continuously for at least 10 minutes without peeking',
      '🚫 Do NOT remove the cloth if it soaks through — add more on top',
      '🦵 If limb is bleeding, raise it above heart level if possible',
    );
  }

  // ── Cannot move ──
  if (cantMove) {
    steps.push(
      '🦽 Do NOT move the person — possible spinal or neck injury',
      '🗣️ Keep talking to them to maintain consciousness',
      '🧥 Keep them warm using a jacket or blanket to prevent shock',
      '🚫 Do NOT give food or water',
    );
  }

  // ── General steps (always included) ──
  steps.push(
    '📞 Ensure someone has called 108 (Ambulance) and 112 (Emergency)',
    '🚦 Turn on hazard lights and set up warning triangle if available',
    '🧘 Stay calm — help is on the way',
  );

  // Minor / no injuries
  if (!unconscious && !bleeding && !cantMove && !fire) {
    steps.push(
      '🚗 Move vehicles off the road if safe and drivable',
      '📷 Document the scene with photos for insurance/police',
      '👮 Call 100 (Police) to file an FIR',
      '🔧 Contact a towing service if the vehicle cannot move',
    );
  }

  return steps;
}

/**
 * Common mistakes to avoid, based on the situation.
 */
function buildDoNotDoList({ unconscious, bleeding, cantMove, fire }) {
  const list = [];

  if (unconscious) {
    list.push('Do NOT shake or slap an unconscious person');
    list.push('Do NOT give water to someone who is unconscious');
  }
  if (bleeding) {
    list.push('Do NOT remove an object embedded in a wound — stabilise it instead');
    list.push('Do NOT apply a tourniquet unless you are trained');
  }
  if (cantMove) {
    list.push('Do NOT move a person with a possible neck/back injury');
    list.push('Do NOT try to straighten a broken limb');
  }
  if (fire) {
    list.push('Do NOT open the fuel cap or try to fight a vehicle fire yourself');
    list.push('Do NOT re-enter a burning vehicle for belongings');
  }

  list.push('Do NOT drive away from the scene before police arrive');
  list.push('Do NOT post accident photos on social media before helping');

  return list;
}

// ─── Utility Exports ──────────────────────────────────────────────────────────

/**
 * Get a single sentence summary of the result for TTS / notifications.
 * e.g. "CRITICAL: Call ambulance immediately. Nearest trauma centre found."
 */
export function getSummaryText(result) {
  const { level, config } = result;
  return `${level}: ${config.recommendation}`;
}

/**
 * Check if any answer is YES (used to skip severity screen for minor cases).
 */
export function hasAnyYes(answers) {
  return Object.values(answers).some(Boolean);
}

/**
 * Get urgency label for display.
 * e.g. score 85 → "Very High"
 */
export function getUrgencyLabel(score) {
  if (score >= 70) return 'Very High';
  if (score >= 40) return 'High';
  if (score >= 20) return 'Moderate';
  return 'Low';
}

export default { assess, SEVERITY_QUESTIONS, getSummaryText, hasAnyYes, getUrgencyLabel };
