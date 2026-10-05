# ADR 0002 — JSON Schema validation built in-house, in a subset

- **Status:** accepted
- **Date:** 2026-10-04
- **Decides:** Paolo Valletta

## Context

A tool's arguments are produced by a model. They are untrusted data: they get the format,
the type and the values wrong. Without validation, a tool that expects
`{ from: date, to: date }` finds `{ from: "yesterday", to: 2026 }` and has to guess.

The most widespread JSON Schema validation library in TypeScript is `ajv`, which is
~120 kB installed and is in practice **a project of its own**: bundle size, a plugin per
keyword, its own documentation. For a runtime that wants to stay under 1000 lines, it is
the biggest bottleneck of the project.

The point, though, is not the size: it is that **validation errors become the input of the
agent's correction**. The model must read a message like
`args.to: expected ISO-8601 string, received 2026` and fix it. So the API must return a
**list of errors with path and message**, not throw an opaque exception to show a developer.

## Decision

A hand-written validator, covering an **explicit subset** of JSON Schema Draft 2020-12,
with two non-negotiable properties:

1. **structured errors**, never exceptions:
   ```ts
   validate(schema, value): ValidationError[]   // empty = valid
   ```
   with `ValidationError = { path: string; message: string }` and `path` in JSON Pointer
   notation (`/args/to`), because the model must be able to quote the field.
2. **a declared and tested subset**: `type`, `properties`, `required`,
   `additionalProperties`, `enum`, `items`, `minimum`, `maximum`, `minLength`,
   `maxLength`, `minItems`, `maxItems`, `anyOf`. No `oneOf`, no `if/then`,
   no `$ref`, no regex patterns.

An unsupported keyword is an **explicit development error** (it throws at startup, not at
runtime on a user input): if someone writes `"pattern": "^\\d+$"` in a tool schema, they
must notice immediately, not discover that the field was not being validated in production.

## Alternatives

| Option | Pros | Cons | Why not |
|---|---|---|---|
| `ajv` | complete, battle-tested, supports every keyword | ~120 kB, a plugin per keyword, an API designed around the exception | the 4 errors we need fit in 120 lines |
| `zod` | great DX, type inference | static types are already covered by TS; a second validation system | overlaps with `validate` and with the compiler |
| hand validation per tool | zero code | every tool rewrites the same checks, and gets them wrong in a different way | you pay N times instead of once |
| full JSON Schema | no surprises | ~2000 lines, pattern subsets, remote `$ref`, formats | it is a project, not a module |

## Consequences

**We win:**
- zero dependencies, therefore zero CVEs to track and zero review discussions;
- the error format is **ours**, so we can write the message so that a model understands it
  and fixes it (that is half the value of this project);
- every supported keyword has a test, and the set is readable in 30 seconds.

**We lose:**
- schemas with `$ref` or `oneOf` are not fine: tool authors must stay away from them. It is
  written in the README and in the docstrings;
- if one day formats are needed (`format: date-time`), the subset grows — and when it grows,
  `ajv` comes back to the table. **It is a price, not a dogma**: if the subset exceeds half
  of the project's code, the decision must be revised.

## Verification

If the real tools I wrote started duplicating checks by hand, or if `validate` exceeds 250
lines, the subset is wrong: `ajv` is re-evaluated.
