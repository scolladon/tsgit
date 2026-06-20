# ADR-382: Whitespace + rename config defaults on `RepositoryConfig`, consumed by diff

## Status

Accepted

- **Date:** 2026-06-20
- **Design:** [design/whitespace-diff-options.md](../design/whitespace-diff-options.md)
- **Supersedes:** the config-deferral in [ADR-373](373-detection-option-api.md)
- **Refines:** [ADR-378](378-whitespace-options-flat-enum.md)

## Context

The per-call whitespace option (ADR-378) lets a caller opt in per `diff` call. The
question is whether to also offer a repo-level standing default on the facade's
`RepositoryConfig`. ADR-373 found that `RepositoryConfig.detectRenames` is
**declared-but-unconsumed** — the diff command reads only the per-call `opts.detectRenames`
— and deliberately deferred config→diff consumption plumbing, because adding config keys
without that plumbing produces dead code (forbidden by the guardrails).

Faithfulness note: `RepositoryConfig` is tsgit's **programmatic facade-tier config**
(caller-supplied via `openRepository`, alongside `parallelism`, `maxResponseBytes`,
`auth`, …). It is NOT git's on-disk `.git/config`, and these keys are not read from it.
Verified against real git 2.54.0: git has **no** on-disk config that defaults the
`-w`/`-b` diff-ignore family (`core.whitespace` governs whitespace-*error* detection for
`apply`/`diff --check`, not diff output; `diff.ignoreAllSpace`/`diff.ignoreWhitespace` do
not exist). So these are tsgit ergonomic defaults with no git on-disk counterpart — not a
faithfulness divergence (no invented on-disk key, no observable git artifact changes), and
explicitly **not** `core.whitespace`.

## Options considered

1. **Option-surface only** (designer's recommendation; matches ADR-373) — pros: bounded,
   no dead code / cons: leaves config consumption deferred again.
2. **Config key + live plumbing for whitespace only** — pros: honors the standing-default
   intent / cons: whitespace config live while `detectRenames` config stays dead — an
   inconsistency.
3. **(chosen) Config key + wire both** — add the whitespace config keys AND build
   config→diff consumption for both whitespace and the pre-existing `detectRenames`,
   retiring the dead field — pros: most consistent end state, no dead config field
   remains / cons: largest scope; absorbs the deferred ADR-373 config work.

## Decision

`RepositoryConfig` gains the ADR-378 flat whitespace keys (`ignoreWhitespace?`,
`ignoreCrAtEol?`, `ignoreBlankLines?`) as programmatic defaults. The `diff` command
resolves each field as **per-call option `??` config default `??` today's default**, so a
per-call option always overrides the standing config default. The same resolution wires
the pre-existing `detectRenames` config field, retiring its declared-but-unconsumed
status. `renameOptions` is not added to `RepositoryConfig` (out of scope; per-call only as
ADR-373 left it).

## Consequences

- No dead config field remains: both `detectRenames` and the whitespace keys are now
  consumed by `diff`.
- Behavior change for `detectRenames`: a caller that set `config.detectRenames: true`
  without a per-call option now gets rename detection. Existing call sites/tests are
  audited for this in implementation; it is the intended effect of retiring the dead field.
- Precedence is fixed and uniform (per-call `??` config `??` default) across whitespace
  and rename detection.
- These are programmatic facade defaults only; they are never read from `.git/config` and
  change no observable git artifact (the config-file → facade mapping remains a separate
  future concern).
