# Design — `bundle` (create / verify / list-heads)

> This design was revised after the decisions conversation. ADRs 420–428 ratify
> its load-bearing choices: three were **user deviations** from the original
> recommendations — the full rev-selection grammar for `create` (ADR-421), a full
> embedded-pack parse for `verify` (ADR-427), and path-based read ops the library
> opens itself (ADR-428) — and the rest were **adopted as recommended**. The
> Decision-candidates section (§11) records each outcome.

## 1. Problem & scope

`git bundle` packages git objects plus the refs that name them into a single
transportable file — a "repository in a file" used for sneakernet transfer,
incremental backups, and air-gapped clones. tsgit must grow the three read/write
operations of the `git bundle` family:

- **`bundle create <file> <rev-list-args>`** — write a bundle: a UTF-8 header
  (version line, optional capabilities, prerequisite lines, ref lines, blank
  line) immediately followed by a packfile carrying the objects reachable from
  the included tips but not from the prerequisites.
- **`bundle verify <file>`** — confirm the bundle is well-formed (header **and**
  the embedded packfile) and that every prerequisite commit it names is already
  present in the current repository; surface the refs it provides, the
  prerequisites it needs, the "records a complete history" fact, and the hash
  algorithm.
- **`bundle list-heads <file> [<refname>…]`** — list the refs the bundle
  defines, optionally filtered to an exact-full-name set.

In scope for this slice: bundle **version 2** (the git default for a SHA-1
repository), the three operations above, the **full rev-selection grammar** for
`create` (ADR-421 — named refs, `--all`/`--branches`/`--tags`, two-dot `A..B`,
three-dot `A...B`, and `^`-exclusion), the include/exclude object closure, the
prerequisite (boundary) computation, and every refusal condition canonical git
raises. Out of scope (call-outs in §11): bundle **version 3** and its capability
lines (`@object-format=…`, `@filter=…`), SHA-256 repositories, incremental
"creation token" bundles, and `unbundle`/clone-from-bundle (the read side that
*imports* a bundle into a repo — a separate concern; `verify` deliberately does
**not** import).

**Through-line:** tsgit bundle is **producer-returns-bytes / readers-take-a-path**.
`create` is the producer of record (ADR-422): it returns the bundle bytes plus
structured metadata, and the caller writes those bytes wherever it likes — exactly
as `archive` leaves tar/zip bytes for the caller to write. `verify`/`listHeads`
are consumers (ADR-428): they take a `{ path }`, and the library opens and reads
the file itself through `Context.fs`, emitting git's faithful
`could not open '<path>'` refusal when it cannot. This split is **deliberately
asymmetric** — its justification, against both faithfulness and the codebase's
producer/reader conventions, is set out in §7 and recommended as Decision-J (§11).

This design obeys two project directives verbatim:

- **Git-faithfulness (prime directive).** The bundle header bytes, ref and
  prerequisite ordering, the object closure, the refusal conditions, and the
  message wording are pinned against real `git` 2.54.0 in §4 and become
  cross-tool interop tests (§10). Nothing here is described from memory.
- **Structured output, not cosmetics.** The library returns structured data
  (refs, prerequisites, the complete-history boolean, the hash algorithm, object
  counts, oids). The human-readable lines `git bundle verify` / `list-heads`
  print are reconstructed *inside the interop test* from those fields, never
  emitted by the library. The two nuances bundle forces — a write op produces a
  binary file (§7), a read op owns the file path (§7, ADR-428) — are resolved
  without smuggling rendered text across the boundary.

## 2. Precedents already in the codebase

Studied before designing; every reuse below was verified against current code
(symbol names and paths confirmed in the worktree).

| Concern | Existing symbol | File |
| --- | --- | --- |
| Pack body assembler (non-delta v2, full objects, trailer) | `buildPack(ctx, { oids }) → { bytes, sha, objectCount }` | `src/application/primitives/build-pack.ts` |
| "objects reachable from wants but not haves" closure | `enumeratePushObjects(ctx, { wants, haves, maxObjects }) → AsyncIterable<ObjectId>` | `src/application/primitives/enumerate-push-objects.ts` |
| Commit walk with `until` boundary (engine for ranges / `^`-exclusion) | `walkCommits(ctx, { from, until, … })`; `walkCommitClosure` | `src/application/primitives/walk-commits.ts`, `enumerate-push-objects.ts` |
| Merge-base frontier (engine for three-dot `A...B`) | `mergeBase`, `mergeBasesMany(read, one, twos)`, `octopusMergeBases` | `src/application/primitives/merge-base.ts` |
| **Full** pack parse — walk **and inflate** every entry (verify, ADR-427) | `walkPackEntries(ctx, packBytes)`, `inflateAllEntries(ctx, packBytes)`, `resolveAllEntries`, `verifyPackTrailer` | `src/application/primitives/fetch-pack.ts` |
| Ref enumeration (HEAD + loose + packed) | `enumerateRefs(ctx) → ReadonlyArray<RefName>` | `src/application/primitives/enumerate-refs.ts` |
| Single-rev resolution (errors `REVPARSE_AMBIGUOUS` / `REVPARSE_UNRESOLVED`) | `revParse(ctx, expression) → ObjectId` | `src/application/commands/rev-parse.ts` |
| Negative-rev exclusion in a command input (precedent for `^`-exclusion) | `LogOptions.excluding: ReadonlyArray<string>` | `src/application/commands/log.ts` |
| Structured base/tip range input (no rev-string parser) | `RangeDiffRange`, `rangeDiff` | `src/application/commands/range-diff.ts` |
| Whole-file read by path (read ops, ADR-428) | `ctx.fs.read(path) → Promise<Uint8Array>` | `src/ports/file-system.ts` |
| Structured-result producer that returns bytes, no path-write | `archive(ctx, opts) → ArchiveResult`; `tarArchive`/`zipArchive` | `src/application/commands/archive.ts`, `src/domain/archive/` |
| Sub-operation namespace facade | `BranchNamespace` + `bindBranchNamespace(ctx, guard)` | `src/repository.ts`, `src/application/commands/internal/cherry-pick-namespace.ts` |
| Boundary-subject formatting (first message line) | `foldSubject` | `src/domain/objects/commit-message.ts` |

