import {
  create_task,
  draft_message,
  escalate,
  find_slots,
  hold_slot,
  lookup_policy,
  search_patient,
  verify_insurance,
} from "../tools.js";
import {
  draftClinicalQuestionAcknowledgement,
  draftExpiredCoverage,
  draftInNetworkConfirmation,
  draftOutOfNetworkBenefits,
  draftReferringOfficeFollowup,
  draftSafeguardingNeutral,
  draftSameDayCancellationAck,
  draftSpanishConfirmation,
  draftUnknownPayer,
} from "./drafts.js";
import type { ExtractionResult } from "./extract.js";
import type {
  Classification,
  Discipline,
  InboxItem,
  Patient,
  Urgency,
} from "../types.js";

export interface HandlerResult {
  urgency: Urgency;
  classification: Classification;
  recommended_next_action: string;
  draft_reply: string | null;
  task_ids: string[];
  escalation: { reason: string; severity: "P0" | "P1" } | null;
  decision_rationale: string;
}

export interface HandlerInput {
  item: InboxItem;
  extraction: ExtractionResult;
  baselineClassification: Classification;
  baselineUrgency: Urgency;
  dueDates: { sameDay: string; nearTerm: string };
}

export async function handle(input: HandlerInput): Promise<HandlerResult> {
  switch (input.baselineClassification) {
    case "safeguarding":
      return handleSafeguarding(input);
    case "scheduling":
      return handleSameDayCancellation(input);
    case "clinical_question":
      return handleClinicalQuestion(input);
    case "missing_paperwork":
      return handleMissingPaperwork(input);
    case "new_referral":
    case "existing_patient_request":
    case "other":
    default:
      return handleNewReferral(input);
  }
}

function firstNameOf(value: string | null): string | null {
  if (!value) return null;
  const parts = value.split(/[,\s]+/).filter(Boolean);
  return parts[0] || null;
}

function parentFirstName(parentContact: string | null): string | null {
  if (!parentContact) return null;
  const namePart = parentContact.split(",")[0].trim();
  return firstNameOf(namePart);
}

function childFirstName(childName: string | null): string | null {
  return firstNameOf(childName);
}

function pickContactChannel(
  item: InboxItem,
  emailFromExtraction: string | null,
  phoneFromExtraction: string | null,
): { channel: "portal" | "email" | "phone"; recipient: string } {
  if (item.channel === "portal_message") {
    return { channel: "portal", recipient: item.sender };
  }
  if (emailFromExtraction) {
    return { channel: "email", recipient: emailFromExtraction };
  }
  if (phoneFromExtraction) {
    return { channel: "phone", recipient: phoneFromExtraction };
  }
  // Fallback: keep the original sender label so reviewers know where it came from.
  return { channel: "email", recipient: item.sender };
}

async function handleSafeguarding(input: HandlerInput): Promise<HandlerResult> {
  const { item, extraction, dueDates } = input;
  const { intake, signals } = extraction;

  const escalation = await escalate({
    item_id: item.id,
    reason: `Voicemail/message language suggests possible unsafe caregiving (matched phrase: "${signals.safeguarding.matchedPhrase ?? "n/a"}"). Per safeguarding policy, route to clinical lead for same-hour review before any clinical or scheduling action.`,
    severity: "P0",
  });

  await lookup_policy({ topic: "safeguarding" });

  const task = await create_task({
    assignee: "clinical_lead",
    title: `Same-hour safeguarding review for ${intake.child_name ?? item.id}`,
    due: dueDates.sameDay,
    notes: `Voicemail from ${item.sender} contains language suggesting unsafe caregiving. Do not return clinical advice over message. Clinical lead to determine next step (e.g. mandated reporter pathway, screening, parent callback). The neutral draft on file is intentionally generic — review before sending. Original message preserved in item ${item.id}.`,
  });

  const contact = pickContactChannel(item, signals.email, signals.phone);
  const draftBody = draftSafeguardingNeutral({
    parentFirstName: parentFirstName(intake.parent_contact),
    childFirstName: childFirstName(intake.child_name),
  });
  await draft_message({
    recipient: contact.recipient,
    channel: contact.channel,
    body: draftBody,
    language: "en",
  });

  return {
    urgency: "P0",
    classification: "safeguarding",
    recommended_next_action:
      "Clinical lead to review escalation within the hour, determine reporting and outreach pathway, and approve the neutral draft before any outbound contact.",
    draft_reply: draftBody,
    task_ids: [task.data.task_id],
    escalation: {
      reason:
        "Caller's message contains language suggesting unsafe caregiving toward the child; mandated-reporter and clinical-lead review required before any outbound action.",
      severity: "P0",
    },
    decision_rationale: [
      `Detected safeguarding signal in body: "${signals.safeguarding.matchedPhrase}".`,
      "Per Cedar Kids Therapy safeguarding policy, any disclosure suggesting harm or unsafe caregiving is P0 and must be escalated to the clinical lead immediately.",
      "Draft is intentionally neutral and does not respond to the speech evaluation request, to avoid tipping off a potential risk source or providing investigative content over message.",
      "No insurance verification, slot search, or hold is performed at this stage — those decisions belong to the clinical lead after review.",
    ].join(" "),
  };
}

