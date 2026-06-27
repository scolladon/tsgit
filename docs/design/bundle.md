# Design — `bundle` (create / verify / list-heads)

## 1. Problem & scope

`git bundle` packages git objects plus the refs that name them into a single
transportable file — a "repository in a file" used for sneakernet transfer,
incremental backups, and air-gapped clones. tsgit must grow the three read/write
operations of the `git bundle` family:

- **`bundle create <file> <rev-list-args>`** — write a bundle: a UTF-8 header
  (version line, optional capabilities, prerequisite lines, ref lines, blank
  line) immediately followed by a packfile carrying the objects reachable from
  the included tips but not from the prerequisites.
- **`bundle verify <file>`** — confirm the bundle is well-formed and that every
  prerequisite commit it names is already present in the current repository;
  surface the refs it provides, the prerequisites it needs, the "records a
  complete history" fact, and the hash algorithm.
- **`bundle list-heads <file> [<refname>…]`** — list the refs the bundle
  defines, optionally filtered to an exact-full-name set.

In scope for this slice: bundle **version 2** (the git default for a SHA-1
repository), the three operations above, the include/exclude object closure, the
prerequisite (boundary) computation, and every refusal condition canonical git
raises. Out of scope (call-outs in §11 Decision-candidates): bundle **version 3**
and its capability lines (`@object-format=…`, `@filter=…`), SHA-256 repositories,
incremental "creation token" bundles, and `unbundle`/clone-from-bundle (the read
side that *imports* a bundle into a repo — a separate concern; `verify`
deliberately does **not** import).

**Through-line:** tsgit bundle is **bytes-in / bytes-out** — `create` returns the
bundle bytes for the caller to write, and `verify`/`listHeads` consume bytes the
caller has read. The library never opens the user's bundle path (it stays
portable and free of arbitrary-path file I/O, exactly as `archive` leaves tar/zip
bytes for the caller to write). See Decision-I (§11).

This design obeys two project directives verbatim:

- **Git-faithfulness (prime directive).** The bundle header bytes, ref and
  prerequisite ordering, the object closure, the refusal conditions, and the
  message wording are pinned against real `git` 2.54.0 in §4 and become
  cross-tool interop tests (§10). Nothing here is described from memory.
- **Structured output, not cosmetics.** The library returns structured data
  (refs, prerequisites, the complete-history boolean, the hash algorithm, object
  counts, oids). The human-readable lines `git bundle verify` / `list-heads`
  print are reconstructed *inside the interop test* from those fields, never
  emitted by the library. The one nuance bundle forces (a write op produces a
  binary file) is resolved in §7.

## 2. Precedents already in the codebase

Studied before designing; every reuse below was verified against current code.

| Concern | Existing symbol | File |
| --- | --- | --- |
| Pack body assembler (non-delta v2, full objects, trailer) | `buildPack(ctx, { oids }) → { bytes, sha, objectCount }` | `src/application/primitives/build-pack.ts` |
| "objects reachable from wants but not haves" closure | `enumeratePushObjects(ctx, { wants, haves, maxObjects }) → AsyncIterable<ObjectId>` | `src/application/primitives/enumerate-push-objects.ts` |
| Commit walk with `until` boundary | `walkCommits(ctx, { from, until, … })` | `src/application/primitives/walk-commits.ts` |
| Pack parsing pipeline (trailer verify, entry walk, idx build) | `verifyPackTrailer`, `walkPackEntries`, `buildIdx` | `src/application/primitives/fetch-pack.ts` |
| Ref enumeration (HEAD + loose + packed) | `enumerateRefs(ctx) → ReadonlyArray<RefName>` | `src/application/primitives/enumerate-refs.ts` |
| Single-rev resolution (errors `REVPARSE_AMBIGUOUS` / `REVPARSE_UNRESOLVED`) | `revParse(ctx, expression) → ObjectId` | `src/application/commands/rev-parse.ts` |
| Structured-result + pure serializer split | `archive(ctx, opts) → ArchiveResult`; `tarArchive`/`zipArchive` | `src/application/commands/archive.ts`, `src/domain/archive/` |
| Sub-operation namespace facade | `BranchNamespace` + `bindBranchNamespace(ctx, guard)` | `src/repository.ts`, `src/application/commands/internal/cherry-pick-namespace.ts` |
| Boundary-subject formatting (first message line) | `foldSubject` | `src/domain/objects/commit-message.ts` |

