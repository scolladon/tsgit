# ADR-020: Checkout path-restore API shape

## Status

Accepted (at `7e413881902fd6346edf2eec96109c1f136799dc`)

## Context

The existing `repo.checkout(opts)` accepts `{ target, detach, force }`
for branch switch. BACKLOG §13.1 acceptance demands _"branch switch +
path-checkout"_. Path-checkout (`git checkout -- foo.txt`) is a
different operation: it restores specific paths from a source (the
index by default, or HEAD's tree, or an arbitrary tree) without
moving HEAD.

Three plausible API shapes:

- **A. Separate command**: `repo.checkoutPaths(opts)`. Reads cleanly
  but duplicates surface (`repo` already has `checkout`).
- **B. Optional field**: extend `CheckoutOptions` with optional
  `paths` and `source`. The presence of `paths` switches mode.
  Backwards compatible — existing callers pass `{ target }` and get
  switch semantics.
- **C. Discriminated union**: `CheckoutOptions =
  CheckoutSwitchOptions | CheckoutPathsOptions`. Either explicit
  `target` (switch) or explicit `paths` (restore). Clear at the
  type level; harder for callers who type the input shape
  themselves.

Canonical git overloads `git checkout` with a `--` separator. We
have no positional-args concept; the discriminator has to be a
field.

## Decision

We use **Option B with a structural discriminator**: keep one
`CheckoutOptions` exported type. Internally it is a discriminated
union, but the discriminator is the **presence of `paths`**, not a
`kind` field. Result:

```ts
// Switch mode (existing — unchanged)
await repo.checkout({ target: 'main' });
await repo.checkout({ target: oid, detach: true });

// Path-restore mode (new)
await repo.checkout({ paths: ['src/foo.ts'] });
await repo.checkout({ paths: ['src/foo.ts'], source: 'HEAD' });
await repo.checkout({ paths: ['src/foo.ts'], source: oid });
```

Type definition:

```ts
export type CheckoutOptions = CheckoutSwitchOptions | CheckoutPathsOptions;

export interface CheckoutSwitchOptions {
  readonly target: string;
  readonly detach?: boolean;
  readonly force?: boolean;
}

export interface CheckoutPathsOptions {
  readonly paths: ReadonlyArray<string>;
  readonly source?: 'index' | 'HEAD' | ObjectId;
}
```

Validation at the command boundary:

- `paths !== undefined` AND `target !== undefined` → `INVALID_OPTION`
  (the two modes are mutually exclusive).
- `paths !== undefined` AND `paths.length === 0` →
  `INVALID_OPTION`.
- `target === undefined` AND `paths === undefined` →
  `INVALID_OPTION`.

Mode is inferred from which field is present. The user never has to
specify a redundant `kind` discriminator.

## Consequences

### Positive

- Backwards-compatible: every existing call site keeps working
  without changes. No breaking change in the v1.x line.
- Idiomatic TypeScript: the discriminated union is recognised by
  control-flow narrowing on `paths`/`target`.
- API surface is one method, one shape — matches what `repo.tag`,
  `repo.branch`, etc. already do (`kind: 'list' | 'create' | …`).

### Negative

- The error-case at validation is one we have to write tests for
  (three INVALID_OPTION paths instead of the type system catching
  it). Mitigated by explicit tests.
- Callers using `unknown` input can't get compile-time guarantees;
  they have to validate at runtime. Most callers are typed.

### Neutral

- `source: 'index'` is the default and explicit reference. The other
  values (`'HEAD'`, `ObjectId`) cover `git checkout HEAD -- path`
  and `git checkout <treeish> -- path`.

## Alternatives considered

- **A — separate method.** Doubles the surface (`checkout` vs
  `checkoutPaths`) for a single conceptual operation. Rejected.
- **C — explicit `kind` discriminator.** Forces a redundant field
  on every call. Rejected for ergonomics.
