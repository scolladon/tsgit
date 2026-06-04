# ADR-262: `readFileAt` is a Tier-1 command over the full rev grammar, returning `{ id, mode, content }`

## Status

Proposed

## Context

The 23.4 API review's finding **M1** is that the single most common viewer job —
*"read a file's bytes as of a revision"* — has no first-class surface. A consumer
today hand-composes a five-step primitive dance (`revParse` → `readObject` →
`readTree` → walk each path segment → `readBlob`). `readFileAt(rev, path)`
collapses that to one call.

Two surface choices are load-bearing and not settled by an existing ADR.

### Tier & accepted `rev` grammar

The convenience hinges on which revision forms resolve. The Core read primitives
resolve a ref **verbatim**: `readTree`/`resolveRef` call `refStore.resolveDirect`
with no candidate expansion, so they accept only `HEAD`, a full ref path
(`refs/heads/main`), and a full 40-hex oid. The forms a real viewer most often
holds in its hand — a **short branch/tag name** (`main`, `v1.0`), **navigation**
(`HEAD~3`, `dev^2`), an **abbreviated oid** (`a1b2c3d`), a **reflog** selector
(`@{yesterday}`) — resolve **only** through `revParse`, which is a Tier-1 command.

So the tier and the grammar are coupled:

1. **Tier-2 primitive over commit-ish (`RefName | ObjectId`).** Mirrors 23.4b's
   `walkCommitsByDate` and the backlog's "4-call **primitive** dance" wording;
   keeps the helper in the Core. But it rejects `main`, `v1.0`, `HEAD~3`, and
   abbreviated oids — the caller must run `revParse` first, restoring a 2-call
   dance for exactly the forms a viewer reaches for. The "convenience" goal is
   undercut.
2. **Tier-1 command over the full `revParse` grammar.** Every form resolves;
   mirrors `show`, which already resolves the full grammar and then reads the
   object. Commands may depend on commands (`show` imports `revParse` today), so
   it is idiomatic. The cost is that it is porcelain-tier, not a Core primitive.

### Return shape

1. **The `Blob` (`{ type, id, content }`).** Identical to `readBlob`; minimal.
   `type` is always `'blob'` by construction (carries no information), and `mode`
   is absent — so a caller cannot tell a symlink (`120000`) or executable
   (`100755`) from a regular file, the exact distinction `git ls-tree` pairs with
   the bytes. A follow-up the moment any caller needs it.
2. **`{ id, mode, content }`.** The blob oid, its tree-entry mode, and the raw
   bytes. `mode` is **free** — the descent already reads the entry that carries
   it — and is the only metadata that makes the result self-describing.

## Decision

Ship `readFileAt` as a **Tier-1 command** (`repo.readFileAt(rev, path, options?)`)
that resolves the **full `revParse` grammar**, and have it return a flat
**`{ id, mode, content }`** record.

```ts
interface ReadFileAtResult {
  readonly id: ObjectId;        // the addressed blob's oid
  readonly mode: FileMode;      // 100644 | 100755 | 120000
  readonly content: Uint8Array; // verbatim committed bytes
}
```

The command composes existing pieces — `revParse(rev)` → `readTree` (peel to root
tree) → `descendTreePath` (shared segment walk) → `readBlob` (blob-guard +
`maxBytes`/`verifyHash`). It introduces **no new refusal**: a missing or
non-tree-intermediate segment reuses `PATH_NOT_IN_TREE`; a directory or gitlink
final entry reuses `UNEXPECTED_OBJECT_TYPE`; an over-cap read reuses
`OBJECT_TOO_LARGE`.

The `<rev>:<path>` **segment descent** that `rev-parse` already implements
privately is lifted into a shared `descendTreePath` primitive both `rev-parse`
and `readFileAt` consume (a behaviour-preserving `refactor(primitives)` landing
before the feature, per the 23.4b precedent of extracting `read-commit.ts` ahead
of `walkCommitsByDate`).

The two are not mutually exclusive forever: the 23.4j read-model convergence may
later let the command delegate to a Core primitive. Per YAGNI we ship one surface
now, and for a helper whose entire reason to exist is convenience, the
full-grammar command is the better single bet.

## Consequences

### Positive

- Every revision form a viewer holds (`main`, `v1.0`, `HEAD~3`, `a1b2c3d`,
  `@{yesterday}`) resolves in a single call — the convenience the backlog asked
  for.
- Consistent with `show`'s established "resolve full grammar, then read" shape;
  no new resolution path to keep faithful.
- `mode` makes the result self-describing (symlink/exec detection) at zero read
  cost.
- The extracted `descendTreePath` removes a latent duplication: `rev-parse`'s
  `<rev>:<path>` walk and `readFileAt` now share one faithful implementation.

### Negative

- `readFileAt` is porcelain-tier, not a Core primitive — a consumer wanting a
  pure commit-ish reader without the grammar still composes primitives. Accepted:
  the grammar *is* the convenience here.
- A command depending on `revParse` deepens the command→command graph (already
  present via `show`).

### Neutral

- `descendTreePath` lives in `primitives/` so the command-tier `readFileAt` and
  `rev-parse` both reach it over the legal `commands → primitives` edge.
- Returning `content` (not the whole `Blob`) keeps the result a flat,
  purpose-built record; the always-`'blob'` `type` tag is dropped as redundant.
- Working-tree/index reads, `.gitattributes` smudge filtering, and batch
  multi-path reads are out of scope (logged in the design), not foreclosed.
