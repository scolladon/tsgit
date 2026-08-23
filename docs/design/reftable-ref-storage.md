# Design — reftable ref storage

> Brief: [ADR-667](../adr/667-tsgit-accepts-every-extension-git-knows.md) ratified that tsgit
> accepts **every** `extensions.*` git knows, and expanded scope so that acceptance is not a lie.
> `refStorage = reftable` is one of the two subsystems that entered the change on that ticket.
> Lift: a domain codec for the reftable binary format, a backend seam behind `RefStore`, and —
> since [ADR-680](../adr/680-reftable-ships-as-a-complete-backend.md) — a **complete backend**:
> reads, writes, the transaction protocol, and compaction.
>
> **The brief's premise understates the defect.** ADR-667 records that a reftable repository
> "presents as **ref-less**" to tsgit. Measured (§Observed failure), it is worse in three separate
> ways. tsgit does not see zero refs — it sees **one phantom ref**, `refs/heads`, because git's
> reftable stub `.git/refs/heads` is a *regular file* whose 41 bytes read as a ref name.
> `branchList` does not return empty — it **throws `INVALID_REF`**, because the stub `.git/HEAD`
> points at `refs/heads/.invalid`. And the write path is **not inert**: `updateRef` into a
> reftable repository *writes the loose ref and its reflog to disk*, then throws `INVALID_REF`
> from a post-write step. The caller sees a failure; the repository keeps a durable ref that
> **git will never see and `git fsck` does not report**. That is not an empty view of a populated
> repository — it is two divergent populated views, created by an operation that reported that it
> failed.
>
> Status: **ratified** — [ADR-680](../adr/680-reftable-ships-as-a-complete-backend.md) (complete
> read + write + compaction backend, all three adapters),
> [ADR-686](../adr/686-refstore-generalises-to-a-backend-neutral-interface.md) (the seam),
> [ADR-687](../adr/687-the-ref-backend-reaches-context-through-the-layout.md) (backend selection),
> [ADR-688](../adr/688-a-corrupt-reftable-stack-refuses-by-tier.md) (corruption tiering),
> [ADR-689](../adr/689-reflogs-route-through-the-same-backend-seam.md) (reflogs on the same seam),
> [ADR-690](../adr/690-refs-migrate-is-not-a-tsgit-surface.md) (no migration surface),
> [ADR-691](../adr/691-the-reftable-parser-lives-in-domain-refs.md) (codec location),
> [ADR-692](../adr/692-the-reftable-stack-loads-eagerly.md) (eager stack load).
> Every candidate the read-only draft raised is settled (§Settled decisions). **Four new
> candidates the widened scope surfaces are open: DN-1 … DN-4** (§New decision candidates).
>
> ADR-680 ratified **against** this design's earlier recommendation of a read-only backend. §5–§10
> are the write side that ratification requires — the writer, the transaction, compaction, the
> ordering fix, adapters, concurrency — measured the same way §1 was: against the binary, never
> against the spec text. §2–§4 are re-scoped around them.

## Context

### What exists today

`RefStore` (`src/application/primitives/ref-store.ts`) is the nearest thing tsgit has to a ref
backend. It is created once per `Context` through a module-level `WeakMap`
(`getRefStore(ctx)` → `createRefStore(ctx)`), mirroring the `registryCache` pattern in
`read-object`, with mtime-keyed `packed-refs` invalidation held in the closure:

```ts
export interface RefStore {
  resolveDirect(name: RefName): Promise<ResolveDirectResult>;
  writeLoose(name: RefName, id: ObjectId): Promise<void>;
  removeLoose(name: RefName): Promise<void>;
  isLoose(name: RefName): Promise<boolean>;
  readLooseRaw(name: RefName): Promise<string | undefined>;
  getPackedRefs(): Promise<PackedRefs>;
}
```

**Four of the six methods name the files backend in their own signature.** A reftable backend has
no "loose" anything, no `packed-refs`, and no raw per-ref text. ADR-686 settles this: the
interface narrows to backend-neutral verbs. §3 is the caller census that sizes that narrowing.

**The seam is narrower than the problem.** `createRefStore` has exactly one call site
(`getRefStore`, same file) — a genuinely clean swap point. But only **one of six** ref
enumerators in `src/` goes through it, and the four files-shaped methods have only ten call sites
between them, while the files *layout* is read directly by a dozen modules that never touch
`RefStore` at all. §3.1 is the census; the short version is that swapping `RefStore` alone
changes what `resolveRef` answers and leaves `branchList`, `tagList`, `fetch`, and every reflog
read still walking directories that a reftable repository does not have.

### What a reftable repository actually is

Everything in §1 was measured against **git 2.55.0** in a `mktemp -d` throwaway with an isolated
`HOME`, `GIT_CONFIG_NOSYSTEM=1`, every `GIT_*` scrubbed and signing off. Structural claims come
from bytes dumped from real reftable repositories, cross-checked against the format specification
that ships with this git build at
`/opt/homebrew/Cellar/git/2.55.0/share/doc/git-doc/technical/reftable.adoc` (1098 lines,
available locally — no claim here rests on recollection). Where a claim about a *policy* rather
than a *format* could not be produced from the outside alone, it is stated as a rule read from
git's own `reftable/` sources at tag `v2.55.0` **and** replayed against measured data; §1.15 does
this for auto-compaction and reports the replay score.

**Three places the shipped spec does not match the shipped binary**, all found by measurement and
all load-bearing enough that designing from the spec alone would have produced wrong bytes:

| # | spec says | git 2.55.0 does | consequence |
|---|---|---|---|
| S1 | reflog `tz_offset` is "the absolute number of minutes from GMT"; `GMT+0230` ⇒ `sint16(150)` | writes the raw `±HHMM` integer; `+0230` ⇒ `sint16(230)` (§1.6, six zones) | a spec-faithful reader misreports every non-zero-offset reflog timestamp |
| S2 | "This forces the first `restart_offset` to be `28`" | 28 for version 1, **32** for version 2 (§1.4) | the spec sentence is v1-only; the rule is `header_size + 4` |
| S3 | "A log index block **must** be written if 2 or more log blocks are written to the file" | writes one only at **4 or more** log blocks (§1.13, measured 2 → none, 3 → none, 4 → present) | a *reader* must brute-force the log section when `log_index_position == 0` even with several log blocks; a *writer* that honours the spec's MUST is not byte-identical to git |

S1 and S2 were carried from the read-only draft. **S3 is new to this revision** and only surfaces
once you have to decide what a writer emits.

### Observed failure (measured, not assumed)

Fixture: `git init --ref-format=reftable`, one commit, a branch, a symbolic ref, a lightweight
tag, an annotated tag, one deleted ref. git reports **5 refs and a reflog**. tsgit was driven
through its own primitives against that exact directory, and against a `--ref-format=files` clone
of it as control.

| surface | files control | reftable repository | verdict |
|---|---|---|---|
| `enumerateRefs` | the real ref set | `["HEAD","refs/heads"]` | **phantom ref** — the stub file `.git/refs/heads` enumerated as a ref name |
| `resolveRef('HEAD')` | the oid | throws `INVALID_REF` / `ref name component must not start with .` | unsupported repo misreported as a caller's bad ref name |
| `resolveRef('refs/heads/main')` | the oid | throws `NOT_A_DIRECTORY` (`.git/refs/heads/main`) | unsupported repo misreported as a filesystem-shape fault |
| `branchList` | 1 branch | throws `INVALID_REF` | a listing command that cannot list |
| `tagList` | `{tags:[]}` | `{tags:[]}` — **2 tags exist** | silently wrong, no signal at all |
| `listReflogs` | 3 reflogs | `[]` — reflogs exist | silently wrong |
| `readReflog('refs/heads/main')` | 1 entry | `[]` — entries exist | silently wrong |
| `getRefStore().getPackedRefs()` | 41 entries | `{entries:[],peeling:'none',sorted:false}` | the "ref-less" reading ADR-667 recorded |

Three distinct misdiagnoses (`INVALID_REF`, `NOT_A_DIRECTORY`, and silent-empty), and **not one
of them names reftable**. A caller cannot tell "this repository uses a storage format tsgit
cannot read" from "you passed a bad ref name".

**The write path is the serious one.** `updateRef` was run for four ref names against a reftable
repository:

| ref written | tsgit result | on disk afterwards | git afterwards |
|---|---|---|---|
| `refs/heads/zz` | throws `NOT_A_DIRECTORY` | nothing | unchanged |
| `refs/tags/zz` | throws `INVALID_REF` | **`.git/refs/tags/zz` written** | **does not exist** |
| `refs/notes/commits` | throws `INVALID_REF` | **written + `.git/logs/refs/notes/commits`** | **does not exist** |
| `refs/remotes/origin/zz` | throws `INVALID_REF` | **written + reflog** | **does not exist** |

The `INVALID_REF` is raised by `logCoupledHead`, which reads `HEAD` **after** `atomicWriteRef` has
already committed the ref file. So the operation reports failure and leaves durable state. After
those four calls tsgit's `enumerateRefs` returns
`["HEAD","refs/heads","refs/notes/commits","refs/remotes/origin/zz","refs/tags/zz"]` and
`resolveRef('refs/tags/zz')` resolves — while `git for-each-ref` is byte-identical to before and
**`git fsck` and `git refs verify` both report nothing**. The divergence is invisible to git's
own integrity checks.

`refs/heads/zz` was blocked only because the stub `.git/refs/heads` is a *file*, so `mkdir` fails.
That is accidental protection covering exactly one namespace, not a designed refusal.

ADR-680 records that this ordering bug is **fixed** by this work, not merely made unreachable.
§8 designs the fix; it is a files-backend bug too, and it is reachable today on any repository
where reading `HEAD` can fail after a ref write has committed.

### Binding constraints

- **Prime directive** (CLAUDE.md, [ADR-226](../adr/226-git-faithfulness-prime-directive.md)) —
  replicate git's observable behaviour byte-for-byte unless an ADR explicitly diverges. Reftable
  is a binary on-disk format that tsgit now **writes**, so this binds the bytes, not only the
  messages. Two ratified divergences apply: ADR-688 (corrupt stacks) and the measured limit on
  byte-identity in §1.14, which DN-1 asks the user to settle.
- **Structured output** ([ADR-249](../adr/249-describe-structured-data-only.md)) — the library
  returns fields, never rendered lines. Nothing in this design emits display text; §11 pins
  faithfulness by reconstructing git's output *in the interop test* from structured fields.
