# ADR 0003 — Replay redoes the tools, with a way out

- **Status:** accepted
- **Date:** 2026-10-04
- **Decides:** Paolo Valletta

## Context

A trace contains everything that happened in a run: the model's response, the arguments
passed to the tool, its result. Two possible replays:

- **policy-only replay**: the model's decisions are recomputed from the trace, but the
  tools **really run**;
- **full replay**: the tool results also come from the trace, the tool code is not executed.

They are not equivalent, and the choice depends on who needs the replay.

Full replay is for **regression tests on the loop**: "if the loop changes, does the
sequence of decisions change?". But it is useless if the tool has external dependencies,
and full replay avoids them: the loop can be tested with no network and no database.

Policy-only replay is for **understanding what would happen**: "if my change to the policy
changed the decision, what would it be?". Here the tools must run, otherwise the answer is
false.

The problem: one single semantics does not work for both.

## Decision

Replay has **three modes**, declared by the user:

| Mode | Policy | Tool | What it is for |
|---|---|---|---|
| `full` | from the trace | from the trace | regression tests on the loop, audit, offline demo |
| `live-tools` | from the trace | **really executed** | "what would happen if the tool changed?" |
| `dry-run` | from the trace | **skipped**, result from the trace but ignored | measuring how much of the run depends on the tools |

Every tool event in the trace carries the tool `name` and a **hash of its source code**
(`tool.fingerprint`). In `full`/`dry-run` mode, if the current tool fingerprint does not
match the recorded one, replay **does not fail silently**: it raises a warning that the
result comes from a different version of the tool. The silent fallback is how a trace
becomes a lie.

## Alternatives

| Option | Pros | Cons | Why not |
|---|---|---|---|
| full replay only | simple, deterministic | a test on the loop cannot tell "the loop changed" from "the tool changed" | a false green is the worst risk of a test |
| live-tools replay only | a useful replay | not testable offline, not deterministic | it does not meet the reproducibility goal |
| replay with VCR (records HTTP) | intercepts at the network layer | loses pure tools, is not local, and ties the trace to a library | the right granularity is the **tool**, not the HTTP request |

## Consequences

**We win:**
- a real test on the loop: `replay(trace, 'full')` and the equality of the final state;
- a way to evaluate a change to the policy without spending tokens;
- the trace stays honest: every replay declares where the data comes from.

**We pay:**
- the hash of the tool code in the fingerprint: if you change one line of the tool, the
  trace "ages". That is the intended behavior, and the warning says so.
- `live-tools` is **not deterministic** by definition: it must be used only in environments
  where that is accepted, and its comparisons are informative, not assertive.

## Verification

The `replay.test.ts` test must have at least one case that changes the tool and verifies
that the warning appears. If it is not there, the silent fallback comes back and this ADR
must be revised.
