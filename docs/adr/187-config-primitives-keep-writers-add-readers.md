# ADR-187: Config primitives — keep writers exported, add reader family alongside

## Status

Accepted (at `ab51e0a`)

## Context

The primitive tier (`src/application/primitives/`) currently exports `setConfigEntry` as a public composable building block. Phase 20.5's `repo.remote` porcelain composes it heavily (every `add` / `setUrl` / `rename` call writes through `setConfigEntry`).

Phase 20.6 adds a porcelain layer (`repo.config.*`) over the same primitive surface. The question is whether the writer family stays public or is hidden behind the new porcelain.

Three options surfaced:

- **A: keep `setConfigEntry` exported AND add a reader family** (`getConfigValue`, `getAllConfigValues`, `readConfigSections`). The Phase 20.2 playbook — porcelain composes primitives; primitives stay usable on their own.
- **B: strip the writer family** ("porcelain owns config writes now"). Breaks Phase 20.5 `repo.remote` which just shipped composing it.
- **C: keep writers, add no new readers** (porcelain handles reads exclusively). Asymmetric — write at primitive tier, read only via porcelain.

## Decision

Adopt option A: keep `setConfigEntry` (and the new `unsetConfigEntry`, `unsetAllConfigEntries`) exported as primitives, and add the matching reader family alongside.

The new primitives exported from `src/application/primitives/`:

- `getConfigValue({ ctx, key, scope? })` — single value; throws `CONFIG_MULTIPLE_VALUES` on ambiguity (same contract as the porcelain).
- `getAllConfigValues({ ctx, key, scope? })` — ordered list.
- `readConfigSections({ ctx, scope? })` — full section map (the structural read used by both `list` and the precedence resolver).
- `setConfigEntry({ ctx, key, value, scope? })` — existing; gains the `scope` parameter from ADR-182.
- `unsetConfigEntry({ ctx, key, scope? })` — new; idempotent (matches ADR-184).
- `unsetAllConfigEntries({ ctx, key, scope? })` — new; idempotent.
- `renameConfigSection({ ctx, oldName, newName, scope? })` — new.
- `removeConfigSection({ ctx, sectionName, scope? })` — new.

The porcelain (`repo.config.*`) is a thin dispatcher that binds the repo's `ctx` and forwards. Both tiers carry identical contracts (error codes, idempotence rules, multi-value handling); the porcelain adds nothing beyond the binding.

## Consequences

### Positive

- **Phase 20.5 `repo.remote` is unaffected.** Its existing `setConfigEntry` composition continues to work.
- **Symmetry between read and write at the primitive tier.** Users who want to compose their own porcelain (or call from a non-`Repository` context, e.g. a one-shot CLI tool) get the full surface.
- **Single source of truth.** Porcelain and primitives share contracts; tests can target the primitives and the porcelain inherits behaviour.

### Negative

- **Two-tier API to document.** Both layers appear in the public surface; documentation has to explain when to use each. Mitigation: the README and `docs/use/config.md` recommend porcelain by default, mention primitives as the escape hatch.
- **Tests duplicate at the porcelain layer.** Each primitive has its own unit tests, and each porcelain method has an integration test through the primitive. The duplication is intentional — the porcelain integration test catches binding errors that the primitive tests can't.

### Neutral

- **No new branded types beyond `ConfigKey` and `ConfigScope`.** The primitives accept the same input types the porcelain does; no separate "primitive types" exist.
- **Symbols renamed for symmetry** — older code referring to `setConfigEntry`'s signature should still compile (the new `scope?` parameter is optional and defaults to `local`).

## Alternatives considered

- **B (strip writers)** — rejected. Breaks Phase 20.5. Would require a parallel refactor of `repo.remote` to call through `repo.config.*`, expanding 20.6 scope further.
- **C (keep writers, no new readers)** — rejected. Asymmetric and creates a weird "you can write directly but must read through the facade" rule that nobody asked for.
- **Make the porcelain its own non-trivial layer (e.g. caching, batching)** — out of scope for v1; porcelain stays a thin dispatcher.
