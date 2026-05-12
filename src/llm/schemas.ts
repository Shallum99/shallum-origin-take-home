import { z } from "zod";

/**
 * Zod schemas mirroring the JSON tool input shapes in src/tools.ts. Used
 * both for runtime validation of the LLM's tool_use blocks (so a malformed
 * call fails closed rather than crashing the tool layer) and as the source
 * of truth for the `input_schema` we hand Claude.
 */

export const DisciplineSchema = z.enum(["SLP", "OT", "PT"]);
export const PolicyTopicSchema = z.enum([
  "service_lines",
  "insurance",
  "safeguarding",
  "clinical_advice",
  "scheduling",
  "cancellation",
  "language_access",
]);
export const AssigneeSchema = z.enum([
  "front_desk",
  "intake",
  "billing",
  "clinical_lead",
]);
export const ClassificationSchema = z.enum([
  "new_referral",
  "existing_patient_request",
  "scheduling",
  "clinical_question",
  "billing_question",
  "missing_paperwork",
  "provider_followup",
  "complaint",
  "safeguarding",
  "spam",
  "other",
]);
export const UrgencySchema = z.enum(["P0", "P1", "P2", "P3"]);
export const ChannelSchema = z.enum(["portal", "email", "phone"]);
export const LanguageSchema = z.enum(["en", "es"]);
export const SeveritySchema = z.enum(["P0", "P1"]);

// --- tool input schemas ------------------------------------------------------

export const SearchPatientArgs = z.object({
  name: z.string().optional(),
  dob: z.string().optional(),
});
export const VerifyInsuranceArgs = z.object({
  payer: z.string().optional(),
  member_id: z.string().optional(),
});
export const LookupPolicyArgs = z.object({ topic: PolicyTopicSchema });
export const FindSlotsArgs = z.object({
  discipline: DisciplineSchema.optional(),
  preferences: z.string().optional(),
  language: z.string().optional(),
});
export const HoldSlotArgs = z.object({
  slot_id: z.string(),
  patient_ref: z.string(),
});
export const CreateTaskArgs = z.object({
  assignee: AssigneeSchema,
  title: z.string(),
  due: z.string(),
  notes: z.string(),
});
export const DraftMessageArgs = z.object({
  recipient: z.string(),
  channel: ChannelSchema,
  body: z.string(),
  language: LanguageSchema.optional(),
});
export const EscalateArgs = z.object({
  item_id: z.string(),
  reason: z.string(),
  severity: SeveritySchema,
});

// --- final-answer (submit_triage) schema -----------------------------------

export const ExtractedIntakeSchema = z.object({
  child_name: z.string().nullable(),
  dob_or_age: z.string().nullable(),
  parent_contact: z.string().nullable(),
  discipline: z.array(DisciplineSchema).min(1).nullable(),
  diagnosis_or_concern: z.string().nullable(),
  payer: z.string().nullable(),
  member_id: z.string().nullable(),
});

export const SubmitTriageArgs = z.object({
  classification: ClassificationSchema,
  urgency: UrgencySchema,
  extracted_intake: ExtractedIntakeSchema,
  missing_info: z.array(z.string()),
  recommended_next_action: z.string().min(1),
  draft_reply: z.string().nullable(),
  task_ids: z.array(z.string()),
  escalation: z
    .object({
      reason: z.string().min(1),
      severity: SeveritySchema,
    })
    .nullable(),
  decision_rationale: z.string().min(1),
});

export type SubmitTriagePayload = z.infer<typeof SubmitTriageArgs>;
