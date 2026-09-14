---
subjects:
  - src/application/primitives/internal/ref-target.ts
  - src/domain/objects/parse-acceptance.ts
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
- **Design:** docs/design/session-caches-faithfulness-addendum.md (B, C, DC-C1 with its parse-acceptance follow-up, DC-C2) · **Supersedes/Refines:** refines ADR-226, ADR-860 and ADR-861

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
(`check_object_signature`). `parse_object_buffer` (`object.c:261`) then parses that buffer and
returns `NULL` — reported as a nonexistent object — when `parse_commit_buffer` (`commit.c:516`) or
`parse_tag_buffer` (`tag.c:130`) refuses it. Those two check far less than a full parse: a commit's
`tree` line and its leading `parent` lines, nothing about `author`, `committer` or the message; a
tag's `object`, `type` and `tag` lines, nothing about `tagger` or the message. `parse_tree_buffer`
validates nothing, and a blob is not parsed.

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

Structural acceptance of a hash-valid commit or tag, which option 1 implies but its first
statement left open:

1. **Transcribe git's own acceptance conditions** from `parse_commit_buffer` and
   `parse_tag_buffer` (chosen by the user) — pros: refuses exactly what git refuses, including a
   commit without a `tree` line, a malformed parent line and an unknown tag type, and accepts
   exactly what git accepts. Cons: a second, deliberately minimal grammar next to tsgit's parsers,
   kept in step with git's by reading its source.
2. **Keep it as a residual** — pros: no new code. Cons: accepts objects git refuses, a divergence on
   a refusal condition the rest of option 1 was chosen to close.
3. **Run tsgit's full commit and tag parsers** — pros: reuses existing code. Cons: their strictness
   has not been probed against git and, read against git's source, they refuse objects git accepts —
   a commit without `author` or `committer`, a tag with an empty name, ids written in upper-case
   hex — so a ref update git performs would be refused.

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

**DC-C1 option 1, structural acceptance option 1, and DC-C2 option 1.**

An internal `assertRefTargetValid(ctx, name, id)` returns at once for the null id. Otherwise it
calls `verifyStoredObject`, which reads the object through the verified blob source at the 64 KiB
buffer gate: a buffered object is inflated once and hashed; a larger loose object or packed base
entry is hashed as it inflates and never retained; a packed delta is reconstructed and hashed; a
`ctx.deltaCache` hit is hashed, not trusted. The parsed-object memo is not on that path. A promised
object is lazy-fetched before it is refused.

For a commit or tag, the bytes that read delivers are also scanned for git's parse acceptance, by a
pure domain function beside the object grammar (`domain/objects/parse-acceptance.ts`). It
transcribes git's refusal conditions and nothing else — for a commit, a `tree ` line of exactly the
hex length followed by a newline and more bytes (`bogus commit object`), hex digits of either case
in it (`bad tree pointer`), and each leading `parent ` line well formed and not the last bytes of
the body (`bad parents`); for a tag, a minimum length of the hex length plus 24, an `object ` line,
a `type ` line whose name is shorter than 20 bytes and is `blob`, `tree`, `commit` or `tag` compared
up to its first NUL (`unknown tag type`), and a `tag ` line ending in a newline. Git's in-process
type conflicts are transcribed only where a fresh process reaches them from the object's own bytes:
a parent id equal to the tree id refuses (`bad parent`), unless the commit is a shallow boundary,
for which git skips the lookup. Below the buffer gate the scan reads the buffered bytes; above it, it
consumes the stream as the hash does and retains at most one partial line and the tree id, so no
body is materialised for it. Its verdict is read only after the hash passed.

Only after the hash and the parse acceptance pass is the stored type tested, and a non-commit on
`HEAD` or `refs/heads/*` is refused.

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
- a commit or tag git's parse acceptance refuses: `INVALID_COMMIT { reason }` or
  `INVALID_TAG { reason }`, the codes tsgit's commit and tag parsers already raise, with `reason`
  naming git's condition; the parent id and the tag type name git prints travel inside `reason`, as
  the tag parser's existing reasons already carry their values;