The `archive` command is the canonical precedent for the structured-output
directive, the serializer split (§7), and the **producer-returns-bytes** stance
(it returns a structured result and offers no path-write). The
`cherry-pick`/`branch`/`config` namespaces are the canonical precedent for a
one-command-three-subcommands facade (§8, ADR-420). `buildPack` is the pack
writer — **do not hand-roll a second one**. The full rev grammar (ADR-421) is
realised by **composing `revParse` + `walkCommits` + `mergeBase` + the
boundary-collecting walk** — *no new rev-string parser* is introduced.

## 3. The on-disk bundle format (v2)

A v2 bundle is: a magic line, then prerequisite lines, then ref lines, then a
single blank line, then a raw v2 packfile.

```
# v2 git bundle\n
-<40-hex prereq-sha> <subject>\n      (zero or more, sorted by oid ascending — only for boundary commits)
<40-hex ref-sha> <full-refname>\n     (one or more — a zero-ref bundle is refused)
\n                                     (single blank line terminates the header)
PACK……                                (raw v2 packfile: signature, version 2, count, objects, 20-byte SHA-1 trailer)
```

- The magic line is exactly `# v2 git bundle` + LF. v3 would be `# v3 git
  bundle` followed by `@`-prefixed capability lines; v3 is out of scope to emit
  and refused on read (§11-D, ADR-423).
- Prerequisite lines are prefixed with `-`, carry the boundary commit's oid and
  its **subject** (first line of the commit message), separated by one space,
  and are **emitted sorted by oid ascending** — pinned in §4.1b against two
  independent selection paths (three-dot and explicit `^`-exclusion), each of
  which produced the same oid-sorted order regardless of merge-base discovery or
  argument order.
- Ref lines carry the oid the ref points at (for an annotated tag, the **tag
  object** oid, *not* the peeled commit) and the **full** refname. Explicit
  positive endpoints preserve **argument order**; `--all`/`--branches`/`--tags`
  expansions are sorted by refname (HEAD appended last only for `--all`).
- The header is UTF-8 text; the pack body begins immediately after the single
  blank-line LF (no padding).

## 4. Pinned git behaviour (real `git` 2.54.0, isolated `HOME`, `GIT_*` scrubbed, `GIT_CONFIG_NOSYSTEM=1`, signing OFF)

All bytes below were produced by `git bundle …` in a `mktemp -d` throwaway repo
seeded with deterministic author/committer dates. These are the faithfulness
goldens; each row becomes an interop assertion (§10).

### 4.1 `create` — header byte goldens (named refs, pseudo-refs, two-dot)

**Whole repo (`--all`)** in a repo with commits first→second→third→fourth, an
annotated tag `v1.0` (→ HEAD~1), a lightweight tag `light` (→ HEAD~2), and a
branch `feature` (→ HEAD~2):

```
# v2 git bundle
e69e665085cde6f540dd81c919e53e71ceaf15bf refs/heads/feature
b6400368c89eac418fc79c7d2a3e1e34932f7c02 refs/heads/main
e69e665085cde6f540dd81c919e53e71ceaf15bf refs/tags/light
29eb1387d49a0494e3f1ef2f8ba9a47d312cc491 refs/tags/v1.0
b6400368c89eac418fc79c7d2a3e1e34932f7c02 HEAD
<blank line>
PACK……
```

Pinned facts:
- **Ref ordering for `--all`:** refs sorted by full refname, **then `HEAD`
  appended last**.
- **Annotated tag** `v1.0` records the **tag object** oid `29eb13…`, not the
  peeled commit; the lightweight tag `light` records the commit oid `e69e66…`.
- `--branches` emits only `refs/heads/*` (sorted, no HEAD); `--tags` only
  `refs/tags/*`.

**Explicit refs preserve argument order** (no sort): `git bundle create f main
feature` →

```
# v2 git bundle
b6400368…  refs/heads/main
e69e6650…  refs/heads/feature
<blank>
PACK……
```

`git bundle create f HEAD` → a single `<oid> HEAD` ref line.

**Range (`main~2..main`)** in a repo first→second→third (so `main`=third,
`main~2`=first), exact hexdump of the header/pack boundary:

```
offset 0x00  '# v2 git bundle\n'
             '-f18025a349926d24d45f79d05aa000ea7b0fddc7 first\n'   ← prerequisite (boundary = main~2 = "first")
             'ed9f28ddb235b8f83317e032c98756f316c7ba9f refs/heads/main\n'
             '\n'                                                   ← blank line, byte at offset 121
offset 0x7a  'PACK' 00 00 00 02  00 00 00 06  …                    ← v2 pack, 6 objects, at offset 122
last 20 bytes: SHA-1 pack trailer
```

Pinned facts:
- The **prerequisite** is the boundary commit (`rev-list --boundary` of the
  excluded side): for `main~2..main` it is `main~2` itself ("first"), recorded
  `-<sha> <subject>`.
- The positive endpoint that is a ref (`main`) becomes the ref line
  `refs/heads/main`; `main~1` (also included) is **not** a separate ref.
- The pack holds 6 objects (commit third, commit second, their two trees, and
  the two newly-introduced blobs). Blobs reachable from the prerequisite are
  **absent** — the pack references their oids inside the included trees but does
  not carry them. This is exactly the `enumeratePushObjects(wants=[third],
  haves=[first])` closure; `git index-pack` / `git clone` accept such a pack
  because the missing oids are supplied by the prerequisite at import time.
- **Two-dot is `^`-exclusion sugar.** `git bundle create f main ^main~2` produced
  a header **byte-identical** to `main~2..main` (same `-f18025… first`
  prerequisite, same `refs/heads/main` ref line). Confirms `A..B ≡ ^A B` — both
  desugar to `wants=[B]`, `haves=[A]`.

