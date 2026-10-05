# ADR 0004 — The model is shown the error the tool author wrote, and nothing else

- **Status:** accepted
- **Date:** 2026-10-04
- **Decides:** Paolo Valletta

## Context

A failing tool does not interrupt the run: the error is put back into `role: 'tool'` and
the model decides what to do. For that to work, the message must be useful to the model.

The delicate point is *what to put in it*. The reflex is to put `error.message` in it.
But unstructured exceptions come from everywhere: an `ECONNREFUSED`, an
`Invalid API key`, a SQL query with table names, a filesystem path.
An agent receives that text and uses it to answer **whoever is talking to it**: if the
caller is an end user, the API key ends up in a response. No attacker is needed: an agent
that tells what it found is enough.

On the other hand, a too-generic message ("internal error") is useless: the model cannot
fix what it cannot see.

## Decision

Two error classes, two treatments.

**`ToolError`** is the error the tool author wrote **to be read by the model**. It goes
entirely into the message, plus its `cause` if it has one. Whoever writes the tool knows
what they are saying.

**Any other error** — `TypeError`, an error from a library, a network error — becomes a
**neutral message built by the runtime**, with the real error going only into the trace.
The model sees:

```
tool "load_orders" failed with an internal error (reference: step-3/tool-1).
Retry with the same arguments only once; if it fails again, explain to the user
that the service is unavailable.
```

The text is the same for every tool: nothing can leak, because it contains nothing from
the tool. The `reference` correlates with the trace, where the cause is.

## Alternatives

| Option | Pros | Cons | Why not |
|---|---|---|---|
| always `error.message` | maximum detail, less friction | any unexpected error becomes an escape channel to the outside | the rare case is the one you did not foresee |
| always generic | no leak | the model cannot fix even validation errors, which are already safe | it throws away the only recoverable case |
| keyword filter (`key`, `token`, `password`) | looks prudent | it is a blacklist: the first new message gets past it. A false sense of security | the right boundary is the origin of the error, not its text |

## Consequences

**We win:**
- a `ToolError` becomes the only intentional way to say something to the model. The
  separation is explicit in the code, not conventional;
- a tool author must declare, by writing the class, that the message is meant for an
  untrusted reader;
- the trace keeps the cause, so debugging loses nothing.

**We pay:**
- 90% of tools will have to write `ToolError` explicitly for their expected errors. It is
  the most boring part and also the most important one;
- a badly written `ToolError` is still a leak. No type saves you from an author who writes
  `"key sk-..."` inside a `ToolError`: what counts here is review.

## Verification

A test must take a tool that raises `Error("token sk-live-123")` and verify that the string
`sk-live-123` does **not** end up in the message. If one day that test needs changes, the
boundary has moved and this ADR must be updated.
