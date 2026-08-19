# Design — SHA-256 object format

> Brief: make tsgit actually read (and, subject to D2, write) a repository whose
> `extensions.objectFormat = sha256`. [ADR-667] ratified that tsgit accepts **every**
> `extensions.*` git knows — no divergence at the acceptance gate — and expanded scope so that
> acceptance is not a lie. The defect is larger than reported: measurement (Context) finds
> **seven** distinct outcomes rather than one `OBJECT_HASH_MISMATCH`, including a raw `TypeError`
> that escapes the error union, a `revParse` that succeeds on a repository the library cannot
> read, and — reachable today on the current public surface, with no new option —
> `openRepository({ algorithm: 'sha256' })` writing a **corrupt `.git/index`** that `status`
> then reports without error as a truncated 40-hex oid.
> Status: draft → self-reviewed ×3 → awaiting the decision-candidate conversation

## Context

### Why this exists

[ADR-667] considered three ways to handle the five `extensions.*` names tsgit does not
implement. The sibling design recommended a strict allowlist that would have **refused**
`objectFormat`. The user ratified the opposite — mirror git's known set exactly — and paid for
it by expanding scope:

> `objectFormat` — real SHA-256 repository support is built (see the SHA-256 design and its
> ADRs).
>
> **The standing rule:** where tsgit cannot yet act on an accepted extension, it refuses
> *precisely, at the point of use* — never by silently reading the repository wrong, and never
> by refusing to open a repository git opens.

This document is that build. It is not a backlog entry: [docs/BACKLOG.md] **29.1** scoped only
the acceptance gate and explicitly assumed `objectFormat` would be refused
("decide the accepted-extensions set (`worktreeConfig` yes; `objectFormat`/`refStorage` refuse
until implemented)"). ADR-667 supersedes that clause.

### What exists today — the substrate is far stronger than the defect suggests

The vocabulary, the port and the adapters are **already SHA-256-capable**, and so is every
consumer that consults `ctx.hashConfig`. The gap is a band in the middle plus a tail of sites
that never consult it at all (§2).

**Tier 1 — the domain vocabulary: done.**
`src/domain/objects/hash-config.ts` (14 lines, the whole file):

```ts
export interface HashConfig {
  readonly digestLength: 20 | 32;
  readonly hexLength: 40 | 64;
}
export const SHA1_CONFIG: HashConfig = Object.freeze({ digestLength: 20, hexLength: 40 });
export const SHA256_CONFIG: HashConfig = Object.freeze({ digestLength: 32, hexLength: 64 });
```

`ObjectId.from` (`src/domain/objects/object-id.ts`) already accepts **either** 40 or 64
lower-case hex; `ObjectId.fromRaw` accepts **either** 20 or 32 bytes. The brand asserts
"well-formed git oid", never "well-formed oid *for this repository*" — §6 returns to that.

**Tier 2 — the port: done.** `src/ports/hash-service.ts` already declares
`readonly algorithm: 'sha1' | 'sha256'` and `readonly digestLength: 20 | 32`.

**Tier 3 — the adapters: done, all three, for real.** Every `HashService` implementation
already computes SHA-256, and every constructor is `(algorithm: 'sha1' | 'sha256' = 'sha1')`:

| adapter | mechanism | verdict |
|---|---|---|
| `src/adapters/node/node-hash-service.ts:16,22` | `createHash(this.algorithm)` — the port's union is `node:crypto`'s own spelling, so there is no branch at all | real |
| `src/adapters/memory/memory-hash-service.ts:24` | `SUBTLE_ALGO` table → `subtle.digest('SHA-256', …)` | real |
| `src/adapters/browser/browser-hash-service.ts:11,16,56` | ternary → `'SHA-256'` | real |

**Tier 4 — the consumers that *ask*: done.** All 24 read sites of `ctx.hashConfig` are already
width-driven; not one of them hard-codes 20 or 40. Representative:

| site | use |
|---|---|
| `src/application/primitives/internal/serialize-and-hash.ts:19` | `serializeObject(object, ctx.hashConfig)` |
| `src/application/primitives/read-index.ts:40` | `const trailerSize = ctx.hashConfig.digestLength` |
| `src/application/primitives/pack-registry.ts:311,364` | idx stride, pack trailer offset |
| `src/application/primitives/internal/midx-source.ts:344` | midx oid stride |
| `src/application/primitives/object-resolver.ts:62,96,417,440` | `emptyTreeOid`, `parseObject`, `parsePackEntryHeader`, `serializeObject` |
| `src/application/primitives/create-commit.ts:38` | `assertWellFormedParents(parents, ctx.hashConfig.hexLength)` |
| `src/application/primitives/shallow-file.ts:54,78` | shallow line width |
| `src/application/primitives/internal/bitmap-container.ts:98`, `…/fsck/bitmap-health.ts:20`, `…/fsck/rev-index-health.ts:21` | bitmap / `.rev` trailer widths |

`emptyTreeOid` (`src/application/primitives/object-resolver.ts:40-47`) even carries the correct
SHA-256 constant already — `6ef19b41225c5369f1c104d45d8d85efa9b057b53b14b4b9b939dd74decc5321`,
independently re-derived in §1c below.

**The counterweight**, and the reason "done" above is scoped to *consumers that ask*: 46 sites
never ask (§2a). `resolve-oid-prefix.ts` re-declares the widths as regex literals; ten commands
test `/^[0-9a-f]{40}$/` directly; `index-parser.ts` declares itself SHA-1-only in a doc comment;
`push.ts:115` shadows the domain `ZERO_OID` with its own 40-zero literal.

**Two entries already select the algorithm correctly.** `src/adapters/memory/memory-adapter.ts:41,51-52,64`
and `src/index.default.ts:38-43,50,83,88` take `algorithm?: 'sha1' | 'sha256'`, construct
`new MemoryHashService(algorithm)`, and set
`hashConfig: algorithm === 'sha256' ? SHA256_CONFIG : SHA1_CONFIG`. That is the wiring precedent
every candidate in D1 is measured against — but a correct `hashConfig` is necessary, not
sufficient: even today's `openRepository({ algorithm: 'sha256' })` on the memory entry would
write a mis-framed `.git/index` and a mis-framed `.idx` (§3b), which is why this design is a
sweep and not a wiring change.

### The gap, precisely

1. **Four wiring sites pin SHA-1** — `src/index.node.ts:19,93,109`,
   `src/index.browser.ts:12,79,84`, `src/adapters/node/node-adapter.ts:3,55,73`,
   `src/adapters/browser/browser-adapter.ts:2,34,44`. Each constructs the hash service with no
   argument (taking the `= 'sha1'` default) and pairs it with a literal `SHA1_CONFIG`.

2. **Nothing reads `extensions.objectFormat`.** `RepositoryFormat`
   (`src/repository/read-repository-format.ts:14-18`) has exactly three fields —
   `bare`, `worktree`, `worktreeConfig` — and `finishLayout`
   (`src/repository/resolve-layout.ts:190-220`) **consumes `fmt` and discards it**: every field
   is folded into `bare` / `workDir` / `workTreeConfigBogus`, and the returned
   `RepositoryLayoutInput` has no slot for anything else. There is no channel from config to
   `hashConfig`.

3. **`hashConfig` is an unreconciled pass-through.** `src/repository.ts:470` is the *only*
   consumer of `fallback.hashConfig` (`hashConfig: fallback.hashConfig`), while `hash` goes
   through `composeAdapters` (`src/repository/compose-adapters.ts:53`,
   `hash: overrides.hash ?? fallback.hash`) whose `AdapterFallback` does not even carry
   `hashConfig`. `createContext` (`src/ports/context.ts:194-197`) is a bare spread + freeze with
   zero validation. Consequence, **today, before this change**:
   `openRepository({ hash: new NodeHashService('sha256') })` on the Node entry yields
   `ctx.hash.algorithm === 'sha256'` paired with `ctx.hashConfig === SHA1_CONFIG`, and nothing
   refuses it. `serialize-and-hash.ts:19-20` uses both in consecutive lines.

4. **`HashConfig` carries sizes but not identity.** There is no `algorithm` field on
   `HashConfig`, so nothing can cross-check it against `HashService.algorithm`; consumers that
   need identity do `hash.digestLength === 32` (`object-resolver.ts:45`).

5. **46 residual hard-coded widths** in the domain and application tiers — §2 — clustered in the
   git index, pack `.idx`, the reflog, the ten command-level `/^[0-9a-f]{40}$/` fast paths,
   prefix resolution, fsck's tree validator, tar's PAX record, and `ZERO_OID`.

6. **Transport claims sha1 unconditionally on v2, and does not look at all on v0** — §3c. This
   is a *pre-existing* silent misread, one protocol layer below the one [ADR-667] named.

### Observed failure — measured on this branch, and it is worse than reported

[ADR-667] and `repository-format-acceptance-gate.md` both state the defect as a single row:
tsgit opens a SHA-256 repository and "throws `OBJECT_HASH_MISMATCH` on the first object read".
Driving the real entry points against real `git init --object-format=sha256` fixtures shows
**seven** distinct outcomes, of which `OBJECT_HASH_MISMATCH` is one:

| fixture | call | tsgit today |
|---|---|---|
| loose (unpacked) sha256 repo | `log` | `OBJECT_HASH_MISMATCH { expected: <64 hex>, actual: <40 hex> }` — the reported row |
| loose sha256 repo | `catFile({ object: 'HEAD' })` | **a raw `TypeError`** — `Cannot read properties of undefined (reading 'map')`. Not a `TsgitError`, not in the error union, not documented: the error contract is breached entirely |
| loose sha256 repo | `status` | `INVALID_INDEX_HEADER { reason: 'index trailer checksum mismatch' }` — a *third* diagnosis for one cause |
| packed sha256 repo | `log` | `OBJECT_NOT_FOUND { id: <64 hex> }` — the pack `.idx` fails its size check at 20-byte strides, so the object is reported **absent** rather than unreadable |
| packed sha256 repo | `revParse('HEAD')` | **succeeds**, returning the correct 64-hex oid from a repository the library cannot read |
| memory entry, `openRepository({ algorithm: 'sha256' })` | `add` | writes a **corrupt `.git/index`**: the 32-byte oid is written at the right offset, then the 2-byte flags at `offset + 60` and the name at `offset + 62` are written **on top of it**. Measured bytes — oid `2cf8…f3a1` `0005` `612e747874` (`a.txt`) `576db9ebb4`, where the real blob is `2cf8d83d9ee29543b34a87727421fdecb7e3f3a183d337639025de576db9ebb4` |
| memory entry, same | `status` | **succeeds** and reports the index oid as `2cf8d83d9ee29543b34a87727421fdecb7e3f3a1` — a silently **truncated 40-hex** id. No error of any kind |

Three conclusions the single-row framing hides:

1. **The failure mode depends on where the object lives.** Loose ⇒ hash mismatch (the object is
   found and inflated, then SHA-1 disagrees with the 64-hex id). Packed ⇒ not-found (the `.idx`
   size arithmetic rejects the file first, §2a). A caller sees "corrupt" or "missing" for the
   same repository depending on whether it has been repacked.
2. **`revParse` succeeds.** `head-ref.ts:30`'s deliberately-unanchored regex (§2c) reads the
   64-hex id correctly, so the caller receives a genuine oid that every subsequent call rejects.
   That is worse than a refusal, and it is not in any existing report.
3. **`algorithm: 'sha256'` is a shipped public option that silently corrupts data.**
   `src/index.default.ts:42` documents it — *"Hash algorithm used by the runtime adapter.
   Default 'sha1'."* — and it wires `hashConfig` correctly (§Context). The corruption is
   entirely downstream, in `index-writer.ts`'s `ENTRY_HEADER_SIZE = 62` and `offset + 60`
   (§2a). So this is not only a missing capability; it is a **live data-integrity bug on the
   current public surface**, reachable today without any of this design's new options.

