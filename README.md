# agentloop

> A small and readable agentic runtime. Four things: loop, tools, budget, replay.

```ts
import { Budget, ToolRegistry, openAICompatible, run, usd } from 'agentloop';

const result = await run({
  policy: openAICompatible({ model: 'gpt-4o-mini', apiKey: process.env.OPENAI_API_KEY! }),
  tools: new ToolRegistry([searchFlights]),
  messages: [{ role: 'user', content: 'How much does the cheapest flight from Naples to Rome cost?' }],
  budget: new Budget(usd(0.15)),   // required: see below
});

result.answer;      // "The cheapest is Wizz at 41 euros."
result.stopReason;  // 'end_turn'
result.spent;       // 0.000214 (µUSD: integers, never float)
result.trace;       // the trace, from which the run is redone
```

Zero runtime dependencies. Node ≥ 22.

---

## The problem

The most widespread agentic frameworks solve three things at once — the loop, the calls
to the provider, and a lot of convenience — and the result is that **the loop, which is
the hard part, can only be read by reading the framework's source**.

An agentic runtime should be able to answer four questions without effort:

1. **How much does this run cost, right now?** Not at the end: *right now*.
2. **What happened?** Not a log: a trace you can write a test against.
3. **Can this run be redone?**
4. **Did the agent pass the right arguments to the tool?** It got them wrong at least once.

It is these four, not the number of features, that make the difference between a
prototype and something that runs in production.

## What it does

- **Declarative loop.** State in, events out. Every effect — calling a provider,
  executing a tool — goes through an interface.
- **Tools with input validated by JSON Schema.** Wrong arguments never reach the code,
  and the error goes back to the model in readable form so it can fix itself.
- **Budget with reservation.** Estimate first, settle after. The cap holds **in front
  of** the spend, not after it.
- **Append-only trace in JSONL.** With redaction declared for sensitive tools.
- **Deterministic replay.** A run is redone from a trace without touching the network.

## What it does NOT do

| It does not do | Why not |
|---|---|
| Token-by-token streaming | it costs stateful complexity that is not needed here. It is the first candidate when it is really needed |
| Multi-provider routing, retries, caching | that is the job of [`llmgateway`](../llmgateway) |
| Parallel tool calls | it makes the reordering of events non-deterministic |
| Persistence, long-term memory | a runtime with no state of its own can be reused anywhere |
| UI, structured logging, telemetry | this is not a service library: bring your own adapters |

The denied perimeter is written out in full in [`docs/rfc/0001-perimeter.md`](docs/rfc/0001-perimeter.md).

---

## The three guarantees

### 1. The budget cannot be bypassed

`budget` is a **required parameter**, not optional with a default. A default will be
forgotten, and the case where it is forgotten is exactly that of a loopy agent calling a
paid provider. If you do not need the cap, declare it: `Budget.unlimited()`.

The mechanism is reserve → settle:

1. `reserve(estimate)` locks the estimated amount right away; if it does not fit, the
   decision **is not executed** and costs nothing;
2. the call actually happens;
3. `settle(actual)` replaces the estimate with the real consumption and releases the rest.

Amounts are **integer micro-dollars** with a branded type. `0.1 + 0.2 !== 0.3`,
and on an invoice the difference is a hole. A model missing from the price table is
valued at the **maximum** known price, not at zero: a zero price means "the budget
protects something" while it protects nothing.

```ts
const budget = new Budget(usd(0.01));
await run({ policy, messages, budget });   // stopReason: 'budget' if it is not enough
budget.spent;    // never > limit
```

### 2. The model's arguments are not trusted

A tool that received wrong input fails in an understandable way: the error goes back to
the model, which fixes it.

```ts
// the model produced { from: 42 }
content: 'ERROR: The arguments for "search_flights" are not valid (1 problems):
  - /from: expected string, received number 42
Fix only the fields listed and call "search_flights" again.'
```

All errors together, not the first one: otherwise a model that gets three fields wrong
would fix them one at a time and take three turns.