The `archive` command is the canonical precedent for the structured-output
directive and the serializer split (§7). The `cherry-pick`/`branch`/`config`
namespaces are the canonical precedent for a one-command-three-subcommands
facade (§8). `buildPack` is the pack writer — **do not hand-roll a second one**.

## 3. The on-disk bundle format (v2)

A v2 bundle is: a magic line, then prerequisite lines, then ref lines, then a
single blank line, then a raw v2 packfile.

```
# v2 git bundle\n
-<40-hex prereq-sha> <subject>\n      (zero or more, only for excluded boundary commits)
<40-hex ref-sha> <full-refname>\n     (one or more — a zero-ref bundle is refused)
\n                                     (single blank line terminates the header)
PACK……                                (raw v2 packfile: signature, version 2, count, objects, 20-byte SHA-1 trailer)
```

- The magic line is exactly `# v2 git bundle` + LF. v3 would be `# v3 git
  bundle` followed by `@`-prefixed capability lines; v3 is out of scope (§11-D).
- Prerequisite lines are prefixed with `-`, carry the boundary commit's oid and
  its **subject** (first line of the commit message), separated by one space.
- Ref lines carry the oid the ref points at (for an annotated tag, the **tag
  object** oid, *not* the peeled commit) and the **full** refname.
- The header is UTF-8 text; the pack body begins immediately after the single
  blank-line LF (no padding).

## 4. Pinned git behaviour (real `git` 2.54.0, isolated `HOME`, `GIT_*` scrubbed, signing OFF)

All bytes below were produced by `git bundle …` in a throwaway repo seeded with
deterministic author/committer dates. These are the faithfulness goldens; each
row becomes an interop assertion (§10).

### 4.1 `create` — header byte goldens

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
The output file is **not created** on any refusal.

### 4.3 `verify` — output and refusal

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

Refusals:

| Trigger | git stderr | exit |
| --- | --- | --- |
| Repository lacks a prerequisite | `error: Repository lacks these prerequisite commits:` then `error: <sha> ` per missing prereq | 1 |
| File is not a bundle | `error: '<path>' does not look like a v2 or v3 bundle file` | 1 |
| File cannot be opened | `error: could not open '<path>'` | 1 |

`verify` never imports the pack into the repository; it validates the header,
checks prerequisite presence, and (canonical git) runs the pack through
`index-pack` to a throwaway to confirm well-formedness. How deeply tsgit
validates the pack body (trailer-only via `verifyPackTrailer`, or a full
`walkPackEntries` parse) is Decision-H (§11); the refs/prerequisites the
structured result reports come from the **header** regardless.

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
`verify`: `error: '<path>' does not look like a v2 or v3 bundle file`, exit 1.

## 5. A note on pack bytes vs the byte-identity contract

The header bytes (magic, prerequisite lines, ref lines, blank line) are part of
the byte-identity contract and are pinned byte-for-byte. The **pack body bytes
are not** — exactly as for `push` and `clone`, which already stream
`buildPack` output that real git consumes. git itself produces non-deterministic
pack bytes (delta heuristics, threading, version drift). `buildPack` emits a
valid, non-thin, non-delta v2 pack; the faithfulness obligation for the pack is
behavioural: **real `git clone`/`git bundle verify`/`git index-pack` accepts a
tsgit-produced bundle**, and a tsgit reader accepts a real-git-produced bundle.
This is consistent with the structured-output directive (the contract binds data
and the on-disk *header* state, the pack is a faithful binary artifact whose
*content* — the object closure — must match, not its byte layout).

## 6. Structured data shapes

All oids are `ObjectId`, all refnames `RefName`; no rendered strings, no
`bytes`-only returns from the query ops.