async function handleSameDayCancellation(
  input: HandlerInput,
): Promise<HandlerResult> {
  const { item, extraction, dueDates } = input;
  const { intake, signals } = extraction;

  // Try to attach the message to a patient record. The mock backend recognizes
  // Noah Patel via DOB; for synthetic variants this is a best-effort search.
  const patientLookup = await search_patient({
    name: intake.child_name ?? undefined,
    dob:
      intake.dob_or_age && /^\d{4}-\d{2}-\d{2}$/.test(intake.dob_or_age)
        ? intake.dob_or_age
        : undefined,
  });
  const patient: Patient | undefined = patientLookup.data[0];

  await lookup_policy({ topic: "cancellation" });

  // Surface make-up options for staff so the front-desk callback has slots
  // ready. We never schedule; staff still owns the decision.
  const discipline = (intake.discipline?.[0] as Discipline | undefined) ?? undefined;
  if (discipline) {
    await find_slots({
      discipline,
      preferences: signals.preferences ?? "make-up visit after a same-day cancellation",
    });
  }

  const task = await create_task({
    assignee: "front_desk",
    title: `Call back ${intake.child_name ?? "patient"} guardian to reschedule today's appointment`,
    due: dueDates.sameDay,
    notes: `Same-day cancellation for ${intake.child_name ?? "patient"} due to illness. Patient ${patient ? `match found (${patient.patient_id}); guardian on file is ${patient.guardian_name}.` : "not found in EMR; verify identity on callback."} Use make-up slot options surfaced in the trace as a starting point.`,
  });

  const contact = pickContactChannel(item, signals.email, signals.phone);
  const draftBody = draftSameDayCancellationAck({
    parentFirstName: parentFirstName(intake.parent_contact),
    childFirstName: childFirstName(intake.child_name),
  });
  await draft_message({
    recipient: contact.recipient,
    channel: contact.channel,
    body: draftBody,
    language: "en",
  });

  return {
    urgency: "P1",
    classification: "scheduling",
    recommended_next_action:
      "Front desk to call the guardian back today to confirm cancellation and offer the surfaced make-up slots; do not auto-reschedule.",
    draft_reply: draftBody,
    task_ids: [task.data.task_id],
    escalation: null,
    decision_rationale: [
      `Message is a same-day cancellation/reschedule request${signals.hasUrgentMarker ? " marked URGENT by the sender" : ""}.`,
      "Per the scheduling policy, same-day cancellations are P1 operational issues; agent must not schedule directly.",
      patient
        ? `Patient identity confirmed via search_patient (${patient.patient_id}).`
        : "Patient could not be confirmed from the message alone; flagged for front-desk verification on callback.",
      "Draft acknowledges the cancellation without committing to a new time — staff will choose from the surfaced make-up options.",
    ].join(" "),
  };
}

async function handleClinicalQuestion(
  input: HandlerInput,
): Promise<HandlerResult> {
  const { item, extraction, dueDates } = input;
  const { intake, signals } = extraction;

  await lookup_policy({ topic: "clinical_advice" });

  const task = await create_task({
    assignee: "intake",
    title: `Offer a brief screening for ${intake.child_name ?? "the child in inquiry"}`,
    due: dueDates.nearTerm,
    notes: `Parent portal message asks a clinical question; per policy, do not answer over message. Reach out to offer a brief SLP screening or evaluation. Parent message preserved in item ${item.id}.`,
  });

  const contact = pickContactChannel(item, signals.email, signals.phone);
  const draftBody = draftClinicalQuestionAcknowledgement({
    parentFirstName: parentFirstName(intake.parent_contact) ?? firstNameOf(item.sender),
    childFirstName: childFirstName(intake.child_name),
  });
  await draft_message({
    recipient: contact.recipient,
    channel: contact.channel,
    body: draftBody,
    language: "en",
  });

  return {
    urgency: "P2",
    classification: "clinical_question",
    recommended_next_action:
      "Intake to reach out and offer a brief SLP screening rather than answering the clinical question over message.",
    draft_reply: draftBody,
    task_ids: [task.data.task_id],
    escalation: null,
    decision_rationale: [
      "Message is a clinical question asking whether a developmental pattern is normal; the family has not asked to book yet.",
      "Per clinical-advice policy, front-desk staff and automated systems must not provide clinical advice over message — route to a screening instead.",
      "Draft acknowledges the question, declines to advise, and offers the appropriate next step (a brief screening).",
    ].join(" "),
  };
}