And there is a boundary beyond that: if a tool raises an **unexpected** error, the model
does not see the error text. It sees a neutral message built by the runtime. The reason
is in [`ADR 0004`](docs/adr/0004-what-is-shown-to-the-model.md): an agent receives that
text and uses it to answer **whoever is talking to it**.

### 3. The run is redone

```ts
const { result, equal, warnings } = await replay(traceJsonl, { tools: registry });
// equal    → true: the exact same execution, with no network and spending nothing
// warnings → did the tool change? the trace no longer describes its behavior
```

Three modes, declared by the caller:

| mode | policy | tool | what it is for |
|---|---|---|---|
| `full` | from the trace | from the trace | regression tests on the loop, audit, offline demo |
| `live-tools` | from the trace | **real ones** | "what changes if the tool changes?" |
| `dry-run` | from the trace | skipped | how much of the run depends on the tools? |

Replay is not a second code path: it is **the same loop** with a `Policy` that reads
from disk inside it. It was possible only because decision and execution are already
interfaces.

And if the tool changed, `warnings` says so with the code fingerprint. A trace that
reproduces something different, silently, is a trace that lies.

---

## Usage

```bash
npm install
npm run ci        # typecheck + lint + test: what runs in CI

export OPENAI_API_KEY=...
npm run example                                    # runs the agent and writes the trace
npx tsx examples/flight-agent.ts --replay traces/flight-agent.jsonl
```

`make ci` exists and does the same thing, for whoever has `make`.

## How it is built

```
src/
  types.ts      the types that flow through everything (readonly: state is not mutated)
  errors.ts     every failure has a type
  budget.ts     reservation, settlement, micro-dollars
  schema.ts     the allowed JSON Schema subset
  validate.ts   the validator: structured errors, never exceptions
  tool.ts       registry, checks on the way in, what is shown to the model
  trace.ts      append-only events, redaction, explicit degradation
  loop.ts       the cycle
  replay.ts     redoing a run from a trace
  policy-openai.ts  the only file that knows the outside world
```

Replay is the proof that the structure holds: if `Policy` and `Tool` were not
interfaces, there would be a second loop to maintain, and the two would diverge.

## Documents

- [RFC 0001 — the perimeter](docs/rfc/0001-perimeter.md): what it does, what it does not, why
- [ADR 0001](docs/adr/0001-loop-as-reducer.md): the loop is state in, events out
- [ADR 0002](docs/adr/0002-json-schema-validator.md): an in-house validator, in a subset
- [ADR 0003](docs/adr/0003-replay-and-tools.md): the three replay modes
- [ADR 0004](docs/adr/0004-what-is-shown-to-the-model.md): what may end up in front of a model
- [ADR 0000](docs/adr/0000-record-architecture-decisions.md): how ADRs are written

The decisions weigh as much as the code: if one of them is wrong, the code is a
consequence.

## What I would do differently

- **Streaming.** I ruled it out for the perimeter, but it is the thing a user notices
  first, and an agentic runtime without it feels fake. It comes in first.
- **Parallel tools.** Ruling it out made replay deterministic with little effort. But an
  agent that has to read five files in parallel is a real case, and there the order of
  events must be decided explicitly, not inherited.
- **`Budget.unlimited()` is a door.** It exists because forcing the cap without giving an
  honest way out produces `new Budget(1e18)` scattered everywhere. That is fine, but if
  an audit is needed in the future, a budget declared `unlimited` should make itself
  noticed.
- **The tool fingerprint only covers the body of `execute`**, not the imported helpers.
  A change inside a helper does not invalidate the trace. I chose the limit because the
  alternative (hashing the import graph) costs more than the benefit.
- **The decisions of a `Policy` are not inspectable.** I can record the trace and the
  cost, not the reasoning. Whoever wants to understand *why* it chose a tool will have to
  go into the provider.

## Development

```bash
git clone git@github.com:paoValle/agentloop.git && cd agentloop
npm ci && npm run ci
```

## License

MIT © Paolo Valletta
