# ADR 0001 — The loop is a reducer: state in, events out

- **Status:** accepted
- **Date:** 2026-10-04
- **Decides:** Paolo Valletta

## Context

The heart of an agentic runtime is a cycle that alternates two actions: asking a model
for a decision, and executing a tool based on that decision. The most widespread
implementations write it as imperative code that calls the provider and the tool directly:

```ts
while (true) {
  const res = await client.chat({ messages, tools });   // effect: network
  if (res.toolCall) await tools[res.toolCall.name](res.toolCall.args);  // effect: the world
  else return res.text;
}
```

This shape is convenient to write and inconvenient for everything else:

- you cannot **reproduce** the run unless you can call the provider, which costs money
  and returns a different answer on every call;
- you cannot **test** the loop without a network or a clumsy mock;
- you cannot know **where** in the run you are without having read every line;
- an error inside a tool leaves you mid-run, with inconsistent state in memory.

## Decision

The loop is an **explicit reduction function**: it receives the state, produces a list of
**events**, and every effect (provider call, tool execution) goes through an interface
that can be replaced with a version that reads from the trace.

In practical terms:

- the run state is a **new object** at every step, never mutated;
- everything that touches the outside world is a `Policy` (decides) or a `Tool` (acts),
  both interfaces;
- every step produces a `TraceEvent` **before** producing the next step:
  the trace is the log, not an addition;
- replay is the same function with a `Policy` and a `ToolRegistry` filled from the
  trace. There is no second code path to maintain.

## Alternatives

| Option | Pros | Cons | Why not |
|---|---|---|---|
| Direct imperative | less code, immediately readable | not reproducible, testable only with fragile mocks | replay and testing are the point |
| Redux-style with a pure reducer | already solved, well-known libraries | 3 dependencies and one more concept for a 5-step cycle | the idea is right, the framework is overkill |
| Full event sourcing, every step persisted | 100% reproducible | persistence, GC, snapshots: complexity that does not pay off at the first use | the in-memory trace + JSONL covers 90% of cases |

## Consequences

**Becomes possible:**
- reproduce a run and **assert** that the final state is identical → a real test,
  not an eyeball check;
- test the loop with a scripted `Policy`, with no network and no sleep;
- inspect a run halfway, because the events are already written;
- take a trace to production and re-analyze it offline.

**Becomes impossible or inconvenient:**
- using the loop without tracing: it is not the default, it is the fixed cost;
- adding a "just call the provider" shortcut: there is no hole to slip it into.

**The real cost:** one more state to model and one more serialization to write. I pay it
in full at the first reproduced run, and I do not pay it at all if the project stays a
local library.

## Verification

If in three months there is no test that rereads a trace and asserts the equality of the
final state, this decision was a useless weight: it must be revised.
