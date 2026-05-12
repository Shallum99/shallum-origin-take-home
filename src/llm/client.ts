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

export const MODEL =
  process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6";

export const MAX_TOOL_ITERATIONS = 12;
