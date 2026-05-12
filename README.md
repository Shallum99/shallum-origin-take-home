# Origin Take-Home — Referral Inbox Triage Agent

A genuine agentic system for Cedar Kids Therapy's Monday inbox: an Anthropic
`messages.create` tool-use loop per item, a bilingual (EN + ES) deterministic
safeguarding pre-filter with hard-override on the LLM, structured output via
a `submit_triage` tool, per-batch cost/cache telemetry, and a regex fallback
that keeps the system running when no API key is provisioned.

## How to run

```bash
npm install
# (optional) put your key in a .env file:
#   ANTHROPIC_API_KEY=sk-ant-...
#   ANTHROPIC_MODEL=claude-opus-4-7   # default; any Claude model works
npm run triage   -- --input data/inbox.json --output output.json --trace .trace/tool-calls.jsonl
npm run validate -- --input data/inbox.json --output output.json --trace .trace/tool-calls.jsonl
npm run typecheck
```

Both `triage` and `validate` accept no flags and default to the same paths.
`npm run validate` is the brief's required check; running it after `triage`
asserts schema correctness and trace alignment.

### Runtime

- **LLM path (default — Opus 4.7)**: ~60–70 seconds end-to-end on the 8-item
  inbox (concurrency=3). Per-item ~5–10s including 2–6 tool turns. Well
  within the brief's "few minutes or less" envelope. Override the model via
  `ANTHROPIC_MODEL` if you want to trade quality for latency
  (`claude-sonnet-4-6` ~30–45s, `claude-haiku-4-5-20251001` faster still).
- **Deterministic fallback (no key)**: sub-second.
- **LLM telemetry** is emitted to stderr at end of run and written to
  `.trace/tool-calls.telemetry.json` (cache hit ratio, per-item tokens,
  per-item turns + wall-clock). Typical cache hit ratio on a warm batch
  is ~80–85%.

## Stack and runtime

- TypeScript on Node LTS, executed via `tsx`.
- `@anthropic-ai/sdk` for the agentic loop. Prompt caching on the system
  prompt and tool definitions (the 5-minute ephemeral cache).
- `zod` for runtime validation of every tool input and of the final
  `submit_triage` payload — failed parses are fed back as `tool_result`s so
  the LLM can self-correct rather than crashing the batch.
- `p-limit` for bounded item-level concurrency.
- `dotenv` for local `.env` loading.

The brief's required test is `npm run validate` (provided Ajv-based
schema + trace alignment validator). No additional test framework
beyond that — see "What I would do with another 4 hours" for the
test-coverage gap I'd close next.

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

- **Defense-in-depth on safety.** The deterministic safeguarding filter
  (`src/safety/safeguarding.ts`) runs every time, even on the LLM path,
  and is bilingual: English + Spanish across PedHITSS clinical
  categories (physical harm, verbal insults, threats, yelling, sexual
  abuse) plus fear-of-caregiver, unsafe-at-home, and self-harm. The
  matched phrase + category + language is passed to the LLM as a pre-
  screen hint; the orchestrator also force-overrides to P0 if the LLM
  disagrees. Safety is hardcoded, not delegated to a probabilistic
  system.

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

- **LLM telemetry.** `src/llm/telemetry.ts` captures `response.usage`
  on every `messages.create` call. End-of-batch summary writes to a
  `.telemetry.json` sidecar and prints to stderr: per-item tokens,
  turns, wall-clock, and cache hit ratio. Reviewers can see the cost
  and latency profile without re-running.

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

5. **Language detection & non-English safety.** Safeguarding patterns
   cover English AND Spanish across the PedHITSS clinical categories
   (physical harm, insults, threats, yelling, sexual abuse) plus fear of
   caregiver, unsafe-at-home, and self-harm. The gap that remains is
   other languages (Mandarin, Vietnamese, dialectal Spanish variants) and
   clinician-reviewed validation of the Spanish phrase set. Production:
   short-text language ID + per-language gold sets reviewed by bilingual
   clinicians.

6. **Cost & latency.** Per-item is 2–5 model turns in practice (telemetry
   on the visible 8-item inbox; emitted to stderr and written to a
   `.telemetry.json` sidecar). With prompt caching on the system +
   tool-definitions prefix, the dominant cost is the tool-result tokens
   and the per-item user message; observed cache-hit ratio is ~80–85% on
   warm batches. Production should track tokens-per-item, cache hit rate,
   p95 latency, and have a circuit breaker that flips to the
   deterministic path under load or outage.

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

1. **Vitest test suite + safeguarding gold set.** The brief only requires
   `npm run validate`, so I kept test scope at zero. A real submission
   would ship: (a) a labelled gold set for the safeguarding pre-filter
   with positives + hard negatives in EN/ES per PedHITSS category, and
   (b) per-item triage invariants (e.g. "item_3 OON Kaiser never calls
   hold_slot") run against the deterministic fallback so CI never spends
   LLM tokens. I built this during development and stripped it before
   submission to honour the brief's scope.
2. **LLM-as-judge eval harness.** Score every item's `decision_rationale`,
   `draft_reply`, and tool-call set against a clinician-reviewed rubric
   using Claude as the judge. Track regression batch-over-batch.
3. **Snapshot tests against a captured LLM run.** Record one LLM batch
   as the golden output; replay-style asserts on per-item invariants
   without spending tokens on every CI run.
4. **A `--explain item_3` CLI flag.** Print the matched signals, the tool
   trace, the system prompt prefix, and the final payload for one item.
   Much faster than re-reading `output.json` end to end.
5. **Retry with exponential backoff** on transient API errors (429 /
   5xx / network). Currently any LLM error falls back immediately to the
   deterministic path; a retry budget would shrink the fallback surface.
6. **Generate JSON schemas from Zod** via `z.toJSONSchema()` — kill the
   ~150 lines of duplicated tool input schemas in `src/llm/tools.ts`.

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
