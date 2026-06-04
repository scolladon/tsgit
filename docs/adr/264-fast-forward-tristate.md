# ADR-264: `fastForward: 'only' | 'never' | 'allow'` replaces the boolean pair

## Status

Accepted (at `63342156`)

## Context

`merge` and `pull` express the fast-forward policy with a **pair of booleans**:

```ts
readonly fastForwardOnly?: boolean; // git merge --ff-only
readonly noFastForward?: boolean;   // git merge --no-ff
```

This is a three-valued choice encoded in two booleans, so the type admits four
combinations where only three are meaningful:

| `fastForwardOnly` | `noFastForward` | meaning |
|---|---|---|
| `false`/unset | `false`/unset | default: fast-forward when possible, else merge (git `--ff`) |
| `true` | `false`/unset | refuse unless fast-forward (git `--ff-only`) |
| `false`/unset | `true` | always create a merge commit (git `--no-ff`) |
| **`true`** | **`true`** | **contradiction** — "must fast-forward" *and* "never fast-forward" |

The contradictory fourth state is representable but nonsensical; today's code
silently resolves it (the `--no-ff` branch is skipped, then `--ff-only` throws
`NON_FAST_FORWARD` even though the history *could* fast-forward). Surfaced by the
23.4 API review (finding **S2**).

## Decision

Replace the boolean pair on both `MergeRunInput` and `PullOptions` with a single
optional tristate:

```ts
readonly fastForward?: 'only' | 'never' | 'allow';
```

- **`'allow'`** (the default when omitted) — fast-forward when possible, else a
  true merge. git's default `--ff`. Omitting the field behaves exactly like
  today's no-flags merge.
- **`'only'`** — refuse with `NON_FAST_FORWARD` when a true merge would be
  required. git `--ff-only`. ≡ today's `fastForwardOnly: true`.
- **`'never'`** — always create a merge commit, even when a fast-forward is
  possible. git `--no-ff`. ≡ today's `noFastForward: true`.

The two guard checks translate mechanically:

```ts
// before
if (base === ourId) { if (opts.noFastForward !== true) { /* fast-forward */ } }
if (opts.fastForwardOnly === true) throw nonFastForward(...);
// after
if (base === ourId) { if (input.fastForward !== 'never') { /* fast-forward */ } }
if (input.fastForward === 'only') throw nonFastForward(...);
```

The contradictory combination becomes **unrepresentable** — the three valid
policies are the only three values.

## Consequences

### Positive

- Illegal state (`--ff-only` ∧ `--no-ff`) is unrepresentable; the option reads as
  the single choice it is.
- One field instead of two on two option types; `pull` and `merge` stay symmetric.

### Negative

- Breaking: callers passing `fastForwardOnly`/`noFastForward` migrate to
  `fastForward: 'only'`/`'never'`. Bounded by the 23.4 window.

### Neutral

- No git-observable behaviour changes — `NON_FAST_FORWARD`, the merge-commit
  path, and the ref-advance are produced by the same code; only the field that
  *requests* the policy is renamed.
- `'allow'` over `'auto'`/`'when-possible'`: `'allow'` reads as "fast-forward is
  permitted" and pairs cleanly with `'only'`/`'never'` as a permission scale.
