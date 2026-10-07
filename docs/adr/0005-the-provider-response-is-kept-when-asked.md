# ADR 0005 — The provider's response is kept in the trace as data, when the policy asks for it

- **Status:** accepted
- **Date:** 2026-10-07
- **Decides:** Paolo Valletta

## Context

The trace answers two questions well: *what happened*, and *how much it cost*. It cannot
answer the interesting one when a run goes wrong in a way a person has to explain: *why did
it decide that*. The trace records the decision and the price of it, never the reasoning
that produced it or the alternatives the model weighed.

The reasoning is not the runtime's to interpret. It arrives in the provider's own format,
that format changes from one provider to the next, and a runtime that parsed it would be
maintaining a parser for something it does not own.

What is left is the question this ADR decides: **is the trace evidence, or a summary?**
Evidence means keeping what the provider actually returned, unread. A summary means reading
it in the provider's dashboard and living with two artifacts that can disagree.

## Decision

**`policy.raw` is a trace event, and the runtime never interprets it.**

A `Policy` may return the provider's response verbatim in `PolicyOutcome.raw`. When it does,
the loop writes a `policy.raw` event carrying it, through the same serialization and the same
64 KiB cap as tool output, so a body that is too large is truncated and says so rather than
being written as if it were complete.

It is **opt-in, per policy** (`openAICompatible({ recordRaw: true })`), because it is the
largest thing a trace can carry and the default trace should stay small. The event sits next
to the `policy.response` it explains: same step, same model.

The runtime does not parse, summarise or normalise it. A reader who wants the reasoning has
the bytes the provider sent, and the provider's documentation.

## Alternatives

| Option | Pros | Cons | Why not |
|---|---|---|---|
| always on | the question is always answerable | every trace grows by the full response of every step; most runs are never read | size is paid by everyone for a question few ask |
| never on | no size, no new format | the interesting question stays a shrug, and the answer lives in another tool that can disagree with the trace | the artifact that is supposed to explain the run is the one that cannot |
| parse the reasoning into fields | structured, queryable, comparable between runs | the parser is per provider, breaks on every provider change, and a guess about a format we do not own | reading the reason is not the runtime's job; keeping it is |
| a second artifact for reasoning | the trace stays small | two files that drift, two things to ship, one of them stale | an artifact that can disagree with the trace is worse than no artifact |

## Consequences

**We win:**
- "why did it decide that" is answerable from the trace itself, on the runs where someone
  asks for it, without the runtime owning a provider's format;
- the request is opt-in, so the default trace is exactly as small as before, and the existing
  tests that assert on traces do not change;
- no new personal data: the response contains the message and the tool arguments the
  `policy.response` event already carries.

**We pay:**
- a trace recorded with `recordRaw` is bigger, and replay comparison is strict: a replay whose
  policy does not make the same choice will differ from the trace, in the same way a replay
  with a different budget or step cap already does;
- whoever reads the raw body has to know the provider's format. That is the point, and it is
  still a cost;
- the raw body is another thing that ends up in a file people share. It carries no more than
  the decisions already do, but it carries it in a less curated form.

## Verification

A test must show that with `recordRaw: true` the `policy.raw` event is byte-identical to what
the provider returned, and that with the default there is no such event at all. If that test
ever needs changing, the boundary moved and this ADR must be updated.