The mechanism behind rows 1-2 is `ObjectId.from`'s width-permissiveness: it accepts the 64-hex
id, the loose path splits `slice(0,2)`/`slice(2)` and is width-agnostic, so nothing refuses
until a width-sensitive step finally disagrees — and *which* step disagrees first decides which
error the caller is told. The permissive brand is what carries an unsupported repository deep
enough to be misdiagnosed (§6, D3).

### Binding constraints

- **Prime directive** ([ADR-226]): match canonical git's observable data and on-disk state.
  Every row in §1 is pinned against **git 2.55.0** in a `mktemp -d` throwaway with an isolated
  `HOME` and `XDG_CONFIG_HOME` under it, `GIT_CONFIG_NOSYSTEM=1`, every `GIT_*` scrubbed,
  signing off, fixed author/committer dates — never recalled. The throwaway is removed after
  measuring; nothing was written inside the worktree.
- **Structured output** ([ADR-249]): the library emits no rendered line. Abbreviation width in
  particular is a **caller** concern — §1f measures git's defaults for the interop
  reconstruction only, and no `abbrev` option enters any tsgit surface.
- **The acceptance gate is not this design's** — [ADR-666], [ADR-667], [ADR-668] and
  `design/repository-format-acceptance-gate.md` own it. This design consumes the value the gate
  already has to read and must not redesign the gate's tier, codes, or precedence.
- Existing decisions this must not contradict: [ADR-658] (the layout read surface is a facade
  field), [ADR-661] (the layout config read includes `config.worktree`), [ADR-664]
  (layout-config refusals surface at open time), [ADR-249].
- Branded types, no `any`, functions < 20 lines, no suppression directives. Coverage gates
  `src/domain` + `src/adapters` at 100 %; Stryker mutates all of `src`.

## Requirements

**R1.** A repository created by `git init --object-format=sha256` opens through
`openRepository` on every entry point that can read its config, and every read command
(`log`, `show`, `cat-file`, `status`, `diff`, `ls-tree`, `rev-parse`, `for-each-ref`) returns
the **same 64-hex object ids git returns**, byte-for-byte.

**R2.** The object-id algorithm is derived from `extensions.objectFormat` in
`<commonDir>/config`, honouring git's measured value grammar (§1b): `sha1` and `sha256` only,
**case-sensitive**, last-wins on duplicates, absent ⇒ `sha1`. An unrecognised value and a
valueless entry each refuse with git's own condition (§1b).

**R3.** `ctx.hash.algorithm` and `ctx.hashConfig` can never disagree. The two are reconciled at
one place, and a caller-supplied `opts.hash` that contradicts the repository's own format is
refused rather than silently mis-paired (§4, §6). This closes a hole that exists **today**,
independent of SHA-256.

**R4.** Every binary format tsgit reads or writes is correct at 32-byte oids (§1d, §3). The
formats already correct — `.rev`, `multi-pack-index`, `commit-graph`, `.bitmap`, the packfile
trailer, `packed-refs`, `shallow`, loose-object paths (§3a) — stay byte-identical and are not
edited. The formats to fix are pack `.idx` v2, the git index (`DIRC`), the reflog, and the tar
PAX comment record (§3b).

**R4a.** No file is framed by two readers with two widths. Specifically,
`read-index.ts`'s trailer view and `index-parser.ts`'s framing agree on one width for one
buffer — today they do not, and only the fact that both widths are 20 hides it (§2a).

**R5.** Every residual 40-hex / 20-byte assumption in `src/` is either generalised or proven
correctly fixed-width, with the classification recorded (§2). No site is left "probably fine".

**R6.** A SHA-1 repository is byte-for-byte unchanged by this work — same oids, same `.idx`,
same `.rev` hash id (`1`), same `packed-refs`, same index. The SHA-1 path is the regression
surface, not the feature surface.

**R7.** Transport refuses an algorithm mismatch at the point of use rather than misreading it,
reproducing git's two distinct conditions (§1e): fetch/clone
(`mismatched algorithms: client <A>; server <B>`) and push
(`the receiving end does not support this repository's hash algorithm`). tsgit's v2 client stops
claiming `object-format=sha1` unconditionally and sends its real algorithm (§3c). Whether the
**v0** `object-format` capability — today unread and unsent, so a v0 SHA-256 peer is silently
accepted — is plumbed in this change is **D8**; if it is not, the v0 gap becomes an explicit,
documented divergence rather than an oversight.

**R8.** `compatObjectFormat` is refused at the point of use, per [ADR-667]'s standing rule.
git itself refuses it on this build (§1g), so there is no behaviour to be faithful to.

**R9.** Write/read symmetry: anything tsgit writes into a SHA-256 repository is re-openable by
canonical git, and anything git writes is re-openable by tsgit — asserted in **both**
directions by interop, per format, not only per command.

**R10.** Whatever the write side's scope (D2), `bootstrapRepository` never emits a repository
it cannot itself reopen: either it keeps writing `repositoryformatversion = 0` with no
`[extensions]`, or it writes git's exact `[extensions] objectformat = sha256` +
`repositoryformatversion = 1` block (§1a) — never a half state.

**R11.** No SHA-256 path escapes the `TsgitError` union. `catFile` on a SHA-256 repository
currently throws a raw `TypeError` (Context) — an unhandled-shape bug that this change must not
merely relocate. Every refusal in this design is a typed code with a documented payload.

**R12.** The corruption reachable today through the shipped `algorithm: 'sha256'` option
(Context) is fixed, not merely superseded: after this change, `openRepository({ algorithm:
'sha256' })` on the memory entry writes an index git can read, or the option is removed. It
must not continue to silently corrupt.

**R13.** The three places two formats can meet without a network behave as git's do (§1h): a
**linked worktree** inherits the common config's format with no per-worktree branch; a
foreign-format **alternate** is *skipped with the object reported absent*, never fatal and never
`INVALID_PACK_INDEX`; a cross-format **submodule** is refused at add time in both directions.

## Design

### 1. Pinned matrix — canonical git 2.55.0

Probe conditions as stated in Binding constraints. `$T` is the throwaway root.

#### 1a. `git init --object-format=sha256` — the exact bytes

`.git/config`, `od -c`-verified — 173 bytes. Every indent below is one literal TAB, every line
ends LF, and there is no trailing blank line. The `[extensions]` block is written **before**
`[core]`, and the key is emitted lower-cased:

```ini
[extensions]
	objectformat = sha256
[core]
	repositoryformatversion = 1
	filemode = true
	bare = false
	logallrefupdates = true
	ignorecase = true
	precomposeunicode = true
```

Contrast, a default `git init` — 137 bytes, no `[extensions]` block at all:

```ini
[core]
	repositoryformatversion = 0
	filemode = true
	bare = false
	logallrefupdates = true
	ignorecase = true
	precomposeunicode = true
```

`git init --bare --object-format=sha256` is identical to the first but for `bare = true` and no
`logallrefupdates` line. `HEAD` is `ref: refs/heads/main` + LF — unchanged by the algorithm.

The ordering is load-bearing for R10: a writer that appends `[extensions]` after `[core]` would
produce a semantically identical but byte-different config, and this doc's write-side interop
row compares bytes.

| operation | verdict |
|---|---|
| `git init --object-format=sha256 <new>` | v1 + `[extensions] objectformat = sha256` (above) |
| `GIT_DEFAULT_HASH=sha256 git init` | same |
| `git -c init.defaultObjectFormat=sha256 init` | same |
| `git init` (no flag) re-run inside an existing sha256 repo | **succeeds**, format preserved as sha256 |
| `git init --object-format=sha1` inside an existing sha256 repo | `fatal: attempt to reinitialize repository with different hash`, exit **128**, config untouched |
| `git clone <sha256 repo> <new>` | the clone is **sha256** — the algorithm is adopted from the wire, and `clone` has **no** `--object-format` option in 2.55.0 (`error: unknown option 'object-format=…'`) |
| `git clone --depth 1 file://<sha256 repo>` | sha256 clone; `.git/shallow` holds a 64-hex line |
| `rev-parse --show-object-format` | `sha256`; `=input` / `=output` / `=storage` all `sha256` |

#### 1b. `extensions.objectFormat` value grammar

Fixture: `repositoryformatversion = 1`, one `[extensions] objectFormat = <v>` entry.

| value | verdict |
|---|---|
| `sha1` | accepted — repository is sha1 (an explicit, legal no-op) |
| `sha256` | accepted — repository is sha256 |
| `SHA256`, `Sha256` | `error: invalid value for 'extensions.objectformat': 'SHA256'` + `fatal: bad config line N in file <F>`, exit 128 — the value is **case-sensitive** (the *key* is lower-cased in the message) |
| `sha-256`, `sha256x` | same `invalid value` pair |
| the empty string (`objectFormat =`, nothing after the `=`) | same `invalid value` pair, reporting `''` — **not** the missing-value shape two rows down; `=`-with-nothing is an empty string, valueless is git NULL |
| `  sha256  ` (surrounding spaces) | accepted — the config tokeniser strips, the value grammar never sees them |
| valueless (`objectFormat`, no `=`) | `error: missing value for 'extensions.objectformat'` + `fatal: bad config line N in file <F>`, exit 128 — a **different** first line from the invalid-value case |
| `sha256` then `sha1`, in that order | **last-wins** ⇒ sha1 |
| `[extensions "x"] objectFormat = sha256` | `fatal: unknown repository extension found:<LF><TAB>x.objectformat<LF>` — a subsectioned known name is not known; this is the **acceptance gate's** refusal ([ADR-668]), not this design's |
| the key absent, at v1 | accepted ⇒ **sha1** |
| `objectFormat = sha256` at v0 | `fatal: repo version is 0, but v1-only extension found:<LF><TAB>objectFormat<LF>` — again the acceptance gate's ([ADR-668], §1c of the sibling design) |

So this design owns exactly two new refusal conditions on the config read — invalid value and
missing value — and both are **existing shapes**: `error: invalid value for '<key>': '<v>'` is
the shape `CONFIG_BAD_BOOLEAN_LITERAL` already reconstructs for `push.gpgsign`, and
`error: missing value for '<key>'` + `fatal: bad config line N in file <F>` is exactly
`CONFIG_MISSING_VALUE`. **D6** asks whether they are reused or given a code of their own.

#### 1c. Object ids — the header is unchanged, only the digest changes

A SHA-256 object id is the SHA-256 of the **same** `<type> <size>\0<payload>` byte string.
Confirmed, not assumed:

| payload | git `hash-object` (sha256) | `shasum -a 256` of the framed bytes |
|---|---|---|
| `hello\n` as a blob | `2cf8d83d9ee29543b34a87727421fdecb7e3f3a183d337639025de576db9ebb4` | `printf 'blob 6\0hello\n'` ⇒ **identical** |

The same payload under SHA-1 is `ce013625030ba8dba906f756967f9e9ca394464a`. So
`serializeObject` needs no change at all — only the digest function behind it.

**Empty-object constants**, pinned and independently re-derived:

| object | SHA-256 | derivation | SHA-1 (unchanged) |
|---|---|---|---|
| empty tree | `6ef19b41225c5369f1c104d45d8d85efa9b057b53b14b4b9b939dd74decc5321` | `sha256("tree 0\0")` | `4b825dc642cb6eb9a060e54bf8d69288fbee4904` |
| empty blob | `473a0f4c3be8a93681a267e3b1e9a7dcda1185436fe141f7749120a303721813` | `sha256("blob 0\0")` | `e69de29bb2d1d6434b8b29ae775ad8c2e48c5391` |

