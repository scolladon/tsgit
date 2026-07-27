# 517 — Every published entry's declaration surface matches its runtime exports

- **Status:** accepted
- **Date:** 2026-07-27
- **Design:** docs/design/close-isogit-perf-gap.md · **Supersedes/Refines:** widens ADR-512's guard to the whole entry matrix

## Context

The declared-vs-runtime guard built for the diff-barrel fix revealed a wider class: rollup-plugin-dts shares declaration chunks across the package's published entry points, so a symbol that is a genuine value export at one entry (e.g. a primitive on its subpath entry) leaks a value-shaped declaration into the main entry's `.d.ts`, where it is `undefined` at runtime. `import { readBlob } from '@scolladon/tsgit'` type-checks and crashes.

## Options considered

1. **Truthful types (recommended)** — fix the `.d.ts` bundling/post-processing so each entry declares exactly its runtime value exports; the bad import becomes a compile error / no completion. No runtime change, no surface expansion.
2. **Expose everything** — make the main entry's runtime match the leaked declarations. Pros: declared surface becomes real / cons: a large deliberate public-surface expansion with every attendant gate.

## Decision

**Option 1 (user-ratified).** Each published entry's built declaration file must declare exactly the value exports its built runtime chunk provides. The declared/runtime guard is widened from the diff barrel to **every published entry**, so any future chunk-sharing drift fails the suite instead of shipping a compile-green runtime crash.

## Consequences

Consumers get a compile-time error instead of a runtime `undefined` for symbols that were never really on an entry. The facade (`openRepository`) and the subpath entries remain the supported routes to primitives/commands. Any future intent to expose primitives from the main entry is a deliberate ADR-level surface change, not a bundling accident.
