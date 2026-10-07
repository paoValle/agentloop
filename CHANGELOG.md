# Changelog

Format [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
versioning [SemVer](https://semver.org/).

## [Unreleased]

### Added
- `policy.raw`: the provider's response, verbatim, in the trace, when a policy is configured with
  `recordRaw`. The runtime stores it as data and never interprets it (ADR 0005); the event sits next
  to the `policy.response` it explains and goes through the same truncation as tool output. Off by
  default, because it is the largest thing a trace can carry.

## [0.1.0] - 2026-10-04

First usable version. No stability promised: it is a side project.

### Added
- `run()`: the agentic cycle, with reservation budget and step cap
- `Budget`: reserve → settle, integer micro-dollar amounts, `unlimited()`
- `ToolRegistry`: name, description, schema and uniqueness checked on the way in
- JSON Schema validator over a declared subset, with JSON Pointer errors
- `ToolError`: the only intentional way to say something to the model (ADR 0004)
- `Trace`: append-only events, JSONL, redaction for sensitive tools, explicit degradation
- `replay()`: three modes (`full`, `live-tools`, `dry-run`) and a warning if the tool changed
- `openAICompatible()`: adapter for OpenAI-compatible chat endpoints

### Notes
- No runtime dependencies. Node ≥ 22.
- Streaming, parallel tools and multi-provider are outside the perimeter: see
  [RFC 0001](docs/rfc/0001-perimeter.md).