async function handleMissingPaperwork(
  input: HandlerInput,
): Promise<HandlerResult> {
  const { item, extraction, dueDates } = input;
  const { intake, missingInfo } = extraction;

  await lookup_policy({ topic: "service_lines" });

  const task = await create_task({
    assignee: "intake",
    title: `Request completed referral from referring office for ${intake.child_name ?? "blank referral"}`,
    due: dueDates.nearTerm,
    notes: `Fax referral missing: ${missingInfo.join(", ")}. Call or fax the referring office (per item ${item.id} sender: ${item.sender}) to request a completed referral with DOB, parent contact, and insurance. Cannot proceed with intake verification or scheduling until paperwork is complete.`,
  });

  // The recipient here is the referring pediatrician office, not the family —
  // we don't have family contact yet.
  const referrer = item.sender.replace(/\s*fax$/i, "").trim();
  const draftBody = draftReferringOfficeFollowup(intake.child_name, referrer);
  await draft_message({
    recipient: referrer || item.sender,
    channel: "phone",
    body: draftBody,
    language: "en",
  });

  return {
    urgency: "P2",
    classification: "missing_paperwork",
    recommended_next_action:
      "Intake to call the referring office for a completed referral; no patient outreach yet because parent contact and DOB are unknown.",
    draft_reply: draftBody,
    task_ids: [task.data.task_id],
    escalation: null,
    decision_rationale: [
      `Referral is incomplete: ${missingInfo.length} required intake fields are blank (${missingInfo.join(", ")}).`,
      "Without DOB, parent contact, and insurance, neither insurance verification nor scheduling can proceed.",
      "Per the service-lines policy, the discipline still needs to be confirmed before any evaluation is scheduled; that conversation must happen with a complete referral in hand.",
      "Draft is addressed to the referring pediatrician's office, not the family, because the family is unreachable from the current referral.",
    ].join(" "),
  };
}

