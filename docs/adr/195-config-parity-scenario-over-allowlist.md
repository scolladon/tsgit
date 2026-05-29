# ADR-195: `config` joins the browser gate via a parity scenario, not an allowlist

## Status

Accepted (at `9a90ab4`)

## Context

Teaching `tooling/audit-browser-surface.ts` about namespaces (the follow-up
ADR-194 deferred) brings five namespaced commands under the browser-surface
gate: `config`, `remote`, `branch`, `tag`, `sparseCheckout`. Four already
carry dotted `repo.X.verb(` call sites in existing parity scenarios / browser
specs, so they go green automatically. `config` has **zero** browser or
parity coverage today — it would be reported as a new gap the moment the
audit recognises it.

ADR-194 explicitly left the resolution open: bring `config` under the gate
"with whatever new scenarios/allowlist entries that requires". Two responses:

- **A: a `config` parity scenario.** Add
  `test/parity/scenarios/config.scenario.ts` driving `set`/`get`/`unset` at
  local scope. `config` (local scope) reads/writes `.git/config` through pure
  FS I/O — no smart-HTTP transport, no POSIX hook processes — so it runs
  unchanged on Node + Memory (vitest) and Browser/OPFS (Playwright). The
  scenario provides the dotted call sites that close the gate **and** real
  cross-runtime parity coverage.
- **B: an allowlist entry for `config`.** Add `config` to
  `audit-browser-surface.allowlist.json` with a `reason`. Smallest change.
  But the allowlist's contract (19.5a) is "a surface that *cannot* be tested
  in the browser today" — transport needs an in-page HTTP server (19.8),
  `runHook` needs POSIX processes absent in OPFS. `config` has no such
  blocker; an allowlist entry would record a **false exemption** and leave a
  fully browser-capable surface untested.
- **C: add a `repo.config.get(` call to `test/browser/surface-parity.spec.ts`
  only.** Closes the gate with browser-only coverage, but asserts no
  Node/Memory parity golden — weaker than A for no real saving.

## Decision

Adopt **A** — a dedicated `config.scenario.ts`.

- Local scope only (browser-portable; global/system/worktree scopes need the
  `homedir`/`xdgConfigHome`/`systemConfigPath` FS capabilities that the
  browser adapter does not provide).
- The result captures deterministic read-backs (the set value, the read-back,
  the post-unset `undefined`), never a full `list()` — default `init` entries
  (`core.repositoryformatversion`, …) could drift across adapters and break
  the parity golden.
- No allowlist change: `config` is covered, not exempted. The allowlist stays
  exactly the four transport commands + `runHook`.

## Consequences

### Positive

- **`config` gets genuine cross-runtime coverage**, proving config read/write
  works byte-identically on Node, Memory, and OPFS — not just an exemption.
- **The allowlist stays honest** — every entry remains a surface that truly
  cannot run in the browser today, so the exempt set keeps its diagnostic
  value.
- **Symmetry with the other four namespaces** — all five are gate-enforced
  *and* actually exercised, closing the gap ADR-194 documented.

### Negative

- **A new scenario is more work than an allowlist line** — and it runs on
  every parity/browser CI pass (Node + Memory + Playwright). Marginal cost; the
  scenario is small and the runtimes already iterate the registry.

### Neutral

- Coverage is asserted at **namespace granularity** (one verb call covers
  `config`), consistent with the parser unit and doc-coverage — not per-verb.
  Per-verb enforcement remains out of scope (no ADR-194 mandate).
