import type Anthropic from "@anthropic-ai/sdk";
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
  CreateTaskArgs,
  DraftMessageArgs,
  EscalateArgs,
  FindSlotsArgs,
  HoldSlotArgs,
  LookupPolicyArgs,
  SearchPatientArgs,
  SubmitTriageArgs,
  VerifyInsuranceArgs,
} from "./schemas.js";

/**
 * Tool registry. Each entry pairs:
 *   - the Anthropic `Tool` spec (name, description, input_schema)
 *   - the Zod parser that validates LLM-supplied args
 *   - the executor that runs inside the per-item withItemContext
 *
 * `submit_triage` is special: it is not a callable tool, it is the
 * "structured-output channel." When Claude calls it, we capture the
 * payload and end the loop. Marking it as a tool keeps Claude on the
 * structured-output rails — it can't pour the final answer into prose.
 */

type ToolExecutor = (input: unknown) => Promise<unknown>;

interface RegistryEntry {
  spec: Anthropic.Tool;
  execute: ToolExecutor;
}

function commonToolSpec(
  name: string,
  description: string,
  input_schema: Anthropic.Tool.InputSchema,
): Anthropic.Tool {
  return { name, description, input_schema };
}

export const TOOL_REGISTRY: Record<string, RegistryEntry> = {
  search_patient: {
    spec: commonToolSpec(
      "search_patient",
      "Look up a patient in the EMR by name and/or DOB. Returns zero or more matches. Use this when a message references an existing patient (e.g. a same-day cancellation, an existing-chart referral) to surface the chart record and any guardian-on-file before you proceed.",
      {
        type: "object",
        properties: {
          name: { type: "string", description: "Child's name as it appears on the message." },
          dob: { type: "string", description: "Date of birth in YYYY-MM-DD if available." },
        },
      },
    ),
    execute: async (input) => {
      const args = SearchPatientArgs.parse(input);
      return search_patient(args);
    },
  },
  verify_insurance: {
    spec: commonToolSpec(
      "verify_insurance",
      "Verify a payer/member_id against the billing system. Returns one of in_network, out_of_network, expired, unknown. Per policy, billing-system status supersedes the referral document. Always call this before any slot search for a new-referral case.",
      {
        type: "object",
        properties: {
          payer: { type: "string" },
          member_id: { type: "string" },
        },
      },
    ),
    execute: async (input) => {
      const args = VerifyInsuranceArgs.parse(input);
      return verify_insurance(args);
    },
  },
  lookup_policy: {
    spec: commonToolSpec(
      "lookup_policy",
      "Fetch policy snippets by topic. Useful when you need to cite the operational rule that supports a recommended action (e.g. clinical_advice for a clinical question, safeguarding for an escalation).",
      {
        type: "object",
        required: ["topic"],
        properties: {
          topic: {
            type: "string",
            enum: [
              "service_lines",
              "insurance",
              "safeguarding",
              "clinical_advice",
              "scheduling",
              "cancellation",
              "language_access",
            ],
          },
        },
      },
    ),
    execute: async (input) => {
      const args = LookupPolicyArgs.parse(input);
      return lookup_policy(args);
    },
  },
  find_slots: {
    spec: commonToolSpec(
      "find_slots",
      "Find available evaluation slots for a discipline, optionally filtered by language. Surfacing slots is reviewable; you may NEVER schedule. For out-of-network or expired coverage, do not call this — the benefits conversation must happen first.",
      {
        type: "object",
        properties: {
          discipline: { type: "string", enum: ["SLP", "OT", "PT"] },
          preferences: { type: "string" },
          language: { type: "string", description: "ISO language code, e.g. 'en' or 'es'." },
        },
      },
    ),
    execute: async (input) => {
      const args = FindSlotsArgs.parse(input);
      return find_slots(args);
    },
  },
  hold_slot: {
    spec: commonToolSpec(
      "hold_slot",
      "Place a pending_review hold on a slot. Holds are NOT scheduled appointments — they exist so staff can confirm with the family. Only hold when insurance is verified in-network.",
      {
        type: "object",
        required: ["slot_id", "patient_ref"],
        properties: {
          slot_id: { type: "string" },
          patient_ref: { type: "string", description: "Patient ID if known, otherwise a stable string like '<child name> / <dob>'." },
        },
      },
    ),
    execute: async (input) => {
      const args = HoldSlotArgs.parse(input);
      return hold_slot(args);
    },
  },
  create_task: {
    spec: commonToolSpec(
      "create_task",
      "Create a work item for a staff role. Required for any action that needs a human (callbacks, billing follow-ups, clinical screenings). Pick the assignee whose role owns the next step: intake, billing, front_desk, or clinical_lead.",
      {
        type: "object",
        required: ["assignee", "title", "due", "notes"],
        properties: {
          assignee: { type: "string", enum: ["front_desk", "intake", "billing", "clinical_lead"] },
          title: { type: "string" },
          due: { type: "string", description: "ISO date string (YYYY-MM-DD)." },
          notes: { type: "string" },
        },
      },
    ),
    execute: async (input) => {
      const args = CreateTaskArgs.parse(input);
      return create_task(args);
    },
  },
  draft_message: {
    spec: commonToolSpec(
      "draft_message",
      "Draft a message for staff review. Never auto-sends. Drafts must: (a) not provide clinical advice, (b) not imply the message has been sent, (c) match the family's language. For safeguarding cases, the draft MUST be a neutral acknowledgement that does not reference the disclosure.",
      {
        type: "object",
        required: ["recipient", "channel", "body"],
        properties: {
          recipient: { type: "string" },
          channel: { type: "string", enum: ["portal", "email", "phone"] },
          body: { type: "string" },
          language: { type: "string", enum: ["en", "es"] },
        },
      },
    ),
    execute: async (input) => {
      const args = DraftMessageArgs.parse(input);
      return draft_message(args);
    },
  },
  escalate: {
    spec: commonToolSpec(
      "escalate",
      "Escalate an item to the clinical lead or operations. P0 is for safeguarding, imminent harm, or mandated-reporter signals. P1 is for same-day operational issues. Include the matched phrase or the operational fact in `reason` so the reviewer can audit the trigger.",
      {
        type: "object",
        required: ["item_id", "reason", "severity"],
        properties: {
          item_id: { type: "string" },
          reason: { type: "string" },
          severity: { type: "string", enum: ["P0", "P1"] },
        },
      },
    ),
    execute: async (input) => {
      const args = EscalateArgs.parse(input);
      return escalate(args);
    },
  },
  submit_triage: {
    spec: commonToolSpec(
      "submit_triage",
      "Submit the final triage decision for this inbox item. Call exactly once, after you have completed all the tool calls you need. The output ends with this call — do not emit free-form prose afterwards.",
      {
        type: "object",
        required: [
          "classification",
          "urgency",
          "extracted_intake",
          "missing_info",
          "recommended_next_action",
          "draft_reply",
          "task_ids",
          "escalation",
          "decision_rationale",
        ],
        properties: {
          classification: {
            type: "string",
            enum: [
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
            ],
          },
          urgency: { type: "string", enum: ["P0", "P1", "P2", "P3"] },
          extracted_intake: {
            type: "object",
            required: [
              "child_name",
              "dob_or_age",
              "parent_contact",
              "discipline",
              "diagnosis_or_concern",
              "payer",
              "member_id",
            ],
            properties: {
              child_name: { type: ["string", "null"] },
              dob_or_age: { type: ["string", "null"] },
              parent_contact: { type: ["string", "null"] },
              discipline: {
                anyOf: [
                  { type: "null" },
                  {
                    type: "array",
                    items: { type: "string", enum: ["SLP", "OT", "PT"] },
                    minItems: 1,
                  },
                ],
              },
              diagnosis_or_concern: { type: ["string", "null"] },
              payer: { type: ["string", "null"] },
              member_id: { type: ["string", "null"] },
            },
          },
          missing_info: { type: "array", items: { type: "string" } },
          recommended_next_action: { type: "string" },
          draft_reply: {
            type: ["string", "null"],
            description:
              "The LITERAL TEXT BODY of the draft message you composed via draft_message — exactly the same string you passed to `body`. NOT the draft_id returned by the tool. Null only if you did not draft a message at all.",
          },
          task_ids: {
            type: "array",
            items: { type: "string" },
            description:
              "The task_id values returned by your create_task calls (e.g. 'task_01ABC...'). Not titles, not descriptions.",
          },
          escalation: {
            anyOf: [
              { type: "null" },
              {
                type: "object",
                required: ["reason", "severity"],
                properties: {
                  reason: { type: "string" },
                  severity: { type: "string", enum: ["P0", "P1"] },
                },
              },
            ],
          },
          decision_rationale: { type: "string" },
        },
      },
    ),
    // submit_triage is captured by the loop, not executed here.
    execute: async () => ({}),
  },
};

export const TOOL_SPECS: Anthropic.Tool[] = Object.values(TOOL_REGISTRY).map(
  (entry) => entry.spec,
);

export function parseSubmitTriage(input: unknown) {
  return SubmitTriageArgs.parse(input);
}
