# 410 — binary attribute override is honoured off-node: provider build decoupled from the runner guard

- **Status:** accepted
- **Date:** 2026-06-23
- **Design:** docs/design/diff-attr-binary-override.md · **Relates:** ADR-408 (off-node driver inert fallback — refined here), ADR-398 (no-driver baseline), ADR-407 (extended CommandRunner), ADR-409 (the override this gates)
- **Decision class:** D-OPTIN user-ratified

## Context

#195 (ADR-407/408) gated **all** `.gitattributes`-driven resolution in
`materialise-patch-files.ts` on `ctx.command !== undefined`, because textconv **spawns a
process** and a runner-less adapter (browser / in-memory / node-without-runner) cannot run it
(ADR-408: off-node drivers fall back inert).

The `diff`/`binary` binary-decision override (ADR-409) is different: `-diff` and bare `diff`
(and the raw-blob numstat decision) spawn **nothing** — they read `.gitattributes` (via the
`FileSystem` port, available on every adapter) and resolve an attribute to an enum. Riding
#195's runner guard would make this pure decision needlessly **inert** off-node, diverging from
git in the browser (a `-diff` textual file would show a text hunk where node-with-a-runner shows
`Binary files … differ`).

## Options considered

1. **Runner-gated** — reuse #195's single `applyTextconv === true && ctx.command !== undefined`
   guard. Off-node ⇒ provider never built ⇒ override `undefined` ⇒ content-sniff. Simplest; one
   guard; mirrors ADR-408; a narrow off-node divergence from git.
2. **Decouple the runner guard** — build the attribute provider whenever the **display opt-in**
   (`applyTextconv: true`) is set, regardless of `ctx.command`; keep **only** textconv *execution*
   gated on the runner. `-diff`/bare `diff` honoured everywhere; `diff=<name>` textconv still
   no-ops off-node.

## Decision

**(2) Decouple.** The `AttributeProvider` is built whenever the display opt-in is set (it needs
only `FileSystem`); the ADR-409 override is resolved from it **in-process** on every adapter;
**only** textconv *driver execution* stays gated on `ctx.command` (ADR-407/408 unchanged for the
spawning part). `-diff` and bare `diff` are therefore git-faithful on node, in-memory, and
browser alike. Chosen over (1) because the override is non-spawning and the prime directive
(ADR-226) prefers full faithfulness over the simpler single guard; the user accepted the cost.

## Consequences

- **The content-stable boundary remains the `applyTextconv` opt-in, not the runner.** Content-stable
  callers (`patch-id`, `range-diff`, `rebase`) pass no opt-in ⇒ no provider build ⇒ no override —
  their bytes are unchanged. Only the runner **sub-guard** is decoupled, so the R4 boundary is
  preserved exactly.
- **ADR-408's inert fallback is refined, not contradicted.** It still holds for the **spawning
  textconv driver**: off-node a `diff=<name>` path yields raw bytes (inert), and the ADR-409
  override then applies to those raw bytes faithfully. The **pure binary override** (`-diff` /
  bare `diff` / raw-numstat decision) is intentionally **not** inert off-node — it is live on all
  adapters.
- **Cross-adapter parity is refined:** ADR-408's "memory ≡ node-with-no-driver inert fallback"
  scopes to the spawning driver only. For the binary override, parity is "every adapter matches
  **real git**" (all honour `-diff`/bare `diff` identically), not "every adapter falls back to
  content-sniff". The parity tests gain that distinction; the `*-interop` tests pin the faithful
  override on node, and the cross-adapter tests assert memory/browser honour `-diff` identically.
- Cost: a `.gitattributes` read on the off-node display path where #195 skipped it. Bounded by the
  same opt-in (display paths only) and the same single lazily-memoised provider build.
