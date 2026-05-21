# ADR-063: `core.logAllRefUpdates` gating

## Status

Accepted (at `1e5f20b`)

## Context

Git does not log every ref update unconditionally. `core.logAllRefUpdates`
controls it:

- **`true`** — log updates to "default-loggable" refs.
- **`false`** — log nothing.
- **`always`** — log *every* ref, including `refs/tags/*` and pseudo-refs.
- **unset** — defaults to `true` for a repo with a working tree, `false` for
  a bare repo (`!bare`).

When enabled (`true` / unset-non-bare), git still only auto-creates logs for
the **default-loggable** refs — `HEAD` and anything under `refs/heads/`,
`refs/remotes/`, `refs/notes/`. `refs/tags/*` is excluded — tag creation is
not reflogged by default.

Independently, git's `log_ref_setup` appends to any reflog file that **already
exists**, regardless of the prefix rule.

tsgit must replicate all of this, or reflog files appear where git would not
write them (and vice versa).

## Decision

- `ParsedConfig.core` gains a `logAllRefUpdates` field, typed
  `boolean | 'always'`. `config-read.ts`'s `mergeCore` parses the
  `logallrefupdates` key: literal `always` → `'always'`; otherwise the
  existing `parseGitBoolean`.
- A pure domain predicate `shouldAutocreateReflog(ref, { logAllRefUpdates,
  bare })` encodes the rule: `always` → true; `false` → false;
  `true`/unset → (`true ? true : !bare`) AND `ref` is default-loggable
  (`HEAD` | `refs/heads/` | `refs/remotes/` | `refs/notes/`).
- `recordRefUpdate` logs iff `reflogExists(ref)` **or**
  `shouldAutocreateReflog(...)` — the existing-file arm mirrors
  `log_ref_setup`.
- The `reflog` *command* (show/expire/delete) ignores the gate — it manages
  logs that already exist; only *writers* are gated.

## Consequences

### Positive

- Git-faithful gating: bare repos stay log-free, tags are not reflogged by
  default, `always` opts everything in, and a pre-existing log keeps growing.
- The prefix rule is a pure, exhaustively unit-testable predicate.

### Negative

- `recordRefUpdate` does one `reflogExists` stat per update before the
  prefix check. Negligible, and only on the (already I/O-bound) ref-write
  path.

### Neutral

- `core.logAllRefUpdates` is a plain tri-state in git — there is no per-ref
  pattern syntax — so honouring the three values is complete, not a subset.
