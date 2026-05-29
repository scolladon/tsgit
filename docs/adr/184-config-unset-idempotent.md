# ADR-184: `repo.config.unset` is idempotent

## Status

Accepted (at `ab51e0a`)

## Context

Canonical `git config --unset key` exits with status 5 when the key is absent. Tooling that wraps git then has to special-case exit-5 as "nothing to do" vs the other non-zero exits as real errors. The Phase 20.6 design surfaced two options for `repo.config.unset`:

- **A: idempotent return** — `{ removed: false, key, scope }` when the key was absent, `{ removed: true, key, scope, previousValue }` when removed.
- **B: throw `CONFIG_KEY_NOT_FOUND`** — canonical-git-style exit-5 equivalent.

The "ensure this key is gone" use case is more common than "fail if it isn't there" (which can always be expressed as `unsetAll` + a follow-up `get` if the caller really wants the distinction).

## Decision

`repo.config.unset({ key, scope? })` is idempotent. Absent-key calls return `{ removed: false, key, scope }`; present-key calls return `{ removed: true, key, scope, previousValue }`.

`repo.config.unsetAll({ key, scope? })` is also idempotent: returns `{ removed: count, key, scope }` where `count >= 0`.

## Consequences

### Positive

- **Composable with automation** — "ensure this is gone" is one call, no try/catch. Matches the convergent-configuration patterns of tools like Ansible, Terraform.
- **Typed result carries the answer** — callers who *do* want to know if the key was present check `result.removed`. The boolean is more useful than a thrown error code.
- **No special-case for the common path** — the common path doesn't have to wrap a try/catch around every unset call.

### Negative

- **Divergence from canonical git** — `git config --unset` users porting a script will see no error where they expected exit-5. Mitigation: documented in design + tsdoc; callers wanting strict behaviour check `result.removed`.

### Neutral

- The behaviour is unchanged for the present-key case.
- `unsetAll` follows the same model with a count instead of a boolean.

## Alternatives considered

- **B (throw on absent)** — rejected. Forces every caller to wrap in try/catch for the "ensure gone" pattern, which is the common case.
- **Two methods, `unset` strict + `unsetSafe` idempotent** — rejected. API surface bloat for a single boolean's worth of information that the result envelope already carries.