- a non-commit on a branch: `UNEXPECTED_OBJECT_TYPE { expected: 'commit', actual, id }`
  (ADR-861).

git's lines compose from those fields plus the ref name the caller passed (ADR-249).

**The null id deletes, as git does.** git treats a new value equal to the null id as a deletion
(the files backend marks such an update `REF_DELETING`), and the `!is_null_oid` guard keeps it out
of verification. Pinned against git 2.55.0 (decided with the user after the design, 2026-09-14):

- `update-ref refs/heads/b 0{40}` on an existing loose branch exits 0; the ref and its own reflog
  are removed. `update-ref -d` behaves identically.
- When `HEAD` symbolically points at the deleted branch, `logs/HEAD` gains one entry
  `<old> 0{40} <identity>\t<message>`, for the null id and for `-d` alike.
- An absent ref exits 0 and nothing is created, reflog included.
- An old value that matches deletes; one that does not refuses with `is at <oid> but expected
  <old>` and leaves the ref; an old value on an absent ref refuses `unable to resolve reference`;
  a null old value on an existing ref refuses `reference already exists`.
- The reftable backend deletes the ref and its reflog the same way.

`updateRef` given the null id without `delete: true` therefore takes the delete path: no target
verification, the compare-and-swap honoured, an absent ref (with no `expected`, or `expected:
'absent'`) a no-op success, the ref's own reflog removed, and the coupled `HEAD` reflog entry
written when `HEAD` points at the deleted ref. The `delete: true` path is not changed: its callers log
`HEAD` themselves where git does — `branch.rename` deletes the old name while `HEAD` still points at it
and writes git's rename entries instead — so adding the coupled entry there would break their reflog
bytes.

**B follows as a consequence.** Lightweight `tag.create` writes through `updateRef`, so it now
refuses a nonexistent target and accepts every existing type. To keep git's order (B4), a
non-forced `tag.create` checks for an existing name before it creates an annotated tag object or
calls `updateRef`, and refuses `TAG_EXISTS` there; the compare-and-swap stays as the race guard. A
forced create skips the pre-check and reaches verification.

## Consequences

`updateRef`, `tag.create` and `clone` gain refusals, each matching a git refusal. A new cross-tool
interop test pins C1–C9, B1–B6, and hash-valid objects written with `git hash-object --literally`: a
commit without a `tree` line, a malformed parent line, an unknown tag type and a truncated tag
object line refused by both tools; a commit without `author` or `committer` on a branch, and a tree
with garbage entries on a tag ref, accepted by both.

`updateRef(name, <null id>, …)` stops writing a ref that holds the null id: it deletes the ref, as
`git update-ref <ref> 0{40}` does, and a caller that passed the null id to create a placeholder ref
now removes it instead. Deleting the branch `HEAD` points at through the null id appends git's
`<old> 0{40}` entry to `logs/HEAD`. The interop test pins the existing, absent,
matching-old, mismatching-old and reftable rows and the reflog outcome of each.

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

- **In-process type conflicts from earlier parses.** git also refuses when an id was already
  parsed as another type earlier in the same process — another update in one
  `update-ref --stdin` transaction, for instance. tsgit keeps no process-wide object table, so only
  the conflict a commit's own bytes produce is transcribed.
- **`info/grafts`.** tsgit reads no grafts file, so for a commit listed there the parent-equals-tree
  refusal applies where git skips the lookup; shallow boundaries match.
- **Writers outside DC-C2's set** — internal writers of ids the same command produced (`commit`,
  `stash`, `rebase`, `checkout`, `worktree`, `submodule`) — remain unverified, where git verifies
  every writer.
- **The empty-tree id** as a target in a repository that does not store it is not among the pins.
  The implementation adds that interop row and follows git's answer.
- **A packed deltified target** is reconstructed in memory under the compressor port's 2 GiB cap
  before it is hashed, as every tsgit read of a deltified object is.

This record corrects ADR-860's closing paragraph, which states that git types lightweight
`tag.create` targets; git checks existence only (B1–B8).
