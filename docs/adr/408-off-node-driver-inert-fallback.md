# 408 — off-node driver execution: memory/browser adapters fall back to the no-driver baseline

- **Status:** accepted
- **Date:** 2026-06-22
- **Design:** docs/design/lfs-filter-driver-port.md · **Relates:** ADR-398 (no-active-driver baseline), ADR-304 (merge-driver fallback), ADR-300 (hook trust/fallback), ADR-407 (extended CommandRunner)
- **Decision class:** adopted-as-recommended

## Context

Drivers are external processes spawned by `NodeCommandRunner`. The memory and browser adapters
have no process-spawn capability. When a `.gitattributes` names a driver (`diff=lfs` /
`filter=lfs`) but no runnable `CommandRunner` is wired (memory/browser, or node with none
configured), the resolver must decide what content the diff/checkout/add sees.

## Options considered

1. **Inert / fall back** to the no-driver baseline (raw committed bytes; identity clean/smudge).
2. An **in-process JS-function registry** (`Map<name, (bytes) => bytes>`) the memory/browser
   adapter populates.
3. **Throw** when a driver is named but unrunnable.

## Decision

**(1) Inert fallback.** With no `CommandRunner` able to run the named driver, the textconv
resolver yields raw bytes and the filter resolver yields identity clean/smudge — exactly
ADR-398's no-active-driver case, and consistent with the merge-driver (ADR-304) and hook
(ADR-300) precedents where memory/browser already fall back to built-in behaviour. A repo that
declares `diff=lfs`/`filter=lfs` but provides no runnable driver is **inert** — git-faithful to a
no-driver environment (the same boundary ADR-398's declared-but-inert case pins).

## Consequences

- memory/browser remain fully usable on repos that declare lfs (or any) filter attributes — no
  throw, no broken diff/checkout.
- The in-process JS-function-registry ergonomic (e.g. browser textconv via a JS function) is a
  documented follow-up if demand appears — it invents a second, non-git driver-execution model
  and data shape, deliberately deferred.
- Cross-adapter parity tests assert the inert fallback (memory ≡ node-with-no-driver); the
  interop tests (node, real driver) assert the active-driver faithfulness.