- **Point-of-use refusal** (ADR-667's standing rule, [ADR-685](../adr/685-one-generic-point-of-use-refusal-code.md))
  — where tsgit cannot act on an accepted extension it refuses *precisely, at the point of use*;
  never by reading the repository wrong, and never by refusing to open a repository git opens.
- **Acceptance gate** (`docs/design/repository-format-acceptance-gate.md`,
  [ADR-666](../adr/666-repository-format-refusals-keep-gits-config-porcelain-tier.md),
  [ADR-668](../adr/668-two-repository-format-refusal-codes.md),
  [ADR-682](../adr/682-acceptance-refusals-attach-to-a-third-tier.md)) —
  `extensions.refStorage` is read at v1 from `<commonDir>/config` only, in the Stage-2 scan, with
  value grammar `files`/`reftable`. This design **consumes** that read; it does not redesign it.
  ADR-682 introduced a third tier, `assertAcceptedRepository`, between `assertRepository` and
  `assertOperationalRepository`. Backend selection here is **layout-resolved** (ADR-687), so it
  happens strictly before any tier assertion and this design adds nothing to any tier. The one
  place the tier matters is §4: a reftable refusal is a point-of-use throw from the backend, not a
  gate refusal, so it never attaches to `assertAcceptedRepository` and the ADR-682 allowlist guard
  is untouched.
- **Coverage / mutation** — `src/domain` and `src/adapters` gate at 100% line/branch/function/
  statement; Stryker mutates all of `src`. The codec, the stack, the writer and the compaction
  policy all live in `src/domain/refs/reftable/` (ADR-691) and are inside that scope.

## Requirements

- **R1** — A reftable repository opens. tsgit never refuses to open a repository git opens.
- **R2** — The phantom ref is gone. `enumerateRefs` on a reftable repository never returns
  `refs/heads` from the stub file, and never returns a name derived from files-layout residue.
- **R3** — Every ref read surface answers from the reftable stack, matching `git show-ref` /
  `git for-each-ref` on the same repository: direct refs, symbolic refs, annotated-tag peeled
  values, and tombstone deletions.
- **R4** — `HEAD` resolves through the stack, not through the `.git/HEAD` stub. The literal
  `refs/heads/.invalid` is never surfaced to a caller as a ref name.
- **R5** — No silent-empty. Where a reftable repository is readable, the answer is right; where it
  is not, the refusal names what failed — `INVALID_REFTABLE { check, reason }` or
  `REFTABLE_LOCKED { stack }` (§4) — and is distinguishable by `code` from the `INVALID_REF` and
  `NOT_A_DIRECTORY` that §Observed failure measured.
- **R6** — **No write leaves divergent state.** Every write surface either commits its reftable
  transaction or leaves the repository byte-unchanged. The measured write-then-throw of
  §Observed failure is closed at its cause (§8), not routed around.
- **R7** — The codec is width-generic from the first commit: version 1 (SHA-1, 24-byte header)
  and version 2 (28-byte header, `hash_id`) are both parsed **and written**, with the digest width
  taken from the file on read and from the repository's object format on write, never from a
  constant.
- **R8** — Reflog reads and writes go through the stack's log blocks, including the `tz_offset`
  encoding actually used by git (§1.6), not the one the spec documents.
- **R9** — Per-worktree ref scoping is preserved: a linked worktree's own stack is consulted and
  written for per-worktree refs and the common stack for shared refs (§1.8, §1.12).
- **R10** — Nothing tsgit writes creates a reftable repository *by accident*.
  `bootstrapRepository` continues to emit `repositoryformatversion = 0` and no `[extensions]`
  unless a caller asks for reftable explicitly, so tsgit cannot trip its own backend.
- **R11** — Wherever an adapter cannot express the transaction protocol (§9), the difference is
  named and decided, never silently absorbed. DN-2 decides whether such an adapter refuses or
  ships with a documented caveat.
- **R12** — The parser tolerates every shape the format permits, not only the shapes git's own
  writer emits (§1.11): unaligned files (`block_size = 0`), log-only files, multi-level indexes,
  and — new in this revision — a log section with 2 or 3 blocks and **no** log index (S3).
- **R13** — **A table tsgit writes is readable by git**, and a table git wrote is readable by
  tsgit, in both hash widths. The stronger byte-level contract is DN-1.
- **R14** — **The transaction is crash-safe in git's shape.** A crash at any point leaves either
  the pre-state or the post-state, never a stack that git reads differently from tsgit. The
  measured crash residue (§1.12, §1.15) — a stale `tables.list.lock`, an orphan `*.ref` — is
  exactly what git leaves, and tsgit leaves the same and recovers the same way.
- **R15** — **Auto-compaction keeps the stack geometric.** After any sequence of tsgit writes the
  stack satisfies the same geometric invariant git maintains (§1.15), so stack depth stays bounded
  without a `pack-refs` surface. DN-4 decides what happens to orphaned table files.
- **R16** — **A concurrent writer is serialised, not corrupted.** Two tsgit writers, or a tsgit
  writer and a `git` writer, on the same stack either both succeed or one fails with a lock
  refusal; the stack is never left inconsistent, and a reader concurrent with a write always sees
  a complete pre- or post-state.

## Design

### 1. Pinned matrix — canonical git 2.55.0

All rows measured. `<LF>` is the literal byte. Hex is verbatim from the fixtures.

#### 1.1 Creation, config, and the on-disk tree

| probe | result |
|---|---|
| `git init --ref-format=reftable` | succeeds; `Initialized empty Git repository` |
| config written | `[extensions]<LF><TAB>refstorage = reftable<LF>[core]<LF><TAB>repositoryformatversion = 1<LF>…` — key emitted **lower-case** |
| `git rev-parse --show-ref-format` | `reftable` (files repo: `files`) |
| `.git/reftable/` | the stack directory |
| `.git/reftable/tables.list` | plain text, one filename per line, LF-terminated including the last, ordered **oldest → newest** |
| table filename | `0x%012x-0x%012x-%08x.ref` — e.g. `0x000000000001-0x000000000007-151aa9f1.ref` |
| `.git/packed-refs` | **absent** |
| `.git/logs/` | **absent** — reflogs live in the stack |
| `.git/HEAD` | present, a stub: `ref: refs/heads/.invalid<LF>` (25 bytes) |
| `.git/refs/` | a **directory** |
| `.git/refs/heads` | a **regular file**, 41 bytes: `this repository uses the reftable format<LF>` |

The last two rows are the compatibility stubs the spec's *Backward compatibility* section
mandates, and they are exactly what produces the phantom ref and the accidental
`NOT_A_DIRECTORY` in §Observed failure. `find-layout.ts:320` `sharedDirsValid` requires
`<commonDir>/refs` to be a directory — a reftable repo satisfies that, so discovery already
passes today.

An `extensions.refStorage = reftable` planted on a repository with a **files** layout is not an
error to git: `git status` reports `Not currently on any branch. / No commits yet`. The
extension, not the directory contents, selects the backend. A bogus value is refused at the
config tier, not the extension tier: `error: invalid value for 'extensions.refstorage':
'banana'` followed by `fatal: bad config line 9 in file .git/config`.

#### 1.2 File structure

```
first_block { header  first_ref_block }
ref_block*  ref_index*  obj_block*  obj_index*  log_block*  log_index*  footer
```

Header, version 1 — 24 bytes:

```
'REFT' | uint8(version=1) | uint24(block_size) | uint64(min_update_index) | uint64(max_update_index)
```

Header, version 2 — 28 bytes: identical plus `uint32(hash_id)`, `"sha1"` or `"s256"`.

Footer — `HEADER` then `uint64(ref_index_position)`, `uint64((obj_position << 5) | obj_id_len)`,
`uint64(obj_index_position)`, `uint64(log_position)`, `uint64(log_index_position)`,
`uint32(CRC-32 of all preceding footer bytes)`. **68 bytes for v1, 72 for v2.** A zero position
means the section is absent. Readers must `stat` for the length, seek to
`file_length - FOOTER_LENGTH`, and verify magic, version and CRC-32.

Measured empty tables: v1 = **124 bytes** (footer at 56), v2 = **132 bytes** (footer at 60). The
CRC-32 was recomputed over the first 64 (v1) / 68 (v2) footer bytes and matched in every fixture.

Block types: `'r'` ref, `'i'` index, `'o'` obj, `'g'` log. Each non-log block is
`type | uint24(block_len) | record+ | uint24(restart_offset)+ | uint16(restart_count) | padding?`.
`block_len` excludes padding; **for the first block it includes the 24/28-byte file header**.
`restart_count` must not be zero. Ref/obj/index blocks are aligned to `block_size` when
`block_size != 0`; log blocks are **never** aligned or padded.

#### 1.3 Varint

The pack ofs-delta encoding, quoted from the spec and confirmed against every fixture:

```
val = buf[ptr] & 0x7f
while (buf[ptr] & 0x80) { ptr++; val = ((val + 1) << 7) | (buf[ptr] & 0x7f) }
```

#### 1.4 Ref records — the full value-type matrix

```
varint(prefix_length) | varint((suffix_length << 3) | value_type) | suffix
  | varint(update_index_delta) | value?
```

`update_index = min_update_index + update_index_delta`. `prefix_length` must be 0 for the first
record in a block and for every record named in `restart_offset`.

| `value_type` | meaning | value bytes |
|---|---|---|
| `0x0` | **deletion / tombstone** | none |
| `0x1` | one object name | one digest |
| `0x2` | two object names | ref digest, then peeled digest |
| `0x3` | symbolic reference | `varint(target_len) target`, uncompressed |
| `0x4`–`0x7` | reserved | — |

The reference fixture — one commit, `feature`, a symbolic `symbolic` → `main`, a lightweight tag,
an annotated tag `v1`, and `deleted` created then deleted — produces a two-table stack
(`min=1,max=7` and `min=8,max=8`). Its first ref block (file offset 24,
`block_len = 0x00010e = 270`), every record decoded from the bytes:

```
offset  bytes                                       decoded
    28  00 23 "HEAD" 00 0f "refs/heads/main"        prefix 0, type 3 symref, upd_delta 0
    51  00 8011 "refs/heads/deleted" 06 <20B oid>   varint 0x8011 = 145 -> suffix 18, type 1
    93  0b 39 "feature" 04 <20B oid>                prefix 11 = "refs/heads/", type 1
   123  0b 21 "main" 01 <20B oid>                   suffix 4, type 1
   150  0b 43 "symbolic" 05 0f "refs/heads/main"    varint 0x43 = 67 -> suffix 8, type 3 symref
   177  05 8001 "tags/lightweight" 03 <20B oid>     prefix 5 = "refs/", suffix 16, type 1
   217  0a 12 "v1" 02 <20B tag oid> <20B peeled>    prefix 10, type 2 peeled annotated tag
        00001c 000033 0002                          restart_offset[2] = {28, 51}, restart_count = 2
```

Two structural facts fall straight out. **`HEAD` is a ref record inside the stack** (type `0x3`
→ `refs/heads/main`); the `.git/HEAD` stub is never consulted by git, which is R4. And **records
are sorted by name, not by creation order** — `deleted` precedes `feature` — so a reader may
binary-search but must never assume `update_index` order.

Note also that both restart points (28 and 51) carry `prefix_length = 0`, as the format requires,
while every other record prefix-compresses against its predecessor.

The deletion of `refs/heads/deleted` is a **separate, newer table** carrying one tombstone:

```
header(min=8,max=8) | 'r' 000037 | 00 8010 "refs/heads/deleted" 00 | 00001c 0001 | log block | footer
```

`varint 0x8010 = 144`; `144 >> 3 = 18` (the name length), `144 & 7 = 0` — value_type 0, no value.
Readers walk the stack **newest first** and the tombstone wins over the older table's live record.
This exact two-table shape is the §Test strategy stack-merge fixture, because a reader that
concatenates instead of merge-joining resurrects `refs/heads/deleted`.

Restart offsets are relative to the block start, except in the first block where they are relative
to the **file** and therefore include the header — measured 28 for v1 and **32** for v2 (spec
divergence S2).

#### 1.5 Index and obj records

Forced by a 3001-ref fixture (`git update-ref --stdin` then `git pack-refs --all`), which produced
a single 97803-byte table: **20 `'r'` blocks**, one `'i'` at 81920, one `'o'` at 86016 with
`obj_id_len = 2`, `log_position = 86069`, `log_index_position = 96750`.

```
index_record: varint(prefix_length) | varint((suffix_length << 3) | 0) | suffix | varint(block_position)
obj_record:   varint(prefix_length) | varint((suffix_length << 3) | cnt_3) | suffix
                | varint(cnt_large)? | varint(position_delta)*
```

`block_position` is absolute from the start of the file. For obj records, `cnt_3` holds counts
1–7; `cnt_3 == 0` means a `cnt_large` varint follows, and `cnt_3 == 0 && cnt_large == 0` is the
special "scan all refs" case. The first `position_delta` is absolute, the rest are relative.

Measured index head — `69 0000d0` (`'i'`, len 208), then
`00 8038 "refs/heads/wide/br00154" 00`, then `14 18 "312" 9f00`: prefix 20, suffix `"312"`,
`block_position` varint `9f 00` = **4096**. Measured obj head — `6f 000035` (`'o'`, len 53), then
`00 10 6dc9 14 00 9f00 9f00 …`: a 2-byte abbreviation mapping to 20 ref-block positions, first
absolute (0) then deltas of 4096. Both consistent with the record grammars above.

The spec's *guidance* on when these sections appear is only half right about git's own writer;
§1.13 replaces it with the measured thresholds. Obj blocks are optional
(`reftable.indexObjects`); when absent, readers brute-force the ref blocks.

#### 1.6 Log blocks and reflog records — including the spec divergence

```
'g' | uint24(block_len) | zlib_deflate { log_record+ | uint24(restart_offset)+ | uint16(restart_count) }
```

`block_len` is the **inflated** size *including* the 4-byte block header — measured 820 against
816 inflated bytes, and 102 against 98. Offsets inside the block include the header, so the first
restart offset is 4. Log blocks are unaligned and consecutive, so a reader must track bytes
consumed by the inflater to find the next block.

Log key: `refname '\0' reverse_int64(update_index)` where
`reverse_int64(t) = 0xffffffffffffffff - t`, so newer entries sort first.

```
log_record: varint(prefix_length) | varint((suffix_length << 3) | log_type) | suffix
            | log_data?
log_data:   old_id | new_id | varint(name_len) name | varint(email_len) email
            | varint(time_seconds) | sint16(tz_offset) | varint(message_len) message
```

`log_type` `0x0` is a deletion (a reflog tombstone); `0x1` carries `log_data`. Renames are a
zero-`new_id` deletion plus a zero-`old_id` creation.

**S1 — `tz_offset` is the raw `±HHMM` integer, not minutes.** The spec states "the absolute number
of minutes from GMT … `GMT-0800` is encoded as `sint16(-480)`". Six repositories were built with
`GIT_COMMITTER_DATE` at distinct offsets and the `sint16` read back from the inflated bytes:

| `GIT_*_DATE` offset | stored `sint16` | spec (minutes) | raw `±HHMM` |
|---|---|---|---|
| `+0230` | **230** | 150 | 230 |
| `+0100` | **100** | 60 | 100 |
| `-0800` | **-800** | -480 | -800 |
| `+0000` | **0** | 0 | 0 |
| `-0530` | **-530** | -330 | -530 |
| `+1345` | **1345** | 825 | 1345 |

Six for six on raw `±HHMM`, zero for six on minutes. tsgit follows the **binary** in both
directions — the writer emits raw `±HHMM` too — and an interop row pins each of these six offsets
so a future git that fixes the spec-conformance is caught.

A fully decoded log block from the reflog fixture (nine records across three ref names) confirms
the grouping and ordering: `HEAD` entries first at update_index 7, 6, 5, 3, 2 descending, then
`refs/heads/main` at 3, 2, then `refs/heads/other` at 4, then `refs/stash` at 8. `HEAD` carries
its own reflog inside the stack — including `checkout: moving from …` entries.

#### 1.7 Hash width

| init | header version | `hash_id` field | empty-table size |
|---|---|---|---|
| `--ref-format=reftable` | **1** | absent | 124 |
| `--ref-format=reftable --object-format=sha256` | **2** | `"s256"` | 132 |

Version and hash are coupled by git's writer — v1 is only ever SHA-1, and the spec recommends v1
for SHA-1 "for maximum backward compatibility". A reader must **not** assume it: `hash_id` is
`"sha1"` or `"s256"` and v2 may carry either. Digest width comes from the parsed header, and it
changes the footer size, the header size, the first restart offset, and every `0x1`/`0x2` ref
value and `log_data` oid pair. This is R7, and on the write side the same coupling is a **writer
obligation**: tsgit emits version 1 for a SHA-1 repository and version 2 with `"s256"` for a
SHA-256 one, because that is what git emits and any other pairing would be a gratuitous
divergence (§5).

#### 1.8 Linked worktrees

`git worktree add` on a reftable repository produces:

```
.git/reftable/{tables.list, *.ref}                       shared refs
.git/worktrees/<name>/reftable/{tables.list, *.ref}      per-worktree refs — a FULL second stack
.git/worktrees/<name>/HEAD                               stub: ref: refs/heads/.invalid
.git/worktrees/<name>/refs/heads                         stub file
```

Measured scoping: `refs/heads/*` and `refs/tags/*` are visible from both; `refs/bisect/bad`
created in the linked worktree is visible **only** there. `ORIG_HEAD` is a record in the stack —
there is no `.git/ORIG_HEAD` file. This maps cleanly onto `perWorktreeRefDir` /
`isPerWorktreeRef`, which already makes exactly this split (§3.2), but it means a backend
instance is scoped to *two* stacks, not one. §1.12 measures what that means for writes.

#### 1.9 Reader protocol

From the spec, and load-bearing because §1.15 measures that git **unlinks compacted tables**:
read `tables.list`, open every file it names, **if any is missing start over**, then read from the
open files as long as needed. Files not in `tables.list` are either about to be added or ready to
be pruned, and must be ignored.

This is not theoretical for tsgit. git's compaction unlinks the merged tables immediately after
swapping `tables.list` (§1.15), and tsgit's `FileSystem` port reads **by path**, not by an fd it
holds open, so it has no POSIX unlink-survives-open protection. The restart path is on the hot
read path and is specified, not defensive: §2 makes it one retry, then `INVALID_REFTABLE
{ check: 'tablesList' }`.

Read-side config knobs: there are none. Every reftable knob git exposes — `reftable.blockSize`,
`reftable.restartInterval`, `reftable.indexObjects`, `reftable.geometricFactor`,
`reftable.lockTimeout` — is a **writer** knob, and §1.13/§1.15 pin their defaults.

#### 1.10 The corruption tier — git degrades to an empty ref space

Seven damaged fixtures, each a copy of the healthy 5-ref repository (a control copy was verified
to still report all 5 refs, so the copies themselves are sound):

| damage | `for-each-ref` | `show-ref` | `rev-parse HEAD` | `log` | `fsck` |
|---|---|---|---|---|---|
| healthy control | rc 0, 5 refs | rc 0 | rc 0, oid | rc 0 | rc 0 |
| bad magic (`XXXX`) | **rc 0, empty** | rc 1 | rc 128 `ambiguous argument 'HEAD'` | rc 128 `fatal: your current branch appears to be broken` | **rc 8, `error: refs died of signal 11`** |
| truncated to 400 bytes | **rc 0, empty** | rc 1 | rc 128 | rc 128 (same) | rc 8, signal 11 |
| footer CRC corrupted | **rc 0, empty** | rc 1 | rc 128 | rc 128 (same) | rc 8, signal 11 |
| header version = 9 | **rc 0, empty** | rc 1 | rc 128 | rc 128 (same) | rc 8, signal 11 |
| `tables.list` names a missing file | **rc 0, empty** | rc 1 | rc 128 | rc 128 (same) | rc 8, signal 11 |
| `tables.list` removed | rc 0, empty | rc 1 | rc 128 | rc 128 (same) | **rc 0**, `notice: No default references` |
| `.git/reftable/` removed | rc 0, empty | — | — | — | — |

Two findings, and they pull in opposite directions.

**First: git does not `fatal` on a corrupt reftable stack — it reports an empty ref space.** The
contrast with the files backend is stark. A `packed-refs` file containing `GARBAGE NOT A REF`
gives `fatal: unexpected line in .git/packed-refs: GARBAGE NOT A REF`, rc 128, on both
`for-each-ref` and `show-ref`. Same class of damage; loud on files, silent on reftable.

**Second: `git fsck` dies on a signal.** `error: refs died of signal 11` is the child
`git refs verify` process crashing — a genuine git bug, not a behaviour.

ADR-688 settles this as a documented divergence: tsgit refuses where git crashes, and degrades
where git degrades coherently (a missing `tables.list` is rc 0 and no signal — a legitimately
empty stack). §4 gives the code, §11 the interop shape.

#### 1.11 Format variations the spec permits that git 2.55.0 did not emit

Every fixture built here used git's own writer, so three legal shapes went **unexercised**. They
are recorded as parser obligations rather than pins, because the honest statement is "the spec
permits this and no measurement covers it" — a reftable can be written by JGit, libgit2, or
Gerrit, and a reader that assumes git's writer choices is wrong on their output.

| variation | measured in every fixture | what the spec permits | parser obligation |
|---|---|---|---|
| `block_size` | always `4096` | **`0` means unaligned** — no padding; blocks are consecutive; a ref index is then *mandatory* if there is more than one ref block | must not derive the next block position from `block_size` when it is 0; walk by `block_len` |
| log-only files | none seen; all tables were `.ref` | files with **`.log` extension** carry only header + log blocks + footer, and the first log block starts at byte 24/28 with no ref block | `tables.list` entries must be dispatched on content (`footer.logPosition`, absent ref section), never on the filename extension |
| ref/obj index depth | single-level (one `'i'` block) | **multi-level** — a first-level index block may point at further index blocks before the leaf | must read the block type at each `block_position` and recurse while it is `'i'`, rather than assuming the target is a leaf |

The `tables.list` dispatch row matters most: naming is a *convention* the spec only "suggests"
(`${min}-${max}-${random}`), so neither the `0x%012x` formatting nor the extension is safe to
parse for meaning. The stack reader takes filenames as opaque and reads each file's own header
and footer.

To this list S3 adds a fourth, and this one *is* pinned: a log section of 2 or 3 blocks with
`log_index_position == 0`. git writes it (§1.13) even though the spec forbids it, so the reader
must brute-force-scan the log section whenever the index is absent, regardless of block count.

#### 1.12 The transaction protocol — measured

The spec describes *Update transactions* in prose. Everything below is measured, using a
`reference-transaction` hook to snapshot `.git/reftable/` at each transaction state and a tight
`ls` loop to catch the intermediate filenames of a 60 000-ref transaction.

**Filenames observed during one `git update-ref --stdin` of 60 000 refs**, in the order they
appeared:

```
tables.list.lock                                          the stack lock, created empty
0x000000000003-0x000000000003-8c9dbb3a.temp.wXKo07        the new table, mkstemp suffix
0x000000000003-0x000000000003-3893be1f.ref                renamed into place — DIFFERENT random
0x000000000001-0x000000000002-ba4de943.ref.lock           per-table locks, taken by auto-compaction
0x000000000003-0x000000000003-3893be1f.ref.lock
0x000000000001-0x000000000003-e2415a5a.temp.ug2BkA        the compacted table
0x000000000001-0x000000000003-23b4ead8.ref                renamed into place — DIFFERENT random again
```

The temp name is `<formatted-name>.temp.XXXXXX` where `XXXXXX` is `mkstemp`'s. The
**`%08x` random is redrawn between the temp name and the final name** — it is
`reftable_rand()`, not a content hash, so it is unpredictable by construction. That single fact
is what caps DN-1.

**Transaction states**, from the hook:

| state | `.git/reftable/` contents |
|---|---|
| `preparing` | pre-state; no lock yet |
| `prepared` | pre-state **+ `tables.list.lock` (0 bytes)** — no new table yet |
| `committed` | post-state; lock gone, new/compacted table in place |

So the order is: acquire `tables.list.lock` (exclusive create) → read `tables.list` → pick
`update_index = max + 1` → write the table to a temp file → rename it to its final name → write
the full new `tables.list` contents into the **lock file** → `fsync` the lock fd → rename the lock
over `tables.list` → reload → auto-compact.

**Crash and abort residue**, measured by killing git with `SIGKILL` from the hook at `prepared`,
and by aborting the hook at `prepared`:

| event | on disk afterwards | subsequent reads | subsequent writes |
|---|---|---|---|
| hook aborts at `prepared` | pre-state, **no lock left** | correct | succeed |
| `SIGKILL` at `prepared` | pre-state **+ a 0-byte `tables.list.lock`** | correct — the stack is untouched | **blocked**: `fatal: update_ref failed for ref '…': cannot lock references` |
| lock removed by hand | — | correct | succeed |

Two consequences. Reads are never blocked by a lock — the lock guards only the list rewrite. And
**git never breaks a stale lock**: `reftable.lockTimeout` (default 100 ms, `0` = no retry,
`-1` = forever) only waits for a *live* holder; a lock left by a killed process blocks writes
until a human removes it, at both `lockTimeout=100` and `lockTimeout=0`. tsgit does the same.

**Locking is per stack, and a cross-stack transaction holds both locks.** A single
`git update-ref --stdin` that creates `refs/bisect/skip/y` (per-worktree) and `refs/heads/both-y`
(shared) from inside a linked worktree was snapshotted at `prepared`:

```
.git/reftable:                       … tables.list tables.list.lock
.git/worktrees/wt-lw/reftable:       … tables.list tables.list.lock
```

Both locks are held simultaneously, then both are committed. The two stacks keep **independent
`update_index` sequences** (both reached 4 independently in the measurement). A crash between the
two commits leaves one applied and one not — git accepts that, and so does tsgit; the guarantee
is "each stack is individually consistent", not "both stacks commit atomically".

**Concurrency, measured.** Two shells each running 120 sequential `git update-ref` calls against
one stack, started together: both exited 0, **all 241 refs present**, final stack depth 4, and
**zero orphan files** in the directory. The 100 ms lock retry absorbs contention transparently at
this rate. A reader run while a lock is held returns the correct pre-state.

#### 1.13 What the writer chooses

The format leaves a writer many choices. Every row below was measured; where the row states a
*rule* rather than an observation, the rule was read from git's `reftable/writer.c` at `v2.55.0`
and then confirmed against the measurement in the same row.

| choice | git 2.55.0 | how pinned |
|---|---|---|
| `block_size` | **4096** (`DEFAULT_BLOCK_SIZE`), written into the header | every fixture |
| `restart_interval` | **16** records | measured by ratio: with `reftable.restartInterval` set to 8 a full 4096-byte ref block carries `restart_count = 17`, at 64 it carries 3–4, and unset it carries **10** — the same ~150 records per block divided by 16 |
| ref/obj/index **padding** | zero bytes, to the next `block_size` boundary | dumped |
| log blocks | never padded, never aligned, written back-to-back | dumped |
| **ref index emitted** | only when the ref section has **≥ 4 blocks** | 3 blocks (400 refs) → `ref_index_position = 0`; 4 blocks (450 refs) → index at 16384; 5 blocks (600 refs) → index at 20480 |
| **log index emitted** | only when the log section has **≥ 4 blocks** — *contradicting the spec's MUST at 2* (S3) | 2 blocks → 0; 3 blocks → 0; 4 blocks → 5297 |
| **multi-level index** | when the index level itself needs > 3 blocks | source rule; unexercised at these sizes (§1.11) |
| **obj section emitted** | only when the ref section got an index (`ref_stats.index_blocks > 0`) *and* `reftable.indexObjects` (default true) | 3 ref blocks → no obj block; 4 ref blocks → obj block at 20480 |
| `obj_id_len` | longest common prefix among adjacent sorted oids, **+ 1**, minimum 2 | source rule; measured value **2** in both obj-bearing fixtures |
| log message | trailing `\n`s stripped, an embedded `\n` is an error, then exactly **one `\n` appended** | `update-ref -m "my reason"` → `'my reason\n'`; `update-ref` with no `-m` → `'\n'`, **not** an absent log record |
| log block compression | zlib **`deflateInit(level 9)`**, default `windowBits`/`memLevel`/strategy | source; §1.14 measures what that means for byte-identity |
| `min`/`max_update_index` of a fresh table | both = `stack.max_update_index + 1` | every append |
| `min`/`max_update_index` of a compacted table | min of the oldest merged table, max of the newest | `0x…01-0x…05` + `0x…06-0x…06` → `0x…01-0x…06` |

**What a ref update actually writes.** `git update-ref refs/heads/zzz HEAD` appended a table
carrying one ref record *and* one log record (`update_index 3`, empty message `'\n'`). Committing
on `main` wrote **two log records at the same `update_index`, `HEAD` and `refs/heads/main`**, in
one transaction — git couples the HEAD reflog *inside* the transaction, which is precisely the
thing tsgit does *after* committing today (§8).

**What a deletion writes.** `git update-ref -d refs/heads/zzz` appended a table containing:

```
ref record:  'refs/heads/zzz'  update_index 4  value_type 0x0   (tombstone)
log record:  'refs/heads/zzz'  update_index 3  log_type 0x0     (reflog tombstone)
```

The ref tombstone carries the **new** `update_index` (4); the log tombstone carries the
`update_index` of **the entry it cancels** (3). git enumerates the ref's existing log entries and
emits **one log tombstone per entry**, each at that entry's own index — a deletion of a ref with
`n` reflog entries writes `n` log tombstones. A writer that emits a single tombstone at the new
index leaves the old reflog entries visible.

**A table's log records can legitimately fall outside its own declared `min`/`max_update_index`
range — deliberately, and reader-safe.** The deletion example above already shows it: the table's
own bounds are `[4, 4]` (a fresh append, per the row above), yet the log tombstone it carries sits
at index 3. `reflogReplace` (`reflog delete`/`expire`, stash drop) does the same on a larger scale:
every existing entry is tombstoned at *its own* original index first, and only the replacement
entries land inside the new table's declared range. This is safe for a reader because a log
record's key is absolute (`refname '\0' reverse_int64(update_index)`) and never re-derived from the
table's own header bounds — measured against real git in the interop run, it reads a tsgit-written
table shaped this way without complaint. What it would not do is *write* one itself: git's own
reftable writer library validates that every record passed to it falls inside the `update_index`
bounds the writer was opened with, and refuses an off-range call with `REFTABLE_API_ERROR` — a
constraint git places on its own writer's *API*, not one its reader enforces on the *file format*.
tsgit's writer carries no such internal constraint, so it emits this shape freely; a correct
deletion or replace has no other way to express "cancel this specific old entry."

#### 1.14 Determinism, and the exact limit of byte-identity

**Table content is deterministic.** The 5-ref fixture was built twice, from scratch, with fixed
`GIT_*_DATE`. Both stacks had two tables; **both tables were byte-identical** (536 and 165 bytes,
matching SHA-256). Given the same logical content, the same `update_index` assignment and the
same options, git's writer is a pure function.

**Table *names* are not.** Five identical `git init` + commit runs produced five different
suffixes (`879f2a51`, `1b964744`, `777aaaca`, `2a23af8c`, `7cd684d8`), and §1.12 shows the random
is even redrawn between the temp name and the final name. `tables.list` content is therefore never
reproducible.

**And the log section is not, across zlib implementations.** git on this machine links
`/usr/lib/libz.1.dylib` (Apple zlib **1.2.12**); Node 22 bundles zlib **1.3.1-e00f703**. Deflating
the *same* 359-byte inflated log block:

| producer | deflated length | bytes equal git's? |
|---|---|---|
| git (Apple zlib 1.2.12, level 9) | **145** | — |
| Node `zlib.deflateSync({level: 9})` | 147 | no |
| Node `zlib.deflateSync({level: 6})` | 147 | no |
| `new CompressionStream('deflate')` (browser path) | 147 | no — and different from Node level 9 |

A sweep of **2835 combinations** (level 1–9 × memLevel 1–9 × strategy 0–4 × windowBits 9–15) in
Node found **no parameter set that reproduces git's bytes**. All four streams inflate to identical
content. This is not a bug and not fixable by configuration: DEFLATE output is
implementation-defined, and two git builds on two platforms will disagree with each other for the
same reason.

Three consequences, and they are the substance of DN-1 and DN-3.

1. **Header, ref blocks, index blocks, obj blocks, padding and footer are byte-reproducible.**
   The log section is not. The footer's CRC-32 covers only the footer, so a differing log section
   invalidates nothing.
2. Because log blocks land *after* every other section, `ref_index_position`, `obj_position`,
   `obj_index_position` and `log_position` are unaffected. Only `log_index_position` (when
   present) and the total file size differ.
3. **Therefore the stack *shape* is not reproducible either.** §1.15's compaction metric is the
   file size, and the measured decisions turn on margins as thin as 432 vs 428 bytes. A 2-byte
   difference in one log block can flip an auto-compaction decision, so after the same sequence of
   updates tsgit's stack may legitimately hold a different number of tables than git's. The repo
   already has the vocabulary for this: `pack-writer.ts`'s `packfile` write surface is
   `equivalent-under-readback` **because deflate is implementation-defined**, while
   `rev-on-idx-write.md` justifies `byte-identical` for `.rev` precisely because nothing in it is.
   Reftable straddles the two, which is why DN-1 is a decision and not a finding.

#### 1.15 Compaction and auto-compaction — the policy, replayed

Every append is followed by auto-compaction in the same command. The policy is a **geometric
sequence with factor 2** (`reftable.geometricFactor`, `DEFAULT_GEOMETRIC_FACTOR = 2`).

**The size metric is not the file size.** It is

```
metric(table) = file_size − footer_size(version) − (header_size(version) − 1)
              = file_size − 91   (v1)
              = file_size − 99   (v2)
```

**The segment rule**, as replayed below:

```
seg = { start: 0, end: 0 }
if n <= 1: no compaction
# 1. walk back from the newest table; the first table whose PREDECESSOR is
#    smaller than factor x itself ends the segment (exclusive).
for i = n-1 down to 1:
    if size[i-1] < size[i] * factor: end = i+1; bytes = size[i]; break
else: no compaction
# 2. continue from the SAME i, accumulating; keep the OLDEST qualifying start.
#    NOTE: start stays 0 if nothing qualifies -> the whole stack compacts.
for ; i > 0; i--:
    curr = bytes; bytes += size[i-1]
    if size[i-1] < curr * factor: start = i-1
compact tables [start, end)
```

**Replay.** A repository was seeded with 20 000 refs (one 626 983-byte table), then driven through
**60 sequential single-ref `git update-ref` calls**, recording the full vector of table sizes
before and after each one. The rule above, with the `−91` metric, predicts **60 of 60**
transitions — every stack depth, every merge boundary, every untouched prefix. Sensitivity check
on the metric constant over the same 60 transitions:

| overhead subtracted | transitions reproduced |
|---|---|
| 0 | 46 / 60 |
| 24 (header only) | 50 / 60 |
| 68 (footer only) | 55 / 60 |
| **91 (footer + header − 1)** | **60 / 60** |

The measurement discriminates 91 from 0, 24 and 68; it does not discriminate 91 from 92 or 99 on
this data set, and the exact value comes from git's own
`stack_table_sizes_for_compaction`. An independent v2/SHA-256 run of 8 transitions with the −99
metric reproduced 8 of 8. That is the honest statement of the pin: the *rule* is confirmed
empirically at high resolution, the *last two bytes of the constant* come from the source.

An excerpt of the replayed sequence, base table `B = 1 867 775`:

| n | depth | table sizes after | what the rule says |
|---|---|---|---|
| 6 | 2 | `B 393` | merge tables 1–2 (`272 < 2 × 146`) |
| 7 | 3 | `B 393 237` | no segment (`302 ≥ 2 × 146`) — the razor-thin row |
| 8 | 2 | `B 455` | merge 1–3 |
| 9 | 3 | `B 455 237` | no segment (`364 ≥ 2 × 146`) |
| 18 | 3 | `B 699 272` | merge **2–3 only** — table 1 survives (`608 ≥ 2 × 294`) |
| 24 | 2 | `B 960` | merge 1–3 |

**Compaction's own protocol**, from the ordering measured in §1.12 plus git's
`stack_compact_range`:

1. Acquire `tables.list.lock`; verify the stack is up to date, else abort `OUTDATED`.
2. Acquire `<table>.lock` for every table in the range, **newest → oldest**. If one is already
   locked, best-effort: shrink the range to the tables locked so far; if fewer than two, give up.
3. **Release `tables.list.lock`** — concurrent appends may proceed while the merge runs.
4. Merge the locked tables into a temp file.
5. Re-acquire `tables.list.lock`; re-read `tables.list`; verify the compacted names still appear
   **in the same order**; abort `OUTDATED` if not.
6. Rename the temp file into place (skipped when the merge produced an empty table).
7. Write the new `tables.list` into the lock, `fsync`, rename over `tables.list`.
8. Reload, then **unlink the merged tables** — best effort; failures are ignored because a
   concurrent reader may still hold them.

Three rules fall out of this that a writer must not get wrong:

- **Tombstones are dropped only when the segment starts at table 0.** git's merge skips a ref or
  log deletion record `if (first == 0 && …is_deletion)`. Measured: `pack-refs --all` over a stack
  containing a deleted `refs/heads/p2` produced a single table with **no `p2` record and no `p2`
  reflog entries at all**. A partial compaction must keep tombstones, or older tables resurrect
  the ref.
- **An empty compaction result is not written.** If tombstones cancel everything in the range, the
  table is simply omitted from `tables.list`.
- **Auto-compaction is best-effort and never fails the write.** With every table lock held by
  hand, `git update-ref` still succeeded and the stack grew from depth 2 to 3; after the locks
  were removed, the next update compacted back to depth 1.

**Stale-file cleanup has a different trigger.** An orphan `0x…-deadbeef.ref` planted in the
directory survived a normal `update-ref` untouched, and was removed by **`git pack-refs --all`**
(which `git gc` also invokes). tsgit has neither command (`src/application/commands/` has no
`pack-refs`), which is DN-4.

#### 1.16 Cross-format interoperability

| probe | result |
|---|---|
| `git clone <reftable repo>` (no flag) | clone is **`files`** — ref format is a purely local choice, never negotiated on the wire |
| `git clone --ref-format=files <reftable>` | files clone, full history and refs intact |
| `git clone --ref-format=reftable <files>` | reftable clone, all refs present incl. `refs/remotes/origin/*` |
| `git refs migrate --ref-format=files` | converts in place; **removes `extensions.refstorage`** and drops `repositoryformatversion` to **0** |

Ref storage never crosses the wire. `fetch`/`push`/`clone` transport is unaffected, which bounds
this design to local ref I/O. ADR-690 settles that `refs migrate` is not a tsgit surface.

### 2. The codec and the stack

A domain codec in `src/domain/refs/reftable/` (ADR-691), alongside the existing binary parsers in
`src/domain/storage/` (`pack-index.ts`, `rev-index.ts`, `pack-entry.ts`) and following their
shape: zero-copy `DataView` over a `Uint8Array`, no I/O, no `Context`, total functions that throw
a typed `TsgitError` on malformed input. ADR-691 notes it is several modules, not one file —
`reftable-format.ts` (header/footer), `reftable-block.ts` (block + record codecs),
`reftable-writer.ts` (§5), `reftable-stack.ts` (merge view), `reftable-compaction.ts` (§7).

```ts
// src/domain/refs/reftable/reftable-format.ts
export interface ReftableHeader {
  readonly version: 1 | 2;
  readonly blockSize: number;
  readonly minUpdateIndex: bigint;
  readonly maxUpdateIndex: bigint;
  readonly hashId: 'sha1' | 's256';   // v1 ⇒ always 'sha1'
  readonly headerLength: 24 | 28;
  readonly digestLength: 20 | 32;
}
export interface ReftableFooter {
  readonly refIndexPosition: number;
  readonly objPosition: number;
  readonly objIdLength: number;
  readonly objIndexPosition: number;
  readonly logPosition: number;
  readonly logIndexPosition: number;
}
export interface Reftable {
  readonly header: ReftableHeader;
  readonly footer: ReftableFooter;
  readonly bytes: Uint8Array;
}
export function parseReftable(bytes: Uint8Array): Reftable;
```

`digestLength` is derived once from `hashId` and threaded through every record read — never a
module constant. That is the whole of R7's read half.

Ref records, as a discriminated union mirroring the four value types:

```ts
export type ReftableRefValue =
  | { readonly kind: 'deletion' }
  | { readonly kind: 'direct'; readonly id: ObjectId }
  | { readonly kind: 'peeled'; readonly id: ObjectId; readonly peeled: ObjectId }
  | { readonly kind: 'symbolic'; readonly target: RefName };
export interface ReftableRefRecord {
  readonly name: RefName;
  readonly updateIndex: bigint;
  readonly value: ReftableRefValue;
}
export function lookupReftableRef(table: Reftable, name: RefName): ReftableRefRecord | undefined;
export function iterateReftableRefs(table: Reftable): Iterable<ReftableRefRecord>;
```

Reflog records:

```ts
export interface ReftableLogRecord {
  readonly name: RefName;
  readonly updateIndex: bigint;
  readonly entry:
    | { readonly kind: 'deletion' }
    | {
        readonly kind: 'entry';
        readonly oldId: ObjectId;
        readonly newId: ObjectId;
        readonly identity: AuthorIdentity;   // timezoneOffset formatted from the raw ±HHMM
        readonly message: string;
      };
}
export function iterateReftableLogs(table: Reftable, name?: RefName): Iterable<ReftableLogRecord>;
```

The `sint16` ↔ `AuthorIdentity.timezoneOffset` conversion is where S1 lands, and it is **one named
function pair** — `decodeTzOffset` / `encodeTzOffset` — with the six measured rows as their unit
table, exercised in both directions. The existing `ReflogEntry` identity shape already carries
`timezoneOffset` as a `'+HHMM'` string, so the raw integer converts to it directly: the divergence
is *cheaper* to honour than the spec would have been.

Above the single file sits the stack:

```ts
// src/domain/refs/reftable/reftable-stack.ts
export interface ReftableStack {
  lookup(name: RefName): ReftableRefRecord | undefined;    // newest table first, tombstone wins
  names(): Iterable<RefName>;                              // merge join, tombstones removed
  logs(name: RefName): Iterable<ReftableLogRecord>;        // newest update_index first
  readonly tables: readonly LoadedTable[];                 // oldest -> newest, for the writer
  readonly maxUpdateIndex: bigint;
}
```

Loading it is an application-tier concern (it needs `ctx.fs` and `ctx.compressor`), so
`loadReftableStack(ctx, reftableDir)` stays in `src/application/primitives/`. It implements
§1.9's protocol — read `tables.list`, open each named file, **restart once** if any is missing —
and is memoised per `Context` with an mtime+size key on `tables.list`, exactly as
`createRefStore` memoises `packed-refs` today. ADR-692 settles eager whole-table loading; §1.15's
compaction path needs the whole stack in memory anyway, so eager is the shape the write side
already requires.

**The staleness contract.** A memoised stack can go stale: git — or another tsgit `Context` — may
compact underneath it, replacing several tables with one and **unlinking the originals** (§1.15
step 8). The mtime+size key on `tables.list` catches every *committed* change, because both the
update and the compaction protocols rewrite `tables.list` as their final step, so a stack that was
valid when loaded stays internally consistent and the next `tables.list` stat sees the swap. The
residual window is a reader that read `tables.list` and then had a table unlinked before it opened
it; §1.9's answer is "start over", which `loadReftableStack` does exactly once before surfacing
`INVALID_REFTABLE { check: 'tablesList' }`. This is the same staleness contract `createRefStore`
already has with `packed-refs`, with one difference worth stating: tsgit is now also a *writer*,
so its own writes invalidate the memo through the same key rather than through a special case.

**Decoding a name from the stack is a merge join, not a concatenation.** The same ref may appear
in several tables; the newest occurrence wins, and a `deletion` in the newest wins over a live
record below it. Getting this backwards produces resurrected deleted refs, so §11 pins it with a
dedicated interop row over the exact two-table fixture measured in §1.4.

### 3. The backend seam

#### 3.1 Caller census — what a seam has to cover

Counted with `find_referencing_symbols` over every `RefStore` member.

| method | call sites | reftable analogue |
|---|---|---|
| `resolveDirect` | **14** — `resolve-ref`, `update-ref` ×3, `stash-ref`, `list-worktrees`, `worktree`, `submodule` ×2, `remote` ×2, `describe`, `name-rev`, `rev-parse` | direct: a stack lookup |
| `getPackedRefs` | **3** — `enumerate-refs`, `fsck/refs-verify`, `fetch.collectRefTips` | no analogue; all three want *"every ref"*, not *"the packed ones"* |
| `writeLoose` | **5** — all `rebase.ts`, all detaching `HEAD` | a stack transaction |
| `removeLoose` | **2** — `update-ref.deleteRef`, `stash-ref.dropStashEntry` | a tombstone |
| `isLoose` | **2** — `update-ref.deleteRef`, `remote.moveTrackingRef` | **meaningless** — it exists only to drive the `delete-packed-ref` / `rename-packed-tracking-ref` refusals, which are files-backend limitations |
| `readLooseRaw` | **1** — `fsck/refs-verify`, needs unparsed bytes to distinguish `badRefContent` from `badRefOid` | **meaningless** — there is no raw text; `badRefContent` is structurally unreachable |

Two methods (`isLoose`, `readLooseRaw`, 3 call sites) exist *only* to express files-backend
limitations. Two more (`writeLoose`, `removeLoose`) name the mechanism rather than the intent.
`getPackedRefs` is asked by all three of its callers for something it is not.

**And the seam does not contain the problem.** Files-layout knowledge outside `RefStore`:

| site | what it does | breaks on reftable |
|---|---|---|
| `enumerate-refs.ts` `walkLooseRefs` | recursive `readdir` of `<gitDir>/refs` and `<commonDir>/refs`, name = path | yes — yields the phantom `refs/heads` |
| `branch.ts:66` `branchList` | **single-level** `readdir` of `<commonDir>/refs/heads` | yes |
| `tag.ts:69` `tagList` | single-level `readdir` of `<commonDir>/refs/tags` | yes — measured silent-empty |
| `checkout.ts:94`, `branch.ts:132`, `tag.ts:214` | `fs.exists(<perWorktreeRefDir>/<name>)` existence probes | yes |
| `fetch.ts:379` `readExistingRef` | own `fs.exists` + `readUtf8`, bypasses `RefStore` entirely | yes |
| `fetch.ts` `collectRefTips` / `prune` | own recursive walks of `refs/remotes/<r>` and `refs/tags` | yes |
| `reflog-store.ts` (all six exports) | `<gitDir>/logs/<ref>`; `listReflogs` walks the tree | yes — measured silent-empty |
| `repo-state.ts` `readHeadRaw` | reads `<gitDir>/HEAD` directly, bypasses `RefStore`; ~15 command consumers | yes — returns the `.invalid` stub |
| `clone`/`checkout`/`commit`/`bootstrap`/`worktree` | raw `fs.writeUtf8` of `<gitDir>/HEAD` | yes (write side) |
| `write-symbolic-ref.ts` | `looseRefPath` + `atomicWriteRef` | yes (write side) |
| `stash-ref.ts` | reflog **whole-file rewrite** via `writeReflog` | yes — the hardest write to port |
| `fsck/refs-verify.ts` | re-implements the loose grammar inline to *report* malformation | partly unreachable |

So: **six independent ref enumerators**, only one behind `RefStore`; and `HEAD` has three
independent read paths. All of them converge on the seam — a `RefStore` swap alone satisfies R3
for `resolveRef` and fails R2, R4 and R8.

`getRefStore` is also called with a **derived child `Context`** in `submodule.ts:660,749`, so a
backend must key off `Context` and never a module-global.

#### 3.2 The narrowed interface (ADR-686, ADR-689)

`RefStore` narrows to backend-neutral verbs; the files backend keeps loose/packed as private
implementation. `getRefStore(ctx)` and its per-`Context` `WeakMap` are unchanged in shape.

```ts
export interface RefStore {
  // reads
  resolveDirect(name: RefName): Promise<ResolveDirectResult>;
  listRefs(prefix?: RefName): Promise<readonly RefEntry[]>;   // replaces getPackedRefs' 3 callers
  readReflog(name: RefName): Promise<readonly ReflogEntry[]>; // ADR-689
  listReflogs(): Promise<readonly RefName[]>;                 // ADR-689
  // writes — one transaction, applied atomically per stack
  applyRefUpdates(updates: readonly RefUpdate[]): Promise<void>;
}

export type RefUpdate =
  | { readonly kind: 'set';      readonly name: RefName; readonly id: ObjectId;
      readonly expected?: ObjectId | 'absent'; readonly reflog?: ReflogAppend }
  | { readonly kind: 'setSymbolic'; readonly name: RefName; readonly target: RefName;
      readonly expected?: ObjectId | 'absent'; readonly reflog?: ReflogAppend }
  | { readonly kind: 'delete';   readonly name: RefName; readonly expected?: ObjectId | 'absent' }
  | { readonly kind: 'reflogOnly'; readonly name: RefName; readonly reflog: ReflogAppend };
```

Three shapes in that signature are load-bearing and each is forced by a measurement:

- **`applyRefUpdates` takes a list, not one ref.** §1.13 measured that committing on `main` writes
  the `HEAD` and `refs/heads/main` log records in **one** transaction at one `update_index`. A
  one-ref-at-a-time write interface cannot express that, and expressing it as two calls is exactly
  the bug of §8.
- **`expected` lives on the update, not on a separate pre-check.** The reftable backend must
  re-verify the old value *under the stack lock*, because between a read and a write another
  process may have committed; the files backend already gets this from its per-ref lock.
- **`reflogOnly`** is what `HEAD`-coupling and `stash` need; §1.13 shows git treats it as an
  ordinary member of the same transaction.

Callers to re-express (from ADR-686): `enumerate-refs.ts`, `resolve-ref.ts`, `update-ref.ts`,
`record-ref-update.ts`, `reflog-store.ts`, `reflog-identity.ts`, `resolve-notes-ref.ts`,
`resolve-oid-prefix.ts`, `stash-ref.ts`, `path-layout.ts`, `fetch.ts`, `fsck/refs-verify.ts`,
plus the four enumerators in the table above that never touched `RefStore`. Each is checked for a
files assumption, not merely recompiled.

`fsck`'s ref verification loses `readLooseRaw`. Under ADR-688 the reftable backend supplies its
own integrity notion: `badRefContent` is structurally unreachable, and the checks that replace it
are the `ReftableCheck` union of §4 applied per table.

#### 3.3 What generalises cleanly

`perWorktreeRefDir(ctx, name)` already encodes exactly the split §1.8 measured — `isPerWorktreeRef`
routes to `gitDir`, everything else to `commonDir`. For reftable the same predicate chooses
between `<gitDir>/reftable/` and `<commonDir>/reftable/`, for **reads and writes alike**; §1.12
measured that git routes writes by the same rule. The *policy* is backend-neutral and already
correct; only the path it produces changes. Reusing it is R9's mechanism and avoids a second,
divergent definition of "per-worktree".

One consequence the files backend never had: a single `applyRefUpdates` list may span both stacks.
§1.12 measured git holding both `tables.list.lock` files at `prepared` and committing both. tsgit
partitions the list by `isPerWorktreeRef`, acquires both locks (**common first, then worktree** —
a fixed order, so two tsgit writers cannot deadlock), commits each, and releases in reverse. The
guarantee matches git's: each stack is individually consistent; the pair is not atomic.

`resolve-ref.ts` is nearly backend-neutral already: it owns the symref chain walk, cycle
detection and `MAX_SYMBOLIC_REF_DEPTH`, delegating each hop to `resolveDirect`. One caveat it
documents explicitly — `validateRefName` is load-bearing there as a *path-escape* guard, because
`resolveDirect` builds a filesystem path from the name. Under reftable that justification goes
vacuous, but the call must stay: it is still the ref-name grammar gate, and removing it would
weaken the files backend that shares the code path.

#### 3.4 Backend selection (ADR-687)

`extensions.refStorage` is already read by the acceptance gate's Stage-2 scan over
`<commonDir>/config`. This design **consumes** the value; it does not add a second read, and it
does not touch the gate. ADR-687 settles the carrier: a `refStorage: 'files' | 'reftable'` field
on `RepositoryLayout`, set at Stage 2 alongside `untrusted` and `implicitBare`, and therefore
resolved before any ref access and readable synchronously.

Two constraints the field inherits:

- **Every `Context` constructor populates it explicitly**, including `createMemoryContext` and
  `createBrowserContext`, defaulting to `'files'` by assignment rather than by omission. An
  optional field whose absence means "files" reintroduces the misread on any path that builds a
  `Context` without the facade.
- **`repo.layout` exposes it**, so a consumer can tell which storage a repository uses. That is a
  public-type widening: `reports/api.json` is regenerated in the same change.

§1.1's measurement remains binding: the extension, not the directory, is authoritative. A
repository declaring `refStorage = reftable` with no `.git/reftable/` is a *valid empty-stack*
reftable repository, and the first write creates the directory. Backend selection never sniffs
for the directory.

### 4. Error shape

Following the house factory style in `src/domain/refs/error.ts` — one arrow-function const per
code, lowerCamel of the code, returning `TsgitError`, never throwing internally:

```ts
export type RefsError =
  | …
  | { readonly code: 'INVALID_REFTABLE'; readonly check: ReftableCheck; readonly reason: string }
  | { readonly code: 'REFTABLE_LOCKED'; readonly stack: string };
```

**`UNSUPPORTED_REF_STORAGE` is not added.** The read-only draft needed it for a write refusal that
ADR-680 removed; with a complete backend on all three adapters there is no surface tsgit accepts
and cannot act on, so a code with no throw site would be dead. Should DN-2 land on refusing
reftable writes in the browser, that refusal reuses ADR-685's generic
`REPOSITORY_EXTENSION_UNSUPPORTED { extension, value }` rather than reviving a bespoke code.

`INVALID_REFTABLE` mirrors `INVALID_PACKED_REFS` and the `MidxCheck` pattern from the midx design:
a `ReftableCheck` union naming the failed check (`magic`, `version`, `footerCrc`, `truncated`,
`blockType`, `restartCount`, `recordOverrun`, `varintOverflow`, `tablesList`) plus a reason
string. Following `packed-refs.ts`, any echoed input is truncated (80 chars) so repository content
never lands whole in a message. ADR-688 sets when it is *thrown* versus degraded past: thrown when
the stack cannot be read at all, degraded per table where git's own readers degrade.

`REFTABLE_LOCKED` is the transaction refusal, and it is deliberately distinct from the existing
`REF_LOCKED`: §1.12 measured that the lock is on the **stack**, not the ref, so the payload names
the stack directory and not a ref name. It is raised after `reftable.lockTimeout`-equivalent
retries expire — including against a stale lock, because §1.12 measured git never breaking one.
Its `reason` names the lock path, so the user can act; that string is the escape hatch that
DC-7/ADR-690 left tsgit owing its users.

Both codes are added to `docs/use/errors.md` with their payload fields and a catch example.

### 5. The writer

`src/domain/refs/reftable/reftable-writer.ts` — pure, no I/O: it takes records and options and
returns bytes.

```ts
export interface ReftableWriteOptions {
  readonly hashId: 'sha1' | 's256';       // fixes version: sha1 -> 1, s256 -> 2  (§1.7)
  readonly blockSize: number;             // default 4096                          (§1.13)
  readonly restartInterval: number;       // default 16                            (§1.13)
  readonly indexObjects: boolean;         // default true                          (§1.13)
  readonly minUpdateIndex: bigint;
  readonly maxUpdateIndex: bigint;
}
export function serializeReftable(
  refs: readonly ReftableRefRecord[],       // caller-sorted by name
  logs: readonly ReftableLogRecord[],       // caller-sorted by (name, reverse update_index)
  options: ReftableWriteOptions,
): Uint8Array;
```

Every choice it makes is a measured row of §1.13, and each is a named constant rather than a
literal at its use site:

1. **Header.** `'REFT'`, version from `hashId` (1 for `sha1`, 2 for `s256` — §1.7), `uint24`
   block size, both update indexes. 24 bytes for v1, 28 for v2, and `hash_id` written only at v2.
2. **Block construction.** Records appended until the next one would overflow `block_size`; a
   restart point every `restart_interval` records **and always at the first record of a block**,
   with `prefix_length = 0` at every restart. `block_len` written as `uint24` **including the file
   header for the first block**. Trailer: `uint24 restart_offset[]`, `uint16 restart_count`.
3. **The first restart offset is `header_size + 4`** — 28 at v1 and **32 at v2** (S2). This is
   derived, never a literal `28`; the read-only draft's S2 row exists precisely because a
   spec-faithful writer would hard-code 28 and emit a v2 file no reader could walk.
4. **Padding** to the next `block_size` boundary with **zero bytes**, for ref/obj/index blocks
   only. Log blocks are written back-to-back, unpadded and unaligned (§1.2, §1.13).
5. **Index emission at ≥ 4 blocks in the section**, for both the ref section and the log section
   (§1.13). The log-index threshold is **4, not the spec's 2** (S3): honouring the spec's MUST
   here would make every 2-or-3-log-block table differ from git's. Multi-level when the index
   level itself exceeds 3 blocks.
6. **Obj section only when the ref section got an index** and `indexObjects` is true, with
   `obj_id_len = (longest common prefix among adjacent sorted oids) + 1`, minimum 2 (§1.13).
7. **Log blocks** deflated with the `Compressor` port. §1.14 measures that the level is not a
   correctness parameter across implementations; tsgit asks for level 9 where the adapter allows
   it, because that is git's choice and it minimises size, and accepts that the bytes differ.
8. **Log message canonicalisation** before encoding: strip trailing `\n`s, reject an embedded
   `\n`, append exactly one `\n` (§1.13). An absent message becomes `'\n'`, not an absent record.
9. **`tz_offset` written as the raw `±HHMM` integer** via `encodeTzOffset` (S1).
10. **Footer** — header bytes, the five positions, `obj_position << 5 | obj_id_len`, then the
    CRC-32 over the preceding 64 (v1) / 68 (v2) bytes. 68/72 bytes total.

**Width genericity is a writer property too (R7).** Header length, footer length, first restart
offset, digest length and every `0x1`/`0x2` value and `log_data` oid pair derive from `hashId`. No
literal `20`, `40`, `24`, `28`, `68` or `72` appears outside the header/footer codec. The v2
fixture in §1.7 is a real `--object-format=sha256` repository, so this is exercised, not asserted.
The sibling SHA-256 design (ADR-681) makes tsgit *create* SHA-256 repositories, so a SHA-256
reftable repository is a shape tsgit will produce itself — the two designs meet here and nowhere
else. Parsing or writing a v2 header is independent of being able to read v2 *objects*, so neither
design blocks the other.

**One thing the writer does not choose: the filename.** §1.12 measured the `%08x` suffix is
`reftable_rand()`, redrawn even between the temp name and the final name. tsgit generates it the
same way (a random 32-bit value rendered `%08x`) and, under the stack lock, retries on a name that
already exists — `fs.writeExclusive` on the temp gives the collision check for free.

### 6. The transaction

`src/application/primitives/reftable-transaction.ts` — the only place that mutates a stack. It
reproduces §1.12 step for step:

```
1  acquire   <dir>/tables.list.lock          fs.writeExclusive(path, empty)   -> FILE_EXISTS ⇒ retry
2  read      <dir>/tables.list               (fresh, not the memo)
3  verify    every `expected` against the freshly loaded stack
4  assign    update_index = stack.maxUpdateIndex + 1n
5  build     ref records + log records for the whole update list
6  write     <dir>/<name>.temp.<rand>        fs.writeExclusive
7  rename    -> <dir>/0x…-0x…-<rand>.ref     fs.rename
8  write     the new tables.list body        into the LOCK file (fs.write)
9  rename    <dir>/tables.list.lock -> tables.list
10 invalidate the per-Context stack memo
11 auto-compact (§7), best effort — never fails the transaction
```

Step 3 is the reason `expected` belongs on `RefUpdate` (§3.2): the compare-and-swap must happen
**after** the lock, against a stack read under it.

**Retry policy (step 1).** git's `reftable.lockTimeout` defaults to 100 ms with a jittered backoff.
tsgit mirrors the default and the semantics: `0` means one attempt, a positive value bounds total
wait, and there is **no lock breaking at any timeout** — a stale lock surfaces `REFTABLE_LOCKED`
naming the path, exactly as git surfaces `cannot lock references`.

**Crash safety (R14).** Every step's residue is a state git already produces and already handles:

| crash after step | on disk | git reads | tsgit reads | recovery |
|---|---|---|---|---|
| 1–5 | pre-state + empty lock | pre-state | pre-state | remove the lock (manual, as with git) |
| 6 | + an orphan `*.temp.*` | pre-state | pre-state | ignored — not in `tables.list`; DN-4 |
| 7 | + an orphan `*.ref` | pre-state | pre-state | ignored — measured §1.15; DN-4 |
| 8 | lock holds the new body, `tables.list` unchanged | pre-state | pre-state | remove the lock |
| 9 | post-state | post-state | post-state | none |

The single commit point is the rename at step 9. There is no window in which a reader sees a
half-updated stack, which is R14 — and it is why the ordering of §8's fix matters: everything that
can refuse must refuse before step 6.

**Durability gap, stated rather than hidden.** git `fsync`s the lock fd before renaming it
(§1.12). The `FileSystem` port has no `fsync`, so tsgit's commit is ordered but not durable
against a power loss between the write and the rename — the same gap `atomicWriteRef` has had
since it was written, and consistent across every tsgit write surface. It is not widened here and
adding `fsync` to the port is out of scope; it is recorded so the difference from git is a known
one.

### 7. Compaction

`src/domain/refs/reftable/reftable-compaction.ts` holds the pure part — the policy — and the
transaction module holds the I/O.

```ts
export interface CompactionSegment { readonly start: number; readonly end: number } // end exclusive
export function suggestCompactionSegment(
  sizes: readonly number[],           // metric(table), oldest -> newest
  factor: number,                     // default 2
): CompactionSegment;
export function compactionMetric(fileSize: number, version: 1 | 2): number;
```

`compactionMetric` is `fileSize − footerSize(version) − (headerSize(version) − 1)` — 91 at v1,
99 at v2 (§1.15). `suggestCompactionSegment` is the two-loop rule of §1.15 verbatim, including the
two details that cost the most if missed: **the second loop continues from the index the first
loop broke at, not one below it**, and — *once the first loop has found an end* — **`start`
remaining 0 because nothing qualified means the whole stack compacts**, which is the only path by
which a full merge ever happens. (If the *first* loop finds no end, `start` and `end` are both 0
and the segment is empty; the two zero cases mean opposite things and a single `if (!end)` guard
is what keeps them apart.) Both are pure functions over numbers, so §1.15's 60-row replay becomes
a literal unit table.

Auto-compaction runs as step 11 of every transaction and follows §1.15's protocol:

1. Re-acquire `tables.list.lock`; abort if the stack moved.
2. Take `<table>.lock` for the segment, **newest → oldest**. On a held lock, shrink the range to
   what was locked; if fewer than two tables remain, give up silently.
3. Release the list lock; merge.
4. Re-acquire the list lock; re-verify the names still appear in the same order; abort if not.
5. Rename the merged table in — **unless it is empty**, in which case it is simply omitted.
6. Rewrite `tables.list` through the lock.
7. Unlink the merged tables, best effort.

Two merge rules from §1.15 that a naive merge gets wrong:

- **Tombstones survive a partial compaction and are dropped only when `start === 0`.** Both ref
  tombstones and log tombstones. Dropping them from a mid-stack merge resurrects deleted refs from
  older tables — the same failure mode as a concatenating reader (§2).
- **`min_update_index` of the result is the oldest merged table's `min`, `max_update_index` the
  newest's `max`** — measured `0x…01-0x…05` + `0x…06-0x…06` → `0x…01-0x…06`.

**Auto-compaction never fails a write.** A lock conflict or an outdated stack is swallowed
(§1.15's measured "depth grew from 2 to 3 while every table lock was held, then compacted back to
1 after they were released"). This is the one place in this design where an error is discarded
rather than propagated, and it is deliberate and narrow: only `REFTABLE_LOCKED` and the
stack-outdated condition, only from the compaction step, and only after the ref update has already
committed. Anything else propagates.

**There is no forced full compaction, and that is deliberate.** git's is `pack-refs --all` / `gc`,
which ADR-690's posture keeps out of tsgit. The consequence is precise and worth naming: a
tombstone is elided only when an auto-compaction segment happens to start at table 0, so a deleted
ref's tombstone can persist across many updates. It is never *visible* — the merge join hides it
(§2) — it only costs bytes, and it costs exactly what it costs in a git repository that never runs
`gc`. What tsgit must not do is elide tombstones from a partial merge to save those bytes; that is
the resurrection bug above.

### 8. The `updateRef` write-then-throw fix

`src/application/primitives/update-ref.ts` today:

```ts
await atomicWriteRef(ctx, name, refPath, content);   // line 46 — COMMITS
if (oldId !== newId) {
  await recordRefUpdate(ctx, name, oldId, newId, options.reflogMessage);   // line 51
}
await logCoupledHead(ctx, store, name, oldId, newId, options.reflogMessage);   // line 53
```

and `logCoupledHead` opens with `await store.resolveDirect(HEAD)` (line 87). **The only read that
can refuse happens after the only write that commits.** That is the whole bug, and it is not
reftable-specific: any `resolveDirect(HEAD)` failure — a corrupt `HEAD`, a symref cycle, an I/O
error — leaves a committed ref and a thrown call on the files backend too.

The fix is the seam's shape, not a reordering patch. `updateRef` becomes:

```
1  validateRefName(name)
2  read   current = store.resolveDirect(name)
3  read   head    = store.resolveDirect(HEAD)          <- MOVED ABOVE every write
4  check  options.expected against current
5  build  updates: RefUpdate[]  = [ set(name, …), reflogOnly(HEAD, …) if head targets name ]
6  await  store.applyRefUpdates(updates)               <- the single commit point
```

Everything that can refuse is in steps 1–5; step 6 either commits or leaves the repository
unchanged. On the files backend `applyRefUpdates` performs the per-ref lock-and-rename it does
today, in list order, so the observable result is unchanged for every existing test. On reftable
it is §6's transaction, and the coupled `HEAD` reflog lands at the **same `update_index`** as the
branch — which §1.13 measured is exactly what git does, so the fix moves tsgit *towards*
faithfulness rather than merely away from the bug.

**Call sites that carry the same shape and are fixed with it:**

| site | today | after |
|---|---|---|
| `update-ref.ts` `updateRef` | write → read `HEAD` → throw | resolve first, one `applyRefUpdates` |
| `update-ref.ts` `deleteRef` | `isLoose` → `removeLoose` → `deleteReflog` (three mutations, no rollback) | one `delete` update; the reflog tombstones are part of it |
| `write-symbolic-ref.ts` | `atomicWriteRef` of the symref text | one `setSymbolic` update |
| `stash-ref.ts` `dropStashEntry` | `writeReflog` whole-file rewrite | log tombstones in one transaction (§1.13: one per cancelled entry) |
| `record-ref-update.ts` | appends to `<gitDir>/logs/<ref>` independently of the ref write | folded into the update it belongs to |

`deleteRef`'s `unsupportedOperation('delete-packed-ref', …)` becomes a **files-backend** refusal
raised inside the files implementation, not a shared branch — reftable has no packed refs and
deletes by tombstone. `remote.moveTrackingRef`'s `rename-packed-tracking-ref` refusal moves the
same way. Those are the two `isLoose` call sites the narrowed interface drops (§3.1).

### 9. Adapters

ADR-680 puts the backend on all three adapters. Against the `FileSystem` port:

| protocol need | port call | node | memory | browser (OPFS) |
|---|---|---|---|---|
| exclusive lock create | `writeExclusive` | `O_EXCL` | map insert, single-threaded | `assertDoesNotExist` + `getFileHandle({create:true})` |
| read the stack | `read` / `readSlice` / `readUtf8` / `readDir` / `stat` | yes | yes | yes |
| inflate / deflate log blocks | `ctx.compressor` | zlib | zlib | `CompressionStream` |
| write a table | `write` | yes | yes | yes |
| **commit by rename** | `rename` | **atomic** (`fs.rename`) | **atomic** (synchronous map swap; no await between delete and set) | **NOT atomic** — documented in the adapter as read + write + rm, and the port JSDoc says lock-file protocols "MUST use the Node or Memory adapter" |
| unlink compacted tables | `rm` | yes | yes | yes |

Reads are portable with no caveat. **Writes have exactly one gap, and it is the commit point.**
Browser `BrowserFileSystem.rename` is `read(src)` → `write(dst)` → `rm(src)`. Applied to step 9 of
§6 that decomposes into: read the lock, overwrite `tables.list` with the new body, delete the lock.
A crash or a closed tab **between the overwrite and the delete** leaves the transaction *committed*
and `tables.list.lock` stranded — reads are correct (the lock is not on the read path) but every
subsequent write is blocked by a lock the writer itself created, on a platform where "remove the
file by hand" is not something a user can readily do. The overwrite itself is a single
`createWritable()` → `write()` → `close()`, and OPFS applies a writable stream at `close()`, so a
torn `tables.list` is not the failure mode; a stranded lock is.

This is not a browser bug tsgit can fix — OPFS has no rename and no atomic replace. It is **DN-2**.
The `writeExclusive` half of the protocol is genuinely available everywhere, so the gap is narrow
and precisely locatable; what it is not is silent, which is why it must be decided rather than
noted.

The `memory` adapter is fully capable: `rename` mutates three maps with no `await` between them,
so within the single-threaded event loop it is atomic. It is therefore the right host for the
parity fleet's write scenarios.

### 10. Concurrency

| scenario | measured git behaviour (§1.12, §1.15) | tsgit |
|---|---|---|
| two writers, same stack | both succeed; the 100 ms retry absorbs contention; 241/241 refs; no orphans | same protocol, same default retry, `REFTABLE_LOCKED` when the budget expires |
| writer vs. reader | reader sees the complete pre- or post-state; the lock never blocks reads | same — the commit is one rename |
| reader vs. compaction | merged tables are unlinked; a reader that has the name but not the bytes gets ENOENT | §1.9's one restart, then `INVALID_REFTABLE { check: 'tablesList' }` |
| writer vs. compaction | table locks are taken newest → oldest; a conflict shrinks the range | same; conflict is swallowed (§7) |
| tsgit writer vs. `git` writer | — | identical protocol on identical files, so the two interleave the same way two `git` processes do; the interop suite runs one of each |
| two stacks in one update | both locks held at `prepared`, both committed; not atomic as a pair | same, with a **fixed lock order (common → worktree)** so two tsgit writers cannot deadlock |
| stale lock | never broken, at any timeout | never broken; `REFTABLE_LOCKED` names the path |

The one place tsgit is *not* a faithful peer is that git's writers are separate OS processes while
tsgit's are `Context`s in one event loop. Two `Context`s over the same stack contend on the same
lock file and behave as above. Two calls on **one** `Context` are serialised by the memo plus the
lock; the per-`Context` single-writer invariant the rest of the codebase relies on is preserved
because the memo is invalidated at step 10 of every transaction, not on a timer.

### 11. Genericity and symmetry checks

**Width genericity.** Covered on both sides in §2 and §5; the v2 fixture makes it exercised rather
than asserted.

**Read-path / write-path symmetry.** ADR-681 records write/read asymmetry as "a recurring blind
spot in this repository". Here the two ship together by construction: `serializeReftable` and
`parseReftable` are a codec pair in one directory with a round-trip property (§Test strategy), the
transaction writes the same `tables.list` grammar the loader reads, and the compaction metric is
computed from the same footer/header sizes the parser reports. The one deliberate asymmetry is
R12: the parser accepts shapes (unaligned files, log-only files, multi-level indexes, 2–3 log
blocks with no index) that the writer never emits, because the writer emits what git emits and the
parser must accept what any implementation emits.

**Read-path / read-path symmetry.** The trap is §3.1's six enumerators. Converting `RefStore`
and `enumerate-refs` while leaving `branchList` and `tagList` on their own `readdir` produces a
repository where `resolveRef` and `enumerateRefs` are right and `branch.list()` / `tag.list()`
are silently empty — the §Observed failure defect, narrowed but not closed. R2/R3 are met only if
all six converge on `listRefs`.

**Faithfulness is pinned on data, not display.** Per ADR-249 nothing here returns a rendered
line. The interop tests reconstruct `git show-ref` / `git for-each-ref` / `git reflog --date=raw`
output *in the test* from structured fields and compare to real git. On the write side the
comparison is on-disk state, not stdout — which ADR-680 already flags as the reason compaction is
the thinnest-pinned part of this design.

## Settled decisions

Every candidate the read-only draft raised is settled. The table records what was decided and by
which ADR; the "against the recommendation" row is the one that resized this document.

| # | Question | Outcome | ADR |
|---|---|---|---|
| DC-1 | Scope of the reftable backend | **(c) read + write + compaction** — the complete backend. **Ratified against this design's recommendation of (a) read-only.** §5–§7 and §10 are the consequence; the `updateRef` ordering bug is fixed at its cause (§8) rather than made unreachable by a refusal | [ADR-680](../adr/680-reftable-ships-as-a-complete-backend.md) |
| DC-2 | How `RefStore` generalises | (a) a narrowed backend-neutral interface, files specifics private. §3.2 gives the signature; the write half is `applyRefUpdates`, which DC-1(c) makes the load-bearing method rather than a single refusal | [ADR-686](../adr/686-refstore-generalises-to-a-backend-neutral-interface.md) |
| DC-3 | How the backend reaches `Context` | (a) a `refStorage` field on `RepositoryLayout`, set by the Stage-2 read. Resolved before any tier assertion, so ADR-682's third tier is unaffected | [ADR-687](../adr/687-the-ref-backend-reaches-context-through-the-layout.md) |
| DC-4 | Behaviour on a corrupt stack | (c) split by tier — refuse where git crashes, degrade where git degrades. A documented divergence from ADR-226 | [ADR-688](../adr/688-a-corrupt-reftable-stack-refuses-by-tier.md) |
| DC-5 | Which adapters carry it | all three, folded into DC-1. The residual gap is the browser commit rename, which DC-1(c) turns from a non-question into **DN-2** | [ADR-680](../adr/680-reftable-ships-as-a-complete-backend.md) |
| DC-6 | Reflog routing | (a) the same backend seam. Under DC-1(c) this is not merely tidier: §1.13 measured that a ref update and its reflog are **one transaction at one `update_index`**, so two seams could not express what git writes | [ADR-689](../adr/689-reflogs-route-through-the-same-backend-seam.md) |
| DC-7 | `git refs migrate` as a tsgit surface | (a) no. `REFTABLE_LOCKED`'s `reason` carries the actionable path instead (§4) | [ADR-690](../adr/690-refs-migrate-is-not-a-tsgit-surface.md) |
| DC-8 | Where the codec lives | (a) `src/domain/refs/reftable/`, several modules | [ADR-691](../adr/691-the-reftable-parser-lives-in-domain-refs.md) |
| DC-9 | Stack load granularity | (a) eager whole-table load. Compaction needs the whole stack in memory anyway, so under DC-1(c) eager is not a trade-off | [ADR-692](../adr/692-the-reftable-stack-loads-eagerly.md) |

## New decision candidates

Four, all surfaced by the write side, none decidable from the read-only draft.

| # | Choice | Alternatives (≤3) | Recommendation | Why |
|---|---|---|---|---|
| **DN-1** | **The byte-identity contract for a table tsgit writes**, and therefore the `kind` on its ADR-140 `@writes` block. §1.14 measures the exact limit: header, ref/index/obj blocks, padding and footer are byte-reproducible; the **log section is not**, because DEFLATE output is implementation-defined (git/Apple zlib 1.2.12 → 145 B, Node zlib 1.3.1 → 147 B, `CompressionStream` → 147 B and different again; 2835 Node parameter combinations reproduce none of them). | **(a) `equivalent-under-readback` for the whole table**, with the interop test additionally asserting that the **prefix up to `log_position` is byte-identical** to git's — a stronger pin than the declared contract, kept honest by measurement. **(b) `equivalent-under-readback`**, records-only comparison; no byte assertions anywhere. **(c) Chase `byte-identical`** by vendoring a DEFLATE implementation matched to git's zlib. | **(a)** | The repo already has both precedents and they point the same way: `pack-writer.ts`'s `packfile` surface is `equivalent-under-readback` **for exactly this reason** (deflate is implementation-defined), while `rev-on-idx-write.md` earns `byte-identical` because nothing in `.rev` is. A reftable straddles them, and ADR-140 permits one `kind` per surface, so the declared contract must be the weaker one. (a) then refuses to throw away the part that *is* pinnable: everything before `log_position` is deterministic, it is where all the structural writer choices live (block sizing, restart points, index thresholds, `obj_id_len`, padding, S2's first restart offset), and asserting it catches every structural regression a byte-identical contract would have caught. (b) discards that for nothing. (c) means shipping a DEFLATE encoder to match one platform's zlib build, which would still not match a differently-built git — it chases a property the format does not have. |
| **DN-2** | **The browser adapter's transaction commit.** ADR-680 puts the backend on all three adapters; `BrowserFileSystem.rename` is read + write + rm, and the `FileSystem` port JSDoc already states that lock-file protocols "MUST use the Node or Memory adapter". A crash between the write and the `rm` leaves a stale `tables.list.lock` that blocks every subsequent write, with no shell to remove it. | **(a) Ship the same protocol on OPFS** and document the weaker crash-safety, as tsgit already does for `atomicWriteRef` on browser. **(b) Refuse reftable *writes* on the browser adapter** with ADR-685's `REPOSITORY_EXTENSION_UNSUPPORTED`, reads unaffected. **(c) Add an `atomicRename: boolean` capability to the `FileSystem` port**; the transaction consults it and takes a documented degraded path (e.g. self-healing a lock it can prove it owns) when false. | **(a)** | It is what the repo already does one layer down: `atomicWriteRef` runs on OPFS today with exactly this caveat, so (b) would make reftable *stricter* than the files backend on the same adapter — a user could write refs to a files repository in the browser but not to a reftable one, which is a worse story than a documented durability caveat. (a) also keeps ADR-680's "all three adapters" literally true and keeps the parity fleet uniform. The cost is real and should be stated in the decision: on OPFS a mid-commit crash can strand a lock. (c) is the principled fix and the one to take if the user weighs a stranded lock as unacceptable, but it widens a port every adapter implements for one caller, and "a lock it can prove it owns" needs an owner token the protocol does not currently have. **This is the row where the user's tolerance for a browser-only durability caveat decides it, and the design should not decide that alone.** |
| **DN-3** | **Whether the interop suite may assert that tsgit's stack has the same *shape* as git's** after the same sequence of updates. §1.14/§1.15 combine badly here: the auto-compaction metric is the file size, log-block sizes are zlib-implementation-dependent, and the measured decision margins are as thin as 432 vs 428 bytes — so a 2-byte deflate difference can legitimately flip one merge. | **(a) Assert the invariant, not the shape** — after any sequence, `suggestCompactionSegment` over tsgit's own stack returns an empty segment (the stack *is* geometric) and the merged ref/reflog view equals git's. Table count is never compared. **(b) Assert table-for-table equality** with git. **(c) Exclude the log section from the compaction metric** so the decision becomes deflate-independent. | **(a)** | (b) is a flaky test waiting to happen, and the flake would be *correct behaviour* — the worst kind. (a) states what actually matters (bounded depth, identical visible refs) and is checkable with a pure function this design already ships. (c) would make tsgit's stack shape reproducible but is a silent divergence from git's policy on the one metric git defines, and it would break the property that a `git`-compacted and a tsgit-compacted stack are interchangeable. Flagged as a candidate rather than decided because it sets what the compaction interop rows are *allowed* to assert, and getting that wrong is how §1.15's work gets thrown away by a later "fix the flake" commit. |
| **DN-4** | **Orphaned table files.** §1.15 measured that git cleans unreferenced `*.ref` files only in `git pack-refs --all` / `git gc`. tsgit has neither (`src/application/commands/` has no `pack-refs`), and the repo's standing posture is no `gc`, no `prune`, no `repack` (ADR-690's own consequence section). A crash at step 6 or 7 of §6 therefore leaves a file nothing ever removes. | **(a) Clean opportunistically inside the transaction** — while `tables.list.lock` is held, unlink `*.ref` / `*.temp.*` in the directory that are absent from both the old and the new `tables.list`, best effort. **(b) Never clean** — leak exactly as git leaks between `gc` runs; document it. **(c) Add a `packRefs`-equivalent full-compaction surface** that also cleans. | **(a)** | The cleanup is already inside a critical section that holds the authoritative list, so it is a `readDir` and a few `rm`s with no new locking and no new surface — it does not become a `gc`. It is also *safer* than git's own version: under the list lock, a file absent from both the pre- and post-list is unreachable by any correct reader, whereas git's `pack-refs`-time sweep has to reason about concurrent additions. (b) is the faithful answer and would be defensible if tsgit had a `gc`; without one the leak is unbounded across a repository's life, which is worse than git's behaviour, not equal to it. (c) contradicts ADR-690's stated posture and adds a public surface for a housekeeping concern. **Surfaced because (a) is a small, deliberate divergence — tsgit cleaning where git would not — and the prime directive means that is the user's call, not the design's.** |

