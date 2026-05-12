import type { Discipline, ExtractedIntake, InboxItem } from "../types.js";
import { detectSafeguarding } from "../safety/safeguarding.js";

export interface ItemSignals {
  safeguarding: { hit: boolean; matchedPhrase: string | null };
  language: "en" | "es";
  isSameDayCancellation: boolean;
  isClinicalQuestionOnly: boolean;
  isMissingPaperwork: boolean;
  hasUrgentMarker: boolean;
  preferences: string | null;
  email: string | null;
  phone: string | null;
}

export interface ExtractionResult {
  intake: ExtractedIntake;
  signals: ItemSignals;
  missingInfo: string[];
}

const SPANISH_TOKENS = [
  "hola",
  "soy",
  "mi hija",
  "mi hijo",
  "mi nino",
  "mi nina",
  "tiene",
  "anos",
  "años",
  "necesita",
  "evaluacion",
  "evaluación",
  "habla",
  "espanol",
  "español",
  "gracias",
  "por favor",
  "mensaje",
  "llamo",
  "miembro",
  "alguien que hable",
  "tenemos",
];

const DISCIPLINE_KEYWORDS: Array<{ pattern: RegExp; discipline: Discipline }> =
  [
    { pattern: /\bSLP\b/i, discipline: "SLP" },
    { pattern: /\bspeech[-\s]?language\b/i, discipline: "SLP" },
    { pattern: /\bspeech\b/i, discipline: "SLP" },
    { pattern: /\barticulation\b/i, discipline: "SLP" },
    { pattern: /\bR\s+sounds?\b/i, discipline: "SLP" },
    { pattern: /\b(language|vocabulary)\s+delay\b/i, discipline: "SLP" },
    { pattern: /\bhabla\b/i, discipline: "SLP" }, // Spanish: speech
    { pattern: /\bOT\b/i, discipline: "OT" },
    { pattern: /\boccupational\b/i, discipline: "OT" },
    { pattern: /\bsensory\b/i, discipline: "OT" },
    { pattern: /\bfeeding\b/i, discipline: "OT" },
    { pattern: /\bPT\b/i, discipline: "PT" },
    { pattern: /\bphysical\s+therapy\b/i, discipline: "PT" },
    { pattern: /\btoe[-\s]?walking\b/i, discipline: "PT" },
    { pattern: /\bgait\b/i, discipline: "PT" },
  ];

const PAYER_PATTERNS: Array<{ pattern: RegExp; canonical: string }> = [
  { pattern: /\bblue\s*cross\s*blue\s*shield\b[^.,\n]*/i, canonical: "raw" },
  { pattern: /\b(BCBS)\b[^.,\n]*/i, canonical: "raw" },
  { pattern: /\baetna\b[^.,\n]*/i, canonical: "raw" },
  { pattern: /\b(united\s*health\s*care|uhc|unitedhealthcare)\b[^.,\n]*/i, canonical: "raw" },
  { pattern: /\bkaiser\b[^.,\n]*/i, canonical: "raw" },
  { pattern: /\bcigna(\s+select)?\b[^.,\n]*/i, canonical: "raw" },
  { pattern: /\bbeacon\b[^.,\n]*/i, canonical: "raw" },
  { pattern: /\bmedicaid\b[^.,\n]*/i, canonical: "raw" },
  { pattern: /\bsunrise\b[^.,\n]*/i, canonical: "raw" },
  { pattern: /\bpediatric\s+choice\b[^.,\n]*/i, canonical: "raw" },
  { pattern: /\bcommunity\s+first\b[^.,\n]*/i, canonical: "raw" },
];

