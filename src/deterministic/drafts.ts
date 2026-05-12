/**
 * Draft templates. Pure functions: no side effects, no clinical advice, no
 * language that implies a message has already been sent. Reviewers see
 * exactly what staff would send if approved.
 *
 * Two hard rules baked into these templates:
 *   1. Never confirm or comment on a safeguarding disclosure — keep the draft
 *      neutral so a parent who might be a risk to the child is not tipped off.
 *   2. Never give clinical advice. Acknowledge the question, route to a
 *      screening or evaluation.
 */

interface DraftContext {
  parentFirstName: string | null;
  childFirstName: string | null;
}

function firstName(value: string | null): string {
  if (!value) return "";
  return value.split(/\s+/)[0];
}

function nameOrFallback(value: string | null, fallback: string): string {
  return firstName(value) || fallback;
}

export function draftInNetworkConfirmation(ctx: DraftContext): string {
  const parent = nameOrFallback(ctx.parentFirstName, "there");
  const child = nameOrFallback(ctx.childFirstName, "your child");
  return [
    `Hi ${parent},`,
    "",
    `Thank you for sending ${child}'s referral. Our billing team confirmed your insurance is in network with Cedar Kids Therapy, so we are well-positioned to move forward.`,
    "",
    "A coordinator will reach out within one business day to walk you through next steps and confirm an evaluation time that fits your schedule. If you have any questions in the meantime, please reply to this message.",
    "",
    "Warmly,",
    "Cedar Kids Therapy intake team",
  ].join("\n");
}

export function draftOutOfNetworkBenefits(ctx: DraftContext, payer: string): string {
  const parent = nameOrFallback(ctx.parentFirstName, "there");
  const child = nameOrFallback(ctx.childFirstName, "your child");
  return [
    `Hi ${parent},`,
    "",
    `Thank you for sending ${child}'s referral. When our billing team checked coverage with ${payer}, it came back as out of network for Cedar Kids Therapy. Before we hold an evaluation time, we want to walk through your benefits and any out-of-pocket costs with you.`,
    "",
    "A billing coordinator will reach out within one business day to go over options. If you have a secondary payer or have already received out-of-network authorization, please let us know and we can include that in the review.",
    "",
    "Warmly,",
    "Cedar Kids Therapy billing team",
  ].join("\n");
}

export function draftExpiredCoverage(ctx: DraftContext, payer: string): string {
  const parent = nameOrFallback(ctx.parentFirstName, "there");
  const child = nameOrFallback(ctx.childFirstName, "your child");
  return [
    `Hi ${parent},`,
    "",
    `Thank you for ${child}'s referral. When our billing team checked the ${payer} coverage on the referral, our system shows the plan as no longer active. The referral document may simply be out of date.`,
    "",
    "A coordinator will reach out within one business day to confirm current coverage with you so we can move forward with scheduling.",
    "",
    "Warmly,",
    "Cedar Kids Therapy billing team",
  ].join("\n");
}

export function draftUnknownPayer(ctx: DraftContext, payer: string | null): string {
  const parent = nameOrFallback(ctx.parentFirstName, "there");
  const child = nameOrFallback(ctx.childFirstName, "your child");
  const payerClause = payer
    ? `we were not able to verify ${payer} in our billing system`
    : "we did not have enough payer information to verify coverage";
  return [
    `Hi ${parent},`,
    "",
    `Thank you for sending ${child}'s referral. Before we move forward, ${payerClause}. A coordinator will reach out within one business day to confirm your insurance details with you.`,
    "",
    "Warmly,",
    "Cedar Kids Therapy intake team",
  ].join("\n");
}

export function draftClinicalQuestionAcknowledgement(
  ctx: DraftContext,
): string {
  const parent = nameOrFallback(ctx.parentFirstName, "there");
  const child = nameOrFallback(ctx.childFirstName, "your child");
  return [
    `Hi ${parent},`,
    "",
    `Thanks for reaching out about ${child}. We are not able to give clinical advice over message, but a brief speech-language screening with one of our SLPs is exactly the right next step for a question like this. The screening helps the clinician answer whether anything is outside the typical range and what, if anything, would be helpful next.`,
    "",
    "If you would like, reply to this message and a coordinator will get a screening on the calendar for you. There is no obligation to continue beyond the screening.",
    "",
    "Warmly,",
    "Cedar Kids Therapy intake team",
  ].join("\n");
}

/**
 * Safeguarding draft. Intentionally neutral. Does not reference the
 * disclosure, does not respond to the underlying request (e.g. speech eval),
 * and does not commit to a clinical pathway — those decisions sit with the
 * clinical lead who will review the escalation.
 */
export function draftSafeguardingNeutral(ctx: DraftContext): string {
  const parent = nameOrFallback(ctx.parentFirstName, "there");
  const child = nameOrFallback(ctx.childFirstName, "your child");
  return [
    `Hi ${parent},`,
    "",
    `Thank you for reaching out about ${child}. We received your message and a member of our team will be in touch with you directly to talk through next steps.`,
    "",
    "Warmly,",
    "Cedar Kids Therapy",
  ].join("\n");
}

export function draftReferringOfficeFollowup(
  childName: string | null,
  referringProvider: string | null,
): string {
  const child = childName || "the patient on the referral";
  const office = referringProvider
    ? `${referringProvider}'s office`
    : "the referring pediatrician's office";
  return [
    `Hello,`,
    "",
    `We received a fax referral for ${child} but several intake fields were left blank, including date of birth, parent or guardian contact, and insurance information. Before we can schedule an evaluation we need a completed referral.`,
    "",
    `Could ${office} send over an updated referral with the missing fields filled in? Happy to receive it via secure fax or your usual referral pathway. If easier, please call our intake line back at your convenience.`,
    "",
    "Thanks for partnering with us on this patient,",
    "Cedar Kids Therapy intake team",
  ].join("\n");
}

export function draftSpanishConfirmation(ctx: DraftContext): string {
  const parent = nameOrFallback(ctx.parentFirstName, "Hola");
  const child = nameOrFallback(ctx.childFirstName, "su hijo/a");
  return [
    `Hola ${parent},`,
    "",
    `Gracias por llamar acerca de ${child}. Hemos confirmado que su seguro Medicaid está activo y dentro de la red con Cedar Kids Therapy. Una coordinadora bilingüe le devolverá la llamada dentro de un día hábil para coordinar una hora de evaluación con un terapeuta del habla que habla español.`,
    "",
    "Si tiene alguna preferencia de horario o alguna pregunta antes de eso, no dude en dejarnos otro mensaje.",
    "",
    "Atentamente,",
    "Equipo de admisión, Cedar Kids Therapy",
  ].join("\n");
}

export function draftSameDayCancellationAck(ctx: DraftContext): string {
  const parent = nameOrFallback(ctx.parentFirstName, "there");
  const child = nameOrFallback(ctx.childFirstName, "your child");
  return [
    `Hi ${parent},`,
    "",
    `Thanks for letting us know about ${child} today, and we hope they feel better soon. We have your today's appointment marked as a same-day cancellation; no charge for illness.`,
    "",
    "Our front desk will reach out shortly to find a make-up time that works for you. If you would like to share any preferred days or times, feel free to reply here.",
    "",
    "Warmly,",
    "Cedar Kids Therapy front desk",
  ].join("\n");
}
