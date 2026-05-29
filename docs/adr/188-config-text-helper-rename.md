# ADR-188: Rename existing pure text-transform helpers with `*InText` suffix

## Status

Accepted (at `ab51e0a`)

## Context

ADR-187 promotes a new family of context-aware, async, scope-aware I/O primitives for config: `setConfigEntry({ ctx, key, value, scope? })`, `unsetConfigEntry`, `renameConfigSection`, `removeConfigSection`. The names were chosen to match the porcelain surface and the canonical git verbs.

The same names are already in use in `src/application/primitives/update-config.ts` as **pure text-transform helpers** — synchronous functions that take a config-file string and return a new string, with no I/O:

- `setConfigEntry(text, section, subsection, key, value): string`
- `setCoreConfigEntry(text, key, value): string`
- `renameConfigSection(text, oldName, newName): string`
- (plus the orchestrator `applyConfigOp(text, op): string` and its supporting helpers)

All four are publicly exported from `src/application/primitives/index.ts` and have extensive test coverage. Phase 20.5 `repo.remote` composes them internally.

The collision is real and load-bearing — both names communicate the right intent for their respective layers.

## Decision

Rename the existing pure text-transform helpers with an `*InText` suffix. The new I/O primitives (ADR-187) take the unsuffixed names.

| Old name (pure text) | New name (pure text) | New name (I/O, ADR-187) |
|---|---|---|
| `setConfigEntry` | `setConfigEntryInText` | `setConfigEntry` |
| `setCoreConfigEntry` | `setCoreConfigEntryInText` | (no I/O equivalent — composes `setConfigEntry`) |
| `renameConfigSection` | `renameConfigSectionInText` | `renameConfigSection` |
| `removeConfigSection` (if present in text family) | `removeConfigSectionInText` | `removeConfigSection` |
| `applyConfigOp` | `applyConfigOpInText` | (no I/O equivalent — orchestrator only) |

The `*InText` suffix explicitly names the layer: a pure transform that operates on a config file's text representation, with no side effects. Callers compose it when they already hold the text (e.g. inside an atomic read-modify-write) and want to skip the I/O layer.

Internal call sites and tests update mechanically. The exports in `src/application/primitives/index.ts` rename in step.

## Consequences

### Positive

- **The ADR-187 names are correct as-stated.** No amendment to ADR-187; the I/O primitives ship under the names that mirror the porcelain (`setConfigEntry`, `unsetConfigEntry`, ...) and the canonical git verbs.
- **The two layers are unambiguous at every call site.** A reader who sees `setConfigEntryInText(...)` knows it's a pure function operating on text. A reader who sees `setConfigEntry({ ctx, ... })` knows it's the I/O-performing primitive.
- **The text-transform family stays publicly composable.** Callers who want to batch many edits on a single config text string (e.g. a migration script) can still use the pure helpers without the I/O round-trip.
- **No semantic drift.** The text helpers' behaviour is unchanged; only the names move.

### Negative

- **Breaking change to the public primitive API.** Any external caller currently using `setConfigEntry` as the pure text-transform sees a rename. tsgit is pre-1.0 so this is acceptable; the next release notes call it out.
- **Internal touch-up cost.** `setCoreConfigEntry` (one call site), `applyConfigOp` (one call site), and the test file (~50 lines of imports + `sut` re-bindings) update mechanically.
- **One additional naming convention to document.** `*InText` joins the existing suffix vocabulary; the README's primitive section gains a one-paragraph explanation.

### Neutral

- **Phase 20.5 `repo.remote` continues to compose the text helpers transitively** (via `applyConfigOpInText`); the rename is a one-line internal change.
- **No new types or branded values introduced.** The signature of each helper is preserved exactly.

## Alternatives considered

- **Rename the new I/O primitives** (e.g. `writeConfigEntry`, `setConfigValue`) — rejected. The chosen ADR-187 names mirror the porcelain (`repo.config.set`) and the canonical git verb (`git config set`). Verbing differently at the primitive layer would force a second mental translation.
- **Move the text helpers to internal (drop from public exports)** — rejected. The pure text-transform family is a deliberate primitive-tier surface that future callers (migration tools, third-party porcelain) might want. Hiding it bets that no one ever will; the rename keeps both layers public.
- **Suffix the new I/O primitives instead** (`setConfigEntryIo`) — rejected. The I/O layer is the *default* one a user reaches for; the pure helper is the niche escape hatch. Suffixing the default is backwards.
