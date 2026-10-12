---
subjects:
  - src/ports/context.ts
  - src/adapters/node
  - src/adapters/browser
  - src/adapters/memory
  - src/domain/eol/crlf-action.ts
---
# 957 — The native line ending is adapter-supplied

- **Status:** accepted
- **Date:** 2026-10-12
- **Design:** docs/design/eol-conversion.md · **Supersedes/Refines:** refines ADR-226

## Context

git fixes `EOL_NATIVE` at compile time — CRLF on Git for Windows, LF everywhere else. It governs
`core.eol=native` and, for a `text` path, an unset `core.eol` when `core.autocrlf` is unset or
false (step 4 of the CRLF-action table, §D3.1 of the design). tsgit runs where git does not: the
browser has no OS line ending, and the memory adapter has no OS at all. This is the one choice in
the feature that matching git cannot settle.

## Options considered

1. **Adapter-supplied** — Node: `process.platform === 'win32'` → crlf, else lf; browser and
   memory → lf (recommended). Pros: matches the git a user would run beside tsgit on each OS.
   Cons: platform-dependent worktree bytes on Windows.
2. **Always lf** — git's Linux/macOS build everywhere. Cons: a Windows Node process writes LF where
   a sibling Git for Windows writes CRLF.
3. **An `openRepository` option** defaulting to option 1. Cons: a knob nobody asked for.

## Decision

**User-ratified — option 1.** The native line ending is a value the platform adapter supplies to
the context — never computed in the application or domain layer, never a public option. The Node
adapter supplies `crlf` on win32 and `lf` elsewhere; the browser and memory adapters supply `lf`.
`EolSettings.nativeEol` reads it and the CRLF-action resolution consumes it only where git consults
`EOL_NATIVE`.

## Consequences

- Windows CI cells check out `text` paths as CRLF under an unset `core.eol`, as Git for Windows
  does; interop rows that depend on it pin per platform.
- The memory adapter's `lf` keeps unit tests platform-independent; the Node value is injectable in
  the adapter's options object for tests of the win32 arm.
- An explicit option can be layered on later as an additive change to the adapter factories.