export function extractIntake(item: InboxItem): ExtractionResult {
  const text = `${item.subject}\n${item.body}`;
  const lowerText = text.toLowerCase();

  const safeguarding = detectSafeguarding(text);
  const language = detectLanguage(lowerText);
  const hasUrgentMarker = /\burgent\b/i.test(text);
  const isMissingPaperwork = countMatches(text, /\[\s*blank\s*\]/gi) >= 2;
  const isSameDayCancellation = detectSameDayCancellation(text);
  const isClinicalQuestionOnly = detectClinicalQuestionOnly(text);

  const child_name = extractChildName(item);
  const { dob_or_age } = extractDobOrAge(text);
  const phone = extractPhone(text);
  const email = extractEmail(item);
  const parent_contact = buildParentContact(item, text, phone, email);
  const discipline = extractDisciplines(text);
  const diagnosis_or_concern = extractConcern(text);
  const payer = extractPayer(text);
  const member_id = extractMemberId(text);
  const preferences = extractPreferences(text);

  const intake: ExtractedIntake = {
    child_name,
    dob_or_age,
    parent_contact,
    discipline,
    diagnosis_or_concern,
    payer,
    member_id,
  };

  const missingInfo = computeMissingInfo(intake);

  const signals: ItemSignals = {
    safeguarding,
    language,
    isSameDayCancellation,
    isClinicalQuestionOnly,
    isMissingPaperwork,
    hasUrgentMarker,
    preferences,
    email,
    phone,
  };

  return { intake, signals, missingInfo };
}

function detectLanguage(lowerText: string): "en" | "es" {
  let score = 0;
  for (const token of SPANISH_TOKENS) {
    if (lowerText.includes(token)) {
      score += 1;
    }
  }
  return score >= 3 ? "es" : "en";
}

function detectSameDayCancellation(text: string): boolean {
  const lower = text.toLowerCase();
  const hasTodayMarker =
    /\btoday'?s?\b/i.test(text) ||
    /\bthis\s+(morning|afternoon|evening)\b/i.test(text);
  const hasCancelIntent =
    /\b(reschedul\w*|cancel\w*|can'?t\s+make|miss(ing)?|won'?t\s+make|out\s+sick|threw\s+up|throwing\s+up|fever)\b/i.test(
      text,
    );
  if (hasTodayMarker && hasCancelIntent) {
    return true;
  }
  // Catch "URGENT!!! need to reschedule today's 3pm" style without requiring exact time
  if (/\burgent\b/i.test(text) && hasCancelIntent && hasTodayMarker) {
    return true;
  }
  // Fallback: a same-day clinic call with "today" and an appointment time
  if (hasTodayMarker && /\b\d{1,2}\s*(am|pm)\b/i.test(lower)) {
    return true;
  }
  return false;
}

function detectClinicalQuestionOnly(text: string): boolean {
  const hasQuestion =
    /\b(is\s+it\s+normal|should\s+i\s+be\s+worried|should\s+we\s+wait|is\s+this\s+typical|is\s+it\s+ok|when\s+should)\b/i.test(
      text,
    );
  const asksAdvice =
    /\b(advice|opinion|guidance|should\s+i)\b/i.test(text);
  const wantsBookingNow =
    /\b(book|schedule\s+an?\s+appointment|set\s+up\s+an?\s+eval|need\s+an?\s+eval|request(ing)?\s+an?\s+eval)\b/i.test(
      text,
    );
  return (hasQuestion || asksAdvice) && !wantsBookingNow;
}

