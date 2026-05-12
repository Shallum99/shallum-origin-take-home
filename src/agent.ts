import { extractIntake } from "./extract.js";
import { handle } from "./handlers.js";
import { getToolCallsForItem, withItemContext } from "./tools.js";
import { triage } from "./triage.js";
import type { InboxItem, ItemOutput } from "./types.js";

/**
 * Pipeline per item:
 *   extract → triage → handler (tool calls) → assemble ItemOutput
 *
 * `withItemContext(item.id, ...)` scopes every tool call so the trace can
 * attribute it back. `getToolCallsForItem(item.id)` is the only source of
 * truth for the `tools_called[]` array — we never hand-build tool call
 * records, so the validator's trace-match check stays green.
 *
 * Items are processed sequentially. With 8 items and stub tools this is
 * already sub-second; we could parallelize at the item level later, but
 * deterministic ordering makes debugging easier here.
 */
export async function runAgent(inbox: InboxItem[]): Promise<ItemOutput[]> {
  const dueDates = deriveDueDates(inbox);
  const items: ItemOutput[] = [];

  for (const item of inbox) {
    const itemOutput = await withItemContext(item.id, async () => {
      const extraction = extractIntake(item);
      const triageDecision = triage(extraction);

      const handlerResult = await handle({
        item,
        extraction,
        baselineClassification: triageDecision.classification,
        baselineUrgency: triageDecision.urgency,
        dueDates,
      });

      const tools_called = getToolCallsForItem(item.id);

      const output: ItemOutput = {
        item_id: item.id,
        classification: handlerResult.classification,
        urgency: handlerResult.urgency,
        // Every triage decision in this prototype is advisory, not autonomous:
        // a human reviews before any outbound action or scheduling happens.
        requires_human_review: true,
        extracted_intake: extraction.intake,
        missing_info: extraction.missingInfo,
        tools_called,
        recommended_next_action: handlerResult.recommended_next_action,
        draft_reply: handlerResult.draft_reply,
        task_ids: handlerResult.task_ids,
        escalation: handlerResult.escalation,
        decision_rationale: handlerResult.decision_rationale,
      };
      return output;
    });
    items.push(itemOutput);
  }

  return items;
}

/**
 * Derive same-day and near-term due dates from the latest received_at in the
 * inbox so task due-dates are stable across runs of the same inbox.
 */
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