The empty-tree value already matches `EMPTY_TREE_OID_SHA256` in
`src/application/primitives/object-resolver.ts:41`. The **zero oid** is width-scaled: in a
SHA-256 repository `git update-ref --stdin` with a 40-zero `<old-oid>` dies
`fatal: update refs/heads/zz: invalid <old-oid>: 000…0` (40 zeros), and the 64-zero form
succeeds. Reflogs write 64 zeros for the create row.

#### 1d. On-disk formats — what changes and what does not

Measured on a 12-object repacked SHA-256 repository against its SHA-1 twin.

| format | version / magic | changes under sha256 | verified by |
|---|---|---|---|
| loose object path | — | `objects/<2 hex>/<62 hex>` (was 38) — a `slice(0,2)`/`slice(2)` split is already correct | `find .git/objects` |
| loose object body | — | **nothing** — same `<type> <size>\0` header, same zlib | §1c |
| pack `.idx` | magic bytes `ff 74 4f 63`, **version 2 — unchanged** | oid table stride 20→32; trailer 40→64 bytes (pack checksum + idx checksum). No new field, no version bump | size arithmetic: `8 + 1024 + 12·32 + 12·4 + 12·4 + 64 = 1576` = actual |
| `.pack` | `PACK`, version 2 | trailer checksum 20→32 bytes | last 32 bytes = the pack name |
| **`.rev`** | `RIDX`, version 1 | **a hash-identifier field changes value: `00 00 00 01` (sha1) → `00 00 00 02` (sha256)**; trailer 40→64 | header `52 49 44 58 00 00 00 01 00 00 00 02`; size `12 + 12·4 + 64 = 124` = actual |
| **`multi-pack-index`** | `MIDX`, version 1 | **hash-version byte `01` → `02`**; oid stride 20→32 | `4d 49 44 58 01 02 04 00` vs `4d 49 44 58 01 01 04 00` |
| **`commit-graph`** | `CGPH`, version 1 | **hash-version byte `01` → `02`**; oid stride 20→32 | `43 47 50 48 01 02 04 00` vs `43 47 50 48 01 01 04 00` |
| `.bitmap` | `BITM`, version 1 | **no** hash-id field; the trailing pack checksum widens 20→32 | `42 49 54 4d 00 01 00 05 …` identical prefix in both |
| `.git/index` | `DIRC`, **version 2 — unchanged** | entry oid 20→32 (the preceding **40 bytes of stat data are a fixed record offset, not a hash width**); trailer 20→32 | first entry's oid sits at byte 52 = 12 + 40 |
| `packed-refs` | text | header line `# pack-refs with: peeled fully-peeled sorted` **unchanged**; oids 40→64 hex; `^peeled` lines likewise | `od -c .git/packed-refs` |
| reflog | text | zero oid 40→64 zeros | `od -c .git/logs/HEAD` |
| `shallow` | text | 64-hex lines | §1a |
| **bundle** | **`# v2 git bundle` → `# v3 git bundle`** | a **new capability line** `@object-format=sha256\n` follows the signature; then the same `<oid> <ref>` body at 64 hex | `# v3 git bundle\n@object-format=sha256\ncf3d…` |

**Three of these are hash-identifier fields, not widths** (`.rev`, midx, commit-graph). A writer
that emits a hard-coded `1` produces a file git will reject or misread even when every width is
right — this is the single most likely silent-corruption bug in the change, and it is a
**write-path** bug, so read-only testing cannot catch it.

**Bundle is a format-version change, not a width change** — the only row here that needs new
parsing and new emission rather than a widened constant.

**Cross-format confusion is detected, but by luck, not by design.** Feeding a SHA-256 pack to a
SHA-1 repository gives `fatal: pack is corrupted (SHA1 mismatch)`; feeding a SHA-256 `.idx`
gives `error: wrong index v2 file size` (the size arithmetic disagrees). A 64-hex oid in a
SHA-1 repository gives `fatal: Not a valid object name`. Note the converse is **not** safe:
a 40-hex string in a SHA-256 repository is a perfectly valid **prefix** and resolves
(`rev-parse --verify <first 40 hex of a sha256 oid>` returns the full 64-hex id). So
"the string is 40 hex" can never be used to infer the algorithm.

#### 1e. Transport — two distinct mismatch refusals

git advertises the algorithm as a capability on **both** wire protocols, and both directions of
a mismatch are refused, with different messages depending on the verb.

| surface | measured |
|---|---|
| protocol v0 `upload-pack --advertise-refs` | capability list ends `… symref=HEAD:refs/heads/main object-format=sha256 agent=git/2.55.0-Darwin` (`object-format=sha1` on a sha1 repo) |
| protocol v0 `receive-pack --advertise-refs` | `report-status report-status-v2 delete-refs side-band-64k quiet atomic ofs-delta object-format=sha256 agent=…` |
| protocol v2 | `object-format=sha256` as its own capability pkt-line, in the server advertisement **and** echoed by the client in the command request |
| `git fetch` sha1 remote into a sha256 repo | `fatal: mismatched algorithms: client sha256; server sha1`, exit **128** |
| `git fetch` sha256 remote into a sha1 repo | `fatal: mismatched algorithms: client sha1; server sha256`, exit **128** |
| `git push` sha256 → sha1 bare | `fatal: the receiving end does not support this repository's hash algorithm` + `fatal: the remote end hung up unexpectedly`, exit **128** |
| `git push` sha256 → sha256 bare | succeeds |
| `git clone` of a sha256 remote | succeeds, **adopting** sha256; there is no `clone --object-format` in 2.55.0 |

Two conditions, two message shapes, selected by verb — the same split [ADR-654] and [ADR-668]
already establish as the reason to carry two codes rather than one. D4 asks the question.

The clone row is the interesting one for tsgit: git **learns** the algorithm from the
advertisement before it writes the destination config. A tsgit `clone` that hard-codes
`SHA1_CONFIG` in `bootstrapRepository` would write a sha1 repository and then fill it with
sha256 objects.

#### 1f. Abbreviation and prefix resolution

| query | sha256 | sha1 |
|---|---|---|
| `rev-parse --short HEAD` | `cf3dd5f` (7) | `cd73be0` (7) |
| `log --oneline` | 7 | 7 |
| minimum unambiguous prefix accepted by `rev-parse --verify` in a 12-object repo | 4 | 4 |
| a 40-hex prefix of a 64-hex oid | **resolves** to the full oid | n/a |
| 65 hex | `fatal: Needed a single revision` | n/a |

The default short width is `7` under both algorithms — git's `auto` floor is not algorithm-keyed
at this repository size. Per [ADR-249] tsgit ships no `abbrev` option and no `%h`; these rows
exist so the interop test can reconstruct git's display from tsgit's full oids, and so that the
**prefix-resolution** path (`src/application/primitives/resolve-oid-prefix.ts`) is generalised
against a measured ceiling of 64 rather than 40.

#### 1g. `compatObjectFormat` — refused by git itself

| fixture | measured |
|---|---|
| a sha256 repo + `extensions.compatObjectFormat = sha1`, then `log` / `rev-parse HEAD` | `fatal: compatibility hash algorithm support requires Rust`, exit 128 |

This confirms [ADR-667]'s note. There is no behaviour to replicate; the extension is accepted at
the gate and refused at the point of use (R8). D5 asks where "the point of use" is.

#### 1h. Where two formats meet inside one working tree

Three routes let a SHA-1 and a SHA-256 repository touch without a network, and git treats all
three differently. None of them is a transport row, so none is covered by §1e.

| route | measured |
|---|---|
| **linked worktree** of a SHA-256 repository | `git worktree add` succeeds; `rev-parse --show-object-format` from inside the worktree is `sha256`; the worktree's own `index` is `DIRC` v2 at 32-byte oids. The format is inherited from `<commonDir>/config` — the linked worktree's admin dir holds `commondir`, `gitdir`, `HEAD`, `index`, `logs`, `ORIG_HEAD`, `refs` and **no config**. This is the same `<commonDir>/config`-only scoping the acceptance gate measured (`repository-format-acceptance-gate.md` §1e); the two rules agree, so the format read needs no worktree-specific branch. |
| **alternates** naming a foreign-format object store (`objects/info/alternates`) | **not a refusal — a degradation.** `git cat-file -t <oid>` prints `error: wrong index v2 file size in <…>.idx` (repeated), then `fatal: Not a valid object name <oid>`, exit 128. In the SHA-256-repo-with-a-SHA-1-alternate direction it also prints `error: multi-pack-index hash version 1 does not match version 2` and `error: packfile <…>.pack index not opened`. So the foreign store is *skipped* with diagnostics and the object is simply not found. |
| **submodule** of a different algorithm | a hard refusal at add time: `error: cannot add a submodule of a different hash algorithm` + `error: unable to index file 'sub/'` + `fatal: adding files failed` + `fatal: Failed to add submodule 'sub'`, exit **128**, in **both** directions (sha1 super + sha256 sub, and the reverse). Note the clone *has already happened* when this fires — `.git/modules/sub` exists and is the submodule's own format — so git leaves a partial state, which is a faithfulness detail a tsgit implementation must reproduce rather than tidy. |

The alternates row is the load-bearing one and it **validates an existing tsgit decision**:
`error: multi-pack-index hash version 1 does not match version 2` is git cross-checking the
midx hash-version byte against the repository's own algorithm — exactly the policy
`src/domain/storage/midx.ts:98-104` already implements, and exactly the *opposite* of the `.rev`
reader's deliberate non-check (`rev-index.ts:75-79`). Both tsgit policies are confirmed
faithful, from a direction neither was originally measured from.

It also sets the shape for tsgit's own alternates handling: a foreign-format alternate must be
**skipped**, not fatal — an object store whose `.idx` fails its size check is unusable, not
corrupt, and the resulting error is `OBJECT_NOT_FOUND`, not `INVALID_PACK_INDEX`. That is the
one place in this design where "unsupported" correctly *does* surface as "absent".

### 2. The width sweep — every site, classified

`src/` was swept systematically for literal `20` / `32` / `40` / `64`, every `{40}` / `{64}` /
`{38}` / `{24}` regex, `repeat(40)`, `slice(0, 40)`, `length === 40`, `padEnd(40, …)`,
`digestLength`, `hexLength`, `sha1` / `sha256`, and every zero-oid and empty-object producer.
**186 sites** classified. Counts: **A must generalise 46 · B correctly SHA-1-only 7 ·
C already dual 72 · D not a hash width 61.**

The shape of the result matters more than the count: `src/domain/storage/` is *almost entirely*
already dual (`midx.ts`, `rev-index.ts`, `bitmap.ts`, `pack-entry.ts`) with two outliers, and
the application tier is dual almost everywhere. The A-sites cluster in seven places.

#### 2a. Class A — must generalise (46)

**The git index, `src/domain/git-index/` (8).** The module carries an explicit doc comment
(`index-parser.ts:16-24`) declaring itself "SHA-1-only, deliberately … as a whole", with the
correct reasoning that entry oid, trailer and cache-tree oid must widen *together*. That comment
is the specification for the change, and it must be rewritten rather than deleted.

| site | source | why |
|---|---|---|
| `index-parser.ts:25` | `const INDEX_OID_LENGTH = 20;` | entry oid width |
| `index-parser.ts:26` | `const INDEX_CHECKSUM_SIZE = INDEX_OID_LENGTH;` | file trailer |
| `index-parser.ts:27` | `const ENTRY_HEADER_SIZE = 62;` | `40 stat + 20 oid + 2 flags` ⇒ 74 |
| `index-parser.ts:28` | `const CACHE_TREE_OID_LENGTH = INDEX_OID_LENGTH;` | TREE-extension oid |
| `index-parser.ts:85`, `:143` | `view.getUint16(offset + 60)` | `60 = 40 + digestLength` ⇒ 72 |
| `index-writer.ts:17` | `const ENTRY_HEADER_SIZE = 62;` | write side of the framing |
| `index-writer.ts:110` | `view.setUint16(offset + 60, flagsRaw);` | write side of the flags offset |

