# RFC 0001 — The perimeter of `agentloop`

> Before writing a line of code: what is being discussed, what is not, and why.
> Status: **accepted**. The technical decisions that follow from it live in `../adr/`.

## The problem

The most widespread agentic frameworks solve three things at once: the loop, the calls
to the provider, and a lot of convenience (memory, retries, streaming, telemetry, an
"agentic" interface). The result is that the loop — which is the hard part — becomes
**readable only by reading the framework's source**.

The questions an agentic runtime should be able to answer without effort:

1. **How much does this run cost, right now?** Not "at the end", *right now*. An agentic
   loop that calls a tool ten times before noticing it overran is a financial incident,
   not a bug.
2. **What happened?** Not a text log: an **append-only trace** that can be reopened, and
   against which a test can be written.
3. **Can this run be redone?** If an agent did something wrong, the useful question is
   not "why" but **"do I redo the run with the same policy and the same inputs, and get
   the same output?"**
4. **Did the agent pass the right arguments to the tool?** Tools are called by a model
   that has been wrong at least once. Validation is not optional.

## What it does

- A declarative **loop**: state in, events out, no implicit magic.
- **Tools** with input validated by JSON Schema, errors that go back to the model as a
  message (so it can self-correct) instead of blowing up the process.
- **Budget** with reservation: estimate first, settle after. Cost is measured in integer
  micro-dollars, never in `float`.
- **Trace** append-only in JSONL, with redaction declared per field.
- **Deterministic replay**: a run is re-executed from a trace without touching the network.

## What it does NOT do (denied perimeter)

| It does not do | Why not |
|---|---|
| Token-by-token streaming | It costs stateful complexity that is not needed here. It is the first candidate when it is really needed. |
| Multi-provider routing | That is the job of `llmgateway`. Two responsibilities = two bugs. |
| Parallel tool calls | It makes the reordering of events non-deterministic. Out until it is needed. |
| Persistence / long-term memory | A runtime with no state of its own can be reused anywhere. |
| UI, structured logging, telemetry | This is not a service library. Whoever uses it brings their own adapters. |

## The success contract

The project is done when:

- [ ] a complete run is re-executed from a trace and produces the **same final state**, test included
- [ ] the budget **cannot** be exceeded, not even with tools that talk to paid providers
- [ ] an invalid tool argument produces a **readable** error and the loop continues
- [ ] `make ci` green: strict typecheck, lint, test
- [ ] the README can be read from top to bottom in five minutes

## Rejected alternatives

- **Adopting an existing framework** and learning it: faster today, but my GitHub would
  still show *nothing* of mine. The goal here is a portfolio piece whose code is mine
  and which I can explain.
- **Writing only a `while` with `openai`**: four lines and zero signal. The value is in
  the boundaries (budget, validation, replay), not in the loop.

## Open questions

- Should replay redo the **tools** or only the **policy**? Redoing the tools is more
  useful for testing the loop, but it is not always possible (the external provider has
  been cancelled). → solved in ADR 0003, with a flag.
- Is streaming needed for the voice use case? Yes, but in `voicebridge`, where the
  latency constraint is different. Not here.
