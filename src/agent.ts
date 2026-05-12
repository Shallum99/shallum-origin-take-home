import pLimit from "p-limit";
import "dotenv/config";
import { extractIntake } from "./deterministic/extract.js";
import { handle as deterministicHandle } from "./deterministic/handlers.js";
import { triage as deterministicTriage } from "./deterministic/triage.js";
import { getAnthropicClient } from "./llm/client.js";
import { runItemAgent } from "./llm/loop.js";
import { detectSafeguarding, type SafeguardingHit } from "./safety/safeguarding.js";
import { getToolCallsForItem, withItemContext } from "./tools.js";
import type { InboxItem, ItemOutput } from "./types.js";

/**
 * Orchestrator. Two paths share the same contract:
 *   - LLM path (active when ANTHROPIC_API_KEY is set): system prompt with
 *     cached policy + tools, per-item tool_use loop, structured output
 *     via the submit_triage tool. Items run in bounded parallel.
 *   - Deterministic path (no key): the regex extractor + signal-based
 *     dispatcher + templated drafts from src/deterministic/.
 *
 * Both paths:
 *   - Run the deterministic safeguarding pre-filter first. If it hits,
 *     the LLM is told about it explicitly, and after the LLM returns we
 *     force-override to safeguarding/P0 if the LLM disagreed. Safety is
 *     a hardcoded property, not a model decision.
 *   - Wrap their work in withItemContext(item.id, ...) so the audit trace
 *     attributes tool calls to the right item.
 *   - Hardcode requires_human_review = true. Every output is advisory.
 *   - Build tools_called by calling getToolCallsForItem(item.id) at the
 *     end, never by hand.
 */

const CONCURRENCY = Number(process.env.AGENT_CONCURRENCY) || 3;

export async function runAgent(inbox: InboxItem[]): Promise<ItemOutput[]> {
  const client = getAnthropicClient();
  const dueDates = deriveDueDates(inbox);
  const limit = pLimit(client ? CONCURRENCY : 8);

  return await Promise.all(
    inbox.map((item) =>
      limit(() => processItem(item, dueDates, client !== null)),
    ),
  );
}

async function processItem(
  item: InboxItem,
  dueDates: { sameDay: string; nearTerm: string },
  useLlm: boolean,
): Promise<ItemOutput> {
  return withItemContext(item.id, async () => {
    const safeguarding = detectSafeguarding(`${item.subject}\n${item.body}`);

    let payload: TriagePayload;
    try {
      payload = useLlm
        ? await runLlmPath(item, safeguarding, dueDates)
        : await runDeterministicPath(item, dueDates);
    } catch (err) {
      // LLM blow-up shouldn't take the batch down. Fall back to the
      // deterministic path for this item.
      console.error(
        `[agent] LLM path failed for ${item.id}, falling back: ${err instanceof Error ? err.message : err}`,
      );
      payload = await runDeterministicPath(item, dueDates);
    }

    if (safeguarding.hit && payload.urgency !== "P0") {
      payload = await forceSafeguardingOverride(item, safeguarding, payload);
    }

    const tools_called = getToolCallsForItem(item.id);

    return {
      item_id: item.id,
      classification: payload.classification,
      urgency: payload.urgency,
      requires_human_review: true,
      extracted_intake: payload.extracted_intake,
      missing_info: payload.missing_info,
      tools_called,
      recommended_next_action: payload.recommended_next_action,
      draft_reply: payload.draft_reply,
      task_ids: payload.task_ids,
      escalation: payload.escalation,
      decision_rationale: payload.decision_rationale,
    };
  });
}

interface TriagePayload {
  classification: ItemOutput["classification"];
  urgency: ItemOutput["urgency"];
  extracted_intake: ItemOutput["extracted_intake"];
  missing_info: string[];
  recommended_next_action: string;
  draft_reply: string | null;
  task_ids: string[];
  escalation: ItemOutput["escalation"];
  decision_rationale: string;
}

async function runLlmPath(
  item: InboxItem,
  safeguarding: SafeguardingHit,
  dueDates: { sameDay: string; nearTerm: string },
): Promise<TriagePayload> {
  const client = getAnthropicClient();
  if (!client) throw new Error("Anthropic client not configured.");
  return runItemAgent(client, item, safeguarding, dueDates);
}

async function runDeterministicPath(
  item: InboxItem,
  dueDates: { sameDay: string; nearTerm: string },
): Promise<TriagePayload> {
  const extraction = extractIntake(item);
  const triageDecision = deterministicTriage(extraction);
  const handlerResult = await deterministicHandle({
    item,
    extraction,
    baselineClassification: triageDecision.classification,
    baselineUrgency: triageDecision.urgency,
    dueDates,
  });
  return {
    classification: handlerResult.classification,
    urgency: handlerResult.urgency,
    extracted_intake: extraction.intake,
    missing_info: extraction.missingInfo,
    recommended_next_action: handlerResult.recommended_next_action,
    draft_reply: handlerResult.draft_reply,
    task_ids: handlerResult.task_ids,
    escalation: handlerResult.escalation,
    decision_rationale: handlerResult.decision_rationale,
  };
}

/**
 * Defense in depth. If the deterministic regex matched a safeguarding
 * phrase but the LLM did not escalate, we force the classification.
 * We do NOT re-emit tools here — by the time we get here, the LLM has
 * already populated the trace; this just rewrites the output payload
 * the human reviewer sees. The trace will reflect whatever the LLM
 * actually did, which is also auditable.
 */
async function forceSafeguardingOverride(
  item: InboxItem,
  safeguarding: SafeguardingHit,
  payload: TriagePayload,
): Promise<TriagePayload> {
  const categoryTag = safeguarding.category ? ` [${safeguarding.category}]` : "";
  const langTag = safeguarding.language ? ` [lang=${safeguarding.language}]` : "";
  return {
    ...payload,
    classification: "safeguarding",
    urgency: "P0",
    escalation: {
      reason: `Deterministic safeguarding pre-filter matched${categoryTag}${langTag}: "${safeguarding.matchedPhrase}". The agent did not escalate. Forced P0 override; clinical lead to review immediately.`,
      severity: "P0",
    },
    decision_rationale: `[OVERRIDE] ${payload.decision_rationale}\n\nSafety override: the deterministic safeguarding filter matched${categoryTag}${langTag} in item ${item.id} (phrase: "${safeguarding.matchedPhrase}"). Per policy, this routes to P0 regardless of model judgment.`,
  };
}

function deriveDueDates(inbox: InboxItem[]): {
  sameDay: string;
  nearTerm: string;
} {
  const latest = inbox.reduce<Date>((acc, item) => {
    const t = new Date(item.received_at);
    return Number.isFinite(t.getTime()) && t > acc ? t : acc;
  }, new Date(0));
  const base = latest.getTime() > 0 ? latest : new Date();
  const sameDay = base.toISOString().slice(0, 10);
  const nearTermDate = new Date(base.getTime() + 2 * 24 * 60 * 60 * 1000);
  const nearTerm = nearTermDate.toISOString().slice(0, 10);
  return { sameDay, nearTerm };
}
