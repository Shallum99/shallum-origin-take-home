# Origin AI Engineering Take-Home: Referral Inbox Triage Agent

This is my submission for the Cedar Kids Therapy Monday inbox triage prototype.
The agent reads `data/inbox.json`, runs a deterministic pipeline per item, calls
the provided tools to build an audit trail, and emits a human-reviewable
`output.json` that passes `npm run validate`.

## How to run

```bash
npm install
npm run triage   -- --input data/inbox.json --output output.json --trace .trace/tool-calls.jsonl
npm run validate -- --input data/inbox.json --output output.json --trace .trace/tool-calls.jsonl
```

Both commands also work with no flags and default to the same paths. No API
key is required — the agent is rules-based at runtime (see below for why).
End-to-end on the 8-item inbox runs in well under a second.

`npm run typecheck` is also available.

## Stack and runtime

- TypeScript on Node LTS, executed via `tsx`. No transpile step.
- Existing dependencies only: `ajv` / `ajv-formats` (validator), `ulid`
  (deterministic-ish IDs in the trace tooling), `tsx` (runner).
- No runtime LLM call. The provided synthetic items are structured enough that
  regex-based extraction is reliable, faster, and reproducible across runs.
  Reviewers without an API key get identical output. The "what I would do with
  another 4 hours" section discusses where I would reintroduce an LLM.

## Architecture

Per-item pipeline, end to end inside one `withItemContext(item.id, ...)`:

```
inbox item
   │
   ▼
extract.ts ──── intake fields + signals (safeguarding, language, same-day,
   │            clinical-question-only, missing-paperwork, contact channels)
   ▼
triage.ts ──── classification + urgency from signals.
   │            Safety-first ordering: safeguarding > same-day cancel >
   │            clinical question > missing paperwork > new_referral.
   ▼
handlers.ts ─── one handler per classification. Calls tools, branches on
   │            tool results (e.g. in-network vs. OON vs. expired), drafts
   │            a message, creates a task, optionally escalates.
   ▼
agent.ts ───── assembles ItemOutput, attaches `tools_called` straight from
                getToolCallsForItem(item.id), hardcodes requires_human_review.
```

The design decisions worth flagging:

- **Signal-based dispatcher, not item-id switches.** The README warns that
  similar synthetic variants will be run during review. `triage()` branches
  on detected signals (safeguarding keyword set, Spanish token frequency,
  same-day language, `[blank]` counts, payer recognition) so it generalizes
  beyond the 8 visible items.

- **Safety-first ordering.** `triage()` checks the safeguarding signal first
  before any other classification — including before scheduling intent.
  Item_2 reads on its surface as a same-day evaluation request, but the
  caregiving disclosure dominates and routes to P0 / clinical lead with a
  neutral draft. The matched phrase is included verbatim in the escalation
  `reason` so the clinical lead can audit *why* the agent escalated.

- **`requires_human_review: true` is a hardcoded policy.** Every output is
  advisory. The agent never auto-sends, never schedules, never holds
  anything as "approved." This is a property of the prototype, not a
  computed flag, so I set it in `agent.ts` as a literal.

- **Tool orchestration follows the policy hierarchy in `data/policies.md`.**
  In particular, the in-network branch does `find_slots` + `hold_slot`, but
  the out-of-network and expired branches deliberately do not — per policy,
  any benefits conversation must precede a slot hold. The expired branch
  also surfaces the billing-system-supersedes-referral discrepancy in the
  rationale (item_3-style cases).

- **`tools_called` is never hand-built.** Each handler issues real tool
  calls inside `withItemContext`, and the final array comes straight from
  `getToolCallsForItem(item.id)`. This keeps the trace-match validator
  happy and means I cannot accidentally drift the audit story from what
  actually happened.

