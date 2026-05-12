# Origin Take-Home — Referral Inbox Triage Agent

A genuine agentic system for Cedar Kids Therapy's Monday inbox: an Anthropic
`messages.create` tool-use loop per item, deterministic safety overrides,
structured output via a `submit_triage` tool, and a regex fallback that keeps
the system running when no API key is provisioned.

## How to run

```bash
npm install
# (optional) put your key in a .env file:
#   ANTHROPIC_API_KEY=sk-ant-...
#   ANTHROPIC_MODEL=claude-sonnet-4-6   # default
npm run triage   -- --input data/inbox.json --output output.json --trace .trace/tool-calls.jsonl
npm run validate -- --input data/inbox.json --output output.json --trace .trace/tool-calls.jsonl
npm test          # vitest: deterministic-path invariants + safeguarding gold set
npm run typecheck
```

Both `triage` and `validate` accept no flags and default to the same paths.

- **With a key set**, the agent runs Claude in a tool-use loop per item; items
  run in bounded parallel (`AGENT_CONCURRENCY=3` by default). End-to-end on
  the 8-item inbox takes ~30–45s.
- **Without a key**, the orchestrator silently falls back to a deterministic
  pipeline. Same contract, same validator-passing output, no LLM cost.

## Stack and runtime

- TypeScript on Node LTS, executed via `tsx`.
- `@anthropic-ai/sdk` for the agentic loop. Prompt caching on the system
  prompt and tool definitions (the 5-minute ephemeral cache).
- `zod` for runtime validation of every tool input and of the final
  `submit_triage` payload — failed parses are fed back as `tool_result`s so
  the LLM can self-correct rather than crashing the batch.
- `p-limit` for bounded item-level concurrency.
- `dotenv` for local `.env` loading.
- `vitest` for the deterministic-path invariants and the safeguarding
  gold-set (no LLM cost in CI).

## Architecture

```
                          inbox item
                              │
                              ▼
                ┌─ safety/safeguarding.ts ─┐   deterministic regex pre-filter,
                │   runs unconditionally   │   always. Provides a hint to the LLM
                └────────┬─────────────────┘   AND overrides the LLM if it
                         │                     refuses to escalate a match.
                         ▼
              ┌──────── orchestrator ────────┐
              │      src/agent.ts            │
              │  if (ANTHROPIC_API_KEY) →    │
              │      llm/loop.ts             │
              │  else →                      │
              │      deterministic/*.ts      │
              └──────┬───────────┬───────────┘
                     │           │
       LLM PATH      ▼           ▼     DETERMINISTIC PATH
  ┌──────────────────┐         ┌────────────────────────┐
  │ messages.create  │         │ extract.ts (regex)     │
  │  + tools + cache │         │ triage.ts (signals)    │
  │ tool_use loop:   │         │ handlers.ts (per-class │
  │   search_patient │         │   tool orchestration)  │
  │   verify_insur.  │         │ drafts.ts (templates)  │
  │   lookup_policy  │         └────────────────────────┘
  │   find_slots     │
  │   hold_slot      │
  │   create_task    │       (both paths call the same
  │   draft_message  │        tools.ts; never modify it,
  │   escalate       │        never bypass the audit
  │   submit_triage  │        trace)
  └──────────────────┘
                     │
                     ▼
       withItemContext(item.id, ...)
       tools_called ← getToolCallsForItem(item.id)
       requires_human_review = true (hardcoded policy)
       output.json (BatchOutput, validator-passing)
```

Design properties worth flagging:

- **Defense-in-depth on safety.** The deterministic safeguarding filter runs
  every time, even on the LLM path. The match is included in the user
  message so the model knows about it; the orchestrator also force-overrides
  to P0 / safeguarding if the LLM disagrees. Safety is hardcoded, not
  delegated to a probabilistic system.

- **Structured output via a tool, not free-form JSON.** `submit_triage` is
  registered as a tool whose input schema is the target shape. The LLM
  cannot "spill" the final answer into prose, and we get the same Zod
  validation as we apply to every other tool. Failed parses produce a
  `tool_result` with the validation error so Claude can self-correct.

- **Prompt caching on the stable prefix.** System prompt (with the verbatim
  policy document inlined) and tool definitions are cached. Per-item cost
  is dominated by the conversation turns, not the static prefix.

- **No hand-built audit entries.** Every tool the LLM uses runs through
  `tools.ts`, every entry in `tools_called[]` comes from
  `getToolCallsForItem(item.id)`. The audit trail is the source of truth.

- **Per-item agentic loop, bounded.** Up to 12 tool-use iterations per item.
  If the model end_turn's without `submit_triage`, we ask it explicitly. If
  iterations exhaust, the item falls back to the deterministic path
  (resilience over partial output).

- **Two paths, one contract.** Both paths produce the same `ItemOutput`
  shape and write to the same trace. The LLM path is the primary; the
  deterministic path is the floor — useful for CI, for reviewers without a
  key, and as the per-item escape hatch when the LLM blows up.

