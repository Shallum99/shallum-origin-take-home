/**
 * Deterministic safeguarding pre-filter.
 *
 * This runs on every item, regardless of whether the LLM agent path is
 * active. Two guarantees:
 *   1. If a phrase here matches, the orchestrator forces P0 escalation,
 *      even if the LLM disagrees. The cost of a missed safeguarding case
 *      is far higher than the cost of an over-escalation, and we never
 *      delegate "ignore this concern" to a probabilistic system.
 *   2. The matched phrase is included verbatim in the escalation reason
 *      so a human reviewer can audit *why* the system escalated.
 *
 * The phrase list is intentionally narrow. We index on language that
 * describes a caregiver's conduct or the child's stated fear, not on
 * generic emotional words. False positives cost a clinical-lead review;
 * false negatives can fail a child. We accept the cost asymmetry.
 */

export interface SafeguardingHit {
  hit: boolean;
  matchedPhrase: string | null;
}

const PATTERNS: RegExp[] = [
  /\babus(e|ive|ing|ed)\b/i,
  /\bneglect(ed|ing|ful)?\b/i,
  /\bmolest(ed|ing)?\b/i,
  /\b(getting|been|gets|got|is|was)\s+rough\b/i,
  /\brough\s+with\s+(him|her|them|the\s+(child|kid|baby|boy|girl))\b/i,
  /\b(hit|hits|hitting|hurt|hurts|hurting)\s+(him|her|me|the\s+(child|kid|baby|boy|girl))\b/i,
  /\b(afraid|scared|terrified|frightened)\s+of\s+(?:(?:his|her|their|the)\s+)?(dad|mom|mommy|daddy|stepfather|stepmother|father|mother|him|her)\b/i,
  /\b(unsafe|not\s+safe|isn'?t\s+safe|wasn'?t\s+safe|aren'?t\s+safe)\s+(at\s+home|in\s+the\s+home|home)\b/i,
  /\b(self[\s-]?harm|self[\s-]?harming|suicid(e|al))\b/i,
  /\bhurt\s+(himself|herself|themselves|themself)\b/i,
  /\b(wants?|wanted|trying)\s+to\s+hurt\s+(himself|herself|themselves|themself)\b/i,
  /\b(slap|slapped|slapping|punch|punched|punching|kick|kicked|kicking)\s+(him|her|me|the\s+(child|kid))\b/i,
  /\byell(ing|ed)?\s+at\s+(him|her|the\s+(child|kid))\b/i,
  /\bsomething'?s\s+wrong\s+at\s+home\b/i,
  /\bbruis(es|ing|ed)\b/i,
  /\bshouldn'?t\s+be\s+alone\s+with\b/i,
];

export function detectSafeguarding(text: string): SafeguardingHit {
  for (const pattern of PATTERNS) {
    const match = text.match(pattern);
    if (match) return { hit: true, matchedPhrase: match[0] };
  }
  return { hit: false, matchedPhrase: null };
}
