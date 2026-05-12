import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

/**
 * Per-item and per-batch telemetry for the LLM path.
 *
 * Why this matters: in production you cannot manage cost or latency you
 * cannot see. Anthropic returns rich `usage` data on every response —
 * input_tokens, output_tokens, cache_creation_input_tokens, and
 * cache_read_input_tokens. If we don't capture it, we're flying blind
 * on (a) whether prompt caching is actually hitting, (b) which items
 * are unusually expensive, and (c) p95 latency drift over time.
 *
 * We accumulate per-item and emit a JSON summary at end of batch.
 */

export interface PerCallUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
}

export interface ItemTelemetry {
  item_id: string;
  model: string;
  turns: number;
  wall_clock_ms: number;
  totals: PerCallUsage;
  cache_hit_ratio: number; // cache_read / (cache_read + cache_creation + input_tokens)
}

export interface BatchTelemetry {
  generated_at: string;
  model: string;
  total_items: number;
  total_wall_clock_ms: number;
  totals: PerCallUsage;
  cache_hit_ratio: number;
  per_item: ItemTelemetry[];
}

let telemetryPath: string | null = null;
const itemRecords = new Map<string, ItemTelemetry>();
const batchStartedAt = Date.now();

export function configureTelemetry(path: string): void {
  telemetryPath = resolve(process.cwd(), path);
  mkdirSync(dirname(telemetryPath), { recursive: true });
  // Don't truncate; let the file grow across runs.
}

const ZERO_USAGE: PerCallUsage = {
  input_tokens: 0,
  output_tokens: 0,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
};

export function startItem(itemId: string, model: string): { recordCall: (usage: PerCallUsage) => void; finish: () => ItemTelemetry } {
  const startedAt = Date.now();
  const totals = { ...ZERO_USAGE };
  let turns = 0;

  return {
    recordCall(usage) {
      turns += 1;
      totals.input_tokens += usage.input_tokens;
      totals.output_tokens += usage.output_tokens;
      totals.cache_creation_input_tokens += usage.cache_creation_input_tokens;
      totals.cache_read_input_tokens += usage.cache_read_input_tokens;
    },
    finish(): ItemTelemetry {
      const wall_clock_ms = Date.now() - startedAt;
      const cacheableTotal =
        totals.input_tokens +
        totals.cache_read_input_tokens +
        totals.cache_creation_input_tokens;
      const cache_hit_ratio =
        cacheableTotal > 0 ? totals.cache_read_input_tokens / cacheableTotal : 0;
      const record: ItemTelemetry = {
        item_id: itemId,
        model,
        turns,
        wall_clock_ms,
        totals,
        cache_hit_ratio,
      };
      itemRecords.set(itemId, record);
      return record;
    },
  };
}

export function buildBatchSummary(model: string): BatchTelemetry {
  const per_item = [...itemRecords.values()];
  const totals: PerCallUsage = per_item.reduce(
    (acc, r) => ({
      input_tokens: acc.input_tokens + r.totals.input_tokens,
      output_tokens: acc.output_tokens + r.totals.output_tokens,
      cache_creation_input_tokens:
        acc.cache_creation_input_tokens + r.totals.cache_creation_input_tokens,
      cache_read_input_tokens:
        acc.cache_read_input_tokens + r.totals.cache_read_input_tokens,
    }),
    { ...ZERO_USAGE },
  );
  const cacheableTotal =
    totals.input_tokens +
    totals.cache_read_input_tokens +
    totals.cache_creation_input_tokens;
  const cache_hit_ratio =
    cacheableTotal > 0 ? totals.cache_read_input_tokens / cacheableTotal : 0;
  return {
    generated_at: new Date().toISOString(),
    model,
    total_items: per_item.length,
    total_wall_clock_ms: Date.now() - batchStartedAt,
    totals,
    cache_hit_ratio,
    per_item,
  };
}

export function writeTelemetrySummary(summary: BatchTelemetry): void {
  if (!telemetryPath) return;
  writeFileSync(telemetryPath, `${JSON.stringify(summary, null, 2)}\n`);
}

/**
 * Render a human-readable one-screen summary to stderr.
 * Reviewers running `npm run triage` see this immediately after the run.
 */
export function printBatchSummary(summary: BatchTelemetry): void {
  if (summary.total_items === 0) return;
  const fmt = (n: number) => n.toLocaleString();
  const pct = (r: number) => `${(r * 100).toFixed(1)}%`;
  const lines = [
    "",
    `--- LLM telemetry (model: ${summary.model}) ---`,
    `  items processed:       ${summary.total_items}`,
    `  total wall-clock:      ${(summary.total_wall_clock_ms / 1000).toFixed(1)}s`,
    `  cache hit ratio:       ${pct(summary.cache_hit_ratio)} (cache_read / cacheable_input)`,
    `  tokens — input:        ${fmt(summary.totals.input_tokens)}`,
    `  tokens — cache create: ${fmt(summary.totals.cache_creation_input_tokens)}`,
    `  tokens — cache read:   ${fmt(summary.totals.cache_read_input_tokens)}`,
    `  tokens — output:       ${fmt(summary.totals.output_tokens)}`,
    `  per-item (item_id | turns | wall_ms | cache% | in/out tokens):`,
  ];
  for (const r of summary.per_item) {
    lines.push(
      `    ${r.item_id.padEnd(10)} ${String(r.turns).padStart(2)} turns  ${String(r.wall_clock_ms).padStart(5)}ms  ${pct(r.cache_hit_ratio).padStart(6)}  ${fmt(r.totals.input_tokens)}/${fmt(r.totals.output_tokens)}`,
    );
  }
  lines.push("");
  process.stderr.write(`${lines.join("\n")}\n`);
}

/** Append one trace line per item — handy for offline cost analysis. */
export function appendPerItemTrace(record: ItemTelemetry): void {
  if (!telemetryPath) return;
  const jsonlPath = telemetryPath.replace(/\.json$/, ".jsonl");
  appendFileSync(jsonlPath, `${JSON.stringify(record)}\n`);
}
