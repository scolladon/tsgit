---
subjects:
  - src/repository/fixed-entry-layout.ts
  - src/index.browser.ts
---
# 717 — `resolveFixedEntryLayout` takes one overrides object

- **Status:** accepted
- **Date:** 2026-08-24
- **Design:** docs/design/common-dir-open-option.md (candidate D9)

## Context

The browser shim never calls `resolveLayout`; it builds its own outcome through
`resolveFixedEntryLayout(fs, workDir, gitDir, bare?, explicitWorkDir?)` — already five
positionals, three of them optional. `commonDir` would be a sixth.

## Options considered

1. **Collapse the trailing positionals into one `overrides: { bare?, workDir?, commonDir? }`
   object** (design recommendation) — pros: mirrors `LayoutOverrides`, which is what the
   parameters become downstream; one internal caller plus its unit tests / cons: a
   mechanical signature migration.
2. **Add a 6th positional** — cons: makes the next option worse.
3. **Node + memory only, refuse in the browser** — cons: breaks the runtime-parity
   contract and needs a browser-only refusal code.

## Decision

**Option 1 — adopted-as-recommended (no user judgment).**

The internal signature becomes `resolveFixedEntryLayout(fs, workDir, gitDir, overrides)`;
`commonDir` rides in the overrides object on all three runtimes.

## Consequences

- One internal caller (`index.browser.ts`) and its unit tests migrate in the same part.
- The option is argument-only and adapter-independent — no runtime consults an
  environment.
