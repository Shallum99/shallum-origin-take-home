/**
 * Deterministic safeguarding pre-filter — bilingual (EN + ES).
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
 * Pattern coverage is structured around the PedHITSS clinical screening
 * tool's five domains plus self-harm and explicit "unsafe at home"
 * disclosures. Spanish patterns are added because the inbox population
 * is known to include Spanish-speaking families and a safety floor that
 * only catches English is a safety floor for half the population.
 *
 * The patterns are narrow. We index on language that describes a
 * caregiver's conduct or the child's stated fear, not on generic
 * emotional words. False positives cost a clinical-lead review; false
 * negatives can fail a child. We accept the cost asymmetry.
 */

export type SafeguardingCategory =
  | "physical_harm"
  | "verbal_insults"
  | "threats"
  | "yelling"
  | "sexual_abuse"
  | "fear_of_caregiver"
  | "unsafe_at_home"
  | "self_harm";

export interface SafeguardingHit {
  hit: boolean;
  matchedPhrase: string | null;
  category: SafeguardingCategory | null;
  language: "en" | "es" | null;
}

interface CategoryPatterns {
  category: SafeguardingCategory;
  language: "en" | "es";
  patterns: RegExp[];
}

// ---------------------------------------------------------------------------
// English patterns, organised by PedHITSS-derived clinical category.
// ---------------------------------------------------------------------------