function extractChildName(item: InboxItem): string | null {
  const text = `${item.subject}\n${item.body}`;
  // Case-sensitive name pattern: requires capital first letter on each token.
  // We never apply /i to the wrapper because under /i, [A-Z] also matches
  // [a-z] and the {0,2} repetition would greedily eat lowercase follow-ons
  // (e.g. "Ava still can't").
  const NAME = `[A-Z][A-Za-z'\\-]+(?:\\s+[A-Z][A-Za-z'\\-]+){0,2}`;
  // Helper for case-insensitive ASCII keywords (we can't use /i on the whole
  // pattern, so spell out each keyword via character classes where the prefix
  // could be capitalised).
  const ci = (word: string) =>
    word
      .split("")
      .map((c) => (/[a-zA-Z]/.test(c) ? `[${c.toLowerCase()}${c.toUpperCase()}]` : c))
      .join("");

  // 1. "Child: <Name>"
  const childField = text.match(new RegExp(`${ci("Child")}(?:'s\\s+${ci("name")})?\\s*:\\s*(${NAME})`));
  if (childField) return childField[1].trim();

  // 2. "Referral: <Name>" in subject (stop on -, /em-dash, " evaluation", or discipline)
  const referralSubject = item.subject.match(
    new RegExp(
      `${ci("Referral")}(?:\\s+${ci("for")})?\\s*:?\\s+(${NAME})(?=\\s+-|\\s+–|\\s+${ci("evaluation")}|\\s+OT|\\s+PT|\\s+SLP|$)`,
    ),
  );
  if (referralSubject) return referralSubject[1].trim();

  // 3. "Referral for <Name>" in body or subject
  const referralFor = text.match(
    new RegExp(`(?:${ci("referral")}|${ci("eval")}(?:${ci("uation")})?|${ci("appointment")})\\s+${ci("for")}\\s+(${NAME})`),
  );
  if (referralFor) return referralFor[1].trim();

  // 4. "my (son|daughter|child|kid) [optional age modifier] <Name>"
  const myChild = text.match(
    new RegExp(
      `\\b${ci("my")}\\s+(?:\\d+[-\\s]?${ci("year")}[-\\s]?${ci("old")}\\s+)?(?:${ci("son")}|${ci("daughter")}|${ci("child")}|${ci("kid")})\\s+(${NAME})`,
    ),
  );
  if (myChild) return myChild[1].trim();

  // 5. "my <age>-year-old <Name>" (no son/daughter qualifier)
  const myAgeChild = text.match(
    new RegExp(`\\b${ci("my")}\\s+\\d+[-\\s]?${ci("year")}[-\\s]?${ci("old")}\\s+(${NAME})`),
  );
  if (myAgeChild) return myAgeChild[1].trim();

  // 6. Spanish: "mi (hija|hijo|nino|nina) <Name>"
  const miChild = text.match(
    new RegExp(`\\b${ci("mi")}\\s+(?:${ci("hija")}|${ci("hijo")}|${ci("nino")}|${ci("nina")}|niño|niña)\\s+(${NAME})`),
  );
  if (miChild) return miChild[1].trim();

  // 7. "<Name> threw up" / "<Name> can't make" / "<Name> is sick" — try this
  // before the possessive pattern because a same-day event line usually
  // contains the full first+last name while the possessive line often only
  // uses the first name ("Noah Patel threw up... Noah's DOB is ...").
  const namedEvent = text.match(
    new RegExp(`(${NAME})\\s+(?:${ci("threw")}\\s+${ci("up")}|${ci("can")}'?${ci("t")}\\s+${ci("make")}|${ci("is")}\\s+${ci("sick")}|${ci("won")}'?${ci("t")}\\s+${ci("make")})`),
  );
  if (namedEvent) return namedEvent[1].trim();

  // 8. "<Name>'s DOB" or "<Name>'s appointment"
  const possessive = text.match(
    new RegExp(`(${NAME})'s\\s+(?:DOB|${ci("appointment")}|${ci("chart")}|${ci("insurance")})`),
  );
  if (possessive) return possessive[1].trim();

  // 9. Generic "about <Name>" / "for <Name>"
  const aboutChild = text.match(new RegExp(`\\b(?:${ci("about")}|${ci("for")})\\s+(${NAME})\\b`));
  if (aboutChild) return aboutChild[1].trim();

  return null;
}

function extractDobOrAge(text: string): { dob_or_age: string | null } {
  const dob = text.match(/\b(\d{4}-\d{2}-\d{2})\b/);
  if (dob) {
    return { dob_or_age: dob[1] };
  }
  const dobField = text.match(/\bDOB\s*:?\s*([^\n,]+)/i);
  if (dobField && !/\[\s*blank\s*\]/i.test(dobField[1])) {
    const value = dobField[1].trim();
    if (value && value.toLowerCase() !== "blank") {
      return { dob_or_age: value };
    }
  }
  const ageNum = text.match(/\bis\s+(\d{1,2})\b/);
  if (ageNum) {
    return { dob_or_age: `age ${ageNum[1]}` };
  }
  const ageWord = text.match(/(\d{1,2})[-\s]?year[-\s]?old/i);
  if (ageWord) {
    return { dob_or_age: `age ${ageWord[1]}` };
  }
  const spanishAge = text.match(/\btiene\s+(\d{1,2})\s+a[nñ]os\b/i);
  if (spanishAge) {
    return { dob_or_age: `age ${spanishAge[1]}` };
  }
  return { dob_or_age: null };
}

