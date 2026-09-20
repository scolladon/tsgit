---
subjects:
  - src/domain/objects/git-object.ts
  - src/application/primitives/object-resolver.ts
  - src/application/primitives/internal/blob-source.ts
  - src/application/primitives/read-object.ts
  - src/application/primitives/cat-file-batch.ts
---
# 863 — A size-lying loose header serves a blob's real bytes and refuses a commit, tree or tag

- **Status:** accepted
- **Date:** 2026-09-14
- **Design:** docs/design/session-caches-faithfulness-addendum.md (A, DC-A1, DC-A2) · **Supersedes/Refines:** refines ADR-226; keeps ADR-854's cache value shape

## Context

A loose object's header carries a size claim; the body behind it is whatever zlib emits. When the
two disagree, tsgit's own reads disagree with each other: `catFile`, `readObject` and
`readObject { verifyHash }` refuse `INVALID_OBJECT_HEADER` (`size mismatch: header says N, actual
content is M`), `streamBlob` serves the real bytes, and `streamBlob { verifyHash }` refuses
`OBJECT_HASH_MISMATCH` because it hashes the stored header.

Pinned against git 2.55.0 (design matrix A1–A4), git has no single rule either. It has three tiers:

- The **header-only** tier (`cat-file -s`, `--batch-check`, `ls-tree -l`) reports the claim.
- The **streaming** tier (`read_istream_loose`, `odb/source-loose.c:292`) inflates to
  `Z_STREAM_END` and ignores the claim. `cat-file -p`, `cat-file blob`, `show`, `checkout` and
  `--batch` route blobs to it (`builtin/cat-file.c:199-230, :430`) and emit the real bytes.
- The **buffered** tier (`unpack_loose_rest`, `object-file.c:202`) allocates a zero-filled buffer
  of the claimed size. Every commit, tree and tag read goes through it: a body longer than the
  claim dies `corrupt loose object`, a shorter one is zero-padded and then refused `hash mismatch`
  by every `parse_object` caller (`object.c:378`) — except `log`, `show -s`, `status` and `commit`
  on an under-running commit body, which accept the padded buffer. Blobs read through it (`diff`,
  `archive`, `grep`, `repack`) are truncated, padded or refused depending on where the body ends
  relative to the first inflate chunk.

`fsck` and every hash-verifying read refuse.

The claim is attacker-controlled: a planted `.git` or a crafted loose file. git's buffered tier
allocates from it — a 12-byte blob claiming 104 857 600 bytes made `git repack -ad` write a
104 857 600-byte object into the pack. tsgit's loose arm allocates what zlib emits, under the
compressor port's 2 GiB cap, and `enforceLooseCap` measures the actual content; the equality check
it has today protects header integrity, not an allocation.

## Options considered

What a read does with a size-lying loose object (DC-A1):

1. **Type-directed** (recommended, chosen) — a blob takes git's streaming contract on every tsgit
   read: its body is served, it is never admitted to `ctx.deltaCache`, and `verifyHash` hashes the
   stored header so it refuses; a commit, tree or tag keeps the refusal. Pros: matches every
   user-facing git blob read and every git commit/tree parse, removes the `streamBlob`/`readObject`
   disagreement, and allocates nothing from the claim. Cons: does not reproduce git's buffered-tier
   blob artefacts, nor the `log` acceptance of an under-running commit.
2. **Refuse on every read, `streamBlob` included** (count the bytes, refuse at stream end) — pros:
   one rule. Cons: diverges from git's most common blob reads (`cat-file -p`, `show`, `checkout`).
3. **Serve the body for every type; refuse only under `verifyHash` or `fsck`** — cons: diverges on
   nearly every commit and tree command.
4. **Transcribe git's three tiers**, truncation and zero-padding included — cons: reproducing them
   means sizing a buffer from the claim, the attacker-chosen allocation described above. Rejected on
   the threat model, not on effort.

What `catFile`'s entry `size` reports for such a blob (DC-A2):

1. **The stored header claim; `readObjectMetadata` stays content-derived** (recommended, chosen) —
   pros: the entry's documented contract is the `size` field of git's `cat-file --batch` header,
   which prints the claim (`-s` and `ls-tree -l` agree). Cons: one internal read variant and a
   `declaredSize` slot on the resolver's return.
2. **The body length** (today's derivation), recorded as a residual — cons: reports data git does
   not.
3. **The claim on both `catFile` and `readObjectMetadata`** — cons: feeds an untrusted number to
   `deltify` and the pack writer, whose sizes must equal the bytes they write.

## Decision

**Option 1 for both.**

The loose arm splits an object with the claim kept as data (`splitLooseObject`) and refuses only a
size-lying commit, tree or tag (`assertLooseSizeConsistent`, today's reason verbatim).
`enforceLooseCap` keeps measuring the actual bytes. A size-lying blob is served with its inflated
bytes by `readObject`, `readBlob`, `catFile`, `streamBlob` and checkout, and is never cached: a
later `verifyHash` read cannot be answered from an entry whose header would be re-derived from the
content length. Under `verifyHash` the stored header is hashed — `serializeHeader(type,
declaredSize)` reproduces it byte for byte, because `parseHeader` refuses every non-canonical
header text — so the read refuses `OBJECT_HASH_MISMATCH { expected, actual }`, as `streamBlob`
already does and as `git fsck` reports `hash-path mismatch`.

The resolver's return gains `declaredSize` on every arm — the content length wherever no loose
header exists — as one more slot on the same literal, with no new `await` on the per-object read
path. `catFile`'s entry `size` is `declaredSize` for every type: the header size git's `--batch`
prints, equal to the body length for every honest object. `readObjectMetadata` stays
content-derived, its documented contract and the value `deltify` budgets on. `splitObject` keeps its strict check, because `parseObject` is public. The
`ctx.deltaCache` value stays `{ type, content }` (ADR-854); no header-prefixed buffer returns.

## Consequences

Observable changes: a size-lying loose blob is readable through every tsgit read, where most of
them refused it before; `catFile` reports the claim for it; a size-lying commit, tree or tag still
refuses `INVALID_OBJECT_HEADER`. The errors page narrows that row to commits, trees and tags and
states that `OBJECT_HASH_MISMATCH` hashes the stored header. A new cross-tool interop test pins the
blob and commit rows against real git.

After this record no tsgit code sizes an allocation from a loose header claim. The claim surfaces
only as a number on `catFile`'s entry and never reaches `readObjectMetadata`, `deltify`, the pack
writer or a buffer constructor.

Residuals, recorded:

- **No truncation or zero-padding on tsgit's buffered consumers** (`diff`, `archive`, `grep`,
  `pack-objects`): they see the real blob bytes. A tsgit `gc` over a size-lying loose blob
  therefore writes the canonical object into the pack, where `git repack` writes the truncated or
  padded bytes, or dies.
- **An under-running commit body refuses** in tsgit where git's `log`, `show -s`, `status` and
  `commit` accept the padded buffer.
- **Claims in `(2^53, 2^64)` refuse** `invalid size` in `parseHeader`, because a `number` cannot
  carry them; git's header tier prints them (A3).
- **`INVALID_OBJECT_HEADER` carries no `id`.** git's `corrupt loose object '<oid>'` line is
  composed by the caller from the id it asked for (ADR-249).