- **Existing-patient handling.** Item_4 (Mateo Ramirez) hits `search_patient`
  and finds an existing chart whose guardian-on-file (Sofia Ramirez) does
  not match the sender (Carla Mendez). The handler surfaces this guardian
  mismatch in the decision rationale and the intake task. I left the
  classification as `new_referral` rather than `existing_patient_request`
  because a pediatrician sent a fresh referral document — the chart match
  is information for the front-desk callback, not a change in the request
  type. Reasonable people could split this differently; I called it once
  and was consistent.

## Failure modes and production eval

The triage decisions reviewers should worry about most:

1. **Missed safeguarding (false negative).** The cost asymmetry here is
   enormous: an over-escalation wastes a clinical lead's time; a missed
   escalation can mean failing a child. My regex set covers the obvious
   English phrases (`abuse`, `neglect`, `rough with`, `unsafe at home`,
   `afraid of dad`, etc.) but it will miss euphemisms, oblique disclosures,
   and any Spanish-language safeguarding cue. In production this should be
   an LLM classifier with calibrated thresholds, plus a human-in-the-loop
   review every time the agent decides *not* to escalate a safeguarding-
   adjacent item, with eval driven by:
   - a clinician-labeled gold set of safeguarding cases (including hard
     negatives — clingy, sad, behavioural without unsafe caregiving)
   - precision/recall reported per language and per channel
   - explicit tracking of false-negative rate; that is the metric that
     decides whether the system ships

2. **Brittle extraction.** Regex extraction is hostage to format drift —
   adding a new payer, a new fax template, or a new voicemail transcription
   provider can silently degrade quality. In production: LLM-assisted
   extraction with the regex layer kept as a deterministic fallback and an
   eval set of `(message, expected_intake)` pairs.

3. **Payer / coverage drift.** `verify_insurance` is mocked but in
   production the in-network set drifts as contracts change. The agent
   should consult an authoritative payer table rather than carrying its
   own list, and the rubric for "in-network vs. OON" should live in
   billing, not in the agent.

4. **Over-escalation.** The brief calls this out explicitly. My triage rule
   biases toward P0 only when the safeguarding regex hits, and defaults to
   P2 otherwise — but a richer eval should track over-escalation rate by
   classification, especially for clinical-question and missing-paperwork
   cases that are tempting to flag P1.

5. **Language detection precision.** I detect Spanish from a token count;
   that works on the synthetic dataset but is too coarse for real use. A
   short-text language identifier would be the production pick, and the
   draft templates would route through the same translation layer.

6. **Draft tone drift.** Templated drafts are predictable but easy to
   identify as templates. The production version should use an LLM with a
   strict system prompt forbidding clinical advice and forbidding any
   statement that implies a message was sent, plus an automated
   LLM-as-judge eval against a clinician-reviewed rubric.

## What I chose not to build, and why

- **No runtime LLM call.** I scoped this prototype to deterministic
  extraction because (a) the synthetic dataset is structured, (b) reviewers
  may not provision a key, and (c) reproducibility matters more than
  surface-level "wow" for a triage layer. The architecture leaves the door
  open: replacing `extract.ts` with an LLM-backed extractor is a localized
  change.

- **No multi-discipline triage on a single referral.** Real referrals can
  ask for SLP+OT or OT+PT; I capture multiple disciplines if multiple
  keyword sets hit, but I don't split into multiple intake tracks or hold
  one slot per discipline. The hold-slot logic uses the first parsed
  discipline. In production this would split into per-discipline subtasks.

- **No retry / backoff around tool calls.** The mock tools never fail, so
  I haven't wired retries. The trace's `audit_exempt: "retry"` field hints
  at what a real implementation would look like — record exempt entries
  for failed attempts, surface only the successful call in the output.

- **No richer existing-patient diff.** I surface the guardian-name mismatch
  in item_4 because it materially changes the front-desk workflow, but I
  don't reconcile a richer diff (e.g. payer-on-file vs. payer-on-referral).
  Production would inspect the chart deeper.

- **No mandated-reporter pathway.** Per policy I escalate safeguarding to
  the clinical lead and let them decide. A real practice has a documented
  mandated-reporter workflow with timestamps, who-reported-to-whom, and
  an attached form. That belongs behind the `escalate` tool, not in the
  agent.