function extractPhone(text: string): string | null {
  // Real 10-digit numbers first; fall back to the 7-digit fake-number style
  // (555-0101) used throughout the synthetic dataset so callbacks have a
  // contact value to surface even when the format is the short one.
  const tenDigit = text.match(/\b(\d{3}[-.\s]?\d{3}[-.\s]?\d{4})\b/);
  if (tenDigit) return tenDigit[1];
  const sevenDigit = text.match(/\b(\d{3}[-.\s]\d{4})\b/);
  return sevenDigit ? sevenDigit[1] : null;
}

function extractEmail(item: InboxItem): string | null {
  const senderEmail = item.sender.match(/<([^>]+@[^>]+)>/);
  if (senderEmail) {
    return senderEmail[1].trim();
  }
  if (item.sender.includes("@")) {
    return item.sender.trim();
  }
  const bodyEmail = item.body.match(
    /\b([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})\b/,
  );
  return bodyEmail ? bodyEmail[1] : null;
}

function buildParentContact(
  item: InboxItem,
  text: string,
  phone: string | null,
  email: string | null,
): string | null {
  let parentName = extractParentName(text);
  if (!parentName) {
    parentName = parentNameFromSender(item);
  }

  const parts: string[] = [];
  if (parentName) parts.push(parentName);
  if (phone) parts.push(phone);
  if (email && (!parentName || !parentName.includes(email))) parts.push(email);
  return parts.length > 0 ? parts.join(", ") : null;
}

function extractParentName(text: string): string | null {
  // "Parent: <Name>" — fax referral style
  const parentLine = text.match(/Parent(?:\/guardian)?\s*:?\s*([^\n]+)/i);
  if (parentLine) {
    const candidate = parentLine[1].split(",")[0].trim().replace(/[.\s]+$/, "");
    if (candidate && !/\[\s*blank\s*\]/i.test(candidate) && candidate.toLowerCase() !== "blank") {
      return candidate;
    }
  }
  // "I am his parent, <Name>"
  const iAm = text.match(
    /I\s+am\s+(?:his|her|their)\s+(?:parent|guardian|mother|father|mom|dad),?\s+([A-Z][A-Za-z'\-]+(?:\s+[A-Z][A-Za-z'\-]+){0,2})/,
  );
  if (iAm) return iAm[1].trim();
  // "this is <Name>"
  const thisIs = text.match(/\bthis\s+is\s+([A-Z][A-Za-z'\-]+(?:\s+[A-Z][A-Za-z'\-]+){0,2})/);
  if (thisIs) return thisIs[1].trim();
  // Spanish: "soy <Name>"
  const soy = text.match(/\bsoy\s+([A-Z][A-Za-z'\-]+(?:\s+[A-Z][A-Za-z'\-]+){0,2})/);
  if (soy) return soy[1].trim();
  return null;
}

function parentNameFromSender(item: InboxItem): string | null {
  // "Anita Patel <anita.patel@example.com>" → "Anita Patel"
  const angle = item.sender.match(/^(.*?)\s*</);
  if (angle) {
    const candidate = angle[1].trim();
    if (looksLikePersonName(candidate)) return candidate;
  }
  // "Maria Gomez voicemail" / "Jordan Kim via parent portal"
  if (
    item.channel === "voicemail_transcript" ||
    item.channel === "portal_message" ||
    item.channel === "email"
  ) {
    const stripped = item.sender
      .replace(/\s+voicemail$/i, "")
      .replace(/\s+via\s+.*$/i, "")
      .replace(/\s+fax$/i, "")
      .trim();
    if (looksLikePersonName(stripped)) return stripped;
  }
  return null;
}