## Test strategy

**Unit — the codec** (`src/domain/refs/reftable/*.test.ts`; domain is 100 %-coverage gated,
Stryker mutates it).

*Read side.*

- Header: v1 (24 B) and v2 (28 B, `hash_id` `"sha1"` and `"s256"`), `block_size`,
  `min`/`max_update_index` as `bigint`. Bad magic, unknown version, and a truncated header each
  get an isolated test asserting `INVALID_REFTABLE` **with its `check` and `reason`** — never
  `toThrow(TsgitError)` alone, per the mutation-resistance rules.
- Footer: 68/72-byte length by version, all five position fields, `obj_position`/`obj_id_len`
  unpacking from the packed `uint64`, and a CRC-32 mismatch as its own test. The measured
  124-byte v1 and 132-byte v2 empty tables are literal fixtures.
- Varint: the ofs-delta decoder, including the multi-byte cases actually measured (`0x8011`=145,
  `0x8010`=144, `0x8001`=129, `0x9f00`=4096) and an overflow guard.
- Ref records: one test per `value_type` (0/1/2/3), prefix compression across a restart boundary,
  and the `prefix_length == 0` invariant at restart points. Guard clauses get isolated tests.
- Log records: `log_type` 0 and 1, the `reverse_int64` key ordering, zlib inflate with
  `block_len` as inflated-size-including-header, and **a parameterised table of the six measured
  `tz_offset` rows** (§1.6) through `decodeTzOffset` — the single most important unit table in the
  suite, because it is the one place the shipped spec would mislead an implementer.