### 4.1b `create` — three-dot / merge-base goldens (ADR-421)

The full grammar (ADR-421) adds three-dot symmetric difference, whose boundary is
the merge-base frontier. Pinned in a repo `first→{second-on-main, feature}` that
diverges at `first`:

**`git bundle create three.bundle main...feature`** →

```
# v2 git bundle
-71d6949a7f6462e96698221cb31cdc3c3bda954a first
77a626023cf95a57e500f09757e43bafb01b8f27 refs/heads/main
a6f23d99cd458c7dacc4825460bdfde1dd6474a9 refs/heads/feature
<blank>
PACK……
```

Pinned facts:
- **Both positive endpoints emit ref lines**, in **argument order** `[A, B]`
  (`main` then `feature`) — not sorted by oid (here `77a6…` > `a6f2…` would sort
  the other way; argument order wins).
- The **prerequisite is the merge-base** `71d6949…` ("first"), confirmed by
  `git merge-base main feature` → `71d6949…`. So `A...B` desugars to
  `wants=[A, B]`, `haves = merge-base(A, B)`; the boundary commits are exactly
  those merge-bases.

**Multiple merge-bases (criss-cross) — prerequisite ordering.** In a criss-cross
where `tipA...tipB` has two merge-bases `X` (`c87006d…`) and `Y` (`a91442e…`),
`git bundle create cc.bundle tipA...tipB` →

```
-a91442ef692736740554d5e10fd791fca614afb7 Y
-c87006d645a7339f4e4afae8d02ee49677315bb5 X
c88a879799f3f48c21e06bac75396273bf8a8e1a refs/tags/tipA
f1115211288011daa3752eedf021137f211684b9 refs/tags/tipB
```

The same repo with **explicit excludes** `git bundle create me.bundle main ^X
^side` produced the **same** prerequisite ordering:

```
-a91442ef692736740554d5e10fd791fca614afb7 Y
-c87006d645a7339f4e4afae8d02ee49677315bb5 X
c88a879799f3f48c21e06bac75396273bf8a8e1a refs/heads/main
```

Pinned fact (load-bearing for ADR-424): `git merge-base --all tipA tipB` reports
the bases in order `X, Y` (`c87006d…`, `a91442e…`), and `^X ^side` lists them in
argument order — yet **both bundles emit the prerequisite lines as `Y` then `X`,
i.e. sorted by oid ascending** (`a914… < c870…`). The bundle writer sorts the
boundary set by oid before serialising; the design sorts prerequisites by oid in
§3/§8.3 to match.

### 4.2 `create` — refusal conditions

| Trigger | git stderr | exit |
| --- | --- | --- |
| Empty rev-list (`main..main`, or no rev args) | `fatal: Refusing to create empty bundle.` | 128 |
| Positive tip is a **bare rev/oid** that names no ref (`main~1`, a raw SHA) | `fatal: Refusing to create empty bundle.` | 128 |
| Unknown ref (`bundle create f nonexistent`) | `fatal: ambiguous argument 'nonexistent': unknown revision or path not in the working tree.` (+ usage hint) | 128 |

The middle row is load-bearing: **a bundle with zero ref lines is refused even
when the object closure is non-empty.** git only records ref lines for positive
endpoints that resolve to actual ref names (or `HEAD`); a bare rev contributes
objects but no ref line, so a bundle whose only tip is a bare rev is "empty".
The output file is **not created** on any refusal — under the producer-returns-
bytes shape this is automatic: `create` computes the bytes (or throws) before the
caller writes, so a refusal yields no bytes and the caller never writes (§7).

### 4.3 `verify` — output, pack depth, and refusal

Well-formed bundle, all prerequisites present (the complete-history `--all`
bundle from §4.1):

```
stdout:
  The bundle contains these 5 refs:
  e69e6650… refs/heads/feature
  b6400368… refs/heads/main
  e69e6650… refs/tags/light
  29eb1387… refs/tags/v1.0
  b6400368… HEAD
  The bundle records a complete history.
  The bundle uses this hash algorithm: sha1
stderr:
  <file> is okay
exit: 0
```

Well-formed bundle **with** prerequisites (range bundle), prerequisites present:

```
stdout:
  The bundle contains this ref:
  <oid> refs/heads/main
  The bundle requires this ref:
  <prereq-sha><space>                    ← subject blank in verify output (see note)
  The bundle uses this hash algorithm: sha1
stderr:
  <file> is okay
exit: 0
```

Pinned wording/pluralisation:
- Refs: `The bundle contains this ref:` (exactly 1) vs `…these N refs:` (≥2).
- Prereqs present: `The bundle records a complete history.` (no prereqs) is
  replaced by `The bundle requires this ref:` / `…these N refs:` (≥1 prereq).
- Hash line: `The bundle uses this hash algorithm: sha1` (always, last).
- `<file> is okay` is on **stderr**; the ref/prereq report is on **stdout**.
- **Note:** the prerequisite line in `verify` output prints `<sha>` + a single
  space + an **empty** subject — git does not echo the subject stored in the
  bundle header here. This is a display detail; the structured data carries only
  the oid (§6), and the interop test reconstructs the trailing-space line.

**Pack-validation depth (ADR-427 — user deviation).** `git bundle verify` does
not stop at the header: it hands the embedded packfile to its index-pack/rev-list
machinery to confirm the pack is intact and usable. The user ratified the
**maximal** option: tsgit's `verify` performs a **full pack parse** — it walks and
inflates **every** embedded pack entry, reusing the existing pack-reading
machinery (`walkPackEntries` + `inflateAllEntries`, with `verifyPackTrailer` for
the trailer), rather than a cheap trailer-only check. A corrupt entry body
surfaces as a verify failure, not a silently-passing trailer. Cost: one full-pack
inflate per `verify` — acceptable for a verification operation and consistent
with what git's verify exercises. The refs/prerequisites the structured result
reports still come from the **header**; the pack parse is the well-formedness
gate, not the source of the reported data.