```ts
// Shared
type BundleVersion = 2 | 3;                  // this slice emits 2; 3 reserved (§11-D)
type BundleHashAlgorithm = 'sha1';           // sha256 out of scope (§11-D)

interface BundleRef {
  readonly oid: ObjectId;                     // tag-object oid for annotated tags
  readonly name: RefName;                     // full refname, or 'HEAD'
}
interface BundlePrerequisite {
  readonly oid: ObjectId;                     // boundary commit
  readonly comment: string;                   // subject stored in the header (create-time)
}

// create — returns metadata AND the bytes (see §7)
interface BundleCreateResult {
  readonly version: BundleVersion;
  readonly bytes: Uint8Array;                 // header + packfile, ready to write
  readonly refs: ReadonlyArray<BundleRef>;
  readonly prerequisites: ReadonlyArray<BundlePrerequisite>;
  readonly objectCount: number;               // from buildPack
  readonly packSha: string;                   // pack trailer hex
}

// Read ops take bytes (the caller read the file); the library opens no path.
interface BundleVerifyInput {
  readonly bytes: Uint8Array;
}
interface BundleListHeadsInput {
  readonly bytes: Uint8Array;
  readonly names?: ReadonlyArray<RefName>;    // exact-full-name filter (§4.4)
}

// verify — a CQS query: well-formed-but-missing-prereqs is a normal result,
// not a thrown error (a malformed header does throw — §9)
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
line — none of it is emitted by tsgit.

## 7. The create bytes-vs-serializer split

`archive` returns a structured `ArchiveResult` and a **separate pure-domain
serializer** (`tarArchive`/`zipArchive`) turns it into bytes, because tar/zip
framing is pure given the (already-hydrated) entry stream. Bundle is different:
its pack body is produced by `buildPack`, an **application primitive that
performs object I/O** through `ctx`. A pure-domain "serialize a
`BundleCreateResult` to bytes" is therefore impossible without re-handing every
object's bytes to the caller — i.e. re-implementing `buildPack`.

The faithful, DRY decomposition:

- **Pure domain, header only** — a `serialize`/`parse` round-trip pair in
  `src/domain/bundle/`:
  - `serializeBundleHeader({ version, prerequisites, refs }) → Uint8Array`
  - `parseBundleHeader(bytes) → { version, hashAlgorithm, prerequisites, refs,
    packOffset }`
  These are a clean parse/serialize pair (round-trip property, §10a) and the only
  bytes in the byte-identity contract.
- **Application command** `bundleCreate` — resolves refs→oids, computes
  prerequisites (§8), runs `enumeratePushObjects`→`buildPack`, concatenates
  `serializeBundleHeader(...)` ++ `pack.bytes`, and returns
  `BundleCreateResult` carrying **both** the structured metadata **and** the
  `bytes`. The caller writes `bytes` to its chosen path.

**Why `create` returns bytes (and this honours the structured-output
directive).** The bytes are a faithful binary artifact (a header is byte-pinned;
a packfile is the same artifact `buildPack` already returns from `push`/`clone`),
not a cosmetic rendering of data the caller should format. The structured fields
are returned *alongside* the bytes so a caller can inspect/report without
re-parsing. tsgit does not own the output file path semantics (`git bundle
create <file>`): writing `bytes` to disk is the caller's responsibility, exactly
as `archive` leaves tar/zip bytes for the caller to write. This is Decision-C
in §11; the alternative (structured-only + a caller-driven re-serialize) is
rejected because it cannot produce the pack without `ctx`.

## 8. Command surface, object enumeration, prerequisite computation

### 8.1 Surface — one `bundle` namespace, three methods

git's CLI is `git bundle <subcommand>`. The faithful and idiomatic tsgit shape
mirrors `branch`/`cherryPick`/`config`: **one Tier-1 namespace** `repo.bundle`
exposing `create` / `verify` / `listHeads`, bound by
`bindBundleNamespace(ctx, guard)` in `src/repository.ts` and typed by a
`BundleNamespace` interface in `src/application/commands/internal/
bundle-namespace.ts`. This counts as **one** Tier-1 command for the surface
snapshot and README count (§8.4). (Decision-A in §11 weighs this against three
flat commands.)

```ts
interface BundleNamespace {
  create(opts: BundleCreateOptions): Promise<BundleCreateResult>;          // → bytes for the caller to write
  verify(input: BundleVerifyInput): Promise<BundleVerifyResult>;           // bytes-in
  listHeads(input: BundleListHeadsInput): Promise<BundleListHeadsResult>;  // bytes-in
}
```

### 8.2 `create` input — structured, not a rev-list-arg string

tsgit does not parse git's rev-list mini-language as a raw string (cf.
`range-diff`, which takes structured `base`/`tip`, and `log`, which takes an
`excluding` list). `bundle create` takes a structured selection:

```ts
interface BundleCreateOptions {
  readonly include?: ReadonlyArray<string>;   // ref-ish tips → each contributes a ref line
  readonly exclude?: ReadonlyArray<string>;   // negative tips → boundary/prerequisites
  readonly all?: boolean;                     // expand to sorted refs + HEAD (--all)
  readonly branches?: boolean;                // refs/heads/* (--branches)
  readonly tags?: boolean;                    // refs/tags/* (--tags)
}
```

Resolution algorithm (faithful to §4):
1. Expand `all`/`branches`/`tags` via `enumerateRefs`: `all` = every ref under
   `refs/` (heads, tags, remotes, …) sorted by full refname, then `HEAD`
   appended last; `branches`/`tags` = the sorted `refs/heads/*` / `refs/tags/*`
   subsets, no HEAD. Each expanded/explicit include is a `(name, oid)` pair —
   annotated tags keep the **tag-object** oid.
2. Explicit `include` entries preserve argument order; expansions are sorted.
3. Resolve `exclude` to commit oids via `revParse`, peeling annotated tags to
   their commit (the boundary walk takes commit oids).
4. If the resolved ref set is **empty**, refuse with the empty-bundle error
   (§4.2) — even if step 5 finds objects.
5. Compute the object closure and prerequisites (§8.3); if the closure is empty,
   refuse with the empty-bundle error.

Decision-B (§11) covers how far the include grammar reaches (named refs +
`--all/--branches/--tags` vs adding two-/three-dot ranges and `^`-exclusion).

### 8.3 Object enumeration & prerequisite (boundary) computation

- **Object closure:** `enumeratePushObjects(ctx, { wants, haves })` with
  `wants` = the included tips' oids (tags unwrapped to commits internally there)
  and `haves` = the resolved exclude commit oids. This is the verified "reachable
  from wants but not haves" walk; its output feeds `buildPack`.
- **Prerequisites = boundary commits.** git records `rev-list --boundary` of the
  excluded side: the excluded commits that are immediate parents of an included
  commit. `walkCommits`/`enumeratePushObjects` already drop parents that fall in
  `until`, but do not *expose* them. Two faithful options (Decision-E, §11):
  (a) add a thin boundary-collecting walk primitive (`walkBoundaryCommits` or an
  extra yield from the push walk) that records each parent skipped because it is
  in `haves`; (b) for the common ancestor case, take the resolved `exclude` tips
  themselves as prerequisites. Option (a) is the recommendation — it matches
  `--boundary` for merge-base and three-dot cases (where the boundary is *not* a
  literal exclude tip, e.g. `main...feature` → merge-base "second"). Each
  boundary commit's subject (via `foldSubject` on its message) fills
  `BundlePrerequisite.comment`.

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
  invoking `repo.bundle.create`/`verify`/`listHeads`, projecting to counts and
  booleans (no oids in assertions), runnable on Node/memory/browser.
- **Count + api.json** — bump `README.md` "41 Tier-1 commands" → 42 and
  regenerate `reports/api.json` via `npm run docs:json` (prepush gate).
- **New error codes** — add to the command-error union and wire exhaustiveness
  switches + the barrel-surface test in the same slice (§9, surface-gates rule
  for a new union member).

## 9. Error codes & refusal mapping

New members of the command-error union (`src/domain/commands/error.ts`), mapping
each pinned refusal (§4) to structured data — never a pre-rendered git line:

| Code | Data | Raised by | git analogue |
| --- | --- | --- | --- |
| `BUNDLE_EMPTY` | `{ reason: 'no-refs' \| 'no-objects' }` | `create` | `fatal: Refusing to create empty bundle.` |
| `BUNDLE_BAD_HEADER` | `{ reason }` | `verify`, `listHeads` | `… does not look like a v2 or v3 bundle file` |
| `BUNDLE_UNSUPPORTED_VERSION` | `{ version: number }` | `verify`, `listHeads` | (v3 read attempt — §11-D) |

Not new codes (reused):
- Unknown include ref → propagated `REVPARSE_UNRESOLVED` / `REVPARSE_AMBIGUOUS`
  from `revParse` (matches `fatal: ambiguous argument …`).
- File cannot be opened — **caller-side** under the bytes-in stance (§1
  through-line, Decision-I): the caller reads the path and reconstructs git's
  `error: could not open …`; the library raises nothing here because it never
  opens the path.
- **Missing prerequisites is NOT an error** — `verify` is a CQS query and
  returns `{ prerequisitesPresent: false, missingPrerequisites: [...] }`. The
  caller decides whether absence is fatal; the interop test reconstructs the
  `error: Repository lacks these prerequisite commits:` display from the
  structured field. (Decision-F in §11 confirms query-vs-throw for verify.)

## 10. Faithfulness interop-test plan

New file `test/integration/bundle-interop.test.ts` (a cross-tool harness like
`archive-interop.test.ts`), one shared seeded repo in `beforeAll`, real `git`
spawned with `GIT_*` scrubbed, isolated `HOME`, `GIT_CONFIG_NOSYSTEM=1`, signing
off, 60s timeout. Pinned assertions:

1. **create header parity** — tsgit `bundle.create({ all: true })` header bytes
   (up to the pack `PACK` signature) are byte-identical to `git bundle create`'s
   header for the same repo: magic line, sorted ref lines, `HEAD` last, blank
   line. Repeat for `{ include: ['refs/heads/main'] }`, `{ branches: true }`,
   `{ tags: true }`, and a range (`include:['main'], exclude:['main~2']`) whose
   header carries the `-<sha> <subject>` prerequisite.
2. **create object-closure parity** — the set of oids in tsgit's pack equals the
   set git packs for the same selection (parse both packs via the §2 pack
   pipeline; compare oid sets, not bytes).
3. **create → real git consumes** — write tsgit's bundle to a temp file and run
   `git bundle verify` and `git clone` against it; both succeed and the clone's
   refs/objects match.
4. **real git → tsgit reads** — `bundle.verify`/`listHeads` on a real-git-
   produced bundle return refs/prerequisites/hashAlgorithm matching git's
   `list-heads`/`verify` output (reconstruct git's stdout from the structured
   fields and diff).
5. **refusal parity** — empty rev-list, bare-rev-only tip, unknown ref (create);
   non-bundle file, unopenable file (verify/listHeads); missing prerequisite
   (verify, in an empty repo) → each matches git's message/exit reconstructed
   from the thrown code or the structured `missingPrerequisites`.
6. **list-heads filter parity** — exact-full-name matching only (`refs/tags/v1.0`
   matches; `v1.0`/`tags/v1.0`/`main` do not).
7. **hash-algorithm line** — `verify` reconstructs `The bundle uses this hash
   algorithm: sha1`.

Per the project's faithfulness rule, parity (cross-adapter) tests do **not**
prove faithfulness — only this interop harness does. A `bundle.parity` scenario
(§8.4) covers cross-adapter behaviour separately.

## 10a. Property tests (parser/serializer lens)

`src/domain/bundle/` adds a parse/serialize pair, so a `bundle-header.
properties.test.ts` sibling is warranted (round-trip lens): for an arbitrary
well-formed header model `{ version:2, prerequisites, refs }` over the ASCII
oid/refname grammar, `parseBundleHeader(serializeBundleHeader(h)) ≡ h` (modulo
documented ordering), and the prerequisite-count ↔ `-`-line-count 1:1 invariant.
Cheap round-trip → `numRuns: 200`. The example interop goldens (§4) stay — they
document the literal git bytes; the property proves the grammar.

## 11. Decision-candidates

Each is a load-bearing choice for the decisions conversation; ≤3 options, with a
recommendation. None is decided here.

**A. Command shape — one namespace vs three flat commands vs three bundle-prefixed
commands.**
- A1: one `repo.bundle` namespace with `create`/`verify`/`listHeads` (mirrors
  `git bundle <sub>` and the `branch`/`config` facade pattern; one Tier-1 count).
- A2: three flat Tier-1 commands `bundleCreate`/`bundleVerify`/`bundleListHeads`.
- A3: three flat commands named `bundle-create` etc.
- **Recommendation: A1** — faithful to git's CLI grouping, matches the existing
  namespace precedent, one surface-snapshot entry.

**B. `create` include grammar reach.**
- B1: named refs + `--all`/`--branches`/`--tags` only (covers the common backup
  and full-clone bundles).
- B2: B1 plus two-dot ranges and `^`-exclusion via the structured
  `include`/`exclude` lists (covers incremental bundles).
- B3: B2 plus three-dot symmetric ranges and arbitrary rev grammar.
- **Recommendation: B2** — `include`/`exclude` lists give ranges and exclusion
  without a rev-list string parser; three-dot/symmetric (B3) is rare and can
  follow later. (B1 alone cannot express incremental bundles, the headline
  bundle use case.)

**C. `create` return — bytes + metadata vs structured-only + separate
serializer.**
- C1: `BundleCreateResult` carries `bytes` **and** the structured fields; the
  pure-domain serializer is header-only (§7).
- C2: structured-only result; caller re-serializes via a domain function.
- **Recommendation: C1** — C2 is infeasible (the pack needs `ctx` I/O); C1 keeps
  the header byte-pinned in a pure round-trip pair while reusing `buildPack`,
  and stays within the structured-output directive (bytes are a faithful binary
  artifact, not cosmetic rendering).

**D. Bundle version / capability scope.**
- D1: emit v2 only; refuse to *read* v3 with `BUNDLE_UNSUPPORTED_VERSION`.
- D2: emit v2, read v2 + v3 (parse `@`-capability lines, accept
  `object-format=sha1`).
- D3: full v3 emit (capabilities, `object-format`, filters).
- **Recommendation: D1** — git defaults to v2 for SHA-1 repos; tsgit is SHA-1
  only today, so v3/sha256/filters add surface with no faithful counterpart yet.
  Reading v3 (D2) can follow when a v3 producer matters.

**E. Prerequisite (boundary) computation primitive.**
- E1: new thin `walkBoundaryCommits` primitive (or an added boundary yield from
  the push walk) implementing `rev-list --boundary`.
- E2: take resolved `exclude` tips directly as prerequisites.
- E3: post-hoc — diff the included oid set against each exclude tip's closure.
- **Recommendation: E1** — only E1 matches git's boundary for merge-base/
  three-dot cases (where the boundary is not a literal exclude tip); E2 is wrong
  for those, E3 is redundant work over the closure already walked.

**F. `verify` on missing prerequisites — query vs throw.**
- F1: return `BundleVerifyResult` with `prerequisitesPresent:false` +
  `missingPrerequisites` (CQS query; caller reconstructs git's `error:` line).
- F2: throw a `BUNDLE_MISSING_PREREQUISITES` error.
- **Recommendation: F1** — mirrors the `fsck` precedent (integrity failure is a
  structured finding, not a throw); malformed/unopenable files still throw
  (`BUNDLE_BAD_HEADER`/`FILE_NOT_FOUND`). Re-confirm whether a thrown variant is
  also wanted for ergonomic parity with git's non-zero exit.

**G. New error-code granularity.**
- G1: `BUNDLE_EMPTY { reason }`, `BUNDLE_BAD_HEADER { reason }`,
  `BUNDLE_UNSUPPORTED_VERSION { version }` (table in §9).
- G2: collapse empty-no-refs and empty-no-objects into a single `BUNDLE_EMPTY`
  without a `reason` discriminant.
- **Recommendation: G1** — git uses one message for both empty cases, but the
  `reason` discriminant is free structured data and keeps the two refusals
  testable in isolation (mutation-resistance).

**H. `verify` pack-validation depth.**
- H1: header + prerequisite presence only (no pack parsing).
- H2: header + pack **trailer** check via `verifyPackTrailer`.
- H3: header + full `walkPackEntries` parse (closest to git's `index-pack`).
- **Recommendation: H2** — cheap, catches truncation/corruption of the pack
  trailer, and keeps `verify` an O(header) + O(1)-pack-tail operation; H3's full
  parse is the faithful "is okay" but costs a whole-pack inflate the structured
  result does not need. H1 cannot detect a corrupt pack at all.

**I. Read-op input — bytes vs path.**
- I1: `verify`/`listHeads` take `{ bytes }`; the caller reads the file (and
  reconstructs git's `could not open` itself). Symmetric with `create` returning
  bytes; keeps the library portable and path-free.
- I2: take `{ path }` and read through `ctx.fs`, so the library raises
  `FILE_NOT_FOUND` faithfully.
- I3: accept either a byte buffer or an `AsyncIterable<Uint8Array>` stream.
- **Recommendation: I1** — matches the bytes-in/bytes-out through-line and the
  `archive` precedent (caller owns file I/O); `FILE_NOT_FOUND` faithfulness
  moves to the caller. I3 (streaming) is a later concern once a streaming pack
  reader exists; today `buildPack` and the pack pipeline are whole-buffer.
