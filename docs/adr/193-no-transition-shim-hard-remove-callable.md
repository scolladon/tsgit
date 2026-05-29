# ADR-193: Hard-remove the callable discriminator form (no transition shim)

## Status

Accepted (at `2a54c19`)

## Context

Migrating the four CRUD families to nested namespaces (ADR-181, ADR-192)
raises a back-compat question: should the old callable form
`repo.remote({ kind: 'add', … })` keep working during a transition?

- **A: hard remove** — `repo.remote` becomes a plain, non-callable
  namespace object. The old call form stops existing; calling
  `repo.remote(...)` is a `TypeError`. ADR-181 already specified "a plain
  namespace object literal (no callable parent)".
- **B: keep both + runtime deprecation warning** — make `repo.remote`
  BOTH callable (old form, emitting `warnDeprecated`) AND carry
  `.add`/`.remove`/… methods. This requires the
  `function & { add, remove, … }` intersection type that ADR-175 raised as
  the typing-complexity objection and ADR-181 explicitly rejected when it
  chose the plain-object shape.

tsgit v2 is pre-release; the public API contract permits breaking the call
shape between v1 and v2.

## Decision

Adopt **A**. Each migrated family is exposed as a frozen, non-callable
namespace object (`repo.remote`, `repo.branch`, `repo.tag`,
`repo.sparseCheckout`), exactly like `repo.config`. The discriminated call
form is removed outright — no runtime deprecation shim, no callable
intersection type. ADR-175 is marked Deprecated.

## Consequences

### Positive

- **No reintroduced complexity** — avoids the `function & { … }`
  intersection ADR-181 removed; the binder stays a plain object literal.
- **One shape, no ambiguity** — there is exactly one way to call each verb.
- **Frozen namespace** — `Object.freeze` prevents runtime monkey-patching,
  matching `bindConfigNamespace`.

### Negative

- **No grace period** — external callers on the old form get a hard
  `TypeError`, not a warn-then-work. Acceptable for a pre-release v2 break;
  the migration is documented in the four `docs/use/commands/*.md` pages and
  `migrate-from-isomorphic-git.md`.

### Neutral

- Consistent with the merge state machine (ADR-172) and config (ADR-181)
  precedent of not retaining superseded call shapes once a cleaner surface
  lands.
