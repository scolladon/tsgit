---
subjects:
  - src/application/primitives/internal/alternate-chain.ts
---
# 917 — Alternate paths are canonicalised by a realpath walk through the port

- **Status:** accepted
- **Date:** 2026-10-01
- **Design:** docs/design/alternates-object-lookup.md (DC-4) · **Supersedes/Refines:** refines ADR-226 (git-faithfulness)

## Context

git resolves each entry relative to the realpath of the objects dir that holds the file and
deduplicates by `strbuf_realpath` (Pins R, D, O1). Lexical collapse diverges whenever a symlinked
component precedes `..`.

## Options considered

1. **Emulate realpath through the port** (`lstat` + `readlink` walk, missing last component tolerated) (recommended).
2. **Runtime-supplied realpath capability** — cons: one more hook per adapter.
3. **Lexical collapse only** — cons: diverges on Pins D3/D4/O1.

## Decision

**Adopted-as-recommended (no user judgment) — option 1.** Exact on adapters with symlinks, lexical
where none exist (OPFS). One walk per alternate per session.

## Consequences

- Dedupe and self-reference detection compare realpaths, honouring `core.ignoreCase`.