Refusals (the open/read refusals are now **owned by the library** — ADR-428):

| Trigger | git stderr | exit | tsgit owner |
| --- | --- | --- | --- |
| File missing **or** unreadable (perm denied) | `error: could not open '<path>'` | 1 | library (`BUNDLE_READ_FAILED`) |
| File opens but is not a bundle (plain text, **or a directory**) | `error: '<path>' does not look like a v2 or v3 bundle file` | 1 | library (`BUNDLE_BAD_HEADER`) |
| Repository lacks a prerequisite | `error: Repository lacks these prerequisite commits:` then `error: <sha> ` per missing prereq | 1 | query result (`missingPrerequisites`) |

Pinned facts (new, ADR-428):
- git renders **both** a missing file **and** a permission-denied file as
  `error: could not open '<path>'`, exit 1 — so the library's open-failure code
  spans not-found and not-readable.
- A **directory** (and any opened-but-not-a-bundle content) is reported as
  `does not look like a v2 or v3 bundle file`, **not** as an open error — git
  opens it, fails to read a valid magic line, and reports a bad header. So the
  read-failure **kind** discriminates: tsgit maps a **not-found / permission-
  denied** `ctx.fs.read` failure to `BUNDLE_READ_FAILED` (git `could not open`),
  but an **is-a-directory** read failure — or a *successful* read whose magic is
  not `# v2 git bundle` — to `BUNDLE_BAD_HEADER` (git `does not look like…`).
  This requires the read failure to surface its errno kind (the Node/memory/OPFS
  adapters carry `.code`); the command inspects it rather than collapsing all
  read failures to one code.
- **Known divergence (ADR-423):** real `git` 2.54.0 *successfully reads* a
  hand-forced `# v3 git bundle` + `@object-format=sha1` file (`<file> is okay`,
  "contains these 0 refs", "complete history", "sha1"). tsgit deliberately
  **refuses** any v3 magic with `BUNDLE_UNSUPPORTED_VERSION` — the one sanctioned
  divergence from git here, justified in §11-D because tsgit has no faithful v3
  producer and v3-read is not on the backlog.

`verify` never imports the pack into the repository; it validates the header,
fully parses the pack (ADR-427), and checks prerequisite presence.

### 4.4 `list-heads` — output, filtering, refusal

```
stdout (no filter): one '<oid> <full-refname>' line per ref, in header order
stderr: empty
exit: 0
```

**Filter semantics (pinned, and surprising):** `git bundle list-heads <file>
<pattern>…` matches a ref **only by exact full-refname string equality**
(`strcmp(ref->name, pattern)`), *not* by `show-ref` tail-matching. Observed:
`refs/tags/v1.0` matched; `v1.0`, `tags/v1.0`, `main`, `heads/main`, `feature`,
`light` all returned **nothing**. A non-bundle file fails identically to
`verify`: `error: '<path>' does not look like a v2 or v3 bundle file`, exit 1; a
missing/unreadable file fails with `error: could not open '<path>'`, exit 1.
Unlike `verify`, `list-heads` is **header-only** — it does not parse the pack.

## 5. A note on pack bytes vs the byte-identity contract

The header bytes (magic, prerequisite lines, ref lines, blank line) are part of
the byte-identity contract and are pinned byte-for-byte. The **pack body bytes
are not** — exactly as for `push` and `clone`, which already stream `buildPack`
output that real git consumes. git itself produces non-deterministic pack bytes
(delta heuristics, threading, version drift). `buildPack` emits a valid,
non-thin, non-delta v2 pack; the faithfulness obligation for the pack is
behavioural: **real `git clone`/`git bundle verify`/`git index-pack` accepts a
tsgit-produced bundle**, and a tsgit reader accepts a real-git-produced bundle.
ADR-427's full parse on the read side strengthens this: a tsgit reader inflates
every entry of a real-git pack, so corruption is caught, not trusted. This is
consistent with the structured-output directive (the contract binds data and the
on-disk *header* state; the pack is a faithful binary artifact whose *content* —
the object closure — must match, not its byte layout).

## 6. Structured data shapes

All oids are `ObjectId`, all refnames `RefName`; no rendered strings, no
`bytes`-only returns from the query ops.

```ts
// Shared
type BundleVersion = 2 | 3;                  // this slice emits 2; 3 refused on read (§11-D)
type BundleHashAlgorithm = 'sha1';           // sha256 out of scope (§11-D)

interface BundleRef {
  readonly oid: ObjectId;                     // tag-object oid for annotated tags
  readonly name: RefName;                     // full refname, or 'HEAD'
}
interface BundlePrerequisite {
  readonly oid: ObjectId;                     // boundary commit
  readonly comment: string;                   // subject stored in the header (create-time)
}

// create input — the FULL rev-selection grammar (ADR-421), expressed
// structurally with NO rev-string parser. An ordered list of typed rev args
// mirrors git's positional <rev-list-args>; each positive endpoint that names a
// ref (or HEAD) contributes a ref line in list order.
type BundleRevArg =
  | { readonly tip: string }                              // <rev>        positive endpoint
  | { readonly exclude: string }                          // ^<rev>       negative endpoint
  | { readonly range: readonly [string, string] }         // <a>..<b>     two-dot   (≡ ^a b)
  | { readonly symmetricRange: readonly [string, string] };// <a>...<b>   three-dot (a b, ^merge-base)

interface BundleCreateOptions {
  readonly revs?: ReadonlyArray<BundleRevArg>;            // ordered rev-list args
  readonly all?: boolean;                                 // --all      → every ref, sorted, then HEAD
  readonly branches?: boolean;                            // --branches → refs/heads/*, sorted
  readonly tags?: boolean;                                // --tags     → refs/tags/*, sorted
}

// create — returns metadata AND the bytes (ADR-422; see §7)
interface BundleCreateResult {
  readonly version: BundleVersion;
  readonly bytes: Uint8Array;                 // header + packfile, ready to write
  readonly refs: ReadonlyArray<BundleRef>;
  readonly prerequisites: ReadonlyArray<BundlePrerequisite>;  // oid-sorted (§3)
  readonly objectCount: number;               // from buildPack
  readonly packSha: string;                   // pack trailer hex
}

// Read ops take a PATH (ADR-428); the library opens it via Context.fs and emits
// git's `could not open` refusal itself.
interface BundleVerifyInput {
  readonly path: string;
}
interface BundleListHeadsInput {
  readonly path: string;
  readonly names?: ReadonlyArray<RefName>;    // exact-full-name filter (§4.4)
}

// verify — a CQS query (ADR-425): well-formed-but-missing-prereqs is a normal
// result, not a thrown error (a malformed header/pack, or an unopenable path,
// does throw — §9)
interface BundleVerifyResult {
  readonly version: BundleVersion;
  readonly hashAlgorithm: BundleHashAlgorithm;
  readonly refs: ReadonlyArray<BundleRef>;
  readonly prerequisites: ReadonlyArray<BundlePrerequisite>;
  readonly missingPrerequisites: ReadonlyArray<ObjectId>;  // subset absent locally
  readonly prerequisitesPresent: boolean;     // missingPrerequisites.length === 0
  readonly recordsCompleteHistory: boolean;   // prerequisites.length === 0
}

// list-heads — header-only read; the pack is never touched
interface BundleListHeadsResult {
  readonly version: BundleVersion;
  readonly refs: ReadonlyArray<BundleRef>;    // filtered by exact-full-name set when given
}
```

