# Design — SHA-256 object format

> Brief: make tsgit read, write **and create** a repository whose
> `extensions.objectFormat = sha256`. [ADR-667] ratified that tsgit accepts **every**
> `extensions.*` git knows — no divergence at the acceptance gate — and expanded scope so that
> acceptance is not a lie. The defect is larger than reported: measurement (Context) finds
> **seven** distinct outcomes rather than one `OBJECT_HASH_MISMATCH`, including a raw `TypeError`
> that escapes the error union, a `revParse` that succeeds on a repository the library cannot
> read, and — reachable today on the current public surface, with no new option —
> `openRepository({ algorithm: 'sha256' })` writing a **corrupt `.git/index`** that `status`
> then reports without error as a truncated 40-hex oid.
>
> Status: **revised against the ratified ADRs** [ADR-681], [ADR-682], [ADR-683], [ADR-685],
> [ADR-693]–[ADR-697] → self-reviewed ×3. Every decision this design raised is settled
> (§Settled decisions); the widened scope surfaced three new candidates
> (§New unsettled candidates).
>
> **What the ratification changed.** Two rulings moved the design rather than confirming it.
> [ADR-681] took write scope to **full parity** — `init` creates SHA-256 repositories and
> `clone` adopts the source's format — and [ADR-683] ratified bundle **v3 now**, against this
> doc's recommendation to defer it behind a point-of-use refusal. Bundle v3 is therefore no
> longer an out-of-scope bullet and a class-B exemption; it is a designed subsystem (§1i, §3d)
> whose sites move into the §2 sweep. The remaining six decisions were adopted as recommended.

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

**The counterweight**, and the reason "done" above is scoped to *consumers that ask*: 52 sites
never ask (§2a). `resolve-oid-prefix.ts` re-declares the widths as regex literals; ten commands
test `/^[0-9a-f]{40}$/` directly; `index-parser.ts` declares itself SHA-1-only in a doc comment;
`push.ts:115` shadows the domain `ZERO_OID` with its own 40-zero literal.

**Two entries already select the algorithm correctly.** `src/adapters/memory/memory-adapter.ts:41,51-52,64`
and `src/index.default.ts:38-43,50,83,88` take `algorithm?: 'sha1' | 'sha256'`, construct
`new MemoryHashService(algorithm)`, and set
`hashConfig: algorithm === 'sha256' ? SHA256_CONFIG : SHA1_CONFIG`. That is the wiring precedent
[ADR-693] generalises — but a correct `hashConfig` is necessary, not
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

5. **52 residual hard-coded widths** in the domain and application tiers — §2 — clustered in the
   git index, pack `.idx`, the reflog, the ten command-level `/^[0-9a-f]{40}$/` fast paths,
   prefix resolution, fsck's tree validator, tar's PAX record, the bundle header, and `ZERO_OID`.
   (46 in the original sweep; the bundle family joins under [ADR-683] — §2 states the arithmetic.)

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
enough to be misdiagnosed, which is precisely why [ADR-694] narrows it at the boundary (§6).

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
- **The refusal tiers are now three, and none of this design's refusals is on the middle one.**
  [ADR-682] inserts `assertAcceptedRepository` between `assertRepository` and
  `assertOperationalRepository`, and it holds exactly the four acceptance refusals of [ADR-668]
  and [ADR-674] — format version, unsupported extension, dubious ownership, implicit bare. Every
  refusal this design introduces sits **outside** that tier, and the three families stay
  distinguishable by *when* they can fire:

  | family | refusals | attaches | why not the acceptance tier |
  |---|---|---|---|
  | **config-value** ([ADR-696]) | `CONFIG_INVALID_ENUM_VALUE`, `CONFIG_MISSING_VALUE` on `extensions.objectFormat` | the Stage-2 layout read, i.e. **open time** ([ADR-664]) — strictly before any `assert*` runs | the extension name is one git knows and tsgit accepts; only its *value* is malformed |
  | **option/config contradiction** ([ADR-693]) | `opts.algorithm` disagreeing with the declared format | `Context` construction, open time | a caller error about the *call*, not a property of the repository ([ADR-693] consequence) |
  | **transport mismatch** ([ADR-695]) | `UNSUPPORTED_OBJECT_FORMAT`, the new push code | the fetch/push negotiation, long after open | both repositories are individually acceptable; only the **pairing** is not ([ADR-695] consequence) |
  | **point of use** ([ADR-685]) | `REPOSITORY_EXTENSION_UNSUPPORTED` for `compatObjectFormat` | the first operation that would need the extension | the gate accepts every name git knows ([ADR-667]); this refuses an *operation* on a repository git opens |

  The commands in this design reach the acceptance tier only the way every other command does —
  `bundleCreate` already calls `assertOperationalRepository`, which chains through it. This
  design adds no member to the tier and moves no call site onto it.
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
claiming `object-format=sha1` unconditionally and sends its real algorithm (§3c). [ADR-697]
closes the **v0** gap in both directions — v0 both reads the advertised `object-format` and sends
its own — so the [ADR-695] mismatch refusal is reachable on **every** transport path, not only
v2. There is no remaining protocol-version-shaped hole to document as a divergence.

**R8.** `compatObjectFormat` is refused at the point of use, per [ADR-667]'s standing rule.
git itself refuses it on this build (§1g), so there is no behaviour to be faithful to. The code
is [ADR-685]'s generic `REPOSITORY_EXTENSION_UNSUPPORTED { extension, value }`, settled once and
shared with the reftable design; this design raises it and does **not** re-specify its shape.
[ADR-685] measured the family down to exactly one member: `objectFormat` and `refStorage` are
implemented, `relativeWorktrees` is backed, `preciousObjects` is honoured by construction.

**R9.** Write/read symmetry: anything tsgit writes into a SHA-256 repository is re-openable by
canonical git, and anything git writes is re-openable by tsgit — asserted in **both**
directions by interop, per format, not only per command.

**R10.** [ADR-681] takes the write side to full parity, so `bootstrapRepository` must emit a
repository it can itself reopen: absent an object-format request it keeps writing
`repositoryformatversion = 0` with no `[extensions]`; asked for `sha256` it writes git's exact
`[extensions] objectformat = sha256` + `repositoryformatversion = 1` block (§1a), byte-for-byte
including the block **ordering** — never a half state. `clone` does not offer the choice: it
adopts the source's algorithm, because git has no `clone --object-format` (§1e).

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

**R14.** Bundles round-trip at both versions, per [ADR-683]. tsgit **reads** `# v2 git bundle`
and `# v3 git bundle` interchangeably, taking the oid width from the bundle's **own** declared
`@object-format` capability and never from `ctx.hashConfig` — git's reader does exactly that, and
proves it by running `git bundle list-heads` successfully **outside any repository** (§1i).
tsgit **writes** the version git's own selection rule picks (§1i): v2 when the repository is
SHA-1 and nothing else forces v3, v3 otherwise, with the `@object-format` line always present at
v3 — including `@object-format=sha1` on a v3 SHA-1 bundle. A v2 magic line with 64-hex oids is
never emitted; git's reader rejects it (§1i measures the exact error).

**R15.** No bundle path takes its width from the surrounding repository. `bundleListHeads`,
`bundleVerify`'s header read, its prerequisite oids, its pack trailer check and its pack walk all
frame against the **bundle's** algorithm; only the prerequisite *lookup* (`readObject`) is a
repository operation, and the cross-format case there is a distinct measured refusal (§1i, N3).

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
`CONFIG_MISSING_VALUE`. **[ADR-696] reuses both**: `CONFIG_MISSING_VALUE` unchanged for the valueless arm, and a new
`CONFIG_INVALID_ENUM_VALUE` — general from day one, because `refStorage` has the identical
grammar — for the bad-value arm. They are **config-value** refusals, a family distinct from both
the [ADR-668] gate codes and [ADR-685]'s point-of-use code, and they fire at open time, outside
[ADR-682]'s tier.

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
| **bundle** | **`# v2 git bundle` → `# v3 git bundle`** | a **capability block** `@object-format=sha256\n` follows the signature; then the same prerequisite/ref body at 64 hex — full grammar, selection rule and read semantics in **§1i** | `# v3 git bundle\n@object-format=sha256\nc7fe…` |

