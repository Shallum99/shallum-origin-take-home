import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { runAgent } from "./agent.js";
import { MODEL } from "./llm/client.js";
import {
  buildBatchSummary,
  configureTelemetry,
  printBatchSummary,
  writeTelemetrySummary,
} from "./llm/telemetry.js";
import { buildBatchOutput, configureTrace } from "./tools.js";
import type { InboxItem } from "./types.js";

interface CliArgs {
  input: string;
  output: string;
  trace: string;
}

async function main(): Promise<void> {
  const args = parseCliArgs(process.argv.slice(2));
  configureTrace({ path: args.trace });
  // Telemetry sits next to the trace; same directory, ".telemetry.json" suffix.
  configureTelemetry(args.trace.replace(/\.jsonl?$/, "") + ".telemetry.json");

  const inbox = JSON.parse(
    readFileSync(resolve(process.cwd(), args.input), "utf8"),
  ) as InboxItem[];

  const items = await runAgent(inbox);
  const output = buildBatchOutput(items);
  const outputPath = resolve(process.cwd(), args.output);
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`);

  // Emit LLM telemetry to stderr + a sidecar JSON so reviewers can see
  // cost/cache/latency without re-running. No-ops if no LLM calls happened
  // (deterministic path, or empty inbox).
  if (process.env.ANTHROPIC_API_KEY) {
    const summary = buildBatchSummary(MODEL);
    writeTelemetrySummary(summary);
    printBatchSummary(summary);
  }
}

function parseCliArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    input: "data/inbox.json",
    output: "output.json",
    trace: ".trace/tool-calls.jsonl",
  };

  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];

    if (!value) {
      throw new Error(`Missing value for ${flag}`);
    }

    if (flag === "--input") {
      args.input = value;
      i += 1;
    } else if (flag === "--output") {
      args.output = value;
      i += 1;
    } else if (flag === "--trace") {
      args.trace = value;
      i += 1;
    } else {
      throw new Error(`Unknown argument: ${flag}`);
    }
  }

  return args;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
