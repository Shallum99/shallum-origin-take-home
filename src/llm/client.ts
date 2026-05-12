import Anthropic from "@anthropic-ai/sdk";

let cachedClient: Anthropic | null = null;

/**
 * Returns a configured Anthropic client, or null if no API key is set.
 * The orchestrator uses the null return as the signal to fall back to the
 * deterministic path.
 */
export function getAnthropicClient(): Anthropic | null {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  if (cachedClient) return cachedClient;
  cachedClient = new Anthropic();
  return cachedClient;
}

// Default to the strongest current Claude model. Triage is a high-judgment
// task and the per-item token cost is bounded; we'd rather pay for accuracy
// here than save on a smaller model.
export const MODEL =
  process.env.ANTHROPIC_MODEL || "claude-opus-4-7";

export const MAX_TOOL_ITERATIONS = 12;
