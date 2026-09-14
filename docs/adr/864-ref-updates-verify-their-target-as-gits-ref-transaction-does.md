---
subjects:
  - src/application/primitives/internal/ref-target.ts
  - src/application/primitives/internal/blob-source.ts
  - src/application/primitives/update-ref.ts
  - src/application/primitives/read-object.ts
  - src/application/primitives/stream-blob.ts
  - src/application/commands/clone.ts
  - src/application/commands/tag.ts
---
# 864 — Ref updates verify their target as git's ref transaction does

- **Status:** accepted
- **Date:** 2026-09-14
- **Design:** docs/design/session-caches-faithfulness-addendum.md (B, C, DC-C1, DC-C2) · **Supersedes/Refines:** refines ADR-226, ADR-860 and ADR-861

## Context

`updateRef` writes whatever id it is given: `updateRef('refs/heads/u', <tree>)` and
`updateRef('refs/tags/nx', <nonexistent>)` both succeed. `clone` writes remote-advertised ids
straight through `applyRefUpdates` (`writeRef`, and `applyRemoteHead`'s detached arm), so an
advertisement can plant a branch at a tree.

git verifies inside the ref transaction, for every writer (`refs.c:1425-1445`): an update that has
a new value, is not symbolic, is not to the null id and is not flagged `REF_SKIP_OID_VERIFICATION`
runs `parse_object`. A `NULL` result is refused `trying to write ref '<ref>' with nonexistent
object <oid>`; a non-commit written to a branch — `HEAD` or `refs/heads/*`, `is_branch` at
`refs.c:1072` — is refused `trying to write non-commit object <oid> to branch '<ref>'`. Pinned
against git 2.55.0 (design matrix C1–C9):

- An annotated tag object on a branch is refused, not peeled (C1). Every existing type is accepted
  on `refs/tags/*`, `refs/remotes/*`, `refs/notes/*`, `refs/*`, `refs/stash` and `ORIG_HEAD` (C2,
  C5).
- `update-ref --no-deref HEAD <tree>` refuses: `HEAD` is a branch (C4).
- Verification precedes the old-value check (C7).
- `parse_object` hashes the object: a hash-mismatching blob or commit is reported `hash mismatch`
  and then as nonexistent (C8).
- Deletes, null ids and symbolic writes are not verified (C9). The only
  `REF_SKIP_OID_VERIFICATION` user in v2.55.0 is ref-storage migration (`refs.c:3200`); `fetch`,
  `clone`, `receive-pack`, `stash`, `notes` and the sequencer all verify.

`parse_object` (`object.c`, `parse_object_with_flags`) looks the type up from the header first,
streams a blob's hash (`stream_object_signature`), and hashes every other type from a whole buffer
(`check_object_signature`).

For a lightweight tag git checks existence only: tree, blob and tag-object targets all succeed (B1),
a nonexistent target is refused by the transaction (B2, B5), identically on the reftable backend
(B8). An existing tag name is reported before the target is verified (B4): `builtin/tag.c:658-694`
resolves the target, validates the name, checks `already exists`, creates the tag object, then runs
the transaction. tsgit's `tag.create` detects an existing name only through `updateRef`'s
compare-and-swap, which would now run after verification.

## Options considered

Strength of the check (DC-C1):

1. **Full `parse_object` parity** (chosen by the user; not the design's recommendation) — the
   object exists and its stored bytes hash to its id; a branch additionally needs a commit. Pros:
   every pinned row, C8 included, matches git; a ref can only name an intact object. Cons: every
   verified update reads and hashes one object; a tag or remote-tracking ref at a large blob hashes
   the whole blob.
2. **Presence for non-branch refs, a header-only type probe for branches, no hash** (the design's
   recommendation) — pros: never inflates a blob for a presence question, and a branch update reads
   one pack entry header. Cons: accepts a hash-mismatching object (C8), a recorded divergence on a
   refusal condition.
3. **A full read without the hash for every target** — cons: pays option 1's read without its
   verdict.

The design argued against option 1 as tabled — `readObject { verifyHash: true }` — because that
read materialises every body, a large blob included. The user chose parity on the refusal surface
over the cost. The design was then revised so the check hashes a body above the buffer gate while
it inflates instead of materialising it: the memory objection no longer holds, the hashing cost
does.

Placement (DC-C2):

1. **`updateRef` plus `clone`'s two direct writers of remote-sourced ids** (recommended, chosen) —
   pros: covers every surface whose ids arrive from outside the process. Cons: the other direct
   writers stay unverified.
2. **The `RefStore.applyRefUpdates` seam on both backends** — git's transaction-layer placement,
   every writer. Pros: structurally faithful. Cons: verifies ids the same command has just written,
   and touches every store unit test that seeds a synthetic oid (heuristic upper bound: 711 literals
   across 172 test files).
3. **`updateRef` only** — cons: leaves `clone` planting a tree at `refs/heads/*`.

## Decision

**DC-C1 option 1 and DC-C2 option 1.**

An internal `assertRefTargetValid(ctx, name, id)` returns at once for the null id. Otherwise it
calls `verifyStoredObject`, which reads the object through the verified blob source at the 64 KiB
buffer gate: a buffered object is inflated once and hashed; a larger loose object or packed base
entry is hashed as it inflates and never retained; a packed delta is reconstructed and hashed; a
`ctx.deltaCache` hit is hashed, not trusted. The parsed-object memo is not on that path. A promised
object is lazy-fetched before it is refused. Only after the hash passes is the stored type tested,
and a non-commit on `HEAD` or `refs/heads/*` is refused.

`updateRef` calls it after `validateRefName` and before it resolves the current value, so
verification precedes the compare-and-swap; a delete skips it. `clone`'s `writeRef` and
`applyRemoteHead`'s detached `set` call it before `applyRefUpdates`. Symbolic writes are not
verified. To give the check the stored type of a loose object above the gate, the blob source's
loose stream arm parses its header when it opens rather than on first drain; `streamBlob` keeps
refusing a loose non-blob with the same data, now at its `await`.

Refusal data reuses existing codes, so the error union, the exhaustiveness switches and the API
report do not change:

- an absent object: `OBJECT_NOT_FOUND { id }`;
- a hash mismatch: the verified read's own `OBJECT_HASH_MISMATCH { expected, actual }`;
- a non-commit on a branch: `UNEXPECTED_OBJECT_TYPE { expected: 'commit', actual, id }`
  (ADR-861).

git's lines compose from those fields plus the ref name the caller passed (ADR-249).

**B follows as a consequence.** Lightweight `tag.create` writes through `updateRef`, so it now
refuses a nonexistent target and accepts every existing type. To keep git's order (B4), a
non-forced `tag.create` checks for an existing name before it creates an annotated tag object or
calls `updateRef`, and refuses `TAG_EXISTS` there; the compare-and-swap stays as the race guard. A
forced create skips the pre-check and reaches verification.

## Consequences

`updateRef`, `tag.create` and `clone` gain refusals, each matching a pinned git refusal. A new
cross-tool interop test pins C1–C9 and B1–B6.

Every verified ref update costs one object read and one hash. A commit-sized target costs one read,
one inflate and one hash, or a `ctx.deltaCache` hit plus the hash; `commit` pays it once per commit
for the commit it has just written. A blob target costs a hash over its whole body, streamed above
the gate. A `clone` or `fetch` writing N refs hashes N targets, as git's transaction does.
`commit.bench` and the `branch.create` floor are re-measured main-vs-branch when the change is
implemented, and the numbers are recorded with it.

Unit fixtures that write refs to synthetic oids through `updateRef` must write a real object first,
or use a non-branch ref where the type is not the point; `applyRefUpdates` fixtures are untouched.

Inside one process tsgit is stricter than git: `parse_object` returns an object the process has
already parsed without hashing it again. tsgit's caches outlive a command and are filled by
unverified reads, so they cannot stand in for git's object table, and tsgit hashes on every
verified update. A fresh git process — what every pin measures — reaches the same verdicts.

Residuals, recorded:

- **No structural parse.** `parse_object_buffer` (`object.c`) also returns `NULL` when
  `parse_commit_buffer`, `parse_tag_buffer` or `parse_tree_buffer` fails on a hash-valid object;
  tsgit's check hashes without parsing, so such an object is accepted. Not probed.
- **Writers outside DC-C2's set** — internal writers of ids the same command produced (`commit`,
  `stash`, `rebase`, `checkout`, `worktree`, `submodule`) — remain unverified, where git verifies
  every writer.
- **The empty-tree id** as a target in a repository that does not store it is not among the pins.
  The implementation adds that interop row and follows git's answer.
- **A packed deltified target** is reconstructed in memory under the compressor port's 2 GiB cap
  before it is hashed, as every tsgit read of a deltified object is.

This record corrects ADR-860's closing paragraph, which states that git types lightweight
`tag.create` targets; git checks existence only (B1–B8).