**Three of these are hash-identifier fields, not widths** (`.rev`, midx, commit-graph). A writer
that emits a hard-coded `1` produces a file git will reject or misread even when every width is
right — this is the single most likely silent-corruption bug in the change, and it is a
**write-path** bug, so read-only testing cannot catch it.

**Bundle is a format-version change, not a width change** — the only row here that needs new
parsing and new emission rather than a widened constant, and the reason [ADR-683] makes it a
designed subsystem (§1i, §3d) rather than a sweep entry. It is also the only format whose width
is declared **inside the artefact** rather than by the repository, which is why §1i is a section
of its own and R15 exists.

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
already establish as the reason to carry two codes rather than one, and [ADR-695] answers it the
same way: `UNSUPPORTED_OBJECT_FORMAT` widened in place for the fetch/clone line, one new code for
the push line.

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
the gate and refused at the point of use (R8) with [ADR-685]'s generic
`REPOSITORY_EXTENSION_UNSUPPORTED { extension, value }` — a code whose shape the reftable design
owns and this one only raises. [ADR-685] measured this to be the family's **only** member.

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

#### 1i. Bundle v2 and v3 — the format [ADR-683] brings into scope

Same probe conditions. Two fixtures, one per algorithm, each with two commits, an annotated tag,
two branches and `HEAD`. Bundles are produced with `git bundle create`, read back with
`git bundle verify` / `list-heads` / `clone` / `fetch`, and hand-crafted for the refusal rows.

**The signature bytes**, `xxd`-verified:

| bundle | leading bytes |
|---|---|
| sha1, default | `23 20 76 32 20 67 69 74 20 62 75 6e 64 6c 65 0a` = `# v2 git bundle\n`, then straight to the body |
| sha256, default | `# v3 git bundle\n@object-format=sha256\n` = `2320763320…0a406f626a6563742d666f726d61743d7368613235360a` |
| sha1, `--version=3` | `# v3 git bundle\n@object-format=sha1\n` |

**Header grammar (v3).** Every line ends LF; the header ends at a blank line, and the packfile
starts at the byte after it:

```
# v3 git bundle LF
( @<name>[=<value>] LF )*        capability block
( -<oid> SP <comment> LF )*      prerequisites
( <oid> SP <ref-name> LF )*      refs
LF                               terminator
PACK…
```

v2 is the same grammar minus the capability block — and an `@` line in a v2 bundle is **not** a
capability, it is a malformed header line (refusal table below). The prerequisite comment is the
boundary commit's subject (`-<oid> c1`), and `git bundle create main~1..main` on both algorithms
confirms prerequisites sit **after** the capability block and **before** the ref lines.

Ordering rules, each measured rather than inferred:

- Capabilities come first, before any oid-bearing line.
- Capability order **among themselves is free** — hand-swapping `@filter` ahead of
  `@object-format` still parses, exit 0.
- But `@object-format` must precede the **first oid line**: the reader has no algorithm until it
  reads that capability, so a v3 bundle with no capability block fails on its first ref line
  rather than on the missing capability.
- A duplicate `@object-format` is **last-wins** — `sha1` then `sha256` parses the 64-hex body
  fine; `sha256` then `sha1` fails on the first 64-hex ref line. The same resolution as the
  config key (§1b), which is a pleasing symmetry and not a coincidence worth relying on: it is
  measured on both sides.

**Capabilities in git 2.55.0: exactly two** — `object-format` and `filter`. Nothing else is
accepted (`@bogus=1` is refused), and when both are emitted the order is `@object-format` then
`@filter`.

**Which version git writes — this corrects [ADR-683]'s premise.** ADR-683's consequence line
reads *"v2 stays the written format for SHA-1 repositories, matching git — v3 is emitted only
when the object format requires it."* The object format is **one of three** triggers, so the
premise is incomplete rather than wrong; the decision it supports is unaffected, but an
implementation that keys only on the algorithm would emit v2 where git emits v3:

| invocation | repo | git writes |
|---|---|---|
| `git bundle create <f> --all` | sha1 | **v2**, no capability block |
| `git bundle create <f> --all` | sha256 | **v3** + `@object-format=sha256` |
| `--filter=blob:none` | sha1 | **v3** + `@object-format=sha1` + `@filter=blob:none` |
| `--filter=blob:none` | sha256 | **v3** + both capabilities, in that order |
| `--version=3 <f> --all` | sha1 | **v3** + `@object-format=sha1` |
| `--version=2 <f> --all` | sha256 | `fatal: cannot write bundle version 2 with algorithm sha256`, exit **128**, no file written |
| `--version=2 --filter=… ` | sha1 | `fatal: cannot write bundle version 2 with algorithm sha1`, exit **128**, no file written |
| `--version=1` / `--version=4` | either | `fatal: unsupported bundle version <n>`, exit **128** |

So the rule is **v3 iff the algorithm is not sha1, or a filter is present, or v3 was asked for**;
and v2 is *refused*, never silently upgraded, when v3 is required. Two notes for whoever
implements the interop rows: the `--version` option must precede the file argument
(`git bundle create --version=3 <file> --all`) — placed after it, rev-list consumes it and git
says `error: unrecognized argument: --version=3`, which is a probe trap, not a git quirk; and the
v2-plus-filter refusal reuses the *algorithm* wording (`…with algorithm sha1`) even though the
filter is what forces v3, so the interop reconstruction must not assume the message names the
real cause.

**The read side accepts both versions, and does not consult the repository.**

| read | verdict |
|---|---|
| v2 in a sha1 repo · v3-sha1 in a sha1 repo · v3-sha256 in a sha256 repo — `verify`, `list-heads` | exit **0** |
| `git bundle list-heads` **outside any repository**, v2 and v3-sha256 | exit **0** both, printing 40- and 64-hex oids respectively |
| cross-format **complete** bundle (no prerequisites), `verify` | `<path> is okay`, exit **0**, in both directions |
| cross-format bundle **with** prerequisites, `verify` | `fatal: missing mapping of <oid> to <local-algo>`, exit **128** |
| same-format bundle whose prerequisites are absent, `verify` | `error: Repository lacks these prerequisite commits:` then one `error: <oid> ` line each, exit **1** |
| `git clone <sha256 v3 bundle> <dst>` | succeeds; `rev-parse --show-object-format` in the clone is **sha256** — the bundle's format is adopted exactly as the wire's is (§1e) |
| `git fetch <cross-format bundle>` | header parses, then index-pack dies: `fatal: pack is corrupted (SHA1 mismatch)` (sha1 repo ← sha256 bundle) or `fatal: early EOF` (sha256 repo ← sha1 bundle), exit **1** |

The list-heads-outside-a-repository row is the load-bearing one: **the bundle's own header is the
sole authority on its oid width.** No bundle read may take a width from `ctx.hashConfig` (R15).

**`git bundle verify` never opens the pack.** Flipping one byte inside the packfile of an
otherwise valid bundle still verifies `is okay`, exit 0 — in the matching repository *and* in a
cross-format one. `verify` is header parse plus prerequisite reachability, nothing more. tsgit's
`bundleVerify` is stricter today: it runs `verifyPackTrailer` and `walkPackEntries`
(`src/application/commands/bundle-verify.ts:43,46`). That is a **pre-existing** divergence, not
one this change creates, and it is not in scope here; R15's rule keeps the two tools agreeing on
every *well-formed* bundle, because once the pack is framed against the bundle's own algorithm
tsgit's extra work simply succeeds. The disagreement survives only for a corrupt pack, where
tsgit reports and git does not.

**Header refusals, pinned line-for-line.** Crafted headers over a real sha256 v3 bundle; the same
message and exit come from both `verify` and `list-heads`:

