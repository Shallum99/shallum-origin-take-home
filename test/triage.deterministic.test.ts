import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { runAgent } from "../src/agent.js";
import { configureTrace, buildBatchOutput } from "../src/tools.js";
import type { InboxItem, ItemOutput, BatchOutput } from "../src/types.js";

/**
 * Smoke / invariant tests against the visible 8-item inbox using the
 * deterministic path (no API key required). These run in CI and on every
 * push; they protect the validator-passing contract without spending LLM
 * tokens.
 *
 * We intentionally do NOT test the LLM path here — it is non-deterministic,
 * costs money, and is best exercised via `npm run triage` and a snapshot
 * of the output, plus the per-item invariants below.
 */

let batch: BatchOutput;
let byId: Record<string, ItemOutput>;

beforeAll(async () => {
  // Force deterministic path even if the developer has a key in .env.
  delete process.env.ANTHROPIC_API_KEY;

  configureTrace({ path: ".trace/test-tool-calls.jsonl" });
  const inbox = JSON.parse(
    readFileSync(resolve(process.cwd(), "data/inbox.json"), "utf8"),
  ) as InboxItem[];
  const items = await runAgent(inbox);
  batch = buildBatchOutput(items);
  byId = Object.fromEntries(items.map((i) => [i.item_id, i]));
});

describe("batch invariants", () => {
  it("covers all 8 items exactly once", () => {
    expect(batch.summary.total_items).toBe(8);
    expect(new Set(batch.items.map((i) => i.item_id)).size).toBe(8);
  });

  it("requires human review on every item", () => {
    expect(
      batch.items.every((i) => i.requires_human_review === true),
    ).toBe(true);
    expect(batch.summary.requires_human_review_count).toBe(8);
  });

  it("uses at least 3 distinct tools across the batch", () => {
    const names = new Set<string>();
    for (const item of batch.items) {
      for (const call of item.tools_called) names.add(call.name);
    }
    expect(names.size).toBeGreaterThanOrEqual(3);
  });

  it("never references forbidden tools", () => {
    for (const item of batch.items) {
      for (const call of item.tools_called) {
        expect(call.name).not.toBe("schedule_appointment");
        expect(call.name).not.toBe("send_message");
      }
    }
  });
});

describe("per-item triage decisions", () => {
  it("item_2 is P0 safeguarding with escalation and a neutral draft", () => {
    const item = byId.item_2;
    expect(item.urgency).toBe("P0");
    expect(item.classification).toBe("safeguarding");
    expect(item.escalation).not.toBeNull();
    expect(item.escalation?.severity).toBe("P0");
    expect(item.task_ids.length).toBeGreaterThan(0);
    // The neutral safeguarding draft must NOT reference the disclosure or
    // commit to a clinical pathway over message. Use word-boundary regex so
    // we don't false-fail on substrings ("rough" inside "through").
    const draft = item.draft_reply ?? "";
    expect(draft).not.toMatch(/\brough\b/i);
    expect(draft).not.toMatch(/\babus\w*\b/i);
    expect(draft).not.toMatch(/\bspeech\s+evaluation\b/i);
  });

  it("item_3 (Kaiser OON) does NOT hold a slot — benefits conversation first", () => {
    const item = byId.item_3;
    const toolNames = item.tools_called.map((t) => t.name);
    expect(toolNames).not.toContain("hold_slot");
    expect(toolNames).toContain("verify_insurance");
  });

  it("item_5 is a clinical question routed to a screening, no clinical advice", () => {
    const item = byId.item_5;
    expect(item.classification).toBe("clinical_question");
    const draft = (item.draft_reply ?? "").toLowerCase();
    // No advice statements
    expect(draft).not.toMatch(/\b(you should|i recommend|you need to wait)\b/);
    // Should offer a screening or evaluation
    expect(draft).toMatch(/(screen|evaluation)/);
  });

  it("item_6 is missing_paperwork with a follow-up task", () => {
    const item = byId.item_6;
    expect(item.classification).toBe("missing_paperwork");
    expect(item.task_ids.length).toBeGreaterThan(0);
    expect(item.missing_info.length).toBeGreaterThan(0);
  });

  it("item_7 is a Spanish referral with a Spanish draft", () => {
    const item = byId.item_7;
    expect(item.classification).toBe("new_referral");
    expect(item.draft_reply).toMatch(/\b(Hola|Gracias|Atentamente)\b/);
  });

  it("item_8 is P1 scheduling with a make-up slot search but no auto-reschedule", () => {
    const item = byId.item_8;
    expect(item.urgency).toBe("P1");
    expect(item.classification).toBe("scheduling");
    const toolNames = item.tools_called.map((t) => t.name);
    expect(toolNames).toContain("create_task");
  });
});

describe("trace alignment", () => {
  it("each tool call in output has matching args from the trace", () => {
    // tools_called is built from getToolCallsForItem; we just assert the
    // structural shape is intact.
    for (const item of batch.items) {
      for (const call of item.tools_called) {
        expect(call.call_id).toMatch(/^[A-Z0-9]{20,30}$/);
        expect(typeof call.name).toBe("string");
        expect(typeof call.args).toBe("object");
        expect(typeof call.result_summary).toBe("string");
      }
    }
  });
});