// Pattern order matters. The detector returns on the first match, so more
// SPECIFIC categories (threats, sexual_abuse, self_harm) are checked BEFORE
// physical_harm — otherwise "said he'd hurt her" routes to physical_harm
// when threats is the precise label.
const EN: CategoryPatterns[] = [
  {
    category: "threats",
    language: "en",
    patterns: [
      /\b(threaten(?:ed|s|ing)?|said\s+(?:he|she|they)'?d)\s+(?:to\s+)?(hurt|hit|kill|beat|leave|send\s+away|kick\s+out)\b/i,
      /\bthreaten(?:ed|s|ing)?\s+(him|her|the\s+(child|kid|family))\b/i,
      /\b(told|tells|said\s+to)\s+(him|her|the\s+(child|kid))\s+(?:he|she|they)'?(?:s|ll)\s+(hurt|kill|beat)\b/i,
      /\bif\s+you\s+don'?t\s+\w+\s+i'?ll\s+(hurt|hit|kill|beat)\b/i,
    ],
  },
  {
    category: "sexual_abuse",
    language: "en",
    patterns: [
      /\bmolest(?:ed|ing|ation)?\b/i,
      /\b(touch|touched|touching|touches)\s+(him|her)\s+(?:in\s+a\s+)?(?:bad|wrong|weird|inappropriate)\s+(?:way|place)\b/i,
      /\binappropriate(?:ly)?\s+touch(?:ed|ing)?\b/i,
      /\b(inappropriate|sexual)\s+contact\b/i,
      /\bsexually?\s+(abus(?:ed|ing|e)|assault(?:ed|ing)?)\b/i,
    ],
  },
  {
    category: "self_harm",
    language: "en",
    patterns: [
      /\b(self[\s-]?harm|self[\s-]?harming|suicid(e|al))\b/i,
      /\bhurt\s+(himself|herself|themselves|themself)\b/i,
      /\b(wants?|wanted|trying)\s+to\s+hurt\s+(himself|herself|themselves|themself)\b/i,
      /\b(thoughts|thinking)\s+of\s+(killing|hurting)\s+(himself|herself|themselves)\b/i,
    ],
  },
  {
    category: "physical_harm",
    language: "en",
    patterns: [
      /\babus(e|ive|ing|ed)\b/i,
      /\bneglect(ed|ing|ful)?\b/i,
      /\b(getting|been|gets|got|is|was)\s+rough\b/i,
      /\brough\s+with\s+(him|her|them|the\s+(child|kid|baby|boy|girl))\b/i,
      /\b(hit|hits|hitting|hurt|hurts|hurting)\s+(him|her|me|the\s+(child|kid|baby|boy|girl))\b/i,
      /\b(getting|gets|got|been|being|is\s+being)\s+(hit|hurt|beat(?:en)?|slapped|punched|kicked|smacked|spanked|whipped)\b/i,
      /\b(dad|daddy|mom|mommy|father|mother|stepfather|stepmother|grandpa|grandma|stepdad|stepmom)\s+(hits?|hurts?|beats?|slaps?|punches?|kicks?|whips?|spanks?)\b/i,
      /\b(beat|beats|beaten|beating|whipped|whipping)\s+(him|her|me|the\s+(child|kid|baby|boy|girl))\b/i,
      /\b(slap|slapped|slapping|punch|punched|punching|kick|kicked|kicking|smack|smacked|smacking)\s+(him|her|me|the\s+(child|kid))\b/i,
      /\bbruis(es|ing|ed)\b/i,
      /\bmarks?\s+(?:on|all\s+over)\s+(?:his|her|the)\s+(arms?|legs?|body|back|face)\b/i,
    ],
  },
  {
    category: "verbal_insults",
    language: "en",
    patterns: [
      /\b(dad|daddy|mom|mommy|father|mother|stepfather|stepmother)\s+(calls?|called)\s+(him|her|the\s+(child|kid))\s+(stupid|dumb|worthless|fat|ugly|trash|garbage|useless|retarded)\b/i,
      /\b(calls?|called)\s+(him|her|the\s+(child|kid))\s+(stupid|dumb|worthless|fat|ugly|trash|garbage|useless|retarded|a\s+mistake)\b/i,
      /\bsays?\s+(?:he'?s|she'?s|i'?m)\s+(stupid|worthless|a\s+mistake|garbage|nothing)\b/i,
      /\b(?:degraded|humiliated|belittled)\b/i,
    ],
  },
  {
    category: "yelling",
    language: "en",
    patterns: [
      /\byell(ing|ed|s)?\s+at\s+(him|her|the\s+(child|kid))\b/i,
      /\bscream(ing|ed|s)?\s+at\s+(him|her|the\s+(child|kid))\b/i,
      /\b(dad|daddy|mom|mommy|father|mother|stepfather|stepmother)\s+yell(?:s|ing|ed)\b/i,
    ],
  },
  {
    category: "fear_of_caregiver",
    language: "en",
    patterns: [
      /\b(afraid|scared|terrified|frightened)\s+of\s+(?:(?:his|her|their|the)\s+)?(dad|daddy|mom|mommy|stepfather|stepmother|father|mother|him|her)\b/i,
      /\b(?:doesn'?t|don'?t)\s+want\s+to\s+go\s+home\b/i,
      /\bhides?\s+when\s+(dad|daddy|mom|mommy|father|mother|stepfather|stepmother)\s+(comes?|gets?)\s+home\b/i,
      /\bflinch(?:es|ing|ed)?\s+when\b/i,
    ],
  },
  {
    category: "unsafe_at_home",
    language: "en",
    patterns: [
      /\b(unsafe|not\s+safe|isn'?t\s+safe|wasn'?t\s+safe|aren'?t\s+safe)\s+(at\s+home|in\s+the\s+home|home)\b/i,
      /\bsomething'?s\s+wrong\s+at\s+home\b/i,
      /\bshouldn'?t\s+be\s+alone\s+with\b/i,
      /\b(can'?t|cannot)\s+go\s+(?:back\s+)?home\b/i,
    ],
  },
];

// ---------------------------------------------------------------------------
// Spanish patterns. Vetted against mandated-reporter Spanish-language training
// vocab and common parent-voicemail phrasing.
//
// IMPORTANT: JavaScript's `\b` is ASCII-only — it does not treat accented
// Latin letters (á, é, í, ó, ú, ñ) as word characters. So `\bamenazó\b` will
// fail at runtime when the next character is whitespace, because the engine
// sees "non-word ó" → "non-word space" and refuses the boundary.
//
// We use the `u` (Unicode) flag plus Unicode property escapes for word
// boundaries: `(?<![\p{L}\p{N}])` for start, `(?![\p{L}\p{N}])` for end.
// This treats every Unicode letter — including ó, ñ — as part of a word.
// ---------------------------------------------------------------------------

// Convenience: build a regex with Unicode-aware boundaries.
function es(pattern: string): RegExp {
  return new RegExp(`(?<![\\p{L}\\p{N}])(?:${pattern})(?![\\p{L}\\p{N}])`, "iu");
}

const ES: CategoryPatterns[] = [
  {
    category: "threats",
    language: "es",
    patterns: [
      es("amenaz(?:a|as|ó|ado|ada|ando|aron)"),
      es("dijo\\s+que\\s+(?:lo|la|le)\\s+(?:va\\s+a\\s+|iba\\s+a\\s+)?(?:matar|pegar|golpear|lastimar)"),
    ],
  },
  {
    category: "sexual_abuse",
    language: "es",
    patterns: [
      es("abuso\\s+sexual"),
      es("(?:la|lo|le)\\s+toca\\s+(?:mal|inapropiad(?:amente|o)|en\\s+partes\\s+privadas)"),
      es("(?:toca|tocó|tocaba)\\s+(?:de\\s+manera\\s+)?inapropiad(?:o|amente)"),
    ],
  },
  {
    category: "self_harm",
    language: "es",
    patterns: [
      es("suicid(?:io|a|arse)"),
      es("autolesi(?:ón|on)"),
      es("hacerse\\s+daño"),
      es("lastimarse"),
      es("quiere\\s+(?:hacerse\\s+daño|lastimarse|morir)"),
    ],
  },
  {
    category: "physical_harm",
    language: "es",
    patterns: [
      es("abus(?:o|os|a|ar|ando|ado|ada)"),
      es("maltrato|maltratar|maltratando|maltratada|maltratado"),
      es("negligenc(?:ia|ias)"),
      es("(?:le\\s+pega|le\\s+pegan|me\\s+pega|le\\s+pegó|le\\s+pegaba)"),
      es("(?:le\\s+golpea|le\\s+golpeó|le\\s+golpean)"),
      es("(?:le\\s+lastima|le\\s+lastimó|le\\s+lastiman)"),
      es("(?:papá|papa|mamá|mama|padre|madre|padrastro|madrastra)\\s+(?:le\\s+pega|le\\s+pegó|le\\s+golpea|lo\\s+golpea|la\\s+golpea)"),
      es("moreton(?:es)?"),
      es("morado(?:s)?"),
    ],
  },
  {
    category: "verbal_insults",
    language: "es",
    patterns: [
      es("(?:le\\s+dice|le\\s+dicen|me\\s+dice)\\s+(?:estúpido|estupido|tonto|inútil|inutil|basura|gorda|fea|feo)"),
      es("insulta|insultando|insultó|insultos"),
      es("humilla|humillado|humillada|humillación|humillacion"),
    ],
  },
  {
    category: "yelling",
    language: "es",
    patterns: [
      es("(?:le\\s+grita|le\\s+gritan|le\\s+gritó|le\\s+gritaba)"),
      es("(?:papá|papa|mamá|mama|padre|madre|padrastro|madrastra)\\s+(?:le|me)\\s+grita"),
    ],
  },
  {
    category: "fear_of_caregiver",
    language: "es",
    patterns: [
      es("(?:le\\s+)?tiene\\s+miedo\\s+(?:de|al?)\\s+(?:su\\s+)?(?:papá|papa|mamá|mama|padre|madre|padrastro|madrastra)"),
      es("no\\s+quiere\\s+(?:ir|regresar|volver)\\s+a\\s+casa"),
      es("se\\s+esconde\\s+cuando\\s+(?:papá|papa|mamá|mama|padre|madre|padrastro)\\s+(?:llega|viene)"),
    ],
  },
  {
    category: "unsafe_at_home",
    language: "es",
    patterns: [
      es("no\\s+(?:es|está|esta)\\s+seguro\\s+en\\s+casa"),
      es("no\\s+(?:es|está|esta)\\s+segura\\s+en\\s+casa"),
      es("algo\\s+(?:malo|mal)\\s+(?:está\\s+|esta\\s+)?pasando\\s+en\\s+(?:la\\s+)?casa"),
    ],
  },
];

const ALL_CATEGORIES: CategoryPatterns[] = [...EN, ...ES];

export function detectSafeguarding(text: string): SafeguardingHit {
  for (const group of ALL_CATEGORIES) {
    for (const pattern of group.patterns) {
      const match = text.match(pattern);
      if (match) {
        return {
          hit: true,
          matchedPhrase: match[0],
          category: group.category,
          language: group.language,
        };
      }
    }
  }
  return { hit: false, matchedPhrase: null, category: null, language: null };
}