- **No multi-language coverage beyond Spanish.** Detection thresholds are
  English-vs-Spanish only.

## What I would do with another 4 hours

1. **LLM-backed extraction with regex fallback.** Same I/O contract as
   `extract.ts` today, but the LLM call fills `ExtractedIntake` directly
   from the inbox body, with strict JSON-schema-shaped output. Run it
   against the existing 8 items as a smoke test, then add a labeled gold
   set and compute per-field accuracy.

2. **LLM-backed draft generation.** Keep the current templates as the
   fallback (no key required), but swap to an LLM for the actual body
   when a key is present, gated by a strict system prompt:
   "no clinical advice; do not state the message has been sent; respect
   the requested language." Add a deterministic LLM-as-judge check that
   rejects any draft mentioning a specific diagnosis, treatment, or
   guarantee.

3. **Eval harness.** A `test/triage.spec.ts` that runs `runAgent` against
   `data/inbox.json` and asserts per-item classification, urgency, and
   the presence of specific tool calls. Add a small "hard variants" set
   that perturbs the visible items (renamed payers, single-word names,
   safeguarding disguised in normal language) so the regression surface
   matches what reviewer variants would actually look like.

4. **Per-classification metrics in the output summary.** Today the summary
   reports `p0_count`, `p1_count`, and `requires_human_review_count`. I'd
   add `per_classification`, `tool_call_density`, and time-to-decision so
   ops can spot drift batch-over-batch.

5. **Tighter retry & idempotency.** Wire `audit_exempt: "retry"` for any
   tool that throws, record it on the trace, and re-attempt with a small
   bounded loop so a flaky downstream doesn't break a whole batch.

6. **A simple inbox CLI.** A `--explain item_3` flag that prints the
   matched signals, the chosen branch, and the tool-call trace for a
   single item — much faster to iterate than re-reading `output.json`
   from a full batch run.

---

## Original brief (preserved)

> Origin builds software for pediatric therapy practices. In this assignment,
> you are helping a fictional practice, Cedar Kids Therapy, triage its Monday
> inbox.

### Scenario

It is Monday at 8am at a multi-disciplinary pediatric therapy practice
supporting speech-language pathology, occupational therapy, and physical
therapy. The shared inbox accumulated items over the weekend from pediatrician
fax referrals, parent voicemails, parent portal messages, and emails. Build an
AI agent prototype that turns the messy batch into a sorted, human-reviewable
action plan.

### Urgency calibration

- `P0`: safeguarding, imminent harm, mandated-reporter escalation. Same-hour human review.
- `P1`: same-day operational issue requiring prompt staff action.
- `P2`: normal intake, scheduling, billing, or clinical-review workflow.
- `P3`: low-priority admin, FYI, spam.

Default to `P2` unless there is a clear safety or same-day operational reason. Over-escalation is itself a production failure mode.

### Constraints (respected by this submission)

- TypeScript / Node LTS / npm.
- Provided tools in `src/tools.ts` used as-is — not modified, not bypassed.
- More than 3 distinct tools used across the batch (`search_patient`,
  `verify_insurance`, `lookup_policy`, `find_slots`, `hold_slot`,
  `create_task`, `draft_message`, `escalate`).
- All item-level tool calls wrapped in `withItemContext(item.id, ...)`.
- `tools_called[]` populated by `getToolCallsForItem(item.id)` — passed
  through unchanged.
- Final batch output assembled via `buildBatchOutput(items)`.
- No auto-send; `draft_message` only.
- No scheduling; `find_slots` / `hold_slot` only as reviewable suggestions.
- Only synthetic data; no real PHI; API keys never committed.

### Rubric (reviewer-facing)

- Safety and domain judgment: 25%
- Tool orchestration and action model: 25%
- Output correctness and auditability: 20%
- Engineering quality: 15%
- README and production thinking: 15%