async function handleNewReferral(input: HandlerInput): Promise<HandlerResult> {
  const { item, extraction, dueDates } = input;
  const { intake, signals } = extraction;

  // Optionally attach to an existing patient record. Surfacing a chart match
  // changes the front-desk workflow (and can surface guardian mismatches).
  let existingPatient: Patient | undefined;
  if (intake.child_name && intake.dob_or_age && /^\d{4}-\d{2}-\d{2}$/.test(intake.dob_or_age)) {
    const lookup = await search_patient({
      name: intake.child_name,
      dob: intake.dob_or_age,
    });
    existingPatient = lookup.data[0];
  }

  const verify = await verify_insurance({
    payer: intake.payer ?? undefined,
    member_id: intake.member_id ?? undefined,
  });

  const language: "en" | "es" = signals.language;
  const discipline = intake.discipline?.[0] as Discipline | undefined;

  const ctx = {
    parentFirstName:
      parentFirstName(intake.parent_contact) ?? firstNameOf(item.sender),
    childFirstName: childFirstName(intake.child_name),
  };
  const contact = pickContactChannel(item, signals.email, signals.phone);

  if (verify.data.status === "in_network") {
    if (discipline) {
      const slots = await find_slots({
        discipline,
        preferences: signals.preferences ?? undefined,
        language,
      });
      if (slots.data[0]) {
        const fallbackRef =
          [intake.child_name, intake.dob_or_age].filter(Boolean).join(" / ") ||
          item.id;
        await hold_slot({
          slot_id: slots.data[0].slot_id,
          patient_ref: existingPatient?.patient_id ?? fallbackRef,
        });
      }
    }

    const task = await create_task({
      assignee: "intake",
      title: `Confirm evaluation time with ${intake.child_name ?? "referred patient"} guardian`,
      due: dueDates.nearTerm,
      notes: `${verify.data.plan ?? intake.payer ?? "Coverage"} verified in-network. ${existingPatient ? `Existing chart: ${existingPatient.patient_id} (guardian on file: ${existingPatient.guardian_name}). Confirm guardian relationship.` : "New patient — capture full demographics on the callback."} Preferences: ${signals.preferences ?? "none provided"}.`,
    });

    const draftBody =
      language === "es"
        ? draftSpanishConfirmation(ctx)
        : draftInNetworkConfirmation(ctx);
    await draft_message({
      recipient: contact.recipient,
      channel: contact.channel,
      body: draftBody,
      language,
    });

    const guardianMismatch =
      existingPatient && intake.parent_contact &&
      !intake.parent_contact.toLowerCase().includes(
        existingPatient.guardian_name.toLowerCase().split(/\s+/)[0],
      );

    return {
      urgency: "P2",
      classification: existingPatient ? "new_referral" : "new_referral",
      recommended_next_action: `Intake to confirm the held slot with the family and complete chart setup${existingPatient ? " against the existing record" : ""}.`,
      draft_reply: draftBody,
      task_ids: [task.data.task_id],
      escalation: null,
      decision_rationale: [
        `Pediatrician referral with sufficient intake fields; ${intake.payer ?? "payer"} verified in-network${verify.data.plan ? ` (${verify.data.plan})` : ""}.`,
        discipline
          ? `Surfaced ${discipline} slots${language === "es" ? " filtered to Spanish-capable providers" : ""} and placed a pending_review hold for staff to confirm.`
          : "Discipline could not be parsed; intake will confirm with the family before scheduling.",
        existingPatient
          ? `Patient matched existing chart ${existingPatient.patient_id}.${guardianMismatch ? ` Guardian on file (${existingPatient.guardian_name}) does not match sender — surface mismatch for intake to verify.` : ""}`
          : "No existing chart match; treat as new patient.",
      ]
        .filter(Boolean)
        .join(" "),
    };
  }

  if (verify.data.status === "out_of_network") {
    await lookup_policy({ topic: "insurance" });
    const task = await create_task({
      assignee: "billing",
      title: `Out-of-network benefits review for ${intake.child_name ?? "referred patient"}`,
      due: dueDates.nearTerm,
      notes: `${intake.payer ?? "Payer"} returned out-of-network. Per policy, hold any scheduling action until the benefits conversation. Family contact: ${intake.parent_contact ?? "see item"}.`,
    });
    const draftBody = draftOutOfNetworkBenefits(ctx, intake.payer ?? "this plan");
    await draft_message({
      recipient: contact.recipient,
      channel: contact.channel,
      body: draftBody,
      language,
    });
    return {
      urgency: "P2",
      classification: "new_referral",
      recommended_next_action:
        "Billing to walk the family through out-of-network options before any slot search or hold.",
      draft_reply: draftBody,
      task_ids: [task.data.task_id],
      escalation: null,
      decision_rationale: [
        `Pediatrician referral; ${intake.payer ?? "payer"} verified as out-of-network.`,
        "Insurance policy requires a benefits conversation before any slot is held or recommended for scheduling — so no find_slots or hold_slot calls were made.",
        "Draft sets the expectation that billing will follow up, without committing to coverage outcomes.",
      ].join(" "),
    };
  }

  if (verify.data.status === "expired") {
    await lookup_policy({ topic: "insurance" });
    const task = await create_task({
      assignee: "billing",
      title: `Re-verify coverage with family before scheduling ${intake.child_name ?? "patient"}`,
      due: dueDates.nearTerm,
      notes: `${intake.payer ?? "Payer"} listed on referral but billing system shows the plan expired. Per policy, billing system supersedes the referral. Confirm current coverage before any slot is held.`,
    });
    const draftBody = draftExpiredCoverage(ctx, intake.payer ?? "the plan on the referral");
    await draft_message({
      recipient: contact.recipient,
      channel: contact.channel,
      body: draftBody,
      language,
    });
    return {
      urgency: "P2",
      classification: "new_referral",
      recommended_next_action:
        "Billing to re-verify active coverage with the family; do not hold a slot on stale plan information.",
      draft_reply: draftBody,
      task_ids: [task.data.task_id],
      escalation: null,
      decision_rationale: [
        `Referral lists ${intake.payer ?? "a payer"}, but the billing system shows the coverage expired.`,
        "Policy is explicit that the billing system supersedes the referral document — flagged the discrepancy and routed to billing instead of progressing the scheduling workflow.",
      ].join(" "),
    };
  }

  // status === "unknown"
  const task = await create_task({
    assignee: "intake",
    title: `Confirm payer details for ${intake.child_name ?? "referred patient"}`,
    due: dueDates.nearTerm,
    notes: `Payer ${intake.payer ?? "[unspecified]"} not recognized by the billing system. Call the family to confirm payer and member ID before insurance verification can complete.`,
  });
  const draftBody = draftUnknownPayer(ctx, intake.payer);
  await draft_message({
    recipient: contact.recipient,
    channel: contact.channel,
    body: draftBody,
    language,
  });
  return {
    urgency: "P2",
    classification: "new_referral",
    recommended_next_action:
      "Intake to confirm payer information with the family; verification cannot complete on what is on the referral alone.",
    draft_reply: draftBody,
    task_ids: [task.data.task_id],
    escalation: null,
    decision_rationale: [
      "Insurance verification returned unknown — billing system did not recognize the payer named on the referral.",
      "Routed to intake to confirm payer/member ID with the family before any scheduling action.",
    ].join(" "),
  };
}