- Index/obj records: `block_position` absolute, `cnt_3` 1–7, `cnt_3 == 0` → `cnt_large`, the
  `cnt_3 == 0 && cnt_large == 0` scan-all case, and `position_delta` accumulation.
- Stack merge: newest-table-wins, and tombstone-beats-older-live — the §1.4 two-table fixture.
- **R12 — the shapes git's writer never emits (§1.11).** `block_size = 0` unaligned with two ref
  blocks and a mandatory ref index; a log-only file whose first log block starts at byte 24 with no
  ref section; a two-level ref index whose first-level `block_position` targets another `'i'`
  block; and **a 3-log-block table with `log_index_position == 0` (S3)**, which git *does* emit and
  the spec forbids. The first three are hand-built with `serializeReftable` plus a test-only option
  bag; the fourth is a real git fixture.

*Write side.*

- Every §1.13 writer choice as its own test with the measured value as the oracle: `block_size`
  4096 in the header, `restart_interval` 16, zero padding to the boundary, log blocks unpadded,
  `block_len` including the file header on the first block, first restart offset **28 at v1 and 32
  at v2** (S2, isolated tests per version so a hard-coded 28 dies).
- Threshold tests at the boundary, both sides: **3 ref blocks → no index, 4 → index**; **3 log
  blocks → no log index, 4 → log index** (S3); **obj section absent at 3 ref blocks, present at 4**.
  These are the rows a mutant most easily survives, so each is a pair, not a single case.