**`index-writer.ts:102` — `buf.set(shaBytes, offset + 40)` — is class D, definitively.** The
ten preceding `setUint32` calls (`:90-99`: ctime, ctime-ns, mtime, mtime-ns, dev, ino, mode,
uid, gid, size) occupy exactly 40 bytes, and `shaBytes` comes from `hexToBytes(entry.id)`, which
self-sizes. That line is **already correct at both widths and must not be touched**; everything
*after* it is broken. §1d's byte-level measurement independently confirms it — the first
entry's oid sits at byte 52 of a SHA-256 index = 12 (header) + 40 (stat).

**A latent inconsistency this exposes.** `read-index.ts:40` already does
`const trailerSize = ctx.hashConfig.digestLength`, then hands the *full* buffer to
`parseIndex(bytes)` (`:54`), which re-frames it with its own 20. Under SHA-256 the two would
disagree by 12 bytes on `maxEntryBytes` (`:57`) and the extension end (`:183`). The trailer
*check* is width-aware; the *parse* is not. Two readers of one file with two widths is exactly
the read/read asymmetry §6 forbids.

**Pack `.idx` v2, `src/domain/storage/ (12)`** — the only non-dual members of an otherwise
generalised directory:

| site | source |
|---|---|
| `pack-index.ts:10` | `const IDX_SHA_LENGTH = 20;` (stride at `:46`, `:86`, `:175`) |
| `pack-index.ts:49` | `const trailerOffset = bytes.length - 40;` — `2 * digestLength` |
| `pack-index.ts:51-52` | `minExpectedSize` ends `+ 40` — the size sanity check is not width-aware |
| `pack-index.ts:185-186` | `if (prefix.length > 40)` and the message naming 40 |
| `pack-index.ts:192-193` | `prefix.padEnd(40, '0')` / `padEnd(40, 'f')` — the prefix range bounds |
| `pack-writer.ts:65,72,91,95,134` | `IDX_SHA_LENGTH = 20`; `:72` **rejects a valid 32-byte pack checksum** |

`parsePackIndex(bytes)` is **the only pack-artefact parser that takes no width parameter** —
`parsePackRevIndex(bytes, digestLength, objectCount)` and `parseMultiPackIndex(bytes, digestLength)`
both do. Adding one is a signature change at exactly one call site,
`src/application/primitives/pack-registry.ts:298`.

**Zero oid and empty-object constants, `src/domain/objects/object-id.ts` (1 + 1).**

- `:59` `ZERO_OID = ObjectId.from('0'.repeat(40))` — git's null oid is `hexsz` zeros (§1c
  measures the 40-zero form being **refused** in a SHA-256 repo). Highest fan-out in the sweep:
  `update-ref`, `reflog`, `push`, `fetch`, `branch`, `remote`, `tag`, `worktree`, `submodule`,
  `clone`, `stash-ref`, `fsck/roots`, `fsck/refs-verify`.
- `src/application/commands/push.ts:115` `const ZERO_OID = ObjectId.from('0'.repeat(40))` — a
  **local shadow** of the domain constant. Wrong width *and* duplicated; it must be deleted, not
  widened.
- `:65-66` `EMPTY_TREE_OID` is the SHA-1 value. Its only consumer already selects by width
  (`object-resolver.ts:45-46`), but the SHA-256 twin lives in `object-resolver.ts:41` — the pair
  is split across two tiers and should be co-located with a selector, the same treatment
  `ZERO_OID` needs.

**Command-level full-oid fast paths (10).** All the same idiom — "if it looks like a full oid,
take it verbatim; otherwise resolve as a ref" — spelled as a literal `/^[0-9a-f]{40}$/`:
`branch.ts:178`, `checkout.ts:63`, `checkout.ts:85`, `internal/commit-ish.ts:18`,
`reset.ts:175`, `rev-parse.ts:59`, `tag.ts:94`, `notes.ts:32` (`OID_RE`) and `:89`,
`push.ts:115`. Under SHA-256 a legitimate 64-hex oid fails the test and is routed to
`resolveRef`, producing a spurious ref-not-found. **`checkout.ts:85` is worse than the rest**:
`const detached = opts.detach === true || /^[0-9a-f]{40}$/.test(opts.rev)` means a raw SHA-256
oid is not recognised as detaching, so it is treated as a **branch name** and
`validateRefName('refs/heads/<64 hex>')` runs. These are the most mechanical of the A-sites:
`looksLikeObjectId` (`src/application/primitives/validators.ts:241`) already exists and is
already dual, so most become one call — but see D3 on why "already dual" is not the same as
"correct".

**Prefix resolution, `src/application/primitives/resolve-oid-prefix.ts` (3)** — the subtlest
failure in the sweep, because it returns `undefined` rather than throwing:

| site | source | effect at 64 hex |
|---|---|---|
| `:16` | `const FULL_OID = /^[0-9a-f]{40}$/;` | a full 64-hex oid falls through to the prefix scan |
| `:17` | `const OID_PREFIX = /^[0-9a-f]{4,39}$/;` | upper bound must be `hexLength - 1` = 63 |
| `:18` | `const LOOSE_NAME = /^[0-9a-f]{38}$/;` | the loose filename is `hexLength - 2` = **62**; abbreviated resolution silently finds nothing |

The lower bound stays 4 — §1f measures a 4-char prefix resolving under both algorithms.

**Reflog, `src/domain/reflog/reflog-format.ts:15` (1).** `const OID_LENGTH = 40` drives
`NEW_ID_START` (`:16`), `NEW_ID_END` (`:17`), `IDENTITY_START` (`:18`), the separator probe
(`:40`) and both `meta.slice` calls (`:43-44`) — fixed slice offsets, so they break together.

**fsck tree validation, `src/domain/fsck/validate-tree.ts:42,67` (2).** `SHA_LENGTH = 20` and
`shaEnd = nullIdx + 1 + SHA_LENGTH`; every entry after the first mis-frames. Its siblings
`validate-commit.ts` and `validate-tag.ts` are already dual — `validate-tree.ts` is the outlier
because it parses **binary** rather than hex.

**Archive PAX, `src/domain/archive/tar.ts:118,383` (2)** — a self-describing length that becomes
a lie:

```ts
const PAX_RECORD_SIZE = 52;                              // "52 comment=" (11) + 40 hex + "\n"
const record = `${PAX_RECORD_SIZE} comment=${oid}\n`;    // :383
```

At 64 hex the true length is `11 + 64 + 1 = 76`, so the emitted global header declares 52 and
carries 76 — a corrupt tar that `tar` and `git archive` will both reject. A **write-path**
corruption with no read-side symptom.

**Wire protocol, `src/domain/protocol/` (3)** — §3c.

**Bootstrap, `src/application/commands/internal/bootstrap.ts:8` (1).**
`readonly hash?: 'sha1'` — a single-valued option **nobody passes** (`init.ts:32` and
`clone.ts:94` both omit it). Dead today; the live parameter under D2(b).

**The four `SHA1_CONFIG` pins (4)** — `src/index.node.ts:109`, `src/index.browser.ts:84`,
`src/adapters/node/node-adapter.ts:73`, `src/adapters/browser/browser-adapter.ts:44`, each
paired with a no-argument hash-service constructor (Context).

#### 2b. Class B — correctly SHA-1-only (7), and why that is conditional

All seven are the **bundle v2** family plus one protocol default:
`src/domain/bundle/types.ts:4` (`BundleHashAlgorithm = 'sha1'`),
`parse-bundle-header.ts:14,16,38,46,59`, and
`src/domain/protocol/v2/capabilities.ts:5` (`DEFAULT_OBJECT_FORMAT = 'sha1'`).

"`# v2 git bundle` ⟹ SHA-1 oids" is a **genuine format invariant**, and §1d confirms git's side:
git will not write a v2 bundle in a SHA-256 repository, it writes v3 with
`@object-format=sha256`. tsgit refuses v3 outright, so these lines can never meet a SHA-256
bundle. They are correct **as long as v3 stays unsupported** — which is D7. The v2 protocol
default is correct too: an absent `object-format` capability means sha1 by spec. Its *reuse as
the only accepted value* is the class-A bug (§3c), not the default itself.

#### 2c. Class C and D — the load-bearing negatives

Class C (72) is dominated by `src/domain/storage/` (`midx.ts` 12 sites, `rev-index.ts` 12,
`bitmap.ts` 6, `pack-entry.ts` 2), `src/domain/objects/` (`tree.ts`, `tree-cursor.ts`,
`git-object.ts`, `encoding.ts`), and the shallow/create-commit/pack-registry/fetch-pack
application sites. Four spellings worth naming because they look like bugs and are not:

- `src/domain/repository/head-ref.ts:30` — `/^[0-9a-fA-F]{40}/`, **deliberately unanchored at
  the end** (comment at `:25-29`): git consumes a leading hex run and ignores the rest, and a
  64-hex id's first 40 characters are hex, so it passes. Dual.
- `src/domain/protocol/upload-pack.ts:20`, `v2/ls-refs.ts:10`, `application/commands/fetch.ts:329`
  — `/^[0-9a-f]{40}([0-9a-f]{24})?$/i`: the optional `{24}` extends 40 → 64. Dual, obscurely
  spelled. **Ref-advertisement parsing is therefore already width-agnostic**; the sha256
  refusal is a *policy* in `capabilities.ts`, not a parsing limit (§3c).
- `src/application/primitives/internal/parse-shallow.ts` — `SHALLOW_HEX_RE[hexLength]`, a table
  keyed by the `40 | 64` parameter. The cleanest parameterised parser in the codebase and the
  model for the rest.
- `src/application/commands/internal/fsck/refs-verify.ts:13`, `notes.ts:29`, `notes/load.ts:6`,
  `validators.ts:234-242`, `validate-commit.ts:29`, `validate-tag.ts:23` — explicit
  `{40}|{64}` alternations.

Class D (61) is the noise floor the sweep had to clear: the fixed **7-char abbreviation**
([ADR-169]: `merge-labels.ts:16,19`, `patch-serializer.ts:48,116`, `checkout.ts:76,143`,
`rebase.ts:153` — width-independent by decision); the **two-hex fanout** split
(`loose-path.ts:4`, `loose-oid-cache.ts:24-25`, `write-object.ts:37`, `enumerate-objects.ts:67-68`,
`notes/load.ts:7` — width-agnostic by construction); fixed struct sizes (`INDEX_HEADER_SIZE = 12`,
`MIDX_HEADER_SIZE = 12`, `REV_HEADER_SIZE = 12`, `IDX_SHA_TABLE_OFFSET = 1032 = 8 + 1024`);
ustar field widths and the tar blocking factor; EWAH/bitmap 32-bit lane geometry; 32-bit stat
and C-`int` truncations; buffer caps and concurrency bounds (`32`, `64 * 1024`, `64 MiB`); fsck
exit **bitmask** bits (`EXIT_MULTI_PACK_INDEX = 32`, `EXIT_PACK_REV_INDEX = 64`); the CGNAT
`100.64.0.0/10` test; pkt-line's 4-hex length prefix; and error-message truncation slices.

Two D-sites deserve naming because a careless sweep would "fix" them into bugs:
`index-writer.ts:102` (above) and `rev-parse-grammar.ts:65` `/^[0-9a-f]{1,3}$/`, which encodes
git's **minimum** abbreviation of 4 and is unrelated to the maximum.

### 3. Binary formats — reader/writer inventory

#### 3a. Already correct — no change