The verify human report (`The bundle contains these N refs:` …) and the
list-heads lines are reconstructed from these fields in the interop test — the
pluralisation, the trailing-space prereq line, the stderr `is okay`, the hash
line, and git's `could not open` / `does not look like…` refusals — none of it
is emitted by tsgit.

## 7. The producer/reader split: create returns bytes, readers take a path

`create` returns bytes; `verify`/`listHeads` take a path. The split is
deliberate and was the substance of the decisions conversation (ADR-422,
ADR-428). It is reconciled here.

### 7.1 Why `create` returns bytes plus a header round-trip pair (ADR-422)

`archive` returns a structured `ArchiveResult` and a **separate pure-domain
serializer** (`tarArchive`/`zipArchive`) turns it into bytes, because tar/zip
framing is pure given the (already-hydrated) entry stream. Bundle is different:
its pack body is produced by `buildPack`, an **application primitive that
performs object I/O** through `ctx`. A pure-domain "serialize a
`BundleCreateResult` to bytes" is therefore impossible without re-handing every
object's bytes to the caller — i.e. re-implementing `buildPack`. So:

- **Pure domain, header only** — a `serialize`/`parse` round-trip pair in
  `src/domain/bundle/`:
  - `serializeBundleHeader({ version, prerequisites, refs }) → Uint8Array`
  - `parseBundleHeader(bytes) → { version, hashAlgorithm, prerequisites, refs,
    packOffset }`
  These are a clean parse/serialize pair (round-trip property, §10a) and the only
  bytes in the byte-identity contract.
- **Application command** `bundleCreate` — resolves the rev grammar →
  oids/ref-lines, computes prerequisites (§8), runs `enumeratePushObjects` →
  `buildPack`, concatenates `serializeBundleHeader(...)` ++ `pack.bytes`, and
  returns `BundleCreateResult` carrying **both** the structured metadata **and**
  the `bytes`. The caller writes `bytes` to its chosen path.

The bytes are a faithful binary artifact (a header is byte-pinned; a packfile is
the same artifact `buildPack` already returns from `push`/`clone`), not a
cosmetic rendering — fully within the structured-output directive (ADR-249). The
structured fields ride *alongside* the bytes so a caller can inspect/report
without re-parsing.

### 7.2 Why readers take a path, and why the asymmetry stands (ADR-428, Decision-J)

ADR-428 (user deviation) makes `verify`/`listHeads` take `{ path }`: the library
opens and reads the file through `Context.fs` and emits git's faithful
`error: could not open '<path>'` itself (§4.3). This is faithfulness-bearing —
git owns that exact message and exit code on its read commands, so owning the read
lets tsgit reproduce it; a bytes-in surface would have to push that faithfulness
onto the caller.

That leaves an asymmetry: **producers return bytes, readers take a path.** The
decisions conversation asked whether to remove it by also giving `create` a
path-write convenience. **Recommendation (Decision-J): keep the asymmetry — the
producer-returns-bytes / readers-take-a-path split is the intended final shape;
`create` does *not* gain a path-write convenience.** Justification:

- **Faithfulness does not pull `create` toward owning the write.** Faithfulness
  binds data and on-disk state and the git-specific *messages* a command owns
  (ADR-226/249). The reader's `could not open` is a git-owned message tsgit must
  reproduce — hence ADR-428. `git bundle create`'s write failures, by contrast,
  are generic OS errors with no git-specific wording tsgit must pin; the *act* of
  writing the buffer carries no SHA/ref/state that is git-specific. So there is
  no faithfulness obligation that a path-write convenience would discharge.
  (The one create-side faithful behaviour — "no output file on refusal", §4.2 —
  is satisfied for free: `create` throws before producing bytes, so the caller
  never writes.)
- **It mirrors the codebase's producer convention exactly.** `archive`, the
  direct precedent, returns a structured result and writes no path; no producer
  in the codebase writes a user-supplied path. Readers taking a path is *new*,
  but introduced precisely where faithfulness demands it (the open error).
- **The asymmetry is principled, not accidental.** A producer's value is its
  artifact *plus* the metadata you cannot recover from a path-write
  (`objectCount`, `packSha`, the resolved `refs`/`prerequisites`); a consumer's
  value is fully captured by its query result, so handing it a locator and
  letting it own its I/O end-to-end (including the faithful open error) is the
  tighter shape. Adding a path-write to `create` would couple a producer to
  `ctx.fs.writeFile` to duplicate a caller one-liner, for no faithfulness or
  ergonomic gain.