- `obj_id_len` = longest adjacent common prefix + 1, floor 2, with an oid set that forces 3.
- Log message canonicalisation: trailing `\n`s stripped, an embedded `\n` rejected with its own
  `check`, absent message → `'\n'`.
- `encodeTzOffset` over the same six rows, and `decodeTzOffset(encodeTzOffset(x)) === x`.
- `suggestCompactionSegment` and `compactionMetric` as pure tables: **the 60 measured transitions
  of §1.15 as `it.each` rows**, plus the v2 8-row set, plus the two structural edge cases (nothing
  qualifies in loop 2 → `start = 0` → whole-stack compaction; `n <= 1` → empty segment).

**Property tests.** DC-1(c) changes the four-lens verdict from the read-only draft: **lens 1 now
applies**, because there is a real `serialize` half.

- **Lens 1 (round-trip)** — `reftable-format.properties.test.ts`, `numRuns` **200** (cheap
  round-trip tier). Property:
  `parseReftable(serializeReftable(refs, logs, opts))` yields exactly `refs` and `logs`.
  Generators in a sibling `arbitraries.ts`: `arbRefName` (valid grammar, ASCII, no NUL, bounded
  depth), `arbRefRecord` over all four value types, `arbLogRecord` over both log types with
  `tz_offset` in ±1400, `arbWriteOptions` over `{hashId, blockSize ∈ {0, 512, 4096}, restartInterval
  ∈ 1..64, indexObjects}`. **The canonicalisation the round-trip is modulo**, stated explicitly
  because a property that hides it is a tautology: (i) refs are compared as a **set keyed by
  name**, since the writer sorts by name and the caller's order is not preserved; (ii) logs are
  compared sorted by `(name, reverse update_index)` for the same reason; (iii) log **messages
  round-trip through §1.13's canonicalisation** — trailing newlines are stripped and exactly one is
  appended, so the generator produces messages without embedded `\n` and the oracle is
  `canonicaliseLogMessage(m)`, not `m`; (iv) `update_index` is compared as the absolute value, not
  the delta encoding.
