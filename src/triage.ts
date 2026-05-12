import type { Classification, Urgency } from "./types.js";
import type { ExtractionResult } from "./extract.js";

export interface TriageDecision {
  classification: Classification;
  urgency: Urgency;
}

export function triage(extraction: ExtractionResult): TriageDecision {
  const { signals, intake } = extraction;

  // Safety first: any safeguarding signal is P0, regardless of any other intent
  // the writer may also have expressed.
  if (signals.safeguarding.hit) {
    return { classification: "safeguarding", urgency: "P0" };
  }

  // Same-day cancellation / reschedule is a P1 operational issue per policy.
  if (signals.isSameDayCancellation) {
    return { classification: "scheduling", urgency: "P1" };
  }

  // A pure clinical question (no booking intent) routes to clinician review,
  // never to scheduling, never to advice over message.
  if (signals.isClinicalQuestionOnly) {
    return { classification: "clinical_question", urgency: "P2" };
  }

  // A referral document with the bulk of fields blank is a paperwork problem,
  // not yet a triage decision.
  if (signals.isMissingPaperwork) {
    return { classification: "missing_paperwork", urgency: "P2" };
  }

  // Default for a referral or evaluation request.
  const looksLikeReferral =
    !!intake.discipline ||
    !!intake.diagnosis_or_concern ||
    !!intake.payer ||
    !!intake.member_id;
  if (looksLikeReferral) {
    return { classification: "new_referral", urgency: "P2" };
  }

  return { classification: "other", urgency: "P2" };
}