| format | evidence |
|---|---|
| **`.rev`** | `serializePackRevIndex` derives `const hashId = digestLength === 32 ? 2 : 1` (`rev-index.ts:125`) from `packChecksum.length`, refuses any other width (`:117-123`), sizes the file `REV_HEADER_SIZE + 4·n + 2·digestLength` (`:131`), and the reader accepts hash id 1 or 2. It even carries a measured comment (`:75-79`) that it deliberately does **not** cross-check `hashId` against `digestLength` because canonical git does not. **Fully SHA-256-ready today.** |
| **multi-pack-index** | `HASH_VERSION_WIDTH = new Map([[1,20],[2,32]])` (`midx.ts:21-23`); the reader **validates** the hash-version byte against the caller's declared width (`:98-104`) — the opposite policy from `.rev`, and documented as measured, not stylistic. Stride is `midx.digestLength` throughout. **There is no midx writer in `src/`** — read-only. |
| **commit-graph** | `const hashLength = hashVersion === 1 ? 20 : 32` (`commit-graph.ts:86`), used at `:88,95,97,108`. |
| **`.bitmap`** | `parsePackBitmap(bytes, digestLength)` (`bitmap.ts:13,45-46,74-83`), fed from `ctx.hashConfig.digestLength`. |
| **`.pack` trailer** | `pack-registry.ts:364` `packFileSize - ctx.hashConfig.digestLength`; the writer derives from `packChecksum.length` (`write-pack-artifacts.ts:65`, whose comment documents the single-width-source discipline). |
| **`packed-refs`** | No width validation at all: `parsePackedRefs` (`packed-refs.ts:17`) hands every token to `ObjectId.from`, which accepts 40 or 64; `serializePackedRefs` (`:88`) is text. §1d confirms the header line is unchanged. |
| **loose-object path** | `loose-path.ts:4` `` `${id.slice(0, 2)}/${id.slice(2)}` `` — 62-char tail falls out for free. |
| **`shallow`** | `parse-shallow.ts` keyed by `hexLength` (§2c). |
| **index trailer (write)** | `index-lock.ts:128-132` — `ctx.hash.hash(body)`, then `checksum.length`. |

**This inverts the intuition the design started from.** The formats carrying an explicit
hash-identifier field are the ones tsgit already handles correctly — because someone
generalised them when the `.rev` write contract and the midx reader were built. The bugs are in
the *older*, width-implicit formats.

#### 3b. Must change

| format | reader | writer | verdict |
|---|---|---|---|
| pack `.idx` v2 | `pack-index.ts:22` `parsePackIndex(bytes)` | `pack-writer.ts:67` `serializePackIndex` | hardcoded 20/40 both sides (§2a); reader gains a `digestLength` parameter matching its two siblings, writer derives from `packChecksum.length` exactly as `serializePackRevIndex` already does |
| git index `DIRC` | `index-parser.ts:40` `parseIndex` | `index-writer.ts:33` `serializeIndex` | hardcoded 20 for entry, trailer and cache-tree; `parseIndex` and `parseCacheTree` gain the width; `read-index.ts:40` already disagrees with it (§2a) |
| reflog | `reflog-format.ts:35` `parseReflogLine` | `reflog-format.ts:23` `serializeReflogLine` | hardcoded 40 slice offsets |
| tar PAX | — | `tar.ts:383` | self-describing length hardcoded 52 (§2a) |
| bundle | `parse-bundle-header.ts:125` | `serialize-bundle-header.ts:26` | v3 refused in **three** places (`parse:32-34`, `parse:106-108`, `serialize:30`); the `@` capability line is actively rejected as `malformed-header` (`parse:91-92`) — and the Stryker equivalence comment there asserting an `@`-line "never holds a 40-hex oid" becomes **false** once v3 lands, so that suppression must be re-proven against the new structure. `types.ts:4` `BundleHashAlgorithm = 'sha1'` is a one-member union while `BundleVersion = 2 \| 3` already allows 3. See D7. |

**REUC.** `parseExtensions` (`index-parser.ts:177-205`) stores every unrecognised extension as
opaque `{ signature, data }` bytes and only rejects lowercase (mandatory) signatures. REUC
carries up to three oids per entry in real git, so today it round-trips byte-for-byte and is
safe at any width — but any future REUC *decoder* inherits the problem, and the doc comment
should say so. Separately, `serializeIndex` is called with `extensions: []` from
`index-lock.ts:122`, so the cache-tree is dropped on that write path — pre-existing, unrelated,
and worth not confusing with a SHA-256 bug during implementation.

#### 3c. Transport — a pre-existing silent hole, and an error code that already exists

| protocol | tsgit today |
|---|---|
| **v2, send** | `src/domain/protocol/v2/sections.ts:51` emits a **hardcoded** `object-format=sha1\n` in *every* command request |
| **v2, receive** | `src/domain/protocol/v2/capabilities.ts:65-69` parses the advertised value and throws `unsupportedObjectFormat(state.objectFormat)` for anything but `sha1` — **the mismatch is already detected here, and the error code already exists** |
| **v0** | **no `object-format` handling whatsoever.** `parseCapabilities` (`src/domain/protocol/capabilities.ts:42`) splits the tail into opaque tokens; `object-format` is in neither `CLIENT_CAPABILITIES_FETCH` nor `CLIENT_CAPABILITIES_PUSH`, and `negotiateCapabilities` only echoes back client-requested keys. **A v0 SHA-256 server is silently accepted** — §1e measures that git advertises `object-format=sha256` on v0 too, in both `upload-pack` and `receive-pack`. |

So the transport story is not "add a mismatch check"; it is **three different states**:

1. v2 fetch already refuses correctly *by accident of only supporting sha1* — the code
   `UNSUPPORTED_OBJECT_FORMAT { format }` exists (`src/domain/protocol/error.ts:35,102-103`),
   is rendered (`src/domain/error.ts:419`), and is documented — with a row that must change:
   > `UNSUPPORTED_OBJECT_FORMAT` | `format` | v2 capability advertisement's `object-format` is
   > not `sha1` — **tsgit only supports sha1 repositories.**

   After this change the condition is a **mismatch against the local repository**, not a
   blanket sha1-only rule.
2. v2 send hardcodes the client's own claim, which becomes a lie the moment the local
   repository is sha256 — and §1e shows the server keys its behaviour on it.
3. v0 has no handling at all, which is the same class of silent misread [ADR-667] expanded
   scope to remove. Closing it is arguably *required* by R7 and is certainly required for the
   push direction, which is v0-shaped.

`UNSUPPORTED_OBJECT_FORMAT` carries `{ format }` — one field. §1e's fetch refusal reconstructs
`client <A>; server <B>`, which needs **two**. D4 decides whether the payload widens or a
second code lands.

### 4. How the algorithm reaches the Context

Three structural facts decide the shape, and they are already true:

1. **The three async entry points already resolve layout before constructing adapters.**
   `src/index.node.ts` resolves at line 68 (`resolveNodeLayout`, which runs
   `resolveLayout` → `finishLayout` → `readRepositoryFormat`, opening and tokenising
   `<commonDir>/config`) and constructs `new NodeHashService()` at line 93.
   `src/index.browser.ts` resolves at line 70 (`resolveFixedEntryLayout`) and constructs at
   line 79. `src/index.default.ts` resolves at lines 74-80 and constructs at line 83. Detection
   needs **no reordering** on any of them.

2. **The two sync factories structurally cannot detect.** `createNodeContext`
   (`src/adapters/node/node-adapter.ts:48`) and `createBrowserContext`
   (`src/adapters/browser/browser-adapter.ts:26`) return `Context`, not a promise, and build
   their layouts purely lexically (`buildLayout(...)` at `node-adapter.ts:60`; an object literal
   at `browser-adapter.ts:38-42`). Neither touches disk. Making them detect means making them
   `async` — a breaking signature change on a public surface. They must take the memory
   adapter's explicit-option treatment. **One mechanism cannot serve both tiers**, and any
   candidate that pretends otherwise is wrong.

3. **`syntheticFallbackLayout` (`resolve-layout.ts:160-178`) reads nothing from disk** by
   design — the found-nothing bootstrap path that `init` and `clone` take. A repository being
   *created* can therefore never have its format detected; it can only be told (D2).

The channel from config to `hashConfig` is the missing piece. `readRepositoryFormat` already
scans the right file with the right machinery: `EXTENSIONS_SECTION` is already a constant
(`read-repository-format.ts:21`) and `lastTopLevelEntry(tokens, EXTENSIONS_SECTION, …)` is
already the reducer used for `worktreeconfig` (line 92), and **last-wins is exactly the measured
resolution for `objectFormat`** (§1b). Adding the read is one constant, one `lastTopLevelEntry`
call, one field on `ScannedFormat`, one resolver.

Two things must **not** be copied from the neighbouring keys:

- **Scoping.** `core.bare` and `core.worktree` go through `pickScoped` ([ADR-661]); the format
  keys do **not** — `repository-format-acceptance-gate.md` §1e measures that a
  `repositoryformatversion` or `extensions.*` planted in `config.worktree` is inert even with
  `extensions.worktreeConfig = true`. `objectFormat` is a format key: `<commonDir>/config`
  only.
- **Leniency.** `scanConfigFile`'s absent-file-behaves-as-empty rule is right for `objectFormat`
  (absent ⇒ sha1, §1b) but the *present-and-malformed* cases are refusals (§1b), matching the
  `configBadBooleanValue` / `configMissingValue` throws the same function already performs
  ([ADR-664]).

Getting the value **out** of `finishLayout` is the real structural question, because today
`fmt` dies there (Context). D1 enumerates the routes.

### 5. Threat model

The repository config is attacker-influenceable whenever a repository arrives from an untrusted
source. This change reads no new file and opens no new path — `<commonDir>/config` is already
read at Stage 2 — but it does something more consequential: **it lets a config value select the
hash function used to verify content.**

- **It closes the misread hole** that [ADR-667] named — and the hole is wider than the ADR
  states. Two hash spaces are mixed under one 40-hex assumption and the result is reported as
  corruption, as absence, as a raw `TypeError`, or **not at all** (Context). An integrity
  failure that reports four different things, one of which is silence, is not a diagnosable
  condition.
- **It makes a config value select the verification function**, which is a downgrade question.
  `extensions.objectFormat = sha1` is a legal value (§1b), so a config edit can declare a
  SHA-256 repository to be SHA-1. Two things bound the risk, and both must hold by construction
  rather than by luck: (i) **git has exactly this property**, so refusing the declaration would
  be the divergence, not accepting it — the config *is* the authority on the format in git too;
  (ii) the resulting state fails **closed**, because a declared-sha1 repository holding 64-hex
  ids cannot resolve them (§1d measures `fatal: Not a valid object name` for a 64-hex id in a
  sha1 repository). The dangerous design would infer the algorithm from the **data** (id width,
  or a `.rev` hash id, or a midx hash-version byte) rather than from the **declaration** — that
  would let planted data choose its own verifier. §6's first bullet forbids it, and §1d's
  40-hex-prefix row is the proof that width cannot identify an algorithm anyway.
- **The declared format must gate verification, never follow it.** `serialize-and-hash.ts:20`
  currently casts a computed digest straight to `ObjectId` (`as ObjectId`), bypassing
  `ObjectId.from`. Under a single algorithm that is a harmless hot-path shortcut; under two it
  removes the only place a written id's width could be checked against the repository's
  declared width. R3 and D3 address it.
- **The transport is the widest new surface.** `object-format` is a **remote-supplied** string
  (§1e). It must select from a closed two-element set and never be interpolated anywhere. An
  unrecognised advertised value is a refusal, not a fallback to sha1 — a fallback would let a
  hostile server downgrade the client's verification.
- **Config-supplied strings are data only.** `objectFormat`'s value is matched against two
  literals and discarded; it never reaches a path, a filename, or a rendered string beyond the
  refusal payload.

### 6. Genericity and symmetry checks

This repository has a **known recurring blind spot on exactly these two axes** — a prior review
raised two HIGH findings on hash-width genericity and write-path/read-path symmetry. Treated
here as a checklist, not an afterthought.

**Width genericity.**