function looksLikePersonName(value: string): boolean {
  // Two or more capitalized tokens, no @ or angle brackets, not a generic
  // office or pediatrician label.
  if (!value || value.includes("@") || /[<>]/.test(value)) return false;
  if (/pediatric|clinic|office|fax|hospital/i.test(value)) return false;
  const tokens = value.split(/\s+/);
  if (tokens.length < 2) return false;
  return tokens.every((tok) => /^[A-Z][A-Za-z'\-]+\.?$/.test(tok));
}

function extractDisciplines(text: string): Discipline[] | null {
  const hits = new Set<Discipline>();
  for (const { pattern, discipline } of DISCIPLINE_KEYWORDS) {
    if (pattern.test(text)) {
      hits.add(discipline);
    }
  }
  if (hits.size === 0) {
    return null;
  }
  return [...hits];
}

function extractConcern(text: string): string | null {
  // "Concern: ..." or "Diagnosis/concern: ..."
  const concernField = text.match(
    /(?:Diagnosis(?:\/concern)?|Concern)\s*:\s*([^\n]+)/i,
  );
  if (concernField) {
    const value = concernField[1].split(/\.\s/)[0].trim();
    if (value && !/\[\s*blank\s*\]/i.test(value)) {
      return value;
    }
  }
  // Pattern: "looking for a PT evaluation for <concern>"
  const lookingFor = text.match(
    /(?:looking\s+for|requesting)\s+an?\s+\w+\s+evaluation\s+for\s+([^.\n]+)/i,
  );
  if (lookingFor) {
    return lookingFor[1].trim();
  }
  // "for toe walking and frequent tripping"
  const forConcern = text.match(/\bfor\s+([a-z][^.\n]{5,80})/);
  if (forConcern && /\b(walking|delay|tolerance|processing|articulation|gait|sensory|feeding)\b/i.test(forConcern[1])) {
    return forConcern[1].trim();
  }
  // Portal/voicemail clinical question
  const cantSay = text.match(/can'?t\s+say\s+([^.?\n]+)/i);
  if (cantSay) {
    return `concern about ${cantSay[1].trim()}`;
  }
  return null;
}

function extractPayer(text: string): string | null {
  for (const { pattern } of PAYER_PATTERNS) {
    const match = text.match(pattern);
    if (match) {
      return cleanPayerString(match[0]);
    }
  }
  // "Insurance: <payer>" generic — capture up to period/comma/newline
  const insuranceField = text.match(/Insurance(?:\s+is)?\s*:?\s*([^.\n]+?)(?=,\s*member|,\s*Member|\.|\n)/i);
  if (insuranceField) {
    const value = insuranceField[1].trim();
    if (value && !/\[\s*blank\s*\]/i.test(value)) {
      return cleanPayerString(value);
    }
  }
  return null;
}

function cleanPayerString(raw: string): string {
  return raw
    .replace(/^\W+/, "")
    .replace(/[.,]+$/, "")
    .replace(/\s+/g, " ")
    .trim();
}

function extractMemberId(text: string): string | null {
  const memberField = text.match(/Member\s*ID\s*:?\s*([A-Z0-9\-]+)/i);
  if (memberField && !/blank/i.test(memberField[1])) {
    return memberField[1].trim();
  }
  const memberSpanish = text.match(/\bmiembro\s+([A-Z0-9\-]+)/i);
  if (memberSpanish) {
    return memberSpanish[1].trim();
  }
  const memberIdInline = text.match(/\bmember\s+id\s+([A-Z0-9\-]+)/i);
  if (memberIdInline) {
    return memberIdInline[1].trim();
  }
  return null;
}

function extractPreferences(text: string): string | null {
  const preferred = text.match(
    /\b(?:preferred?\s+availability|prefer|prefers|preference|family\s+prefers)\s*:?\s*([^.\n]+)/i,
  );
  if (preferred) {
    return preferred[1].trim();
  }
  const spanishPref = text.match(/\bprefiero\s+([^.\n]+)/i);
  if (spanishPref) {
    return spanishPref[1].trim();
  }
  return null;
}

function computeMissingInfo(intake: ExtractedIntake): string[] {
  const missing: string[] = [];
  if (!intake.child_name) missing.push("child_name");
  if (!intake.dob_or_age) missing.push("dob_or_age");
  if (!intake.parent_contact) missing.push("parent_contact");
  if (!intake.discipline || intake.discipline.length === 0)
    missing.push("discipline");
  if (!intake.diagnosis_or_concern) missing.push("diagnosis_or_concern");
  if (!intake.payer) missing.push("payer");
  if (!intake.member_id) missing.push("member_id");
  return missing;
}

function countMatches(text: string, pattern: RegExp): number {
  return (text.match(pattern) || []).length;
}