- **Lens 3 (total function over a grammar)** — `parseReftable` over a declared safe subset
  (well-formed header + footer + arbitrary block payload) must never throw anything other than
  `INVALID_REFTABLE`, never hang, and never read out of bounds. A reftable is untrusted input from
  a cloned repository, so "no crash, only a typed refusal" is the invariant worth generating for.
  `numRuns` **50** (filter-heavy negative tier).
- **Lens 2 (compositional aggregator)** — the stack merge, without re-implementing the loop: an
  empty stack yields no names; appending a table with a live record for `X` makes `lookup(X)`
  defined; appending a tombstone for `X` makes it `undefined`; appending the live record again
  flips it back. `numRuns` **100** (default tier). A second lens-2 property covers
  `suggestCompactionSegment`: for any size vector, applying the suggested merge and re-running the
  function converges — the post-compaction stack is geometric. That is R15 as a property.
- **Lens 4** — does not apply; no property here needs the production loop as its oracle.

Per ADR-134–136 these are additive: no example test is deleted in the same change, no seed is
committed, and the property files sit beside the example files rather than mixed in.

**Interop** — `test/integration/reftable-ref-storage-interop.test.ts`, twin git/tsgit rows over
real reftable repositories. **One shared `beforeAll` fixture with a 60 000 ms timeout**, per the
repo's git-spawning-suite convention; every read row builds its tsgit `Context` *after* the last
`git` subprocess has written, so no memoised stack predates the mutation under test. Environment
scrubbed via the existing `runGitEnv` helper (`GIT_*` cleared, isolated `HOME`, signing off) —
`-C` does not override `GIT_DIR`.