- No site may branch on `hexLength === 40` / `digestLength === 20` to mean "sha1". The
  discriminator is the **declared algorithm**, and §1d proves why: a 40-hex string is a valid
  prefix in a SHA-256 repository, so width does not determine algorithm. The existing
  `emptyTreeOid`'s `hash.digestLength === 32` test (`object-resolver.ts:45`) is the pattern to
  avoid propagating — it happens to be correct because the set has two elements, but it encodes
  identity in a size. If `HashConfig` gains an `algorithm` field (D3), that test becomes a name
  comparison.
- Every derived width must be computed, never restated as a literal: `hexLength === 2 * digestLength`,
  the loose-object filename tail is `hexLength - 2`, the `.idx` trailer is `2 * digestLength`,
  the `.rev` trailer is `2 * digestLength`.
- The upper bound in bounds-checks and prefix caps moves from 40 to `hexLength`, and the
  **minimum** does not move (both algorithms accept a 4-char prefix, §1f).
- `ObjectId.from` accepting both widths unconditionally is correct as a *format* check and
  insufficient as a *repository* check; so is `looksLikeObjectId`
  (`validators.ts:241`), whose doc comment says "a valid SHA1 … or SHA256" — true of the
  string, silent about the repository. Replacing the ten `/^[0-9a-f]{40}$/` command fast paths
  (§2a) with calls to it makes them *width-permissive* rather than *width-correct*: a 40-hex
  string handed to a SHA-256 repository would be treated as a full oid when §1d proves it is a
  **prefix**. This is the trap in the most obvious remediation, and D3 exists because of it.

**Write-path / read-path symmetry.** §3a falsified this design's first hypothesis — the three
formats carrying an explicit hash-identifier field (`.rev`, midx, commit-graph) are the ones
tsgit already handles correctly, and `serializePackRevIndex` already derives the id rather than
hard-coding it. The asymmetries that remain are the ones a width-only reading of the problem
would miss:

| format | read side | write side | asymmetric? | symmetric test |
|---|---|---|---|---|
| `.rev` | accepts hash id 1 or 2, deliberately not cross-checked (`rev-index.ts:75-79`) | derives `hashId` from `packChecksum.length` (`:125`) | no — already matched | regression only: assert the sha1 file still writes `1` |
| midx | validates the hash-version byte against the declared width (`midx.ts:98-104`) | **no writer exists** | vacuously | read a git-written sha256 midx |
| commit-graph | `hashVersion === 1 ? 20 : 32` | — | vacuously | read a git-written sha256 graph |
| `.idx` | size check keyed on 20 (`pack-index.ts:51-52`) | stride and trailer keyed on 20; `pack-writer.ts:72` **rejects** a 32-byte checksum | **yes, both broken the same way** | tsgit-written `.idx` opened by `git verify-pack`, and the converse |
| git index | `read-index.ts:40` width-aware, `index-parser.ts:26` not — **the two readers of one file disagree** | `index-writer.ts:102` correct, `:110`/`:17` not — **the writer is half-correct** | **yes, in both directions and internally** | `git ls-files --stage` against a tsgit-written index |
| reflog | fixed 40-char slice offsets | same constants | no — symmetrically wrong, so a tsgit-only round-trip passes and git rejects | git reads a tsgit-written reflog |
| tar PAX | n/a | declares 52 for a 76-byte record | **write-only** — no read-side symptom at all | `tar -t` / `git archive --list` on a tsgit archive |
| bundle | v3 refused | v2 only | no — symmetrically absent | `git bundle verify` on a tsgit bundle, and the converse |
| wire v2 | refuses non-sha1 (`capabilities.ts:67`) | **hardcodes** `object-format=sha1` (`sections.ts:51`) | **yes** — tsgit would refuse a sha256 server while claiming to be one | capability round-trip against real `upload-pack` |
| wire v0 | **no parsing** | **no emission** | **yes** — silently accepts a sha256 peer | v0 advertisement against real `upload-pack`/`receive-pack` |
| config | `objectFormat` unread | writes v0 with no `[extensions]` | **yes** | `git rev-parse --show-object-format` on a tsgit-created repo |

Two classes are invisible to any test that only exercises tsgit against itself: the
**symmetrically wrong** rows (reflog, bundle) round-trip perfectly inside tsgit, and the
**write-only** row (tar PAX) has no read-side symptom at all. Both are caught only by the
git-reads-tsgit direction of R9, which is why §Test strategy makes that a per-format battery
rather than a per-command one.

**Read-path/read-path symmetry.** A repository's format must be read from exactly one place. If
both `readRepositoryFormat` and a later `readConfig(ctx)` derive it, they can disagree when
`config.worktree` is in play (§4). One reader. The git index shows what the failure looks like
when this rule is already broken: `read-index.ts` and `index-parser.ts` are two readers of one
file with two widths, and the bug is latent only because both widths are currently 20.

**SHA-1 invariance (R6).** Every change must be a no-op at `SHA1_CONFIG`. The strongest guard is
that the existing golden/parity/interop suites are unmodified and still green — a diff that
touches a SHA-1 golden is a bug in the change, not in the golden.

### 7. Error shape

Per [ADR-249] every new code carries fields only; the interop test reconstructs git's bytes.
The conditions this design introduces, and the existing shape each matches:

| condition | git's bytes | existing tsgit shape |
|---|---|---|
| `extensions.objectFormat = <bad>` | `error: invalid value for 'extensions.objectformat': '<v>'` + `fatal: bad config line N in file <F>` | `CONFIG_BAD_BOOLEAN_LITERAL`'s `error: invalid value for '<key>'` + the `CONFIG_PARSE_ERROR` second line — D6 |
| valueless `extensions.objectFormat` | `error: missing value for 'extensions.objectformat'` + `fatal: bad config line N in file <F>` | `CONFIG_MISSING_VALUE` exactly (`{ key, source, line }`) — D6 |
| fetch/clone algorithm mismatch | `fatal: mismatched algorithms: client <A>; server <B>` | **`UNSUPPORTED_OBJECT_FORMAT { format }` already exists** (`src/domain/protocol/error.ts:35,102-103`; rendered `src/domain/error.ts:419`; documented `docs/use/errors.md:180`) — but carries **one** field where the reconstruction needs two, and its docs row currently reads "tsgit only supports sha1 repositories", which this change falsifies. D4 |
| push algorithm mismatch | `fatal: the receiving end does not support this repository's hash algorithm` | none — and v0 has no `object-format` handling at all (§3c) |
| `extensions.compatObjectFormat` at the point of use | `fatal: compatibility hash algorithm support requires Rust` | new — [ADR-667]'s point-of-use family, explicitly *not* the [ADR-668] gate codes. D5 |
| `opts.hash` contradicting the repository's declared format | none — tsgit-only | new; a caller error, not a faithfulness surface. D1 |
| `bundle` in a SHA-256 repository, if v3 is deferred | git writes v3 | `BUNDLE_UNSUPPORTED_VERSION` exists but names the *file's* version, not the repository's. D7 |

The `UNSUPPORTED_OBJECT_FORMAT` row is the important one: this design does not introduce the
transport refusal, it **narrows** one that already exists from "not sha1" to "not this
repository's algorithm". That is a semantic change to a shipped public code, so it is a docs
row rewrite and an `reports/api.json` regeneration whichever way D4 goes.

## Decision candidates