## Failure modes and production eval

The decisions that should worry a reviewer:

1. **Missed safeguarding (false negative).** Highest-stakes failure mode. The
   regex catches the obvious English phrases; the LLM catches the rest
   *most* of the time. Production should ship a clinician-labeled gold set
   and report per-language precision/recall, with explicit tracking of
   false-negative rate. Both layers (regex + LLM) are independent; the
   override is the belt-and-braces.

2. **LLM tool-use drift.** The model occasionally puts the wrong value in a
   structured field (we caught `draft_id` going into `draft_reply` during
   development). Mitigation today: Zod validation with self-correction loop.
   In production: LLM-as-judge on the final payload against a structured
   rubric, plus offline regression tests against held-out items.

3. **Over-escalation.** The brief flags this. Default urgency is P2 in both
   paths; safeguarding override is the only force-promote. Production eval
   should track per-classification escalation rates, especially for
   clinical-question and missing-paperwork items.

4. **Payer / coverage drift.** `verify_insurance` is mocked; in production
   the in-network set drifts as contracts change. The agent should consult
   an authoritative payer table, not carry its own list, and "in-network
   vs. OON" should be billing's rubric, not the agent's.

5. **Language detection & non-English safety.** Spanish detection is
   token-based; safeguarding patterns are English-only. Production:
   short-text language ID + Spanish-language safeguarding patterns reviewed
   by a bilingual clinician.

6. **Cost & latency.** Each item is ~5-12 model turns. With prompt caching
   the dominant cost is the tool-result tokens. Production should track
   tokens-per-item, cache hit rate, p95 latency, and have a circuit breaker
   that flips to the deterministic path under load or outage.

## What I chose not to build, and why

- **No multi-discipline branching on a single referral.** Real referrals can
  request SLP+OT; this prototype takes the first parsed discipline. Per-
  discipline subtasks belong in a v2.
- **No retry / backoff around tool calls.** Mock tools never fail. The trace
  format already has `audit_exempt: "retry"` for this; wiring it up is
  cosmetic without a flaky downstream to test against.
- **No mandated-reporter workflow.** Per policy I escalate to clinical_lead
  and stop. A real practice has a documented reporter pathway with
  timestamps and a form; that belongs behind `escalate`, not in the agent.
- **No richer chart-diff on existing patients.** I surface the guardian-name
  mismatch on item_4 because it materially changes the front-desk workflow,
  but I don't reconcile payer-on-file vs. payer-on-referral.
- **No streaming.** The agent uses non-streamed `messages.create`. For an
  interactive surface streaming matters; for batch triage it doesn't.

## What I would do with another 4 hours

1. **LLM-as-judge eval harness.** Score every item's `decision_rationale`,
   `draft_reply`, and tool-call set against a clinician-reviewed rubric.
   Track regression as the system evolves.
2. **Snapshot tests against a captured LLM run.** Record one LLM batch as
   the golden output; replay-style asserts on per-item invariants without
   spending tokens on every CI run.
3. **A `--explain item_3` CLI flag.** Print the matched signals, the tool
   trace, the system prompt prefix, and the final payload for one item.
   Much faster than re-reading `output.json` end to end.
4. **Wire `audit_exempt: "retry"`** around the LLM call itself, recording
   failed turns to the trace but not surfacing them in `tools_called`.
5. **Spanish safeguarding patterns**, plus a small bilingual gold set, so
   the deterministic safety floor isn't English-only.
6. **Cost telemetry**: log `usage.cache_creation_input_tokens` and
   `usage.cache_read_input_tokens` per item; emit a per-batch summary.

---

## Original brief (preserved)

> Origin builds software for pediatric therapy practices. In this
> assignment, you are helping a fictional practice, Cedar Kids Therapy,
> triage its Monday inbox.

### Urgency calibration

- `P0`: safeguarding, imminent harm, mandated-reporter escalation. Same-hour human review.
- `P1`: same-day operational issue requiring prompt staff action.
- `P2`: normal intake, scheduling, billing, or clinical-review workflow.
- `P3`: low-priority admin, FYI, spam.

### Constraints respected by this submission

- TypeScript / Node LTS / npm.
- `src/tools.ts` used as-is — never modified, never bypassed.
- More than 3 distinct tools used across the batch.
- All item-level tool calls wrapped in `withItemContext(item.id, ...)`.
- `tools_called[]` built from `getToolCallsForItem(item.id)`, passed
  through unchanged.
- Batch output assembled via `buildBatchOutput(items)`.
- No auto-send; `draft_message` only.
- No scheduling; `find_slots` / `hold_slot` only as reviewable suggestions.
- API key kept in `.env` (gitignored); only synthetic data; no real PHI.

### Rubric (reviewer-facing)

- Safety and domain judgment: 25%
- Tool orchestration and action model: 25%
- Output correctness and auditability: 20%
- Engineering quality: 15%
- README and production thinking: 15%
