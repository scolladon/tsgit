# ADR-183: `repo.config.get` throws on a multi-valued key

## Status

Accepted (at `ab51e0a`)

## Context

A git config key may have multiple values (e.g. `remote.origin.fetch` carries multiple refspecs; `core.gitProxy` may list multiple entries). Canonical `git config --get key` silently returns the *last* value when multiple exist, falling back to a precedence rule across sections.

The Phase 20.6 design surfaced three options for `repo.config.get`:

- **A: throw `CONFIG_MULTIPLE_VALUES`** — force the caller to use `getAll` when ambiguity exists.
- **B: return the last value** — canonical-git behaviour.
- **C: return the first value** — diverges from canonical without a clear benefit.

## Decision

`repo.config.get({ key, scope? })` throws a domain error with code `CONFIG_MULTIPLE_VALUES` when the resolved key has more than one entry in the active scope set. The error data carries:

```ts
{
  code: 'CONFIG_MULTIPLE_VALUES',
  key: ConfigKey,
  count: number,
  scope?: ConfigScope, // present when get was scope-filtered
}
```

`repo.config.getAll({ key, scope? })` returns the full ordered list (no throw).

## Consequences

### Positive

- **Eliminates a silent-pick footgun.** Mutation testing catches `[last]` vs `[first]` mutants; a thrown error makes the test target unambiguous.
- **Type-system pressure** — callers who hit the error in development immediately know to switch to `getAll`. The fix is one keystroke.
- **`get` becomes a single-value contract** — the result type is `{ value: string, scope: ConfigScope }`, not `{ value: string | string[] }`. No discriminated-union narrowing at the call site.

### Negative

- **Divergence from canonical git** — a `git config --get` user porting a script will see a thrown error where they expected the last-wins value. Mitigation: the error message names `getAll` as the fix and links to the design doc.
- **Multi-valued keys hit the throw at runtime, not compile time** — TypeScript can't know which keys are multi-valued statically. Acceptable cost.

### Neutral

- The behaviour is identical for single-valued keys; only the multi-value case differs.
- `getRegexp` and `list` are unaffected — they return `entries: ConfigEntryView[]` by definition.

## Alternatives considered

- **B (return last value)** — rejected. Silent-pick is the bug class the typed-result envelope was meant to eliminate.
- **C (return first value)** — rejected. Diverges from canonical *and* is unsafe.
- **Return `string | string[]`** — considered, rejected. Pushes the narrowing burden to every caller and doesn't actually communicate "this key is multi-valued" at the type level.