| # | Choice | Alternatives (≤3) | Recommendation | Why |
|---|---|---|---|---|
| D1 | **How the algorithm reaches the `Context`.** §4: the async entries already resolve layout first, but `finishLayout` discards `fmt` and `RepositoryLayoutInput` has no slot for it. | **(a) Widen the layout channel** — add `objectFormat` to `RepositoryFormat` and surface it on `RepositoryLayout` (an additive optional public field, [ADR-658]); each async shim reads `layout.objectFormat` and builds the matching `HashService` + `HashConfig`. **(b) Explicit option only** — `algorithm?: 'sha1' \| 'sha256'` on every entry's options, exactly the `index.default.ts` precedent; no detection anywhere. **(c) Both, option wins** — (a) for detection plus (b) as an override, with the override refused when it contradicts a declared format (§5). | **(c) both, option overrides, contradiction refused** | (b) alone fails R1: `openRepository({ cwd })` on a real SHA-256 repository would still misread it, which is the entire defect [ADR-667] expanded scope to fix — an option the caller must already know to pass is not support. (a) alone cannot serve the two **sync** factories (`createNodeContext` / `createBrowserContext`), which can never detect without becoming `async` (§4.2), and cannot serve `init`, whose layout is synthetic (§4.3) — so the option must exist regardless. (c) is therefore not "both for safety", it is the minimum that covers all three tiers. The contradiction refusal is what keeps (c) from re-opening the `ctx.hash` / `ctx.hashConfig` desync that already exists today (Context §3, R3). The cost is one additive public field on `RepositoryLayout` and one new option on four option types. |
| D2 | **Scope of the write side.** [ADR-667] requires only that acceptance not be a lie — i.e. that tsgit not *misread* a SHA-256 repository. It does not require tsgit to *create* one. | **(a) Read + write into an existing sha256 repo, but no creation** — every command works against a repository git created; `init` keeps writing v0/sha1; `clone` of a sha256 remote refuses at the transport (D4). **(b) Full parity** — `init` gains `objectFormat`, `bootstrapRepository` emits git's exact §1a block, `clone` adopts the remote's algorithm as git does (§1e). **(c) Read-only** — a sha256 repository opens and every read command works; the first write refuses at the point of use. | **(b) full parity** | (c) is the smallest change and the worst boundary: "read works, write refuses" splits the command surface along a line no caller can predict, and every write path would need its own refusal — the exact per-site-refusal sprawl [ADR-667]'s standing rule exists to avoid. (a) is coherent and genuinely satisfies ADR-667, but it leaves `clone` of a SHA-256 remote refusing where git succeeds — a **new** divergence, created by the very change whose purpose was to remove one, and §1e shows git *adopts* the algorithm from the wire rather than offering a choice, so there is nothing to configure. (b)'s marginal cost over (a) is small and well-bounded: `bootstrapRepository`'s `renderConfig` gains the §1a `[extensions]` block, and `BootstrapOptions.hash?: 'sha1'` — today a **dead single-valued field nobody passes** (`internal/bootstrap.ts:8`; `init.ts:32` and `clone.ts:94` both omit it) — becomes the live parameter it was clearly scaffolded to be. (b) is also the only option under which R9 can be asserted in both directions for every format. |
| D3 | **The mechanism for the width sweep** (§2a's 46 sites) and for keeping `ctx.hash` and `ctx.hashConfig` honest (R3). | **(a) Thread `ctx.hashConfig.hexLength` to each site** — the pattern the 24 existing consumers already use. **(b) Reuse the existing `looksLikeObjectId`** (`validators.ts:241`, already dual) at the ten command fast paths and thread the width elsewhere — the smallest diff. **(c) A repository-aware predicate** — `isOid(value, hashConfig)` / `oidPattern(hashConfig)` in the domain, plus `algorithm: 'sha1' \| 'sha256'` added to `HashConfig`, with `looksLikeObjectId` kept and renamed to say it is a *format* check. | **(c)** | (b) is the trap, and it is the obvious move: `looksLikeObjectId` accepts **either** width unconditionally, so a 40-hex string in a SHA-256 repository would be taken as a full oid when §1d proves it is a valid **prefix** — `checkout.ts:63`, `reset.ts:175`, `rev-parse.ts:59` and the rest would resolve the wrong object instead of failing. Width-permissive is not width-correct. (a) is the status quo and scales badly for *validators* specifically: §2a's sites are mostly regex literals, and threading a number to each leaves N independently-mutable predicates — an `=== 40` flipped to `>= 40` in a regex-adjacent guard is invisible to a SHA-1-only suite, so the mutation cost is per-site rather than per-behaviour. (c) is one tested helper with one call per site, so one mutant-killing test per behaviour; adding `algorithm` to `HashConfig` collapses the `digestLength === 32` identity test (`object-resolver.ts:45`, §6) and gives D1(c)'s contradiction check something to compare on a name rather than a size. Object Calisthenics reads it as replacing a primitive — a bare number width — with a named concept. Its cost is a public type change (`HashConfig` is exported via `src/public-types.ts:86`) and a rename touching three call sites. |
| D4 | **Transport refusal shape.** §3c: `UNSUPPORTED_OBJECT_FORMAT { format }` **already exists**, already fires on the v2 advertisement, and is already documented as "tsgit only supports sha1 repositories" — a sentence this change falsifies. §1e measures two distinct git conditions where tsgit has one code carrying one field. | **(a) Widen in place + one new code** — `UNSUPPORTED_OBJECT_FORMAT` keeps `format` (the peer's) and gains `local` (additive, non-breaking), covering the fetch/clone line; a new code covers the push line. **(b) One code for both** — widen `UNSUPPORTED_OBJECT_FORMAT` and raise it on push too. **(c) Two fresh codes** named for the conditions, retiring `UNSUPPORTED_OBJECT_FORMAT` (a breaking removal from a shipped surface). | **(a)** | git renders two different lines for two different conditions and a caller acts differently on them — a fetch mismatch means "these two repositories can never exchange objects"; a push mismatch means "this *server* cannot take your objects". That is exactly the test [ADR-668] used to choose two codes over one and [ADR-654] before it, so (b) would force the interop reconstruction to branch on a verb the payload does not carry. (c) is cleaner naming bought with a breaking change to a code that is exported, rendered and documented, for a rename. (a)'s cost is that the surviving name reads as a *capability* statement when it is now a *mismatch* statement — mitigated because it keeps the field a caller may already switch on. **Bound to D2:** under D2(b) `clone` adopts the remote's algorithm (git's behaviour, §1e) and there is no clone refusal to shape at all; under D2(a)/(c) `clone` must refuse and should reuse the fetch code, since it is the same negotiation. Take D2 and D4 together, not in sequence. |
| D5 | **Point-of-use refusals for what remains unsupported** — `compatObjectFormat` (§1g), and any residual gap this change does not close. [ADR-667] creates this family and states it is *distinct* from the [ADR-668] gate codes. | **(a) One shared code** — `EXTENSION_UNSUPPORTED_HERE { extension }` — raised wherever an accepted-but-unactionable extension is reached, shared with the reftable design. **(b) One code per extension** — `COMPAT_OBJECT_FORMAT_UNSUPPORTED`, `REF_STORAGE_UNSUPPORTED`, … **(c) Reuse the gate's `REPOSITORY_EXTENSIONS_UNSUPPORTED`** with a different raise site. | **(a) one shared code** | (c) is ruled out by [ADR-668]'s own consequence line ("Point-of-use refusals introduced by ADR-667 are a separate family and do not reuse these codes") — a caller distinguishing "git would not open this either" from "git opens this, tsgit cannot act on it" is the whole point of the split. Between (a) and (b): the payload already carries the extension name, so (b) adds a union member per extension for a distinction the field makes, and it would multiply as the reftable design lands its own. (a) has one real cost — the refusal cannot say *which operation* was refused unless it carries an `operation` field too, and this design cannot settle that alone because the **reftable design is choosing the same code concurrently**. Raised here so one shared answer is given once. |
| D6 | **Where `extensions.objectFormat`'s own value refusals live** (§1b: invalid value, valueless). Both are shapes tsgit already reconstructs (§7), but they arise in `readRepositoryFormat`, which is the *acceptance gate's* file. | **(a) Reuse the existing codes** — `CONFIG_MISSING_VALUE` for valueless, and `CONFIG_BAD_BOOLEAN_LITERAL`'s `error: invalid value for '<key>'` shape generalised (renamed or joined by a sibling `CONFIG_INVALID_ENUM_VALUE { key, source, value }`) for a bad value. **(b) One new `OBJECT_FORMAT_INVALID { value, source }`** covering both, with the two renderings derived from whether `value` is absent. **(c) Two new codes**, one per git line. | **(a) reuse, adding one enum-value code** | `CONFIG_MISSING_VALUE` is already documented as covering string-typed present-but-valueless keys and already carries `{ key, source, line }` — the exact payload git's two-line refusal needs; adding `extensions.objectformat` to its key list is a docs row, not a code. For the bad-value half, git's `error: invalid value for '<key>': '<v>'` is the *same* line `CONFIG_BAD_BOOLEAN_LITERAL` reconstructs for `push.gpgsign`, and `refStorage` (the reftable design) has an identically-shaped enum refusal — so a general `CONFIG_INVALID_ENUM_VALUE` is earned by two callers, not one. (b)'s "value absent means the other case" is the sentinel [ADR-668] rejected in its own option (a). (c) is faithful but adds two members for renderings the existing codes already produce. Cross-check with the reftable design before ratifying. |
| D7 | **Bundle v3.** §1d: a SHA-256 repository's bundle is `# v3 git bundle` + `@object-format=sha256`, not a widened v2. tsgit refuses v3 in **three** places and actively rejects the `@` capability line (§3b). This is a *format-version* feature, not a width change, and it is the one sub-scope large enough to be its own change. | **(a) Implement v3 in this change** — parse and emit the magic and the `@capability` block; `BundleHashAlgorithm` widens; `bundle create` in a sha256 repo writes v3. **(b) Defer v3; refuse `bundle` in a SHA-256 repository** at the point of use, per [ADR-667]'s standing rule, and keep the seven class-B sites (§2b) correct as written. **(c) Defer v3 and let `bundle` write v2 with 64-hex oids** — a file git will not read. | **(b) defer, with a point-of-use refusal** | (c) is the only option that is actually wrong: it emits a file no other tool accepts, which is precisely the "silently reading/writing the repository wrong" [ADR-667] forbids. Between (a) and (b): v3 is a genuinely separate format with its own capability grammar, its own `verify` semantics, and its own interop battery, and folding it in roughly doubles the domain surface of a change that is already touching nine files across five subsystems. (b) is explicitly sanctioned — ADR-667's standing rule *is* "refuse precisely, at the point of use" — and it keeps §2b's seven class-B sites honest instead of turning them into half-migrated dual-width code. The cost is one command that works in a SHA-1 repository and refuses in a SHA-256 one, which is a worse boundary than any other in this design and the reason this is a decision rather than a note. Also load-bearing for implementation: the Stryker equivalence suppression at `parse-bundle-header.ts:91-92` asserts an `@`-line "never holds a 40-hex oid" — true today, **false under (a)** — so choosing (a) requires re-proving that suppression against the new structure, not carrying it forward. |
| D8 | **The protocol-v0 `object-format` gap.** §3c: tsgit reads and sends the capability on v2 only. On v0 it neither parses nor emits it, so a v0 SHA-256 peer is **silently accepted** today — the same silent-misread class [ADR-667] expanded scope to remove, one layer down. §1e measures git advertising it on v0 in both `upload-pack` and `receive-pack`. | **(a) Close it** — parse the advertised `object-format` on v0 and add it to `CLIENT_CAPABILITIES_FETCH` / `CLIENT_CAPABILITIES_PUSH`, so both verbs refuse a mismatch on both protocols. **(b) Close it for `push` only** — push is the v0-shaped verb and the only one whose §1e refusal is otherwise unreachable; leave v0 fetch as-is. **(c) Leave v0 alone** and document the gap as a known divergence. | **(a) close it** | (c) leaves this change shipping a repository-format feature whose refusal can be walked around by negotiating v0 — the gate would be real on one protocol and absent on the other, which is worse than having no gate, because it reads as covered. (b) is a coherent minimum (R7's push half is unreachable without it) but leaves the fetch direction silently accepting a mismatched peer, and the two paths share `parseCapabilities` (`src/domain/protocol/capabilities.ts:42`) and `negotiateCapabilities`, so the marginal cost of (a) over (b) is small — one token in each client capability list and one comparison. The honest counter-argument for (b) or (c) is scope: this is a **pre-existing** hole, not one this change creates. Raised so that the scope call is made deliberately rather than by omission. |

## Test strategy

**Unit.** `src/domain` and `src/adapters` are inside the 100 %-coverage scope; the application
and repository tiers are not, but Stryker mutates all of `src`.

- `test/unit/repository/read-repository-format.test.ts` — extend with an `it.each` sweep over
  §1b's value grammar (both accepted values, the four `invalid value` shapes, valueless,
  whitespace-padded, duplicate/last-wins, absent-at-v1). Refusal rows use try/catch + direct
  `.data` assertions, never `toThrow(Class)` — and the two refusal arms get **separate** tests
  so each guard is proven alone (CLAUDE.md's isolated-guard rule; `invalid value` and
  `missing value` are one `if/else` away from each other).
- The §1b **case-sensitivity** row is its own test. A `toLowerCase()` added "for symmetry with
  the key" is the single most likely faithfulness regression here, and only that row kills it.
- New domain helper tests for D3(c)'s `oidPattern` / `isOid` — every width × every algorithm ×
  malformed (uppercase, 39/41/63/65 chars, non-hex, empty).
- **Two regression tests named directly from Context**, because both are live defects rather
  than missing features and both must be *proven* fixed, not assumed:
  - `catFile` against a SHA-256 repository throws a **typed** `TsgitError`, never a bare
    `TypeError` (R11). Assert the `.data.code`, not the class.
  - `openRepository({ algorithm: 'sha256' })` on the memory entry, then `add`, produces an index
    whose entry oid at `offset + 40` is the **full 32 bytes** of the real blob oid and whose
    flags sit at `offset + 72` (R12). The current bytes — oid prefix, then `0005`, then the
    ASCII name written over the oid's tail — make a byte-literal assertion the clearest oracle.
- `src/domain/objects/hash-config.ts` — if `algorithm` is added (D3), a test that the two
  frozen configs are internally consistent (`hexLength === 2 * digestLength`) so a future
  third algorithm cannot be added half-populated.
- Each §3b format gets a **fixture pair** — literal sha1 bytes and literal sha256 bytes, both
  produced by real git — rather than a single width-parameterised fixture. A computed fixture
  and a computed parser agree with each other even when both are wrong; only a literal disagrees.
- §6's three invisible classes each get a test that could not exist otherwise:
  - **symmetrically wrong** (reflog, bundle) — assert against git-written bytes, never against
    a tsgit round-trip, which passes either way;
  - **write-only** (tar PAX) — assert the emitted record's declared length equals its actual
    byte length, and shell out to `git archive --list` / `tar -t` in interop;
  - **internally disagreeing** (the git index) — one test that `read-index`'s trailer view and
    `parseIndex`'s framing agree on the same buffer at **both** widths. That test fails today
    at neither width and would fail at 32 before the fix — it is the regression guard for the
    latent bug §2a found.
- `index-writer.ts:102` gets an explicit "this offset is 40 at every width" test with a
  comment, because it is the one line a width sweep is most likely to break while making
  everything else right.
- **Regression, not feature**: `.rev`, midx, commit-graph, `.bitmap`, `packed-refs`,
  `parse-shallow` and `loose-path` are already dual (§3a) and need **no new unit tests** — they
  need their existing sha1 assertions left untouched (R6). A diff that edits those files is a
  signal to re-read §3a.
- Adapter tests: `NodeHashService('sha256')`, `MemoryHashService('sha256')`,
  `BrowserHashService('sha256')` against a known vector, plus `digestLength === 32`.

**Interop** — new `test/integration/sha256-object-format-interop.test.ts`, following
`config-boolean-interop.test.ts` and using `interop-helpers.ts`
(`GIT_AVAILABLE`, `runGit`, `runGitEnv`, `git`, `gitAsync`, `tryRunGitWithExit`). **One shared
`beforeAll(fn, 60_000)`** builds a single `git init --object-format=sha256` repository with a
commit, a tag, a branch and a repacked pack; each row copies it — the default 10 s hook timeout
fails under full-validate concurrency. Twin rows (git verdict ‖ tsgit verdict):

1. **Object identity** — `log`, `cat-file`, `ls-tree`, `rev-parse HEAD` and `HEAD^{tree}`:
   tsgit's oids equal git's, 64 hex, exactly (R1). Plus the §1c empty-tree and empty-blob
   constants, asserted as literals so a derivation bug cannot self-agree.
2. **Config read** — §1b's full grammar table driven through `openRepository`, each refusal's
   structured fields reconstructing git's exact two lines (§7).
3. **Per-format read symmetry** (R4/R9, git writes → tsgit reads): loose object, `.idx`,
   `.pack`, `.rev`, `multi-pack-index`, `commit-graph`, `.bitmap`, `.git/index`, `packed-refs`,
   `shallow`, reflog — and bundle v3 **only under D7(a)**; under D7(b) the row becomes the
   refusal in row 10 instead.
4. **Per-format write symmetry** (R9, tsgit writes → git reads) — the direction that catches
   §6's symmetrically-wrong and write-only classes, which no tsgit-internal test can see: after
   a tsgit write, run `git fsck`, `git verify-pack`, `git ls-files --stage`,
   `git reflog show`, `git archive` → `tar -t`, and `git rev-parse --show-object-format`, each
   exiting 0. `git bundle verify` joins the list only under D7(a).
5. **Round-trip** — a tsgit-created SHA-256 repository (D2(b)) whose `.git/config` matches
   §1a's bytes and which `git log` reads; and a git-created one that tsgit writes into and git
   then reads.
6. **SHA-1 invariance** (R6) — the same battery on a sha1 repository, asserting the `.rev` hash
   id is still `1`, the `.idx` trailer is still 40 bytes, the index entry header is still 62,
   and every oid is still 40 hex.
7. **Transport** (R7) — §1e's rows over `file://` and the in-process HTTP path: sha256↔sha256
   fetch and push succeed; sha1→sha256 and sha256→sha1 fetch refuse; push to a sha1 receiver
   refuses; the client's own v2 request carries its **real** algorithm rather than a hardcoded
   `sha1` (§3c), asserted against a real `upload-pack` advertisement. Under D8(a) the same rows
   run forced to protocol v0. Use `gitAsync` for anything driving the in-process server — a sync
   `git` spawn deadlocks it.
8. **Cross-format confusion** (§1d) — a 40-hex prefix of a sha256 oid **resolves** to the full
   oid (it is a prefix, not an algorithm signal, and §2a's `checkout.ts:85` is the site this row
   guards); a sha256 pack in a sha1 repository is refused; a 64-hex id in a sha1 repository is
   not found.
9. `compatObjectFormat` (§1g) — both tools refuse; tsgit's is D5's point-of-use code.
10. Under D7(b), `bundle` in a SHA-256 repository refuses precisely, while git writes a v3
    bundle — an asserted, commented divergence row rather than a co-truth one.
11. **Cross-format meeting points** (R13, §1h) — a linked worktree of a SHA-256 repository
    reports sha256 and writes a 32-byte-oid index; a foreign-format alternate yields
    `OBJECT_NOT_FOUND` (not a pack-index error) in both directions; `submodule add` across
    formats refuses in both directions, leaving the same partial `.git/modules/<name>` state
    git leaves.

**Parity** — `test/parity/scenarios/` shares one golden across the memory, node and browser
drivers. A `sha256-object-format.scenario.ts` proves the *same* 64-hex oids on all three
adapters. **This needs a change to the harness**: `Scenario`
(`test/parity/scenarios/types.ts:15-25`) has no slot for open options, and each driver calls
`openRepository({ cwd })` with a fixed literal (`test/parity/node.test.ts:43`). Add an optional
`openOptions` to `Scenario` and spread it in all three drivers — a small, named cost that must
be in the plan rather than discovered during implementation. Note `test/parity/*` proves
cross-adapter agreement only; it does **not** prove faithfulness — that is §Interop's job.

**Property tests** — the four CLAUDE.md lenses, applied honestly:

- **Lens 1 (round-trip pair): no.** `serializeObject`/`parseObject` are unchanged by this design
  (§1c: the header is identical), so there is no new round-trip to prove; the existing property
  siblings already cover them and simply run under a second `HashConfig`.
- **Lens 2 (compositional matcher): no.** Nothing here reduces a rule list to a verdict.
- **Lens 3 (total function over an algebraic grammar): YES — one sibling is warranted, under
  D3(c) only.** `isOid(value, hashConfig)` / `oidPattern(hashConfig)` is a total width-generic
  validator over the hex grammar, and it is exactly the kind of predicate whose off-by-one
  survives an example sweep — §2a's `resolve-oid-prefix.ts` shows the failure mode, where a
  wrong bound returns `undefined` instead of throwing. `src/domain/objects/oid-pattern.properties.test.ts`
  beside the example test, generators in a shared `arbitraries.ts`: for an arbitrary lower-case
  hex string of arbitrary length, `isOid(s, cfg) === (s.length === cfg.hexLength)`; for
  arbitrary bytes, `isOid(toHex(bytes), cfg) === (bytes.length === cfg.digestLength)`; and no
  input in the ASCII-hex safe subset makes it throw. `numRuns: 100` (invariant tier). Generate
  the hex alphabet from character **ranges**, never a base64-ish literal — a literal alphabet
  trips `CKV_SECRET_6` in the secret scanner. **Under D3(a) or D3(b) this sibling does not
  exist**: (a) has no single function to pin down, and (b)'s `looksLikeObjectId` takes no
  config, so the only property expressible is the tautology its two regexes already state.
- **Lens 4 (idempotence / counting): no** — the config read's counting invariant belongs to the
  acceptance gate's extension enumerator, which that design already scoped.

**Public-surface gates** — this change touches all of them, and each is a hard pre-PR gate:

| gate | what changes |
|---|---|
| `reports/api.json` | regenerated — new option(s) on `OpenRepositoryOptions` / the three shim option types / `NodeAdapterOptions` / `BrowserAdapterOptions`, the `RepositoryLayout` field (D1a), `HashConfig.algorithm` (D3c), the widened `UNSUPPORTED_OBJECT_FORMAT` payload (D4a), new error codes |
| `docs/use/errors.md` | an **edited** row — `UNSUPPORTED_OBJECT_FORMAT` (line 180) currently says "tsgit only supports sha1 repositories", which this change falsifies; plus new rows for the push-side mismatch under *Network, transport, partial clone* and the point-of-use extension refusal and any config-value code under *Repository state*, matching the depth of the neighbouring rows |
| the `openRepository` reference | the algorithm option and the detection rule, on every entry-point page it appears on (`docs/get-started/node.md`, `browser.md`, `memory.md`, `deno.md`, `bun.md`, `cloudflare-workers.md`) |
| barrel exports | `SHA256_CONFIG` is currently **not** in the public surface — `src/public-types.ts:86` re-exports `domain/objects` with `export type *`, which carries `HashConfig` but not the value constants. If a caller must name a config, that changes. |
| `docs/use/commands/init.md`, `clone.md`, `bundle.md` | under D2(b) |
| `docs/understand/repository-layout.md`, `security.md` | the format field and §5's downgrade note |
| `cspell.json` | already done alongside this doc — `objectformat` and `precomposeunicode`, joining the existing lower-cased git-config keys (`worktreeconfig`, `repositoryformatversion`, `logallrefupdates`) |
| browser scenario + `test/runtime-parity` | a new adapter option must be exercised on every runtime |

## Out of scope

- **The reftable ref backend** (`docs/design/reftable-ref-storage.md`, being written
  concurrently). It is the other subsystem [ADR-667] pulled in. Shared surfaces, named so they
  are settled once rather than twice: D5's point-of-use refusal code, D6's
  `CONFIG_INVALID_ENUM_VALUE` (`refStorage` has the identical value-grammar shape), and the D1
  channel out of `readRepositoryFormat` — a second format-bearing key wants the same route.
- **The repository-format acceptance gate itself** (`docs/design/repository-format-acceptance-gate.md`,
  [ADR-666]/[ADR-667]/[ADR-668]). It decides *whether* a repository opens; this design decides
  what happens *after* it does. That design's §1b/§1e are cited here as measured input, never
  re-derived, and its codes are not reused (D5).
- **The ownership / trust gate** (the sibling design and [ADR-669]–[ADR-679]). Orthogonal:
  it decides whether a repository may be touched at all.
- **`extensions.compatObjectFormat`'s actual semantics** — a dual-hash repository with a
  translation table. git itself refuses it on this build (§1g), so there is no observable
  behaviour to be faithful to; tsgit refuses at the point of use (R8, D5). If a future git
  ships it, that is a new design.
- **`relativeWorktrees` and `preciousObjects`** — the other two names [ADR-667] accepted.
  `preciousObjects` is honoured by construction (no `gc`/`prune`/`repack` command exists);
  `relativeWorktrees` is the acceptance-gate design's measurement to owe.
- **Bundle v3**, under D7(b) — the `# v3 git bundle` magic and the `@object-format=` capability
  grammar. It is a format-version feature, not a width change, and §2b's seven class-B sites
  stay correct precisely because it stays out. Under D7(a) it is in scope and this bullet is
  deleted.
- **Protocol v0 `object-format`**, under D8(b)/(c) only — a pre-existing hole (§3c), named here
  so the scope call is explicit either way.
- **A multi-pack-index writer.** tsgit reads midx and does not write one (§3a). SHA-256 does not
  change that.
- **`.rev`, midx, commit-graph, `.bitmap`, `packed-refs`, `shallow`, loose paths and the
  `.pack` trailer** — already dual (§3a). Listed here as out of scope so the implementation
  does not "generalise" code that is already generic; a diff touching them is a review flag.
- **Rendering**: abbreviation width, `%h`, `--abbrev`, and any pretty format. §1f's numbers exist
  only so the interop test can reconstruct git's display ([ADR-249]).
- **Changing the SHA-1 default.** Absent `extensions.objectFormat`, a repository is SHA-1 (§1b),
  and tsgit's default for a *new* repository stays SHA-1 under every D2 option — git's does too
  (`GIT_DEFAULT_HASH` / `init.defaultObjectFormat` are opt-ins, §1a). This design adds a
  capability, never a default change.
- **Performance work on the SHA-256 path.** No benchmark scenario, cache tuning or `docs/perf`
  entry is in this change. The relative cost of SHA-256 versus SHA-1 in each adapter was
  **not measured** here and no claim is made about it; if it matters, it is a nightly-bench
  question, not a design-doc assertion.

[ADR-169]: ../adr/169-oid-abbrev-and-context-defaults.md
[ADR-226]: ../adr/226-git-faithfulness-prime-directive.md
[ADR-249]: ../adr/249-describe-structured-data-only.md
[ADR-654]: ../adr/654-two-work-tree-refusal-codes.md
[ADR-658]: ../adr/658-layout-read-surface-is-a-facade-field.md
[ADR-661]: ../adr/661-layout-config-read-includes-config-worktree.md
[ADR-664]: ../adr/664-layout-config-refusals-surface-at-open-time.md
[ADR-666]: ../adr/666-repository-format-refusals-keep-gits-config-porcelain-tier.md
[ADR-667]: ../adr/667-tsgit-accepts-every-extension-git-knows.md
[ADR-668]: ../adr/668-two-repository-format-refusal-codes.md
[ADR-669]: ../adr/669-ownership-is-an-optional-layout-probe-capability.md
[ADR-679]: ../adr/679-an-untrusted-repository-reads-as-an-empty-config-scope.md
[docs/BACKLOG.md]: ../BACKLOG.md