## 8. Command surface, object enumeration, prerequisite computation

### 8.1 Surface — one `bundle` namespace, three methods (ADR-420)

git's CLI is `git bundle <subcommand>`. The faithful and idiomatic tsgit shape
mirrors `branch`/`cherryPick`/`config`: **one Tier-1 namespace** `repo.bundle`
exposing `create` / `verify` / `listHeads`, bound by
`bindBundleNamespace(ctx, guard)` in `src/repository.ts` and typed by a
`BundleNamespace` interface in `src/application/commands/internal/
bundle-namespace.ts`. This counts as **one** Tier-1 command for the surface
snapshot and README count (§8.4).

```ts
interface BundleNamespace {
  create(opts: BundleCreateOptions): Promise<BundleCreateResult>;          // → bytes for the caller to write
  verify(input: BundleVerifyInput): Promise<BundleVerifyResult>;           // { path } — library reads it
  listHeads(input: BundleListHeadsInput): Promise<BundleListHeadsResult>;  // { path } — library reads it
}
```

### 8.2 `create` input — the full rev grammar, structured (ADR-421)

tsgit does not parse git's rev-list mini-language as a raw string. ADR-421
(user deviation) chose **maximal CLI fidelity**: `create` accepts the **full**
rev-selection grammar by **composing the existing rev infrastructure**, not a
hand-rolled include/exclude subset and not a new parser. The structured input
(§6 `BundleCreateOptions`) is an ordered list of typed rev args plus the three
pseudo-ref flags; each arg desugars onto the existing primitives:

| git grammar form | structured arg | desugaring (existing primitives) |
| --- | --- | --- |
| `<rev>` (named ref, `HEAD`, `v1.0`, `main~2`, raw oid) | `{ tip }` | `revParse(tip)` → a **want**; a ref line if `tip` names a ref or `HEAD` (annotated tag keeps the **tag-object** oid) |
| `^<rev>` | `{ exclude }` | `revParse(exclude)`, peel to commit → a **have**; no ref line |
| `<a>..<b>` (two-dot) | `{ range: [a, b] }` | `a` → **have**, `b` → **want** + ref line if `b` names a ref (`A..B ≡ ^A B`, pinned §4.1) |
| `<a>...<b>` (three-dot) | `{ symmetricRange: [a, b] }` | `a`, `b` → **wants** + ref lines if they name refs; **haves** = `mergeBasesMany(read, a, [b])` (the merge-base frontier, pinned §4.1b) |
| `--all` / `--branches` / `--tags` | `all` / `branches` / `tags` | `enumerateRefs` expansion (sorted; HEAD last only for `--all`) |

Resolution algorithm (faithful to §4):
1. Expand `all`/`branches`/`tags` via `enumerateRefs`. `all` = every ref under
   `refs/` sorted by full refname, then `HEAD` appended last; `branches`/`tags` =
   the sorted `refs/heads/*` / `refs/tags/*` subsets, no HEAD. Each is a
   `(name, oid)` pair — annotated tags keep the **tag-object** oid.
2. Walk `revs` in order, desugaring each arg per the table into the accumulating
   **wants** (with ref-line contributions, in argument order) and **haves**.
   Explicit ref lines preserve list order; expansions are sorted.
3. Three-dot args contribute their merge-base(s) to **haves** via `mergeBase`.
4. If the resolved **ref set** is empty, refuse with the empty-bundle error
   (`BUNDLE_EMPTY { reason: 'no-refs' }`, §4.2) — even if step 5 finds objects.
5. Compute the object closure and prerequisites (§8.3); if the closure is empty,
   refuse (`BUNDLE_EMPTY { reason: 'no-objects' }`).