*git writes → tsgit reads:*

| # | fixture | asserts |
|---|---|---|
| 1 | 5-ref fixture of §1.4 | tsgit's ref set ≡ `git show-ref`; and ≡ `git for-each-ref` including the `commit`/`tag` type column |
| 2 | annotated tag | peeled value ≡ `git for-each-ref '%(objectname) %(*objectname)'` |
| 3 | symbolic ref `refs/heads/symbolic` | resolves through the chain as `git rev-parse` does |
| 4 | `HEAD` | ≡ `git symbolic-ref HEAD`; the `.invalid` stub never surfaces (R4) |
| 5 | tombstone across two tables | the deleted ref is absent from both tools (R3) |
| 6 | reflog fixture | entries, order, oids, identity and message ≡ `git reflog show --date=raw`, **for each of the six tz offsets** (R8, S1) |
| 7 | `--object-format=sha256` reftable | v2 header parsed; ref set ≡ git's (R7) |
| 8 | 3001-ref fixture | ref index + obj block exercised; ref set ≡ git's |
| 9 | linked worktree | shared vs per-worktree scoping ≡ git's, from both stacks (R9) |
| 10 | 100-ref fixture (3 log blocks) | log records read correctly with **no log index** (S3, R12) |
| 11 | the seven §1.10 damaged fixtures | tsgit's tier matches ADR-688 — refuse where git's `fsck` dies on signal 11, degrade where git degrades; **tsgit never crashes or hangs**. Per ADR-688 the crashing rows assert git's exit signal and tsgit's structured refusal side by side |

