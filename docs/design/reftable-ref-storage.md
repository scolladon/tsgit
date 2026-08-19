# Design — reftable ref storage

> Brief: [ADR-667](../adr/667-tsgit-accepts-every-extension-git-knows.md) ratified that tsgit
> accepts **every** `extensions.*` git knows, and expanded scope so that acceptance is not a lie.
> `refStorage = reftable` is one of the two subsystems that entered the change on that ticket.
> Lift: a domain parser for the reftable binary format, a backend seam behind `RefStore`, and a
> point-of-use refusal wherever tsgit cannot act.
>
> **The brief's premise understates the defect.** ADR-667 records that a reftable repository
> "presents as **ref-less**" to tsgit. Measured (§Observed failure), it is worse in three separate ways. tsgit
> does not see zero refs — it sees **one phantom ref**, `refs/heads`, because git's reftable stub
> `.git/refs/heads` is a *regular file* whose 41 bytes read as a ref name. `branchList` does not
> return empty — it **throws `INVALID_REF`**, because the stub `.git/HEAD` points at
> `refs/heads/.invalid`. And the write path is **not inert**: `updateRef` into a reftable
> repository *writes the loose ref and its reflog to disk*, then throws `INVALID_REF` from a
> post-write step. The caller sees a failure; the repository keeps a durable ref that **git will
> never see and `git fsck` does not report**. That is not an empty view of a populated
> repository — it is two divergent populated views, created by an operation that reported that it
> failed.
>
> Status: draft → self-reviewed ×3 → **decision candidates open** (§Decision candidates). Nine
> candidates; DC-1 (read-only vs read-write) governs the size of everything else and is the one
> the design most needs decided first.

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
no "loose" anything, no `packed-refs`, and no raw per-ref text. Generalising this interface is
the central architectural question of this design, and §3 answers it against a full caller
census rather than a guess.

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
available locally — no claim here rests on recollection).

**Two places the shipped spec does not match the shipped binary**, both found by measurement and
both load-bearing enough that designing from the spec alone would have produced wrong bytes:

| # | spec says | git 2.55.0 writes | consequence |
|---|---|---|---|
| S1 | reflog `tz_offset` is "the absolute number of minutes from GMT"; `GMT+0230` ⇒ `sint16(150)` | the raw `±HHMM` integer; `+0230` ⇒ `sint16(230)` (§1.6, six zones) | a spec-faithful reader misreports every non-zero-offset reflog timestamp |
| S2 | "This forces the first `restart_offset` to be `28`" | 28 for version 1, **32** for version 2 (§1.4) | the spec sentence is v1-only; the rule is `header_size + 4` |

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

### Binding constraints

- **Prime directive** (CLAUDE.md, [ADR-226](../adr/226-git-faithfulness-prime-directive.md)) —
  replicate git's observable behaviour byte-for-byte unless an ADR diverges. Reftable is a binary
  on-disk format, so this binds the bytes, not only the messages.
- **Structured output** ([ADR-249](../adr/249-describe-structured-data-only.md)) — the library
  returns fields, never rendered lines. Nothing in this design emits display text; §5 pins
  faithfulness by reconstructing git's output *in the interop test* from structured fields.