| crafted header | git |
|---|---|
| `@bogus=1` | `error: unknown capability 'bogus=1'`, exit 1 — the message carries the whole `name=value` text, not just the name |
| `@object-format` with no `=` | `error: unknown capability 'object-format'`, exit 1 — a valueless capability is a *different key*, not a missing value |
| `@` alone | `error: unknown capability ''`, exit 1 |
| `@object-format=sha512` | `error: unrecognized bundle hash algorithm: sha512`, exit 1 |
| `@filter=bogus` | `fatal: invalid filter-spec 'bogus'`, exit **128** — the spec is validated eagerly, and this is the only fatal in the table |
| v3 with **no** capability block | `error: unrecognized header: <first ref line> (80)`, exit 1 — the parenthesised number is the line's byte length |
| v3 with `@object-format` **after** the first ref line | the same `unrecognized header` on that ref line |
| v2 magic **plus** a capability line | `error: unrecognized header: @object-format=sha256 (21)`, exit 1 |
| **v2 magic with 64-hex oids** | `error: unrecognized header: <ref line> (80)`, exit 1 — the measured proof that the deferred-and-write-v2-at-64-hex option ADR-683 rejected produces a file no git reads |
| a non-bundle file | `error: '<path>' does not look like a v2 or v3 bundle file`, exit 1 |

Three distinctions the mapping in §3d must preserve: *not a bundle* (the signature line), *not
header-shaped* (`unrecognized header`, carrying the line and its length), and *unknown
capability* (carrying the capability text). tsgit's `bundleBadHeader(path, reason)` already
carries a `reason` discriminator with exactly two values — `'not-a-bundle' | 'malformed-header'`
(`src/domain/commands/error.ts:769`) — so this is a widening of an existing enum, not a new code.

### 2. The width sweep — every site, classified

`src/` was swept systematically for literal `20` / `32` / `40` / `64`, every `{40}` / `{64}` /
`{38}` / `{24}` regex, `repeat(40)`, `slice(0, 40)`, `length === 40`, `padEnd(40, …)`,
`digestLength`, `hexLength`, `sha1` / `sha256`, and every zero-oid and empty-object producer.
**186 sites** classified. Counts **as revised by [ADR-683]**: **A must generalise 52 ·
B correctly SHA-1-only 1 · C already dual 72 · D not a hash width 61.**

**The reclassification, stated plainly.** The original sweep found A 46 · B 7, and [ADR-694]
records the 46. Implementing bundle v3 moves the whole bundle family — `types.ts:4` plus the five
`parse-bundle-header.ts` sites — out of class B and into class A, because their correctness was
*conditional on v3 staying unsupported* (§2b said so explicitly). 46 + 6 = **52**; B keeps one
member. The total is unchanged, no site changed meaning, and [ADR-694]'s decision is untouched:
the repository-aware predicate now serves 52 call sites instead of 46. **This is the one place
where the v3 work and the width sweep meet, and [ADR-683]'s first consequence names it** — the
two are one work item at `parse-bundle-header.ts`, not two sections to reconcile during
implementation. §3d designs that meeting point.

**An enumeration defect this revision found, and did not paper over.** §2a's twelve cluster
subtotals — 8 + 12 + 2 + 10 + 3 + 1 + 2 + 2 + 6 + 3 + 1 + 4 — sum to **54**, not 52. At least one
site is double-counted: `src/application/commands/push.ts:115` is named both as the `ZERO_OID`
local shadow and as the tenth command-level fast path, because it is genuinely both. That
accounts for one; the remaining discrepancy of one predates this revision and is not resolvable
by re-reading the doc. Since §2a is the **implementation map** rather than decoration, the plan
must reconcile the enumeration against the classification — counting distinct `file:line` pairs,
not cluster subtotals — before the first slice, and the reconciled list is what the sweep is
measured against. No decision depends on the number: [ADR-694]'s predicate serves however many
there turn out to be, and the per-site table in §2a is the part that carries the work.

The shape of the result matters more than the count: `src/domain/storage/` is *almost entirely*
already dual (`midx.ts`, `rev-index.ts`, `bitmap.ts`, `pack-entry.ts`) with two outliers, and
the application tier is dual almost everywhere. The A-sites fall into **twelve named clusters**,
every one of which §2a enumerates site by site — there is no "and the rest" bucket.

#### 2a. Class A — must generalise (52)

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
already dual, so most become one call — but "already dual" is not "correct" ([ADR-694]), and the
call must be to the repository-aware predicate, never to the config-free one (§6).

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

**Bundle header, `src/domain/bundle/` (6) — moved here from class B by [ADR-683].** These six
were *correct as written* while v3 was refused, and became bugs the moment v3 landed. They are
the only class-A cluster whose width comes from the **artefact** rather than the repository
(R15), so the fix is not "thread `ctx.hashConfig`" — it is "thread the algorithm the header just
declared":

| site | source | why |
|---|---|---|
| `types.ts:4` | `export type BundleHashAlgorithm = 'sha1';` | a one-member union while `BundleVersion = 2 \| 3` already admits 3; widens to `'sha1' \| 'sha256'` |
| `parse-bundle-header.ts:14` | `const HEX_PATTERN = /^[0-9a-f]{40}$/;` | the site [ADR-683] names; becomes a per-parse predicate keyed on the declared algorithm |
| `parse-bundle-header.ts:16` | `const isHex40 = (s) => HEX_PATTERN.test(s)` | the shared helper both oid parsers call |
| `parse-bundle-header.ts:38` | `return { version: 2, hashAlgorithm: 'sha1' }` | correct for v2 and only v2 (§1i); v3 must read the capability instead |
| `parse-bundle-header.ts:46` | `if (!isHex40(oidStr))` in `parsePrerequisiteLine` | prerequisite oid width |
| `parse-bundle-header.ts:59` | `if (!isHex40(oidStr))` in `parseRefLine` | ref oid width |

Two adjacent sites carry **no width literal**, so the sweep never counted them, yet they are in
scope under [ADR-683] and must not be discovered during implementation:
`serialize-bundle-header.ts:4,28` (`MAGIC_V2` and the `if (input.version !== 2) throw` guard) and
`bundle-create.ts:237` (`const VERSION: BundleVersion = 2`). §3d covers all three.

**Wire protocol, `src/domain/protocol/` (3)** — §3c.

**Bootstrap, `src/application/commands/internal/bootstrap.ts:8` (1).**
`readonly hash?: 'sha1'` — a single-valued option **nobody passes** (`init.ts:32` and
`clone.ts:94` both omit it). Dead today; the live parameter under [ADR-681].

**The four `SHA1_CONFIG` pins (4)** — `src/index.node.ts:109`, `src/index.browser.ts:84`,
`src/adapters/node/node-adapter.ts:73`, `src/adapters/browser/browser-adapter.ts:44`, each
paired with a no-argument hash-service constructor (Context).

#### 2b. Class B — correctly SHA-1-only (1), after the conditional expired

The original sweep put seven sites here and said so conditionally: six of them were the bundle
family, correct **only as long as v3 stayed unsupported**. [ADR-683] ratified v3, the condition
expired, and those six are now class A (§2a). The reasoning was right and the premise changed —
which is exactly why the class was written as conditional rather than as a clean negative.

One member survives: `src/domain/protocol/v2/capabilities.ts:5`
(`DEFAULT_OBJECT_FORMAT = 'sha1'`). An **absent** `object-format` capability means sha1 by
protocol spec, on v2 and — per [ADR-697], now that tsgit parses it there too — on v0. The default
value is correct and stays. Its *reuse as the only accepted value* is the class-A bug (§3c), not
the default itself, and widening the accepted set must not touch the default.