*tsgit writes → git reads:*

| # | fixture | asserts |
|---|---|---|
| 12 | tsgit creates a ref in a git-made reftable repo | `git show-ref` sees it; `git fsck` and `git refs verify` clean |
| 13 | tsgit deletes a ref | gone from `git show-ref`; **its reflog entries gone from `git reflog`** (one tombstone per entry, §1.13) |
| 14 | tsgit writes a symbolic ref | ≡ `git symbolic-ref` |
| 15 | tsgit commits on the branch `HEAD` points at | `git reflog HEAD` **and** `git reflog <branch>` both gain an entry at the same index (§1.13, §8) |
| 16 | tsgit writes into a SHA-256 reftable repo | v2 table; `git show-ref` sees it (R7, R13) |
| 17 | **DN-1's byte pin** | for a fixture whose logical content git can reproduce exactly, the table tsgit writes is **byte-identical up to `log_position`** to git's, and records-equal beyond it |
| 18 | tsgit writes 60 refs one at a time | after each, `git show-ref` ≡ tsgit's `listRefs`; and **DN-3's invariant**: `suggestCompactionSegment` over the resulting stack is empty |
| 19 | full compaction round trip | tsgit compacts a git-built stack; `git show-ref`, `git reflog` and `git fsck` all agree with the pre-state, and tombstones are elided only when the segment started at table 0 |
| 20 | interleaved writers | a `git update-ref` and a tsgit write against one stack, alternating; all refs present, stack geometric, no orphans (R16) |
| 21 | stale lock | with `tables.list.lock` planted, tsgit raises `REFTABLE_LOCKED` naming the path and `git update-ref` says `cannot lock references`; **the stack is byte-unchanged**; reads succeed on both sides |
| 22 | crash residue | the §6 table replayed by killing the write between steps: for each row, git and tsgit read the same state afterwards (R14) |
| 23 | **the R6 regression pin** | drive `updateRef` so the coupled-`HEAD` read fails; assert the throw **and** that `.git/refs`, `.git/logs` and `.git/reftable` are byte-identical to before. Run on **both backends** — §8's bug is a files-backend bug too |
| 24 | tsgit-created repo | default `init` still yields `repositoryformatversion = 0` and no `[extensions]`; git opens it (R10) |

Row 23 is the one that must not be dropped: it is the direct regression test for the measured
write-then-diverge defect, and ADR-680 makes it a fix rather than an avoidance, so it has to fail
on `main` before it passes here.

**Parity** — `test/parity/` proves cross-adapter agreement only, never faithfulness. A reftable
fixture materialised into the memory adapter, asserting node ≡ memory ≡ browser for the read
surfaces and, scoped to whatever DN-2 ratifies, for the write surfaces. **The parity oracle is
records, not bytes**: §1.14 measures that Node's zlib and the browser's `CompressionStream`
produce different log-block bytes for identical content, so a byte-equality assertion across
adapters would fail for a reason that is not a defect. The non-log prefix *is* byte-comparable
across adapters and is asserted as such.

**Public-surface gates.** `repo.layout` gains `refStorage` (ADR-687), so `reports/api.json` is
regenerated and committed in the same change (pre-push gate). `docs/use/errors.md` gains
`INVALID_REFTABLE` and `REFTABLE_LOCKED` with their payload fields and a catch example. If the
codec types are exported, `src/domain/refs/index.ts` re-exports them and `src/public-types.ts` is
updated. The writer file carries an ADR-140 `@writes` block whose `kind` DN-1 decides, and
`tooling/audit-write-surfaces.ts` then requires a `cross-tool-interop` test whose `@proves` header
names the surface — rows 17–19 supply it, so no allowlist entry is added. A new Tier-1 command is
**not** added (ADR-690), so the barrel/facade/`repository.test`/browser-scenario/README gates for
new commands do not fire.

## Out of scope

- **SHA-256 object format** — a sibling design (`docs/design/sha256-object-format.md`) revised
  concurrently under [ADR-681](../adr/681-sha256-reaches-full-write-parity.md). This design
  requires width-genericity (R7) and both parses and writes v2 reftable headers, but designs none
  of the object-side hash work and does not depend on it landing. The two meet only at
  "a SHA-256 repository exists"; a v2 reftable is readable and writable whether or not v2 objects
  are.
- **Bundle v3** — [ADR-683](../adr/683-bundle-v3-is-implemented-now.md), same ticket, no overlap.
- **The acceptance gate itself** — `docs/design/repository-format-acceptance-gate.md`, ADR-666,
  ADR-668, ADR-682. This design consumes the Stage-2 `extensions.refStorage` read and attaches no
  refusal to any tier.
- **The ownership/trust gate** — `docs/design/ownership-trust-gate.md`, ADRs 669–679.
- **`git refs migrate`** — ADR-690. The escape-hatch wording in `REFTABLE_LOCKED`'s `reason` and
  the docs page is in scope; the command is not.
- **A `pack-refs` / `gc` surface** — DN-4 recommends opportunistic cleanup inside the transaction
  precisely so that no housekeeping command is added.
- **`fsync` on the `FileSystem` port** — §6 records the durability gap against git and leaves it
  where every other tsgit write surface already leaves it.
- **Block-level lazy reads** — ADR-692 settles eager loading; lazy reads are a perf optimisation
  with no correctness content, and compaction needs the whole stack in memory regardless.
- **Transport** — §1.16 pins that ref storage never crosses the wire, so `clone`/`fetch`/`push`
  negotiation is untouched.