- **Point-of-use refusal** (ADR-667's standing rule) — where tsgit cannot act on an accepted
  extension it refuses *precisely, at the point of use*; never by reading the repository wrong,
  and never by refusing to open a repository git opens.
- **Acceptance gate** (`docs/design/repository-format-acceptance-gate.md` §1b/§1e,
  [ADR-666](../adr/666-repository-format-refusals-keep-gits-config-porcelain-tier.md),
  [ADR-668](../adr/668-two-repository-format-refusal-codes.md)) — `extensions.refStorage` is read
  at v1 from `<commonDir>/config` only, in the Stage-2 scan, with value grammar
  `files`/`reftable`. This design **consumes** that read; it does not redesign it.
- **Coverage / mutation** — `src/domain` and `src/adapters` gate at 100% line/branch/function/
  statement; Stryker mutates all of `src`.

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
  is not, a refusal names reftable and the surface, and it is distinguishable by `code` from
  `INVALID_REF` and `NOT_A_DIRECTORY`.
- **R6** — **No write leaves divergent state.** Every write surface against a reftable repository
  either writes the reftable stack correctly or refuses *before* mutating anything. The measured
  write-then-throw of §Observed failure is closed regardless of which DC-1 option is chosen.
- **R7** — The parser is width-generic from the first commit: version 1 (SHA-1, 24-byte header)
  and version 2 (28-byte header, `hash_id`) are both parsed, with the digest width taken from the
  file, never from a constant.
- **R8** — Reflog reads answer from the stack's log blocks, including the `tz_offset` encoding
  actually used by git (§1.6), not the one the spec documents.
- **R9** — Per-worktree ref scoping is preserved: a linked worktree's own stack is consulted for
  per-worktree refs and the common stack for shared refs (§1.8).
- **R10** — Nothing tsgit writes creates a reftable repository. `bootstrapRepository` continues to
  emit `repositoryformatversion = 0` and no `[extensions]`, so tsgit cannot trip its own backend.
- **R11** — Wherever DC-5 lands, an adapter that does **not** carry the backend refuses by name
  rather than misreading. Under the recommended DC-5(a) no adapter is excluded and R11 is
  vacuous; it becomes load-bearing only if reftable is scoped to a subset of adapters.
- **R12** — The parser tolerates every shape the format permits, not only the shapes git's own
  writer emits (§1.11): unaligned files (`block_size = 0`), log-only files, and multi-level
  indexes.

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
`NOT_A_DIRECTORY` in §Observed failure. `find-layout.ts:320` `sharedDirsValid` requires `<commonDir>/refs` to
be a directory — a reftable repo satisfies that, so discovery already passes today.

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

A ref index "should" be written at ≥4 ref blocks, and **must** be if the file is unaligned with
more than one ref block. A log index must be written at ≥2 log blocks. Obj blocks are optional
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

`log_type` `0x0` is a deletion (a reflog tombstone, used by `git stash drop`); `0x1` carries
`log_data`. Renames are a zero-`new_id` deletion plus a zero-`old_id` creation.

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

Six for six on raw `±HHMM`, zero for six on minutes. tsgit follows the **binary**, and an interop
row pins each of these six offsets so a future git that fixes the spec-conformance is caught.

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
value and `log_data` oid pair. This is R7.

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
instance is scoped to *two* stacks, not one.

#### 1.9 Transactions, locking, compaction

From the spec's *Update transactions*, confirmed by observation: acquire `tables.list.lock`, read
`tables.list`, pick `update_index = max + 1`, write `tmp_XXXXXX`, rename it to the
`0x…-0x…-random.ref` name, copy `tables.list` to the lock with the new name appended, rename the
lock over `tables.list`. A single lock file makes the repository **single-threaded for writers**.
Compaction takes `B.lock`/`C.lock`, releases the list lock, merges, re-acquires, verifies, swaps.

| probe | result |
|---|---|
| pre-existing `tables.list.lock`, then `git update-ref` | `fatal: update_ref failed for ref 'refs/heads/zzz': cannot lock references` |
| 200 sequential single-ref transactions | max stack depth observed: **1** — auto-compaction is aggressive |
| 40 sequential updates | 2 tables; `git pack-refs --all` → 1 |
| write-side config knobs | `reftable.blockSize`, `reftable.restartInterval`, `reftable.indexObjects`, `reftable.geometricFactor`, `reftable.lockTimeout` |

Every reftable config knob git exposes is a **writer** knob. A read-only backend consumes none of
them — a point that bears directly on DC-1.

Reader protocol, from the spec: read `tables.list`, open every file it names, **if any is missing
start over**, then read from the open files as long as needed. Files not in `tables.list` are
either about to be added or ready to be pruned, and must be ignored.

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

**Second: `git fsck` dies on a signal.** `error: refs died of signal 11` is the child `git refs verify`
process crashing — a genuine git bug, not a behaviour. A missing `tables.list` (a legitimately
empty stack) is distinguishable: rc 0 and no signal.

This creates the design's sharpest tension. Faithfulness (ADR-226) argues for reproducing
silent-empty. But **silent-empty on a populated repository is precisely the hazard ADR-667 exists
to close** — the ADR's own words are "silent, and dangerous". Reproducing it here would mean
closing the hazard for a healthy reftable repository and re-opening it for a damaged one. And no
reading of the prime directive requires replicating a segmentation fault. This is **DC-4**.

#### 1.11 Format variations the spec permits that git 2.55.0 did not emit

Every fixture built here used git's own writer, so three legal shapes went **unexercised**. They
are recorded as parser obligations rather than pins, because the honest statement is "the spec
permits this and no measurement covers it" — a reftable can be written by JGit, libgit2, or Gerrit,
and a reader that assumes git's writer choices is wrong on their output.

| variation | measured in every fixture | what the spec permits | parser obligation |
|---|---|---|---|
| `block_size` | always `4096` | **`0` means unaligned** — no padding; blocks are consecutive; a ref index is then *mandatory* if there is more than one ref block | must not derive the next block position from `block_size` when it is 0; walk by `block_len` |
| log-only files | none seen; all tables were `.ref` | files with **`.log` extension** carry only header + log blocks + footer, and the first log block starts at byte 24/28 with no ref block | `tables.list` entries must be dispatched on content (`footer.logPosition`, absent ref section), never on the filename extension |
| ref/obj index depth | single-level (one `'i'` block) | **multi-level** — a first-level index block may point at further index blocks before the leaf | must read the block type at each `block_position` and recurse while it is `'i'`, rather than assuming the target is a leaf |

The `tables.list` dispatch row matters most: naming is a *convention* the spec only "suggests"
(`${min}-${max}-${random}`), so neither the `0x%012x` formatting nor the extension is safe to
parse for meaning. The stack reader takes filenames as opaque and reads each file's own header
and footer.

#### 1.12 Cross-format interoperability

| probe | result |
|---|---|
| `git clone <reftable repo>` (no flag) | clone is **`files`** — ref format is a purely local choice, never negotiated on the wire |
| `git clone --ref-format=files <reftable>` | files clone, full history and refs intact |
| `git clone --ref-format=reftable <files>` | reftable clone, all refs present incl. `refs/remotes/origin/*` |
| `git refs migrate --ref-format=files` | converts in place; **removes `extensions.refstorage`** and drops `repositoryformatversion` to **0** |

Ref storage never crosses the wire. `fetch`/`push`/`clone` transport is unaffected, which bounds
this design to local ref I/O.

### 2. What the read must produce

A domain parser in `src/domain/refs/reftable/`, alongside the existing binary parsers in
`src/domain/storage/` (`pack-index.ts`, `rev-index.ts`, `pack-entry.ts`) and following their
shape: zero-copy `DataView` over a `Uint8Array`, no I/O, no `Context`, total functions that throw
a typed `TsgitError` on malformed input.

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
module constant. That is the whole of R7's mechanism.

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

The `sint16` → `AuthorIdentity.timezoneOffset` conversion is where S1 lands, and it is one named
function with the six measured rows as its unit table. Note the existing `ReflogEntry` identity
shape already carries `timezoneOffset` as a `'+HHMM'` string, so the raw integer converts to it
directly — the divergence is *cheaper* to honour than the spec would have been.

Above the single file sits the stack:

```ts
// src/application/primitives/reftable-stack.ts
export interface ReftableStack {
  lookup(name: RefName): ReftableRefRecord | undefined;    // newest table first, tombstone wins
  names(): Iterable<RefName>;                              // merge join, tombstones removed
  logs(name: RefName): Iterable<ReftableLogRecord>;
}
export async function loadReftableStack(ctx: Context, reftableDir: string): Promise<ReftableStack>;
```

`loadReftableStack` implements §1.9's reader protocol — read `tables.list`, open each named file,
restart once if any is missing — and is memoised per `Context` with an mtime+size key on
`tables.list`, exactly as `createRefStore` memoises `packed-refs` today. Stack depth is 1–2 in
practice (§1.9), so a full parse of every table on load is affordable; block-level laziness is a
perf option, not a correctness requirement, and DC-9 records it as deliberately deferred.

**One assumption worth stating, because it is inherited rather than introduced.** A memoised
stack can go stale: git may compact underneath a live `Context`, replacing several tables with
one and deleting the originals. The mtime+size key on `tables.list` catches every *committed*
change, because §1.9's protocol rewrites `tables.list` as the final step of both update and
compaction — so a stack that was valid when loaded stays internally consistent, and the next
`tables.list` stat sees the swap. The residual window is a reader that loaded `tables.list`,
then had a table deleted before it opened it; the spec's answer is "start over", which
`loadReftableStack` does once before surfacing `INVALID_REFTABLE { check: 'tablesList' }`. This
is the same staleness contract `createRefStore` already has with `packed-refs`, and it is
bounded by the same per-`Context` single-writer invariant the rest of the codebase relies on —
tsgit is not the writer here, so the invariant is weaker than usual and the single retry is what
carries it.

**Decoding a name from the stack is a merge join, not a concatenation.** The same ref may appear
in several tables; the newest occurrence wins, and a `deletion` in the newest wins over a live
record below it. Getting this backwards produces resurrected deleted refs, so §5 pins it with a
dedicated interop row over a repo whose tombstone and live record are in different tables — the
exact fixture measured in §1.4.

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
independent read paths. Any option in DC-2 must say which of these it converts and which it
leaves — a `RefStore` swap alone satisfies R3 for `resolveRef` and fails R2, R4 and R8.

`getRefStore` is also called with a **derived child `Context`** in `submodule.ts:660,749`, so a
backend must key off `Context` and never a module-global.

#### 3.2 What generalises cleanly

`perWorktreeRefDir(ctx, name)` already encodes exactly the split §1.8 measured — `isPerWorktreeRef`
routes to `gitDir`, everything else to `commonDir`. For reftable the same predicate chooses
between `<gitDir>/reftable/` and `<commonDir>/reftable/`. The *policy* is backend-neutral and
already correct; only the path it produces changes. Reusing it is R9's mechanism and avoids a
second, divergent definition of "per-worktree".

`resolve-ref.ts` is nearly backend-neutral already: it owns the symref chain walk, cycle
detection and `MAX_SYMBOLIC_REF_DEPTH`, delegating each hop to `resolveDirect`. One caveat it
documents explicitly — `validateRefName` is load-bearing there as a *path-escape* guard, because
`resolveDirect` builds a filesystem path from the name. Under reftable that justification goes
vacuous, but the call must stay: it is still the ref-name grammar gate, and removing it would
weaken the files backend that shares the code path.

#### 3.3 Backend selection

`extensions.refStorage` is already read by the acceptance gate's Stage-2 scan over
`<commonDir>/config` (§1e of that design). This design **consumes** the value; it does not add a
second read, and it does not touch the gate. The open question is only how the decided value
reaches `getRefStore`, which is DC-3: today `Context` has no `refStore`/`refBackend` slot and
`RepositoryLayout` carries no format field.

Note the §1.1 measurement that the extension, not the directory, is authoritative: a repository
declaring `refStorage = reftable` with no `.git/reftable/` is a *valid empty-stack* reftable
repository to git, not a files repository. Backend selection must therefore key on the config
value alone and never sniff for the directory.

#### 3.4 Adapters

`FileSystem` already offers everything a reader needs, including `readSlice` for block reads
without whole-file loads. Reftable's *reads* are portable. Its *writes* are not equally so: the
transaction protocol is lock-file + rename, and `BrowserFileSystem.rename` is **not atomic** —
it is emulated read+write+rm, which is documented as not crash-safe for `atomicWriteRef` today.
Memory and browser adapters are sandboxed single-writer environments where the lock is cheap but
the rename guarantee is absent. This is DC-5, and it interacts with DC-1: a read-only backend has
no adapter question at all.

### 4. Error shape

Following the house factory style in `src/domain/refs/error.ts` — one arrow-function const per
code, lowerCamel of the code, returning `TsgitError`, never throwing internally:

```ts
export type RefsError =
  | …
  | { readonly code: 'UNSUPPORTED_REF_STORAGE'; readonly format: string; readonly surface: string }
  | { readonly code: 'INVALID_REFTABLE'; readonly check: ReftableCheck; readonly reason: string };

export const unsupportedRefStorage = (format: string, surface: string): TsgitError =>
  new TsgitError({ code: 'UNSUPPORTED_REF_STORAGE', format, surface });
```

`UNSUPPORTED_REF_STORAGE` is the point-of-use refusal ADR-667's standing rule requires, and it is
what makes R5 checkable: it names the format and the surface, and it is distinguishable by `code`
from the `INVALID_REF` and `NOT_A_DIRECTORY` that §Observed failure measured. Its exact population depends on
DC-1 — under a read-only backend it covers every write surface; under read-write it covers only
what remains unimplemented (and under DC-1(a) it may cover nothing, in which case the code is not
added).

`INVALID_REFTABLE` mirrors `INVALID_PACKED_REFS` and the `MidxCheck` pattern from the midx design:
a `ReftableCheck` union naming the failed check (`magic`, `version`, `footerCrc`, `truncated`,
`blockType`, `restartCount`, `recordOverrun`, `varintOverflow`, `tablesList`) plus a reason
string. Following `packed-refs.ts`, any echoed input is truncated (80 chars) so repository content
never lands whole in a message. Whether it is *thrown* or degraded past is DC-4.

### 5. Genericity and symmetry checks

**Width genericity.** Every width-dependent quantity — header length (24/28), footer length
(68/72), first restart offset (28/32), digest length (20/32), and the size of every `0x1`/`0x2`
value and `log_data` oid pair — derives from the parsed `version` and `hashId`. No literal `20`,
`40`, `24` or `68` appears outside the header/footer decoder. The v2 fixture in §1.7 is a real
`--object-format=sha256` repository, so this is exercised, not asserted. A sibling design is
adding SHA-256 object support concurrently; this parser must not need retrofitting when it lands,
and it must not *depend* on it either — parsing a v2 header is independent of being able to read
v2 objects.

**Read-path / write-path symmetry.** Deliberately asymmetric, and DC-1 sets the degree.
`bootstrapRepository` writes `repositoryformatversion = 0` and no `[extensions]`, so tsgit cannot
create a repository that trips its own backend (R10) — an interop row asserts this in both
directions. Under DC-1(a) the asymmetry is total (read yes, write refuse) and there is **no
serializer**, which removes the round-trip property lens (§Test strategy) and every byte-identity
obligation. Under DC-1(b)/(c) the write side owes byte-identity with `git`'s own writer, which is
a materially larger contract: block sizing, restart-point selection, index emission thresholds,
and obj-block abbreviation length are all writer choices the format permits to vary, so
"byte-identical to git" needs its own pinned matrix that this design does not yet contain.

**Read-path / read-path symmetry.** The trap is §3.1's six enumerators. Converting `RefStore`
and `enumerate-refs` while leaving `branchList` and `tagList` on their own `readdir` produces a
repository where `resolveRef` and `enumerateRefs` are right and `branch.list()` / `tag.list()`
are silently empty — the §Observed failure defect, narrowed but not closed. R2/R3 are only met if all six
converge on one enumeration, which is why DC-2 is scored on how many of them each option forces
through the seam.

**Faithfulness is pinned on data, not display.** Per ADR-249 nothing here returns a rendered
line. The interop tests reconstruct `git show-ref` / `git for-each-ref` / `git reflog --date=raw`
output *in the test* from structured fields and compare to real git.

## Decision candidates

| # | Choice | Alternatives (≤3) | Recommendation | Why |
|---|---|---|---|---|
| **DC-1** | **Scope of the reftable backend.** The single most consequential decision; it sizes every other row. | **(a) Read-only + precise write refusal** — parse the stack, answer every read surface, refuse every write with `UNSUPPORTED_REF_STORAGE` *before* mutating. **(b) Read + write** — add the transaction protocol (`tables.list.lock`, temp table, rename, list swap). **(c) Read + write + compaction** — plus geometric auto-compaction and stale-file cleanup. | **(a)** | ADR-667 requires only that acceptance not be a lie, and (a) discharges it fully: R1–R5 and R7–R9 are met, and **R6 is met by refusal**, which closes the measured write-then-diverge defect — the most dangerous thing in §Observed failure — at a fraction of (b)'s cost. Honest sizes: (a) is a parser + a stack reader + a refusal, with **no serializer, no lock protocol, no byte-identity obligation, and no adapter-atomicity question** (§3.4); every reftable config knob git has is a writer knob (§1.9), so (a) consumes none. (b) adds a writer that must be byte-compatible with git's — block sizing, restart selection, index thresholds and obj abbreviation are all writer-variable, so (b) owes a second pinned matrix this design does not contain, plus a lock protocol whose atomicity assumption the browser adapter does not satisfy. (c) adds a compaction policy whose only purpose is a perf property (stack depth) that git already maintains at 1–2 (§1.9) and that no tsgit correctness requirement needs. The cost of (a) is honest and bounded: a reftable repository is readable but not writable by tsgit, and users are told so precisely. |
| **DC-2** | **How `RefStore` generalises.** §3.1 shows 2 of 6 methods are meaningless under reftable and 6 independent enumerators sit outside the seam. | **(a) Narrow `RefStore` to a backend-neutral interface** — `resolveDirect`, `listRefs`, `readReflog`, `writeRef`, `deleteRef`; push `isLoose`/`readLooseRaw`/`getPackedRefs` behind a `FilesRefStore` sub-interface the two files-only callers (`refs-verify`, `remote.moveTrackingRef`) narrow to. **(b) Two interfaces + discriminated union** — `{kind:'files'|'reftable'}`, callers switch. **(c) A port in `src/ports/`** — `RefBackend` alongside `FileSystem`, adapters supply it. | **(a)** | (a) keeps one interface and one call site to swap (`createRefStore`), and it makes the neutral surface honest: `listRefs` replaces `getPackedRefs` for all three of its callers, who each want "every ref" anyway. It forces the six enumerators through the seam — `enumerate-refs`, `branchList`, `tagList`, `fetch.collectRefTips`, `fetch.prune`, `listReflogs` — which is exactly what R2/R3 require, and the narrowing is a refactor the files backend benefits from independently (`branchList`'s single-level `readdir` is a latent bug for `refs/heads/feat/x` today, backend or no backend). (b) spreads a `switch` across ~20 call sites and re-admits the files vocabulary everywhere. (c) is the wrong layer: a ref backend is an application-tier policy over `FileSystem`, not a platform capability — putting it in `ports/` would force all three adapters to implement it and contradict the `Context`-derived-cache pattern `read-object` and `ref-store` already share. **This row is worth deciding jointly with DC-1**: under DC-1(a) the neutral interface's write half is a single refusal, which makes (a) markedly cheaper than it looks. |
| **DC-3** | **How the backend reaches `Context`.** The gate's Stage-2 read already has the value; `Context` has no slot for it. | **(a) A `refStorage: 'files' \| 'reftable'` field on `RepositoryLayout`**, populated at discovery next to `bare`/`workTreeConfigBogus`. **(b) An optional `Context.refBackend` capability**, populated by `openRepository` like `promisor`/`worktreeFs`. **(c) `getRefStore` re-reads the config itself** on first use, memoised per `Context`. | **(a)** | Ref format is a property of the repository's on-disk layout, which is exactly what `RepositoryLayout` models, and discovery already reads the config scope that carries it — so (a) adds a field to a frozen struct and no new I/O. (b) makes the backend an *optional* capability, which invites the absent case to mean "files" by default and silently reintroduces the misread on any path that builds a `Context` without the facade — the memory and browser adapters build contexts directly. (c) duplicates the gate's read, risks the two disagreeing, and violates the brief's instruction not to redesign the Stage-2 read. Note (a) requires the field to be populated by **every** `Context` constructor including `createMemoryContext`/`createBrowserContext`, defaulting to `'files'` explicitly rather than by omission. |
| **DC-4** | **Behaviour on a corrupt reftable stack.** §1.10: git reports an **empty ref space** (rc 0) and its own `fsck` **crashes with a segmentation fault**. | **(a) Refuse precisely** — throw `INVALID_REFTABLE` naming the failed check; a documented, ADR-worthy divergence from git. **(b) Replicate git** — degrade to an empty ref space silently. **(c) Split by tier** — refuse on structural faults (bad magic, bad version, CRC mismatch, truncation), degrade to empty on a missing/absent `tables.list` (which git itself treats differently — rc 0, no signal 11). | **(c)** | (b) is faithful in the letter and indefensible in the spirit: silent-empty on a populated repository is the *exact* hazard ADR-667 was ratified to close, and replicating it would close the hole for healthy reftable repos while re-opening it for damaged ones. It also has no defensible target — the only loud signal git gives is a segmentation fault, which is a bug, not a behaviour to be faithful to. (a) is safe but over-refuses the one case git is legitimately right about: a missing `tables.list` genuinely *is* an empty stack, and §1.10 shows git distinguishes it (fsck rc 0, no signal). (c) tracks that distinction — it is faithful where git is coherent and refuses where git crashes — and it maps onto the two-tier precedent already ratified for the midx in [ADR-593](../adr/593-midx-corruption-replicates-gits-two-tiers.md). **This needs an ADR either way**, since (a) and (c) both diverge from measured git behaviour. |
| **DC-5** | **Which adapters get reftable.** | **(a) All three** — reads use only portable `FileSystem` calls. **(b) Node-only**, memory/browser refuse with `UNSUPPORTED_REF_STORAGE`. **(c) All three for reads, Node-only for writes.** | **(a)**, conditional on DC-1(a) | Reftable *reading* needs `stat`, `read`/`readSlice`, `readdir`, `readUtf8` and inflate — all present on all three adapters, and `ctx.compressor` already supplies zlib everywhere. Under DC-1(a) there is no write path, so the browser's non-atomic `rename` (§3.4) never matters and (a) is free. Under DC-1(b)/(c) this must become **(c)**: the transaction protocol assumes an atomic rename that `BrowserFileSystem` does not provide. So DC-5 collapses into DC-1 — decide DC-1 first and DC-5 follows mechanically. |
| **DC-6** | **Reflog routing.** Reftable stores reflogs inside the stack; `reflog-store.ts`'s six exports all build `<gitDir>/logs/<ref>`. | **(a) Route reflog reads through the same backend seam** — `readReflog`/`listReflogs` become backend methods. **(b) A separate `ReflogStore` seam** parallel to `RefStore`. **(c) Leave `reflog-store.ts` files-only** and refuse reflog surfaces on reftable. | **(a)** | In reftable, refs and reflogs are the same file and the same transaction — splitting them into two seams (b) models the files backend's accident, not the domain, and would need two loads of the same stack. (c) fails R8 and leaves `listReflogs`/`readReflog` in their measured silently-empty state, which is the defect. (a) costs the two read methods on the neutral interface of DC-2. Caveat the user should weigh: `stash-ref.dropStashEntry` rewrites a reflog **whole-file** via `writeReflog`, which reftable expresses as a `log_type = 0x0` tombstone — under DC-1(a) that is a refusal and costs nothing, under DC-1(b) it is the hardest single write in the port. |
| **DC-7** | **Does `git refs migrate` become a tsgit surface?** §1.12 measures it converting in place and rewriting the config. | **(a) No** — out of scope entirely. **(b) Read-side only** — expose nothing, but let a caller who migrates with real git have tsgit pick up the change. **(c) Implement `refs migrate`.** | **(a)/(b)** | (b) is (a) plus a documentation sentence — it falls out for free because backend selection is per-`Context` and re-reading the config picks up a migrated repository. (c) is a write surface strictly larger than DC-1(b) (it is a full stack writer *plus* a files writer *plus* a config rewrite) and nothing in ADR-667 asks for it. Surfaced because it is the natural user escape hatch under DC-1(a): "tsgit cannot write your reftable repo — run `git refs migrate --ref-format=files`" is a precise, actionable refusal message, and the user may want that string blessed. |
| **DC-8** | **Where the parser lives.** | **(a) `src/domain/refs/reftable/`** — with the other ref codecs. **(b) `src/domain/storage/`** — with the other binary parsers (`pack-index`, `rev-index`). **(c) `src/domain/reftable/`** — its own top-level domain area. | **(a)** | The existing split is by *subject* (`refs/` holds `packed-refs.ts` and `loose-ref.ts`), not by *encoding*; `storage/` is the object-store's area and a reftable holds no objects. A sub-directory keeps the ~5 files from swamping `refs/`, and the barrel `src/domain/refs/index.ts` re-exports as it already does for the packed-refs codec. Low-stakes, but it determines the barrel and the 100%-coverage boundary, so it should be decided rather than drifted into. |
| **DC-9** | **Stack load granularity.** §1.9 measures stack depth 1–2 with aggressive auto-compaction; the largest single table measured was 97803 bytes for 3001 refs. | **(a) Parse whole tables eagerly** on first stack load, memoised per `Context`. **(b) Lazy block reads** via `readSlice` + the ref index, mmap-style. **(c) Eager header/footer + lazy blocks.** | **(a)** | At depth 1–2 and ~100 KB for 3000 refs, (a) is a couple of whole-file reads — cheaper than today's `packed-refs` parse on the 41-entry control fixture, and far cheaper than the loose-ref directory walk it replaces. (b) is the format's design intent and the right end state for a 866k-ref repository, but it is a perf optimisation with no correctness content, and CLAUDE.md's zero-copy `DataView` priority is satisfied by (a) too — the whole file is read once and parsed in place without copying. (c) is a reasonable middle if a bench shows (a) hurting cold-open. Recommend (a) now with the index-driven path noted as a follow-up **only if a bench justifies it** — and per the repo's standing rule, no follow-up is filed unless the user asks. |

## Test strategy

**Unit — the parser** (`src/domain/refs/reftable/*.test.ts`; domain is 100 %-coverage gated,
Stryker mutates it).

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
  `tz_offset` rows** (§1.6) — the single most important unit table in the suite, because it is
  the one place the shipped spec would mislead an implementer.
- Index/obj records: `block_position` absolute, `cnt_3` 1–7, `cnt_3 == 0` → `cnt_large`, the
  `cnt_3 == 0 && cnt_large == 0` scan-all case, and `position_delta` accumulation.
- Stack merge: newest-table-wins, and tombstone-beats-older-live — the §1.4 two-table fixture.
- **R12 — the shapes git's writer never emits (§1.11).** These need *hand-crafted* byte fixtures,
  because no `git` invocation produces them: a `block_size = 0` unaligned file with two ref blocks
  and a mandatory ref index; a log-only file whose first log block starts at byte 24 with no ref
  section; and a two-level ref index where the first-level `block_position` targets another `'i'`
  block. Built by a `reftable-fixture-helpers.ts` writer used **only by tests** — the same pattern
  as `midx-fixture-helpers.ts`, and explicitly not a production serializer (it does not make DC-1
  lens-1 applicable, since it is not the code under test).

**Property tests — an honest four-lens verdict.** Under **DC-1(a) there is no serializer, so
lens 1 (round-trip) does not apply** — there is no `serialize` half to round-trip against, and
inventing one purely to test the parser would be a tautology (lens-4's explicit anti-pattern).
What *does* apply regardless of DC-1:

- **Lens 3 (total function over an algebraic grammar)** — fits. `parseReftable` over a declared
  safe subset (well-formed header + footer + arbitrary block payload) must never throw anything
  other than `INVALID_REFTABLE`, and must never hang or read out of bounds. This is the valuable
  property: a reftable is untrusted input from a remote-cloned repository, and "no crash, only a
  typed refusal" is exactly the invariant worth generating for. Ship
  `reftable-format.properties.test.ts` with a `numRuns` of 50 (filter-heavy negative property),
  generators in a sibling `arbitraries.ts`.
- **Lens 2 (compositional aggregator)** — fits the stack merge. Invariants without re-implementing
  the loop: an empty stack yields no names; appending a table containing a live record for `X`
  makes `lookup(X)` defined; appending a table containing a tombstone for `X` makes it
  `undefined`; appending the live record again flips it back. This is the negation-flip shape
  lens 2 names.
- **Lens 1 and lens 4** — do not apply under DC-1(a). **If DC-1 is decided as (b) or (c), lens 1
  becomes a textbook fit** (`parseReftable(serializeReftable(x)) ≡ x`, modulo writer-choice
  canonicalisation) at `numRuns` 200, and this section must be revised. Flagged rather than
  silently omitted.

**Interop** — `test/integration/reftable-ref-storage-interop.test.ts`, twin git/tsgit rows over
real `git init --ref-format=reftable` repositories. **One shared `beforeAll` fixture with a
60 000 ms timeout**, per the repo's git-spawning-suite convention; every row builds its tsgit
`Context` *after* the last `git` subprocess has written, so no memoised stack predates the
mutation under test. Environment scrubbed via the existing `runGitEnv` helper (`GIT_*` cleared,
isolated `HOME`, signing off) — `-C` does not override `GIT_DIR`.

Rows, each reconstructing git's output from tsgit's structured fields:

| # | fixture | asserts |
|---|---|---|
| 1 | 5-ref fixture of §1.4 | tsgit's ref set ≡ `git show-ref`; and ≡ `git for-each-ref` including the `commit`/`tag` type column |
| 2 | annotated tag | peeled value ≡ `git for-each-ref '%(objectname) %(*objectname)'` |
| 3 | symbolic ref `refs/heads/symbolic` | resolves through the chain as `git rev-parse` does |
| 4 | `HEAD` | ≡ `git symbolic-ref HEAD`; and the `.invalid` stub never surfaces (R4) |
| 5 | tombstone across two tables | the deleted ref is absent from both tools (R3) |
| 6 | reflog fixture | entries, order, oids, identity and message ≡ `git reflog show --date=raw`, **for each of the six tz offsets** (R8, S1) |
| 7 | `--object-format=sha256` reftable | v2 header parsed; ref set ≡ git's (R7) |
| 8 | 3001-ref fixture | ref index + obj block exercised; ref set ≡ git's |
| 9 | linked worktree | shared vs per-worktree scoping ≡ git's, from both stacks (R9) |
| 10 | the seven §1.10 damaged fixtures | tsgit's tier matches whatever DC-4 ratifies — **and tsgit never crashes or hangs** |
| 11 | write attempt (DC-1(a)) | `UNSUPPORTED_REF_STORAGE`, **and the repository is byte-identical afterwards** — `.git/refs`, `.git/logs` and `.git/reftable` unchanged; this is the R6 regression pin for §Observed failure |
| 12 | tsgit-created repo | `repositoryformatversion = 0`, no `[extensions]`, git opens it (R10) |

Row 11 is the one that must not be dropped: it is the direct regression test for the measured
write-then-diverge defect, and it is meaningful under every DC-1 option (under (b)/(c) it becomes
"the write lands and `git for-each-ref` sees it").

**Parity** — `test/parity/` proves cross-adapter agreement only, never faithfulness. A reftable
fixture materialised into the memory adapter, asserting node ≡ memory ≡ browser for the read
surfaces, scoped to whatever DC-5 ratifies.

**Public-surface gates.** New public exports require a regenerated `reports/api.json` committed
in the same change (pre-push gate). `docs/use/errors.md` gains `UNSUPPORTED_REF_STORAGE` and
`INVALID_REFTABLE` with their payload fields and a catch example. If the parser types are
exported, `src/domain/refs/index.ts` re-exports them and `src/public-types.ts` is updated. A new
Tier-1 command is **not** added, so the barrel/facade/`repository.test`/browser-scenario/README
gates for new commands do not fire — the change is entirely behind existing surfaces plus two
error codes.

## Out of scope

- **SHA-256 object format** — a sibling design (`docs/design/sha256-object-format.md`) being
  written concurrently. This design assumes width-genericity is **required** (R7) and parses v2
  reftable headers, but designs none of the object-side hash work and does not depend on it
  landing.
- **The acceptance gate itself** — `docs/design/repository-format-acceptance-gate.md`, ADR-666,
  ADR-668. This design consumes the Stage-2 `extensions.refStorage` read; it does not modify it.
- **The ownership/trust gate** — `docs/design/ownership-trust-gate.md`, ADRs 669–679. Orthogonal
  tier, same ticket.
- **`git refs migrate`** — DC-7 recommends leaving it out; the escape-hatch wording is in scope,
  the command is not.
- **Reftable *writing*** — conditional on DC-1. Under the recommended (a) it is out of scope and
  every write surface refuses; under (b)/(c) it enters, and this design owes a second pinned
  matrix for writer byte-identity (§5) before it can be planned.
- **Compaction and stale-file cleanup** — writer concerns; out under DC-1(a)/(b).
- **Block-level lazy reads** — DC-9(b); a perf optimisation with no correctness content, and
  deferred unless a bench justifies it.
- **Transport** — §1.12 pins that ref storage never crosses the wire, so `clone`/`fetch`/`push`
  negotiation is untouched.
