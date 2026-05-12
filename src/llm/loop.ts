import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { MAX_TOOL_ITERATIONS, MODEL } from "./client.js";
import { buildUserMessage, SYSTEM_PROMPT } from "./prompts.js";
import {
  appendPerItemTrace,
  startItem as startTelemetryItem,
} from "./telemetry.js";
import { parseSubmitTriage, TOOL_REGISTRY, TOOL_SPECS } from "./tools.js";
import type { SubmitTriagePayload } from "./schemas.js";
import type { InboxItem } from "../types.js";
import type { SafeguardingHit } from "../safety/safeguarding.js";

/**
 * One-item agentic loop. Caller is responsible for wrapping this in
 * withItemContext(item.id, ...) so the audit trace attributes tool calls
 * correctly.
 *
 * The loop:
 *   1. Send system + tools (both cached) + user message
 *   2. If Claude returns tool_use blocks, execute each one and feed the
 *      results back as tool_result blocks
 *   3. If a tool_use block is `submit_triage`, capture its input as the
 *      final answer, return any tool_result back so the conversation is
 *      closed cleanly, and break
 *   4. If the LLM returns end_turn without submit_triage, ask it to call
 *      submit_triage. If after MAX_TOOL_ITERATIONS we still don't have an
 *      answer, throw — caller falls back to the deterministic path.
 *
 * Validation: submit_triage args are run through Zod. If they fail to
 * parse, we feed the error back as a tool_result so the LLM can correct
 * itself (this is a well-known structured-output reliability pattern).
 */
export async function runItemAgent(
  client: Anthropic,
  item: InboxItem,
  safeguarding: SafeguardingHit,
  dueDates: { sameDay: string; nearTerm: string },
): Promise<SubmitTriagePayload> {
  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: buildUserMessage(item, safeguarding, dueDates) },
  ];

  const telemetry = startTelemetryItem(item.id, MODEL);

  let finalAnswer: SubmitTriagePayload | null = null;

  for (let iter = 0; iter < MAX_TOOL_ITERATIONS && !finalAnswer; iter++) {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 4096,
      system: [
        {
          type: "text",
          text: SYSTEM_PROMPT,
          cache_control: { type: "ephemeral" },
        },
      ],
      tools: TOOL_SPECS.map((tool, i) =>
        i === TOOL_SPECS.length - 1
          ? { ...tool, cache_control: { type: "ephemeral" as const } }
          : tool,
      ),
      messages,
    });

    telemetry.recordCall({
      input_tokens: response.usage.input_tokens ?? 0,
      output_tokens: response.usage.output_tokens ?? 0,
      cache_creation_input_tokens:
        response.usage.cache_creation_input_tokens ?? 0,
      cache_read_input_tokens: response.usage.cache_read_input_tokens ?? 0,
    });

    messages.push({ role: "assistant", content: response.content });

    if (response.stop_reason === "end_turn") {
      // Model decided to stop without calling submit_triage. Ask explicitly.
      messages.push({
        role: "user",
        content:
          "You did not call submit_triage. Call it now with the final triage decision; do not emit any other text.",
      });
      continue;
    }

    if (response.stop_reason !== "tool_use") {
      throw new Error(
        `Unexpected stop_reason from Anthropic: ${response.stop_reason}`,
      );
    }

    const toolUses = response.content.filter(
      (block): block is Anthropic.ToolUseBlock => block.type === "tool_use",
    );
    if (toolUses.length === 0) {
      throw new Error(
        "Model returned stop_reason=tool_use but no tool_use blocks were present.",
      );
    }

    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const toolUse of toolUses) {
      if (toolUse.name === "submit_triage") {
        try {
          finalAnswer = parseSubmitTriage(toolUse.input);
          toolResults.push({
            type: "tool_result",
            tool_use_id: toolUse.id,
            content: "Triage decision recorded.",
          });
        } catch (err) {
          const errorText =
            err instanceof z.ZodError
              ? `submit_triage arguments failed validation. Re-call submit_triage with corrected fields. Errors:\n${err.issues
                  .map((i) => `- ${i.path.join(".")}: ${i.message}`)
                  .join("\n")}`
              : `submit_triage failed to parse: ${err instanceof Error ? err.message : String(err)}`;
          toolResults.push({
            type: "tool_result",
            tool_use_id: toolUse.id,
            content: errorText,
            is_error: true,
          });
        }
        continue;
      }

      const entry = TOOL_REGISTRY[toolUse.name];
      if (!entry) {
        toolResults.push({
          type: "tool_result",
          tool_use_id: toolUse.id,
          content: `Unknown tool: ${toolUse.name}`,
          is_error: true,
        });
        continue;
      }

      try {
        const result = await entry.execute(toolUse.input);
        toolResults.push({
          type: "tool_result",
          tool_use_id: toolUse.id,
          content: JSON.stringify(redactToolResult(result)),
        });
      } catch (err) {
        toolResults.push({
          type: "tool_result",
          tool_use_id: toolUse.id,
          content: `Tool error: ${err instanceof Error ? err.message : String(err)}`,
          is_error: true,
        });
      }
    }

    messages.push({ role: "user", content: toolResults });
  }

  // Finalize telemetry whether or not we produced an answer — failed runs
  // are exactly the cases where telemetry is most useful.
  const record = telemetry.finish();
  appendPerItemTrace(record);

  if (!finalAnswer) {
    throw new Error(
      `Agent did not produce submit_triage within ${MAX_TOOL_ITERATIONS} iterations.`,
    );
  }

  return finalAnswer;
}

/**
 * Trim noisy fields out of tool results before they go back to the model.
 * The real tools.ts returns call_id and args echo on every result; the LLM
 * does not need to see those (they live in the trace) and including them
 * just inflates the context.
 */
function redactToolResult(result: unknown): unknown {
  if (result && typeof result === "object" && "data" in result) {
    const r = result as { data: unknown; result_summary?: string };
    return { summary: r.result_summary, data: r.data };
  }
  return result;
}