An unknown `tip`/`exclude`/range endpoint propagates `revParse`'s
`REVPARSE_UNRESOLVED` / `REVPARSE_AMBIGUOUS` (matches git's `fatal: ambiguous
argument …`, §4.2).

### 8.3 Object enumeration & prerequisite (boundary) computation (ADR-424)

- **Object closure:** `enumeratePushObjects(ctx, { wants, haves })` with `wants`
  = the resolved positive-endpoint oids (tags unwrapped to commits internally
  there) and `haves` = the resolved exclude/merge-base commit oids. This is the
  verified "reachable from wants but not haves" walk; its output feeds
  `buildPack`.
- **Prerequisites = boundary commits (ADR-424, now load-bearing).** git records
  `rev-list --boundary` of the excluded side: the excluded commits that are
  immediate parents of an included commit. `walkCommits`/`walkCommitClosure`
  already *drop* parents that fall in `until`/`haves` (confirmed in
  `walk-commits.ts`) but do not *expose* them. ADR-421's full grammar makes a
  **boundary-collecting commit walk** load-bearing rather than optional, because
  for three-dot/merge-base the boundary is **not** a literal exclude tip (e.g.
  `main...feature` → merge-base "first"; criss-cross → the merge-base set, §4.1b).
  ADR-424 adopts that primitive: a walk layered on the same `walkCommits` engine,
  fed `from`=wants / `until`=haves, that **records each parent skipped because it
  is in `haves`** as a boundary commit, computing the packed object set and the
  prerequisites in **one** traversal (rejecting both "use exclude tips directly"
  — wrong for merge-base — and a post-hoc closure diff — two traversals).
- **Subject + ordering.** Each boundary commit's subject (via `foldSubject` on
  its message) fills `BundlePrerequisite.comment`. The prerequisite list is
  **sorted by oid ascending** before serialisation (pinned §4.1b — git sorts the
  boundary set by oid regardless of discovery/argument order).

### 8.4 Surface-gate checklist (pre-paid in-slice, per the surface-gates rule)

- **Barrel** — export `bindBundleNamespace`, `BundleNamespace`, and the
  option/result types from `src/application/commands/index.ts` (alphabetical).
- **Facade** — add `readonly bundle: commands.BundleNamespace` to the
  `Repository` interface and `bundle: commands.bindBundleNamespace(ctx, guard)`
  to the frozen object in `src/repository.ts`; add `bundle` to the sorted
  `Object.keys(sut)` snapshot in `test/unit/repository/repository.test.ts`.
- **`check:doc-coverage`** — add `docs/use/commands/bundle.md` and an index row
  in `docs/use/commands/README.md`.
- **`audit-browser-surface`** — add a `test/parity/scenarios/bundle.scenario.ts`
  invoking `repo.bundle.create`, then **writing the returned bytes to a temp path
  and calling** `verify`/`listHeads` **on that path** (ADR-428), projecting to
  counts and booleans (no oids in assertions), runnable on Node/memory/browser.
- **Count + api.json** — bump `README.md` "41 Tier-1 commands" → 42 and
  regenerate `reports/api.json` via `npm run docs:json` (prepush gate).
- **New error codes** — add the four bundle codes (§9) to the command-error union
  and wire exhaustiveness switches + the barrel-surface test in the same slice.

## 9. Error codes & refusal mapping (ADR-426 + ADR-428)

New members of the command-error union (`src/domain/commands/error.ts`), mapping
each pinned refusal (§4) to structured data — never a pre-rendered git line.
ADR-426 ratified the discriminated empty/header/version set; **ADR-428's
library-owned path read adds the fourth code** (`BUNDLE_READ_FAILED`) — a
refusal ADR-426 did not contemplate because it predated the path-read decision.
Read-op codes now carry `{ path }` so the interop test can reconstruct git's
path-bearing messages.

| Code | Data | Raised by | git analogue |
| --- | --- | --- | --- |
| `BUNDLE_EMPTY` | `{ reason: 'no-refs' \| 'no-objects' }` | `create` | `fatal: Refusing to create empty bundle.` |
| `BUNDLE_READ_FAILED` | `{ path }` | `verify`, `listHeads` | `error: could not open '<path>'` (missing **or** unreadable) |
| `BUNDLE_BAD_HEADER` | `{ path, reason }` | `verify`, `listHeads` | `error: '<path>' does not look like a v2 or v3 bundle file` |
| `BUNDLE_UNSUPPORTED_VERSION` | `{ path, version: number }` | `verify`, `listHeads` | (v3 read — tsgit refuses where git 2.54.0 reads v3-sha1; §4.3, §11-D) |

Mapping rules:
- A `ctx.fs.read(path)` failure that is **not-found / permission-denied** →
  `BUNDLE_READ_FAILED` (git `could not open`); an **is-a-directory** read failure,
  or a **successful** read whose magic is not `# v2 git bundle` (plain text) →
  `BUNDLE_BAD_HEADER` (git `does not look like…`); a `# v3 git bundle` magic →
  `BUNDLE_UNSUPPORTED_VERSION` (§4.3). The command inspects the read-failure kind
  (errno `.code`) rather than collapsing all read failures to one code.
- A truncated/corrupt **pack** (caught by ADR-427's full parse, §4.3) → a verify
  failure surfaced as a thrown malformation, distinct from a malformed *header*.

Not new codes (reused):
- Unknown include ref → propagated `REVPARSE_UNRESOLVED` / `REVPARSE_AMBIGUOUS`
  from `revParse` (matches `fatal: ambiguous argument …`).
- **Missing prerequisites is NOT an error** (ADR-425) — `verify` is a CQS query
  and returns `{ prerequisitesPresent: false, missingPrerequisites: [...] }`. The
  caller decides whether absence is fatal; the interop test reconstructs the
  `error: Repository lacks these prerequisite commits:` display from the
  structured field.

## 10. Faithfulness interop-test plan

New file `test/integration/bundle-interop.test.ts` (a cross-tool harness like
`archive-interop.test.ts`), one shared seeded repo in `beforeAll`, real `git`
spawned with `GIT_*` scrubbed, isolated `HOME`, `GIT_CONFIG_NOSYSTEM=1`, signing
off, 60s timeout. Pinned assertions:

1. **create header parity** — tsgit `bundle.create({ all: true })` header bytes
   (up to the pack `PACK` signature) are byte-identical to `git bundle create`'s
   header for the same repo: magic line, sorted ref lines, `HEAD` last, blank
   line. Repeat for `{ revs: [{ tip: 'refs/heads/main' }] }`, `{ branches: true }`,
   `{ tags: true }`, a two-dot range (`{ revs: [{ range: ['main~2', 'main'] }] }`),
   and — **new for ADR-421** — a three-dot range
   (`{ revs: [{ symmetricRange: ['main', 'feature'] }] }`) and a `^`-exclusion
   (`{ revs: [{ tip: 'main' }, { exclude: 'main~2' }] }`), each header carrying the
   oid-sorted `-<sha> <subject>` prerequisite(s).
2. **three-dot / merge-base prerequisite parity** — for `symmetricRange` (single
   merge-base) and a criss-cross (two merge-bases), the prerequisite lines match
   git **and are oid-sorted** (§4.1b).
3. **create object-closure parity** — the set of oids in tsgit's pack equals the
   set git packs for the same selection (parse both packs via `walkPackEntries`;
   compare oid sets, not bytes).
4. **create → real git consumes** — write tsgit's bundle to a temp file and run
   `git bundle verify` and `git clone` against it; both succeed and the clone's
   refs/objects match.
5. **real git → tsgit reads** — `bundle.verify`/`listHeads` on a real-git-produced
   bundle (passed by **path**, ADR-428) return refs/prerequisites/hashAlgorithm
   matching git's `list-heads`/`verify` output (reconstruct git's stdout from the
   structured fields and diff).
6. **verify full-pack parse (ADR-427)** — a bundle whose pack body is corrupted
   *after the trailer-covered region* (a flipped inflated byte) makes tsgit
   `verify` fail, proving it inflates entries rather than trusting the trailer.
7. **refusal parity** — empty rev-list, bare-rev-only tip, unknown ref (create);
   **missing file and unreadable file → `BUNDLE_READ_FAILED` reconstructing
   `could not open`** (ADR-428); non-bundle/directory → `BUNDLE_BAD_HEADER`
   reconstructing `does not look like…`; forced-v3 → `BUNDLE_UNSUPPORTED_VERSION`
   (documenting the divergence from git's v3-sha1 read); missing prerequisite
   (verify, in an empty repo) → reconstructed from the structured
   `missingPrerequisites`.
8. **list-heads filter parity** — exact-full-name matching only (`refs/tags/v1.0`
   matches; `v1.0`/`tags/v1.0`/`main` do not).
9. **hash-algorithm line** — `verify` reconstructs `The bundle uses this hash
   algorithm: sha1`.

Per the project's faithfulness rule, parity (cross-adapter) tests do **not**
prove faithfulness — only this interop harness does. A `bundle.parity` scenario
(§8.4) covers cross-adapter behaviour separately.

## 10a. Property tests (parser/serializer lens)

`src/domain/bundle/` adds a parse/serialize pair, so a `bundle-header.
properties.test.ts` sibling is warranted (round-trip lens): for an arbitrary
well-formed header model `{ version: 2, prerequisites, refs }` over the ASCII
oid/refname grammar, `parseBundleHeader(serializeBundleHeader(h)) ≡ h` (modulo
documented ordering — prerequisites canonicalised to oid-sorted), and the
prerequisite-count ↔ `-`-line-count 1:1 invariant. Cheap round-trip →
`numRuns: 200`. The example interop goldens (§4) stay — they document the literal
git bytes; the property proves the grammar.

## 11. Decision-candidates — ratified outcomes

Each was a load-bearing choice for the decisions conversation. ADRs 420–428
record the outcomes: **three user deviations** (B/H/I) and the rest **adopted as
recommended**. A new reconciliation (K) was added by this revision.

**A. Command shape — one namespace vs three flat commands.** → **ADOPTED
(ADR-420).** One `repo.bundle` namespace with `create`/`verify`/`listHeads`
(mirrors `git bundle <sub>` and the `branch`/`config` facade; one Tier-1 count).

**B. `create` include grammar reach.** → **USER-RATIFIED DEVIATION (ADR-421).**
The designer recommended B2 (named refs + `--all/--branches/--tags` + two-dot +
`^`-exclusion). The user chose the **full** grammar — adding three-dot symmetric
difference (`A...B`, merge-base frontier) — for maximal CLI fidelity, realised by
composing `revParse` + `walkCommits` + `mergeBase` + the boundary walk (no
rev-string parser, no minimal include/exclude subset). This makes Decision-E's
boundary walk load-bearing.

**C. `create` return — bytes + metadata vs structured-only.** → **ADOPTED
(ADR-422).** `BundleCreateResult` carries `bytes` **and** structured fields; the
pure-domain serializer is header-only (§7.1). Structured-only is infeasible (the
pack needs `ctx` I/O).

**D. Bundle version / capability scope.** → **ADOPTED (ADR-423).** Emit v2 only;
refuse to *read* v3 with `BUNDLE_UNSUPPORTED_VERSION`. Pinned divergence: real git
2.54.0 reads a forced v3-sha1 bundle; tsgit refuses, because it has no faithful v3
producer and v3-read is not on the backlog.

**E. Prerequisite (boundary) computation primitive.** → **ADOPTED (ADR-424).** A
boundary-collecting commit walk implementing `rev-list --boundary`; the only
option correct for merge-base/three-dot boundaries (ADR-421 makes it
load-bearing). Rejected: exclude-tips-as-prerequisites (wrong for merge-base),
post-hoc closure diff (two traversals).

**F. `verify` on missing prerequisites — query vs throw.** → **ADOPTED
(ADR-425).** Return `prerequisitesPresent: false` + `missingPrerequisites` (CQS
query, mirrors the `fsck` structured-finding precedent); malformed header/pack and
unopenable path still throw (§9).

**G. New error-code granularity.** → **ADOPTED (ADR-426), extended by ADR-428.**
Discriminated set `BUNDLE_EMPTY { reason }`, `BUNDLE_BAD_HEADER`,
`BUNDLE_UNSUPPORTED_VERSION`. The library-owned path read (I/ADR-428) adds a
**fourth** code `BUNDLE_READ_FAILED { path }`; read-op codes carry `{ path }` so
the interop test reconstructs git's path-bearing messages (§9).

**H. `verify` pack-validation depth.** → **USER-RATIFIED DEVIATION (ADR-427).**
The designer recommended H2 (header + pack-**trailer** check). The user chose H3 —
a **full pack parse**: walk and inflate every embedded entry via `walkPackEntries`
+ `inflateAllEntries`, catching body corruption, not just truncation, at the cost
of a full-pack inflate per `verify` (§4.3, §5). Closest to what `git bundle verify`
exercises.

**I. Read-op input — bytes vs path.** → **USER-RATIFIED DEVIATION (ADR-428).** The
designer recommended I1 (`{ bytes }`, symmetric with `create`). The user chose I2
— `verify`/`listHeads` take `{ path }`, the library opens it via `Context.fs` and
emits git's faithful `could not open` refusal itself (§4.3, §7.2). Streaming (I3)
remains a later concern.

**J. Reconcile the create/read asymmetry (added by this revision).** ADR-428's
path-read leaves `create` returning bytes while readers take a path; ADR-428 asks
the revision to decide whether `create` also gains a path-write convenience. →
**RECOMMENDATION: keep the asymmetry — producer-returns-bytes / readers-take-a-
path is the intended final shape; `create` gains no path-write convenience.**
Justified in §7.2 against faithfulness (no git-owned write message obliges
`create` to own the write; the reader's `could not open` *is* git-owned, hence
ADR-428) and the codebase's producer convention (`archive` returns a structured
result and writes no path).