"`# v2 git bundle` ⟹ SHA-1 oids" remains a genuine format invariant on the **read** side and is
preserved by §3d rather than deleted: §1i measures git rejecting a v2 header carrying 64-hex
oids. What changed is that tsgit no longer gets to treat "v2" as "the only version", so the
invariant becomes a branch instead of a file-level assumption.

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
| bundle | `parse-bundle-header.ts:125` `parseBundleHeader` | `serialize-bundle-header.ts:23` `serializeBundleHeader` | **not a width fix — a format-version implementation** ([ADR-683]). v3 is refused in three places (`parse:32-34`, `parse:101-113`, `serialize:28`), the `@` capability line is actively rejected as `malformed-header` (`parse:91-92`), and the width is `/^[0-9a-f]{40}$/` (`parse:14`). Designed in **§3d**, which is also where the §2 sweep and the v3 work are reconciled into one edit. |

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
   scope to remove. **[ADR-697] closes it, both directions**: v0 parses the advertised
   `object-format` and adds the token to `CLIENT_CAPABILITIES_FETCH` and
   `CLIENT_CAPABILITIES_PUSH`. Both verbs then refuse a mismatch on both protocols, which is what
   makes the push refusal — a v0-shaped verb — reachable at all.

`UNSUPPORTED_OBJECT_FORMAT` carries `{ format }` — one field. §1e's fetch refusal reconstructs
`client <A>; server <B>`, which needs **two**. **[ADR-695] widens the payload in place** (the
peer's `format` plus the new `local`) and lands **one new code** for the push line, so no shipped
code is removed and the two git conditions stay distinguishable by code rather than by verb.

#### 3d. Bundle v2 and v3 — read and write

[ADR-683] puts this in scope. §1i is the measurement; this is the shape. Four rules carry it, and
the first is the one that makes the rest fall out.

**Rule 1 — the bundle declares its own width (R15).** `ParsedBundleHeader` already returns
`hashAlgorithm`; today it is a one-member union filled with a literal. It becomes the parse's
*output and internal driver*: `parseMagicLine` returns `{ version: 2, hashAlgorithm: 'sha1' }`
for v2 exactly as now, and for v3 returns the version with the algorithm **undetermined**, which
the capability block then fixes before any oid line is read. §1i's "no capability block ⇒ the
first ref line is `unrecognized header`" row is not an edge case to tolerate — it is the direct
consequence of that ordering, and reproducing it falls out of implementing the reader in git's
order rather than pre-scanning for the capability.

`ctx.hashConfig` appears nowhere in `parse-bundle-header.ts`, which stays a pure domain function
over bytes. It is the width source for `bundleVerify`'s *repository* lookups only.

**Rule 2 — the header parse gains a capability phase, and `bundleBadHeader` gains reasons.** The
loop over `contentLines` becomes three ordered phases matching §1i's grammar: capabilities while
the line starts with `@` **and** the version is 3; then prerequisites (`-`); then refs. The
existing `else if (line.startsWith('@')) throw bundleBadHeader(path, 'malformed-header')` stays —
but only for **v2**, where §1i confirms an `@` line is still a malformed header
(`unrecognized header: @object-format=sha256 (21)`).

The `reason` discriminator widens from two values to four, one per distinction git actually
draws (§1i): `'not-a-bundle'`, `'malformed-header'`, `'unknown-capability'`, and
`'unknown-hash-algorithm'`. Each carries the fields its git line needs — the capability text for
the first, the algorithm value for the second — per [ADR-249], with no rendered string. This is a
widening of an existing code's payload, in the same spirit as [ADR-695]'s, and `BUNDLE_BAD_HEADER`
is already exported, rendered and documented, so it is a docs row and an `api.json` regeneration.
The renderer needs the same widening: `src/domain/error.ts:531` returns one line
(`'<path>' does not look like a v2 or v3 bundle file`) for **every** reason today, where §1i
measures three distinct git lines. It branches on `reason` — which is what having the
discriminator is for, and the reason the existing code already carries one.

`BUNDLE_UNSUPPORTED_VERSION` does **not** disappear: §1i measures `--version=1` and `--version=4`
refused as `fatal: unsupported bundle version <n>`, so the code keeps its meaning and merely stops
firing on 3. Its docs row — which today says v3 is unsupported — is falsified by this change in
exactly the way [ADR-695] falsifies the `UNSUPPORTED_OBJECT_FORMAT` row, and is corrected here.

**Rule 3 — the writer selects the version rather than being told it.** `serializeBundleHeader`'s
`if (input.version !== 2) throw bundleUnsupportedSerializeVersion(input.version)` becomes a
two-branch emitter: v2 emits the magic and nothing else; v3 emits the magic then
`@object-format=<algorithm>\n` — **always**, including `sha1` (§1i). Prerequisite sorting, ref
order and the blank terminator are unchanged, so the v2 goldens must stay byte-identical (R6).

`bundle-create.ts:237`'s `const VERSION: BundleVersion = 2` becomes the measured selection rule
(§1i): **v3 iff the repository's algorithm is not sha1, or a filter is present, or v3 was asked
for.** tsgit's `BundleCreateOptions` has neither a filter nor a version today, so the rule
degenerates to "v3 iff sha256" *for the surface as it stands* — but it must be written as the
full rule with the two absent inputs defaulted, not as an algorithm test, or the first of N1/N2
to land turns a correct implementation into a wrong one silently. The v2-refusal half of the rule
(`cannot write bundle version 2 with algorithm <a>`) has no reachable trigger until N1 is
answered; `bundleUnsupportedSerializeVersion` is the code that already fits it.

**Rule 4 — the commands.** `bundleCreate` picks the version (rule 3) and emits the header; its
`BundleCreateResult.version` already reports it, so callers see which version they got with no
new field. `bundleListHeads` and `bundleVerify` already thread `header.version` and
(`bundle-verify.ts:55`) `header.hashAlgorithm` into their results — those fields simply stop
being single-valued, which is the whole public-surface change on the read side.
`bundleVerify`'s pack work (`verifyPackTrailer`, `walkPackEntries`) moves from `ctx.hashConfig`
to the bundle's declared algorithm, per R15; its prerequisite lookup stays a repository read and
is the one place the two formats meet (N3). tsgit has **no** `unbundle`, and no clone- or
fetch-from-bundle path — `clone.ts` and `fetch.ts` never mention bundles — so §1i's clone and
fetch rows are measurement for the interop reconstruction and for N1's context, not surfaces to
build. Adding one would be a new command, not part of this change.

**The Stryker suppression at `parse-bundle-header.ts:90-92` must be re-proven, not carried.** Its
text asserts that an `@`-prefixed line "never holds a 40-hex oid before a space, so the false
branch also throws" — a claim about a structure that no longer exists once the `@` branch is
version-conditional and the width is no longer 40. Per the repository's own rule that equivalence
proofs are structure-specific, the comment is deleted with the structure and a fresh proof is
written against the new one, or a kill test replaces it. The same applies to
`findBlankLineOffset`'s suppression (`:19`) only if the scan changes; it does not, so that one
stands.

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
   *created* can therefore never have its format detected; it can only be told — which is why
   [ADR-693] keeps the explicit option even though [ADR-681] makes detection the common path.

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
`fmt` dies there (Context). **[ADR-693] settles it: both channels, and the option wins.** The
layout channel widens (`objectFormat` on `RepositoryFormat`, surfaced as an additive optional
field on `RepositoryLayout` per [ADR-658]) and serves the three async entries; the explicit
`algorithm` option serves the two sync factories and `init`, which structurally cannot detect
(facts 2 and 3 above). When both are present and disagree, the **open refuses** — that refusal is
the load-bearing half of the decision, because without it (c) would re-open the
`ctx.hash` / `ctx.hashConfig` desync that already exists today (Context §3, R3). Per [ADR-693]'s
own consequence, it is an option/config conflict and sits **outside** [ADR-682]'s acceptance tier.

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
  declared width. R3 and [ADR-694] address it.
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
  identity in a size. [ADR-694] adds `algorithm` to `HashConfig`, so that test becomes a name
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
  **prefix**. This is the trap in the most obvious remediation, and it is why [ADR-694] chose a
  repository-aware `isOid(value, hashConfig)` over reusing the dual predicate. The bundle sites
  (§2a) are the one group the repository-aware predicate does **not** serve: their authority is
  the artefact's declared algorithm, not the repository's (R15), so they take the same predicate
  with the *bundle's* config — which is only safe because the predicate takes its config as an
  argument rather than reading a context.

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
| bundle | v3 refused, width 40 | v2 only | no — symmetrically absent, so a tsgit-only round-trip passes at both ends while git reads neither | `git bundle verify` on a tsgit-written v3 bundle, and tsgit reading a git-written v3 bundle — **both directions required** ([ADR-683]) |
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
| `extensions.objectFormat = <bad>` | `error: invalid value for 'extensions.objectformat': '<v>'` + `fatal: bad config line N in file <F>` | **new `CONFIG_INVALID_ENUM_VALUE { key, source, value }`** ([ADR-696]), joining the config-error family beside `CONFIG_BAD_BOOLEAN_LITERAL`; `refStorage` is its second caller from day one |
| valueless `extensions.objectFormat` | `error: missing value for 'extensions.objectformat'` + `fatal: bad config line N in file <F>` | **`CONFIG_MISSING_VALUE` reused unchanged** (`{ key, source, line }`) ([ADR-696]) — a docs key-list row, not a code |
| fetch/clone algorithm mismatch | `fatal: mismatched algorithms: client <A>; server <B>` | **`UNSUPPORTED_OBJECT_FORMAT { format }` already exists** (`src/domain/protocol/error.ts:35,102-103`; rendered `src/domain/error.ts:419`; documented `docs/use/errors.md:180`) — but carries **one** field where the reconstruction needs two, and its docs row currently reads "tsgit only supports sha1 repositories", which this change falsifies. **[ADR-695] widens it in place**: `format` keeps meaning the peer's, `local` is added |
| push algorithm mismatch | `fatal: the receiving end does not support this repository's hash algorithm` | **one new code** ([ADR-695]), reachable on v0 as well as v2 once [ADR-697] lands — push is the v0-shaped verb, so without ADR-697 this row would be unreachable |
| `extensions.compatObjectFormat` at the point of use | `fatal: compatibility hash algorithm support requires Rust` | **`REPOSITORY_EXTENSION_UNSUPPORTED { extension, value }`** ([ADR-685]) — shared with the reftable design, shape settled there, *not* the [ADR-668] gate codes |
| `opts.algorithm` contradicting the repository's declared format | none — tsgit-only | new ([ADR-693]); a caller error, not a faithfulness surface, and outside [ADR-682]'s tier |
| bundle header line that is not header-shaped, unknown capability, unknown hash algorithm (§1i) | `error: unrecognized header: <line> (<len>)` · `error: unknown capability '<text>'` · `error: unrecognized bundle hash algorithm: <v>` | **`BUNDLE_BAD_HEADER`'s `reason` widens from two values to four** (§3d) — an existing code's payload, not a new member |
| bundle version 1 or 4 | `fatal: unsupported bundle version <n>` | `BUNDLE_UNSUPPORTED_VERSION` **keeps its meaning** and stops firing on 3; its docs row, which today says v3 is unsupported, is falsified by [ADR-683] and corrected here |
| `bundle create` asked for v2 where v3 is required | `fatal: cannot write bundle version 2 with algorithm <a>` | `bundleUnsupportedSerializeVersion` already fits — but note it emits the **same** `BUNDLE_UNSUPPORTED_VERSION` code as the read-side refusal and is told apart only by `path` being absent (`src/domain/error.ts:533-536`), a sentinel-shaped distinction; unreachable until N1 is answered, and N1 is where it would first matter |
| cross-format bundle prerequisites | `fatal: missing mapping of <oid> to <algo>`, exit 128 | **none — see N3**, the one genuinely open shape the bundle work surfaces |

Two rows are semantic changes to **shipped public codes** rather than additions, and both carry
the same obligation — a `docs/use/errors.md` rewrite and a `reports/api.json` regeneration:
`UNSUPPORTED_OBJECT_FORMAT` narrows from "not sha1" to "not this repository's algorithm"
([ADR-695]), and `BUNDLE_UNSUPPORTED_VERSION` stops meaning "v3" and starts meaning "not 2 or 3"
([ADR-683]). Neither is a new capability; both are documentation defects the moment their ADR
lands, so neither is a follow-up.

## Settled decisions

Every candidate this design raised has been ratified. Six were adopted as recommended; **two
moved the design** and are marked. The table is the record — the sections above are written
against these outcomes, not against the alternatives.

| # | Question | Outcome | ADR | Effect on this design |
|---|---|---|---|---|
| D1 | How the object algorithm reaches the `Context`, given that `finishLayout` discards `fmt`, the two sync factories cannot detect without becoming `async`, and `init`'s layout is synthetic. | **Both channels; the explicit option wins; a contradiction between them refuses the open.** | [ADR-693] | §4. The layout channel widens (`objectFormat` on `RepositoryFormat`, an additive optional field on `RepositoryLayout` per [ADR-658]); the `algorithm` option serves the sync factories and `init`. The contradiction refusal is what keeps R3 honest and closes a desync that exists **today**, independent of SHA-256. It is an option/config conflict and sits **outside** [ADR-682]'s acceptance tier. |
| D2 | Scope of the write side. | **Full parity — `init` creates SHA-256 repositories, `clone` adopts the source's format.** *Ratified as recommended, and the widest of the three options.* | [ADR-681] | §1a's config bytes become a write contract (R10); `BootstrapOptions.hash?: 'sha1'` — a dead single-valued field nobody passes — becomes the live parameter it was scaffolded to be; the shipped `.git/index` corruption (Context, R12) is fixed as a consequence rather than a hotfix; and R9's both-directions interop becomes assertable per format. It is also what makes [ADR-683] necessary: a format tsgit can *create* must not have a command that emits an unreadable artefact. |
| D3 | The mechanism for the width sweep and for keeping `ctx.hash` and `ctx.hashConfig` honest. | **A repository-aware `isOid(value, hashConfig)`, plus `algorithm` on `HashConfig`.** | [ADR-694] | §2, §6. One predicate, one rule, one place for mutation to prove it — instead of 46 (now 52) independently-mutable literals. `looksLikeObjectId` stays as a *format* check under a name that says so. `HashConfig` is public (`src/public-types.ts:86`), so this is an `api.json` change. The bundle sites are the one group that passes the **bundle's** config rather than the repository's (R15) — safe only because the predicate takes its config as an argument. |
| D4 | Transport refusal shape, given one existing code carrying one field where git has two conditions. | **Widen `UNSUPPORTED_OBJECT_FORMAT` in place (`format` + new `local`); one new code for the push direction.** | [ADR-695] | §3c, §7. No shipped code is removed. The existing docs row ("tsgit only supports sha1 repositories") is falsified by [ADR-681] and corrected in this change. Under D2's full parity there is no `clone` refusal to shape at all — `clone` adopts the source's algorithm (§1e, §1i). |
| D5 | The point-of-use refusal family for accepted-but-unbacked extensions. | **One generic `REPOSITORY_EXTENSION_UNSUPPORTED { extension, value }`.** | [ADR-685] | R8. **Shared with the reftable design and settled once there — this design does not re-specify its shape**, it only raises it. [ADR-685]'s own measurement shrank the family to exactly one member, `compatObjectFormat` (§1g), because `objectFormat` and `refStorage` are now implemented and `relativeWorktrees` / `preciousObjects` are backed. The code stays general so a future unbacked name joins by name, with no new code and no new ADR. |
| D6 | Where `extensions.objectFormat`'s own value refusals live. | **Reuse `CONFIG_MISSING_VALUE` for the valueless arm; add `CONFIG_INVALID_ENUM_VALUE` for the bad-value arm.** | [ADR-696] | §1b, §7. Both join the **config-value** family, which is a third tier distinct from [ADR-668]'s gate refusals and [ADR-685]'s point-of-use refusals. `refStorage` is `CONFIG_INVALID_ENUM_VALUE`'s second caller from day one, so it is general by construction rather than by aspiration. These fire at open time ([ADR-664]) — before any `assert*` tier. |
| D7 | Bundle v3. | **Implement now.** *Ratified **against** this design's recommendation to defer behind a point-of-use refusal.* | [ADR-683] | The one real change in this revision. §1i pins the format, §3d designs read and write, §2a absorbs six sites from class B, and the interop battery gains four rows. The deferral this design argued for would have left one command working in a SHA-1 repository and refusing in a SHA-256 one — the worst boundary in the design, as it said itself; the ratification removes it. The counter-argument the doc made (v3 roughly doubles the domain surface) was measured wrong on one point: §1i shows the v3 grammar is four lines of ordering rules and two capabilities, and the reader change is mostly *deleting* three refusals. |
| D8 | The protocol-v0 `object-format` gap. | **Close it, both directions.** | [ADR-697] | §3c, R7. v0 parses the advertised capability and adds the token to `CLIENT_CAPABILITIES_FETCH` / `CLIENT_CAPABILITIES_PUSH`, sharing `parseCapabilities` and `negotiateCapabilities` with the existing paths. Without it the push refusal — a v0-shaped verb — would be unreachable, so [ADR-695]'s new code would ship dead. |

**What did not change.** [ADR-683] is the only ratification that redirected work. [ADR-681] took
the widest option, which this design recommended; the remaining six were adopted as recommended
with no user judgment required. Nothing above reopens a measurement: §1's matrix and §2's
classification are the same evidence, re-partitioned once (§2's arithmetic) and extended once
(§1i).

**One correction the revision owes.** [ADR-683]'s consequence line states that *"v2 stays the
written format for SHA-1 repositories … v3 is emitted only when the object format requires it."*
§1i measures the object format to be **one of three** triggers — a filter or an explicit
`--version=3` also force v3, on a SHA-1 repository. The decision is unaffected; the premise is
incomplete, and §3d's rule 3 is written against the measured rule rather than the ADR's summary
of it. Recorded here rather than by editing the ADR, which is a record of a ratification.

## New unsettled candidates

The widened scope surfaced three. **N1** and **N2** are public-surface questions the bundle work
raises; **N3** is a measured git behaviour with no tsgit shape. None blocks the sections above —
each has a stated default that §3d already assumes — but each is a real choice.

| # | Choice | Alternatives (≤3) | Recommendation | Why |
|---|---|---|---|---|
| **N1** | **Does `bundleCreate` expose an explicit bundle version?** §1i measures git accepting `--version=3` on a **SHA-1** repository (writing `@object-format=sha1`) and refusing `--version=2` on a SHA-256 one (`fatal: cannot write bundle version 2 with algorithm sha256`, exit 128). tsgit's `BundleCreateOptions` has no `version`; `bundle-create.ts:237` pins `const VERSION: BundleVersion = 2`. Under [ADR-683] the pin becomes a selection rule (§3d rule 3) — the question is whether the caller may override it. | **(a) No option** — the version is derived from the repository's algorithm alone; a SHA-1 repository can only produce v2 through tsgit. **(b) `version?: 2 \| 3` on `BundleCreateOptions`**, defaulting to the derived value, with the v2-where-v3-is-required refusal reproduced. **(c) No option now, but write the selection rule with the override parameter already threaded** and unexposed, so (b) is a surface change and not a logic change. | **(b)** | This is a **format** selector, not a rendering one, so [ADR-249] does not exclude it — it changes the bytes on disk, exactly as `init`'s object-format option does under [ADR-681]. (a) is a real capability gap of the kind [ADR-683] just closed elsewhere: git can hand a SHA-1 v3 bundle to a tool that wants one, and tsgit could not. (a) also leaves the measured `cannot write bundle version 2 with algorithm <a>` refusal permanently unreachable, so the interop suite could pin git's row but never tsgit's twin — a co-truth row that is only half true. (c) is honest about scope but leaves a parameter with one caller and one value, which is precisely the `BootstrapOptions.hash?: 'sha1'` shape [ADR-681] had to resurrect; the repository has now paid that cost once. (b)'s cost is one optional field, one `api.json` regeneration and one `docs/use/commands/bundle.md` row. Note the option is *not* symmetric with git's CLI in one respect worth documenting: git's `--version` must precede the file argument or rev-list eats it (§1i), a CLI parsing artefact with no library analogue. |
| **N2** | **What does the reader do with a `@filter` capability?** §1i: `filter` is the *other* of git's exactly-two bundle capabilities, git emits it whenever `--filter` is passed (forcing v3 even on SHA-1), and it **validates the spec eagerly** — `@filter=bogus` is `fatal: invalid filter-spec 'bogus'`, exit **128**, the only fatal in the header-refusal table. tsgit has an object-filter vocabulary already (`src/domain/protocol/object-filter.ts`, used by `clone.ts` / `fetch.ts`) but no bundle filter concept and no partial-bundle support. | **(a) Parse, validate against the existing filter vocabulary, and expose it** on `ParsedBundleHeader` / `BundleVerifyResult` — reproducing git's eager `invalid filter-spec` refusal. **(b) Parse and ignore** — accept the line so the bundle reads, drop the value, expose nothing. **(c) Refuse a filtered bundle** with [ADR-685]'s point-of-use code — tsgit cannot honour a partial bundle, so it declines to pretend. | **(a)** | tsgit already owns a filter-spec parser with its own refusals, so (a) reuses a tested component rather than adding one, and it is the only option that reproduces the measured 128. (b) is the silent-acceptance shape this whole change exists to remove: a caller would receive a bundle marked complete when its objects are deliberately absent, and R9's git-reads-tsgit direction cannot see it because tsgit never *writes* a filter. (c) over-refuses — git reads a filtered bundle's header perfectly well, `list-heads` on one succeeds, and a filtered bundle is only *incomplete*, not unreadable; refusing it would be a new divergence created by a change whose purpose is removing one. The open sub-question (a) leaves — whether `bundleVerify` should treat a filtered bundle's missing objects as a verification failure — is genuinely out of scope, because tsgit's `verify` already diverges from git's by walking the pack at all (§1i), and that divergence is pre-existing. |
| **N3** | **The cross-format bundle prerequisite refusal.** §1i measures two *different* git outcomes that tsgit currently cannot tell apart: a prerequisite the repository simply lacks is `error: Repository lacks these prerequisite commits:` + one line per oid, exit **1**; a prerequisite in the *wrong algorithm* is `fatal: missing mapping of <oid> to <local-algo>`, exit **128**. tsgit's `bundleVerify` calls `readObject(ctx, prereq.oid)` and maps `OBJECT_NOT_FOUND` to `missingPrerequisites` (`bundle-verify.ts:96-103`), so a 64-hex prerequisite in a SHA-1 repository would be reported as *absent* — git's exit-1 shape for git's exit-128 condition. | **(a) A new typed refusal** raised before the lookup when `header.hashAlgorithm` differs from the repository's declared algorithm, carrying `{ oid, bundleAlgorithm, localAlgorithm }`. **(b) Reuse [ADR-695]'s widened `UNSUPPORTED_OBJECT_FORMAT`** — it already means "this peer's format is not one we can work with here", and a bundle is a peer in every sense but the socket. **(c) Report it through the existing `missingPrerequisites` field** and accept the divergence, documented. | **(a)** | (c) is wrong on the measurement: git distinguishes the two conditions by *exit code*, and a caller acts differently — "fetch more history" versus "this bundle can never apply here". Collapsing them re-creates the exact failure Context documents, where one cause produced four diagnoses. (b) is tempting and nearly right, but [ADR-695]'s consequence scopes that code to a **transport** concern where "both repositories are individually acceptable; only the pairing is not" — true here too, yet the refusal fires with no negotiation, no peer and no protocol, and its `local`/`format` fields would have to be read as bundle-versus-repository. Reusing it would make the code's meaning depend on the call site, which is what [ADR-668] and [ADR-654] both refused. (a)'s cost is one union member; the guard is a single comparison of two algorithm names, and it must sit **before** the lookup, because after it the information that distinguishes the two conditions is gone. Note the refusal fires only when prerequisites exist: §1i measures a cross-format **complete** bundle verifying `is okay`, exit 0, in both directions — so the guard is on the prerequisite loop, never on the header read, or `bundleListHeads` (which git runs outside a repository entirely) would break. |

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
- New domain helper tests for [ADR-694]'s `oidPattern` / `isOid` — every width × every algorithm
  × malformed (uppercase, 39/41/63/65 chars, non-hex, empty).
- **Bundle header, `test/unit/domain/bundle/parse-bundle-header.test.ts`** — the existing file
  keeps every v2 row untouched (R6) and gains §1i's grammar as literal fixtures: v3 + `sha256`,
  v3 + `sha1`, capabilities in swapped order, duplicate `@object-format` last-wins in **both**
  orders (the second must fail on the ref line, which is what proves last-wins rather than
  first-wins), v3 with no capability block, `@object-format` after the first ref line, an `@`
  line in a v2 bundle, and a v2 magic line carrying 64-hex oids. Each refusal row asserts
  `.data.reason` via try/catch — the four-valued discriminator (§3d) is exactly the kind of
  StringLiteral mutant a `toThrow(Class)` check leaves alive.
  `serialize-bundle-header.test.ts` gains the mirror: v2 bytes byte-identical to today, v3+sha256
  and v3+sha1 byte-identical to §1i's `xxd` prefixes.
- **Two regression tests named directly from Context**, because both are live defects rather
  than missing features and both must be *proven* fixed, not assumed:
  - `catFile` against a SHA-256 repository throws a **typed** `TsgitError`, never a bare
    `TypeError` (R11). Assert the `.data.code`, not the class.
  - `openRepository({ algorithm: 'sha256' })` on the memory entry, then `add`, produces an index
    whose entry oid at `offset + 40` is the **full 32 bytes** of the real blob oid and whose
    flags sit at `offset + 72` (R12). The current bytes — oid prefix, then `0005`, then the
    ASCII name written over the oid's tail — make a byte-literal assertion the clearest oracle.
- `src/domain/objects/hash-config.ts` — [ADR-694] adds `algorithm`, so a test that the two
  frozen configs are internally consistent (`hexLength === 2 * digestLength`, and `algorithm`
  agreeing with both) keeps a future third algorithm from being added half-populated.
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
   `shallow`, reflog, **and bundle v3** ([ADR-683]).
4. **Per-format write symmetry** (R9, tsgit writes → git reads) — the direction that catches
   §6's symmetrically-wrong and write-only classes, which no tsgit-internal test can see: after
   a tsgit write, run `git fsck`, `git verify-pack`, `git ls-files --stage`,
   `git reflog show`, `git archive` → `tar -t`, `git bundle verify` and
   `git rev-parse --show-object-format`, each exiting 0.
5. **Round-trip** — a tsgit-created SHA-256 repository ([ADR-681]) whose `.git/config` matches
   §1a's bytes and which `git log` reads; and a git-created one that tsgit writes into and git
   then reads.
6. **SHA-1 invariance** (R6) — the same battery on a sha1 repository, asserting the `.rev` hash
   id is still `1`, the `.idx` trailer is still 40 bytes, the index entry header is still 62,
   and every oid is still 40 hex.
7. **Transport** (R7) — §1e's rows over `file://` and the in-process HTTP path: sha256↔sha256
   fetch and push succeed; sha1→sha256 and sha256→sha1 fetch refuse; push to a sha1 receiver
   refuses; the client's own v2 request carries its **real** algorithm rather than a hardcoded
   `sha1` (§3c), asserted against a real `upload-pack` advertisement. Per [ADR-697] **the same
   rows run again forced to protocol v0**, in both `upload-pack` and `receive-pack` — that is the
   row that proves the push refusal is reachable at all. Use `gitAsync` for anything driving the
   in-process server — a sync `git` spawn deadlocks it.
8. **Cross-format confusion** (§1d) — a 40-hex prefix of a sha256 oid **resolves** to the full
   oid (it is a prefix, not an algorithm signal, and §2a's `checkout.ts:85` is the site this row
   guards); a sha256 pack in a sha1 repository is refused; a 64-hex id in a sha1 repository is
   not found.
9. `compatObjectFormat` (§1g) — both tools refuse; tsgit's is [ADR-685]'s
   `REPOSITORY_EXTENSION_UNSUPPORTED`.
10. **Bundle v2/v3** (R14, R15, [ADR-683]) — the battery §1i's measurement earns, extended into
    `test/integration/bundle-interop.test.ts` beside its existing v2 rows rather than duplicated:
    - a **tsgit-written v3 bundle** from a SHA-256 repository passes `git bundle verify` and
      `git bundle list-heads` (exit 0), and `git clone`ing it yields a repository whose
      `rev-parse --show-object-format` is `sha256` — the row that proves the header is not merely
      parseable but *adoptable*;
    - a **git-written v3 bundle** from a SHA-256 repository is read by tsgit with the same
      64-hex oids, same ref set, same version and same `hashAlgorithm`;
    - the **SHA-1 v2 control**: a tsgit-written v2 bundle from a SHA-1 repository is byte-identical
      to today's golden and still verifies (R6), and git's own v2 bundle still reads — the
      regression half, and the one that fails first if the writer's version selection is keyed
      wrongly;
    - `bundleListHeads` on a **cross-format** bundle succeeds in both directions, because the
      bundle declares its own width (R15) — the tsgit twin of §1i's outside-a-repository row;
    - `git bundle create --filter=blob:none` on a **SHA-1** repository writes v3, and tsgit reads
      it — the row that catches an implementation keyed on the algorithm alone rather than on
      §1i's three-trigger rule. Its tsgit-side assertion depends on N2.
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

- **Lens 1 (round-trip pair): YES for the bundle header, no elsewhere.**
  `serializeObject`/`parseObject` are unchanged by this design (§1c: the header is identical), so
  there is no new round-trip to prove there; the existing property siblings simply run under a
  second `HashConfig`. But [ADR-683] makes `parseBundleHeader`/`serializeBundleHeader` a genuine
  round-trip pair across **two versions and two algorithms**, and
  `test/unit/domain/bundle/bundle-header.properties.test.ts` **already exists** with its
  generators in the sibling `arbitraries.ts` — so this is an extension, not a new file. The
  arbitrary widens to `(version, algorithm)` pairs drawn from the legal set (v2 ⟹ sha1 only, v3 ⟹
  either), and the property is `parse(serialize(h)) ≡ h` modulo the documented prerequisite sort.
  `numRuns: 200` (round-trip tier). This is the lens that catches a v3 emitter which forgets
  `@object-format` on the sha1 branch — a bug every example test would have to be written to
  suspect.
- **Lens 2 (compositional matcher): no.** Nothing here reduces a rule list to a verdict.
- **Lens 3 (total function over an algebraic grammar): YES — one new sibling, per [ADR-694].**
  `isOid(value, hashConfig)` / `oidPattern(hashConfig)` is a total width-generic
  validator over the hex grammar, and it is exactly the kind of predicate whose off-by-one
  survives an example sweep — §2a's `resolve-oid-prefix.ts` shows the failure mode, where a
  wrong bound returns `undefined` instead of throwing. `src/domain/objects/oid-pattern.properties.test.ts`
  beside the example test, generators in a shared `arbitraries.ts`: for an arbitrary lower-case
  hex string of arbitrary length, `isOid(s, cfg) === (s.length === cfg.hexLength)`; for
  arbitrary bytes, `isOid(toHex(bytes), cfg) === (bytes.length === cfg.digestLength)`; and no
  input in the ASCII-hex safe subset makes it throw. `numRuns: 100` (invariant tier). Generate
  the hex alphabet from character **ranges**, never a base64-ish literal — a literal alphabet
  trips `CKV_SECRET_6` in the secret scanner. The sibling is warranted *because* [ADR-694] chose
  a single predicate: the rejected alternatives had nothing to pin down (per-site threading) or
  only a tautology to state (the config-free dual predicate).
- **Lens 4 (idempotence / counting): no** — the config read's counting invariant belongs to the
  acceptance gate's extension enumerator, which that design already scoped.

**Public-surface gates** — this change touches all of them, and each is a hard pre-PR gate:

| gate | what changes |
|---|---|
| `reports/api.json` | regenerated — the `algorithm` option on `OpenRepositoryOptions` / the three shim option types / `NodeAdapterOptions` / `BrowserAdapterOptions`, the `RepositoryLayout.objectFormat` field ([ADR-693]), `HashConfig.algorithm` ([ADR-694]), the widened `UNSUPPORTED_OBJECT_FORMAT` payload ([ADR-695]), `BundleHashAlgorithm` widening to a two-member union ([ADR-683]), and every new error code |
| `docs/use/errors.md` | **two edited rows, not just one** — `UNSUPPORTED_OBJECT_FORMAT` (line 180) says "tsgit only supports sha1 repositories" ([ADR-695] falsifies it) and `BUNDLE_UNSUPPORTED_VERSION` says v3 is unsupported ([ADR-683] falsifies it). Plus new rows for the push-side mismatch under *Network, transport, partial clone*; `REPOSITORY_EXTENSION_UNSUPPORTED` and `CONFIG_INVALID_ENUM_VALUE` under *Repository state*; `CONFIG_MISSING_VALUE`'s key list gains `extensions.objectformat`; and `BUNDLE_BAD_HEADER`'s widened `reason` values |
| the `openRepository` reference | the algorithm option and the detection rule, on every entry-point page it appears on (`docs/get-started/node.md`, `browser.md`, `memory.md`, `deno.md`, `bun.md`, `cloudflare-workers.md`) |
| barrel exports | `SHA256_CONFIG` is currently **not** in the public surface — `src/public-types.ts:86` re-exports `domain/objects` with `export type *`, which carries `HashConfig` but not the value constants. If a caller must name a config, that changes. |
| `docs/use/commands/init.md`, `clone.md` | the object-format option and the adopt-from-source rule ([ADR-681]) |
| `docs/use/commands/bundle.md` | v3 read and write, the version-selection rule (§1i), the widened `hashAlgorithm` and `version` result fields — and a `version` option if N1 lands |
| `docs/understand/repository-layout.md`, `security.md` | the format field and §5's downgrade note |
| `cspell.json` | already done alongside this doc — `objectformat` and `precomposeunicode`, joining the existing lower-cased git-config keys (`worktreeconfig`, `repositoryformatversion`, `logallrefupdates`) |
| browser scenario + `test/runtime-parity` | a new adapter option must be exercised on every runtime |

## Out of scope

- **The reftable ref backend** (`docs/design/reftable-ref-storage.md`, revised concurrently;
  [ADR-680] makes it a complete read + write + compaction backend). It is the other subsystem
  [ADR-667] pulled in. Shared surfaces, settled once rather than twice: **[ADR-685]'s
  `REPOSITORY_EXTENSION_UNSUPPORTED` — whose shape that design owns and this one only raises**,
  [ADR-696]'s `CONFIG_INVALID_ENUM_VALUE` (`refStorage` has the identical value grammar and is
  its second caller), and [ADR-693]'s channel out of `readRepositoryFormat`, which a second
  format-bearing key takes without widening again.
- **The repository-format acceptance gate itself** (`docs/design/repository-format-acceptance-gate.md`,
  [ADR-666]/[ADR-667]/[ADR-668]) **and [ADR-682]'s `assertAcceptedRepository` tier**. The gate
  decides *whether* a repository opens; this design decides what happens *after* it does. That
  design's §1b/§1e are cited here as measured input, never re-derived; its codes are not reused
  ([ADR-685]); and no refusal in this design joins its tier (§Binding constraints).
- **The ownership / trust gate** (the sibling design and [ADR-669]–[ADR-679]). Orthogonal:
  it decides whether a repository may be touched at all.
- **`extensions.compatObjectFormat`'s actual semantics** — a dual-hash repository with a
  translation table. git itself refuses it on this build (§1g), so there is no observable
  behaviour to be faithful to; tsgit refuses at the point of use with [ADR-685]'s code (R8). If a
  future git ships it, that is a new design.
- **`git bundle unbundle`, and clone/fetch from a bundle.** §1i measures git's behaviour on both
  (a bundle clone adopts the bundle's format, a cross-format bundle fetch dies in index-pack)
  because the rows bound N1 and confirm R14's read model — but tsgit has no such command and no
  such path (`clone.ts` and `fetch.ts` never mention bundles). Adding one is a new command, not
  part of this change.
- **`bundleVerify`'s pack walk.** tsgit verifies the packfile where git's `verify` never opens it
  (§1i, measured with a deliberately corrupted pack). That is a **pre-existing** divergence,
  unrelated to the algorithm, and R15 makes the two tools agree on every well-formed bundle
  regardless. Narrowing tsgit to git's semantics is a separate faithfulness question.
- **`relativeWorktrees` and `preciousObjects`** — the other two names [ADR-667] accepted.
  `preciousObjects` is honoured by construction (no `gc`/`prune`/`repack` command exists);
  `relativeWorktrees` is the acceptance-gate design's measurement to owe.
- **Partial (filtered) bundles.** [ADR-683] brings the v3 *format* in scope; it does not bring
  partial-clone bundle semantics with it. tsgit has no `--filter` on `bundleCreate` and writes no
  `@filter` capability. What the **reader** does with a git-written `@filter` line is N2, and it
  is the only filter question this change answers.
- **A multi-pack-index writer.** tsgit reads midx and does not write one (§3a). SHA-256 does not
  change that.
- **`.rev`, midx, commit-graph, `.bitmap`, `packed-refs`, `shallow`, loose paths and the
  `.pack` trailer** — already dual (§3a). Listed here as out of scope so the implementation
  does not "generalise" code that is already generic; a diff touching them is a review flag.
- **Rendering**: abbreviation width, `%h`, `--abbrev`, and any pretty format. §1f's numbers exist
  only so the interop test can reconstruct git's display ([ADR-249]).
- **Changing the SHA-1 default.** Absent `extensions.objectFormat`, a repository is SHA-1 (§1b),
  and tsgit's default for a *new* repository stays SHA-1 even under [ADR-681]'s full parity —
  git's does too (`GIT_DEFAULT_HASH` / `init.defaultObjectFormat` are opt-ins, §1a). The bundle
  default follows from it (§1i: a SHA-1 repository still writes v2). This design adds a
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
[ADR-674]: ../adr/674-two-trust-refusal-codes.md
[ADR-679]: ../adr/679-an-untrusted-repository-reads-as-an-empty-config-scope.md
[ADR-680]: ../adr/680-reftable-ships-as-a-complete-backend.md
[ADR-681]: ../adr/681-sha256-reaches-full-write-parity.md
[ADR-682]: ../adr/682-acceptance-refusals-attach-to-a-third-tier.md
[ADR-683]: ../adr/683-bundle-v3-is-implemented-now.md
[ADR-685]: ../adr/685-one-generic-point-of-use-refusal-code.md
[ADR-693]: ../adr/693-the-object-algorithm-reaches-context-by-both-channels.md
[ADR-694]: ../adr/694-width-correctness-comes-from-a-repository-aware-oid-predicate.md
[ADR-695]: ../adr/695-the-transport-refusal-widens-in-place.md
[ADR-696]: ../adr/696-extension-enum-values-reuse-the-config-error-family.md
[ADR-697]: ../adr/697-the-protocol-v0-object-format-gap-is-closed.md
[docs/BACKLOG.md]: ../BACKLOG.md
