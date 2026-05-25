# Phase 19.7 — Interop suite (canonical-git cross-tool)

Wave 0 (test base) closer of v2.0 alongside 19.8 (runtime parity).
19.1–19.6 hardened the test pyramid; 19.7 hardens the **other**
oracle — canonical `git`. For every byte tsgit writes to disk, prove
canonical `git` reads it (and where format determinism allows, prove
the bytes are *identical*).

This is a tooling-and-coverage phase, not a product phase: src/
gains no behaviour, only a `@writes` tag on each byte-emitting
module. The audit, the allowlist, the gating ramp, and the sweep of
existing surfaces mirror 19.4 / 19.5a verbatim — same posture,
different oracle.

## 1. Goals

1. **Every write surface in src/ is interop-tested.** A code path
   that emits Git-on-disk bytes is either covered by a
   `cross-tool-interop` test (per 19.4 bucket taxonomy) or sits in
   the new allowlist with a written reason.
2. **The contract is auditable and blocking.** A new audit
   (`tooling/audit-write-surfaces.ts`) joins `validate`. Ships
   warn-only first PR (sweep + retrofit), blocking next cycle per
   ADR-099 / ADR-125 pattern.
3. **Comparison strategy is explicit per surface.** Three kinds:
   *byte-identical* (fully-specified formats: loose objects, trees,
   refs, index, reflog, sparse-checkout, shallow),
   *equivalent-under-readback* (legitimate non-determinism — packfile
   delta selection, compression heuristics), and *readback-only* (Git
   accepts a wider input grammar than it writes, e.g. config text).
   Each `@writes` tag declares its kind; the interop test enforces
   the matching contract.
4. **The oracle is canonical `git`, not a snapshot.** Snapshots bake
   our own encoding into the repo; a tsgit mis-encoding would update
   the snapshot in the same PR and pass forever. Real `git` keeps
   the oracle external — see ADR-137.
5. **CI runs against pinned git versions.** A matrix of two pins
   (latest stable + most-recent LTS-ish that ships in
   `setup-git`-friendly distributions) catches both regressions
   *we* introduce and the rare format-touching changes `git` itself
   ships.

Deliberately deferred:

- Wire-format interop (smart-HTTP v1/v2 packfile request/response
  framing) — that surface is exercised at integration tier today via
  `git-http-backend`, but the byte stream is non-deterministic by
  design. Either a follow-up phase or a 19.8 deliverable once
  Cloudflare Workers harness lands the in-process transport.
- Bundle / archive / signed objects — these write surfaces don't
  exist yet (Phases 24.4, 24.3, 25.2). The `@writes` discipline
  applies to them when they ship; they don't need pre-emptive
  coverage today.
- A "what version of git did we last test?" attestation file. The
  CI matrix is the attestation; the report file (§3.6) records the
  matrix in metadata for each run.

## 2. Context

### 2.1 What the existing tests already prove

`test/integration/reflog-writers.test.ts` is the precedent. Its
`@proves` block reads:

```
surface: reflog
bucket:  cross-tool-interop
unique:  .git/logs/** on-disk format round-trips against canonical git
```

That file already does what 19.7 generalises: invokes
`execFileSync('git', ['reflog', '--no-abbrev', '--format=%H %gd %gs'])`
against a tsgit-written `.git/logs/` and asserts canonical `git`
returns the expected entries. The pattern is:

1. Build state with tsgit primitives/commands.
2. Open the same on-disk repo with canonical `git`.
3. Compare what `git` reads against what tsgit wrote — either
   byte-for-byte (file contents) or by semantic readback (`git
   cat-file -p`, `git ls-files --stage`, `git fsck`).

19.7's job is to enforce that **every** byte-emitting surface has a
test in this shape, not to invent a new test style.

### 2.2 Inventory of write surfaces

Cataloged from `src/domain/**/*` and `src/application/primitives/**/*`.
Each row maps a tsgit code path to a Git-on-disk format and a
proposed `surface` identifier (matches the 19.4 surface regex
`^[a-z][a-zA-Z0-9.-]{1,40}$`).

Final inventory (as shipped — pass 4 reconciles with implementation):

| # | Surface | Source | Format | Kind |
|---|---|---|---|---|
| 1 | `looseObject` | `primitives/write-object.ts` | `<type> <size>\0<payload>` zlib-deflated, filed by SHA | equivalent-under-readback |
| 2 | `tree` | `domain/objects/tree.ts` | sorted entries, raw SHA bytes (loose object) | equivalent-under-readback |
| 3 | `commit` | `domain/objects/commit.ts` | header lines + blank + message (loose object) | equivalent-under-readback |
| 4 | `tag` | `domain/objects/tag.ts` | tag header + message (loose object) | equivalent-under-readback |
| 5 | `looseRef` | `domain/refs/loose-ref.ts` | `<sha>\n` in `.git/refs/**` | byte-identical |
| 6 | `packedRefs` | `domain/refs/packed-refs.ts` | header + sorted ref lines, peel `^` annotations | byte-identical |
| 7 | `symbolicRef` | `primitives/write-symbolic-ref.ts` | `ref: <target>\n` in `HEAD` etc. | byte-identical |
| 8 | `index` | `domain/git-index/index-writer.ts` (v2 + v3 paths) | DIRC header + entries + extensions + trailer SHA | equivalent-under-readback |
| 9 | `reflog` | `domain/reflog/reflog-format.ts` | one line per entry in `.git/logs/**` | byte-identical |
| 10 | `sparseCheckoutFile` | `primitives/write-sparse-checkout.ts` | `.git/info/sparse-checkout` pattern list | byte-identical |
| 11 | `shallowFile` | `primitives/shallow-file.ts` | `.git/shallow` sorted SHA list | byte-identical |
| 12 | `packfile` | `domain/storage/pack-writer.ts` (writes both .pack body and .idx body) | v2 packfile + pack-index | equivalent-under-readback |
| 13 | `config` | `primitives/update-config.ts` | git-config text format (`.git/config`) | readback-only |

Thirteen surfaces. Two adjustments from the pass-3 inventory:

- **All loose-object surfaces are `equivalent-under-readback`, not
  `byte-identical`.** The audit's first run caught this in the
  `looseObject` test: tsgit uses Node's `deflateSync` default
  compression level (6), canonical git uses level 1. SHA matches
  (compression is over the same payload) but disk bytes differ.
  This is a property of the Git format, not a tsgit bug — the
  on-disk loose-object spec doesn't pin compression level.
  Promotion path: pin tsgit to git's level (small product change)
  would let us tighten to byte-identical, but is out of scope for
  19.7.
- **`packIndex` is absorbed into `packfile`.** The .idx writer
  (`serializePackIndex`) lives in `pack-writer.ts` alongside
  `serializePackfile`, and ADR-140 forbids two `@writes` tags per
  file. The single `packfile` surface covers both .pack and .idx
  emission; the interop test asserts `git fsck` accepts both files
  together (a malformed .idx would fail fsck just as a malformed
  .pack would). If we later split the writers into separate files
  (good factoring), we add the second tag then.

`reflog` was the precedent (its test already existed, retagged in
place to add `interopSurface: reflog`). The other twelve surfaces
each ship one new interop test in this PR.

### 2.3 Why three "kinds"

**`byte-identical`** is the strict claim: write bytes with tsgit,
read raw bytes from disk, `expect(actual).toEqual(canonicalGit)`.
Holds for everything where Git's format is fully specified — object
encodings, refs, index, reflog, sparse-checkout, shallow.

**`equivalent-under-readback`** acknowledges Git's legitimate
non-determinism. Two valid Git implementations writing the same
logical content (same set of objects, same tree) can produce
bit-different packfiles — delta base selection is a heuristic, not
a spec; deflate compression level is implementation-defined. The
contract is weaker but still strong: canonical `git fsck` must
accept the packfile, and `git cat-file --batch-all-objects` against
our pack must enumerate the same objects with the same contents as
canonical git's pack.

**`readback-only`** is the loosest contract: we prove canonical
`git` parses what tsgit wrote and surfaces the same logical content,
without claiming the bytes match. Reserved for surfaces where Git's
own writer is non-canonical (config text — Git accepts wide
whitespace variation; ordering and comment preservation are
implementation-defined). The interop test seeds via tsgit, reads via
`git config --get` / `git config --list`, and asserts the expected
key/value semantics. Promotion path: if we ever need byte equality
for config (e.g. to lock section ordering), the surface is
re-declared as `byte-identical` and the test tightens.

### 2.4 Why blocking after one cycle (not first-PR blocking)

19.5a went blocking on first PR because the property it audited
(browser-spec coverage) is binary and crisp. 19.7's property is also
binary, but the sweep is large enough that retrofitting it in a
single PR carries refactoring risk in the interop tests themselves.
Ship warn-only on the sweep PR (same posture 19.4 took); flip
blocking once the audit has been clean for one merge cycle.

## 3. Architecture

### 3.1 Pipeline

```
src/**/*.ts ──parseWritesTags──► WriteSurfaceSet
test/integration/**/*.test.ts ─┐
                               ├──parseInteropCoverage──► CoverageSet
test/integration/interop/*.ts ─┘
allowlist.json                  ──────────────────────► ExemptSet

(WriteSurface − Covered − Exempt) = Gaps
Gaps.length === 0  ⇒  exit 0
Gaps.length  > 0   ⇒  warn-only first cycle / exit 1 once blocking
report: reports/write-surface-coverage.json
```

### 3.2 The `@writes` tag — src side

A JSDoc directive on the **module** that emits the bytes (file-level
header block), exact same grammar discipline as 19.4's `@proves`.

```ts
/**
 * Domain serializer for tree objects: maps {entries} → canonical
 * binary form. Used by createCommit, write-tree, materializeTree.
 *
 * @writes
 *   surface: tree
 *   kind:    byte-identical
 *   format:  git-tree-object
 */
```

Parser rules (mirror 19.4 §3 exactly):

- Block must begin within the first JSDoc of the file.
- Each `@writes` carries `surface`, `kind`, `format`.
- `surface` matches `^[a-z][a-zA-Z0-9.-]{1,40}$` — same regex as
  `@proves` (per ADR-121) so surface names are interchangeable
  between the two audits.
- `kind` ∈ `{ byte-identical, equivalent-under-readback, readback-only }`.
- `format` is free-form for traceability (e.g. `git-tree-object`,
  `pack-index-v2`, `git-config-text`). Lowercase, kebab-case, 4–40
  chars.
- A file may carry **at most one** `@writes` tag. If a file emits
  two surfaces (e.g. an index writer that branches v2/v3 in one
  module), split it or pick the primary — the audit forces clarity.
- Index writer is the obvious case where one file produces two
  surfaces (`indexV2`, `indexV3`). Resolution: tag the module as
  `surface: index`, and let the interop test cover both versions
  via parameterisation. The audit surface name doesn't need to
  enumerate every variant; it identifies the writer.

### 3.3 The `interopSurface:` key — test side

The existing 19.4 `@proves` block gains an optional key:

```
@proves
  surface:        index
  bucket:         cross-tool-interop
  unique:         index v2 + v3 round-trip against `git ls-files --stage`
  interopSurface: index
```

If `bucket: cross-tool-interop`, `interopSurface` is **required**.
For all other buckets, it MUST be absent (or the audit rejects the
file). This keeps the existing 19.4 surface taxonomy untouched —
`surface:` is the "what" of integration tests; `interopSurface:` is
the precise pointer to a `@writes` declaration. They are usually
identical, but the indirection allows a single interop test to
cover multiple write surfaces (e.g. `index` covers both
`indexV2`/`indexV3` if the writer module splits later).

Grammar (extends 19.4 parser):

- Single line, comma-separated list permitted: `interopSurface:
  packfile, packIndex`.
- Each name must match a `@writes surface:` value somewhere in src.
- Order is irrelevant; the audit compares as a set.

### 3.4 The audit — `tooling/audit-write-surfaces.ts`

Mirrors `tooling/audit-browser-surface.ts` shape.

```ts
type WriteSurface = {
  readonly name: string;
  readonly kind: 'byte-identical' | 'equivalent-under-readback' | 'readback-only';
  readonly format: string;
  readonly declaredIn: string;  // src/... path
};

type Coverage = {
  readonly surface: string;
  readonly coveredBy: ReadonlyArray<string>;  // test/... paths
};

type AllowEntry = {
  readonly surface: string;
  readonly reason: string;            // non-empty
  readonly deferredTo: string | null; // phase tag or null for permanent
};

const main = (): number => {
  const surfaces = parseWritesTags(loadSourceFiles('src/'));
  const covered  = parseInteropCoverage(loadTestFiles('test/integration/'));
  const exempt   = loadAllowlist('tooling/audit-write-surfaces.allowlist.json');

  validateAllowlistAgainstDeclared(surfaces, exempt);  // unknown name → fail

  const gaps = computeGaps({ surfaces, covered, exempt });
  writeReport(gaps, surfaces, covered, exempt);

  return gaps.length === 0 ? 0 : (gating.blocking ? 1 : 0);
};
```

Scanning rules:

- `parseWritesTags` walks `src/**/*.ts` (excluding `*.test.ts`,
  `*.spec.ts`, `*.properties.test.ts`, and `index.ts` re-export
  barrels). Reads only the file head until the first `*/`. If no
  `@writes` is present, the file is ignored (most src files don't
  write bytes).
- `parseInteropCoverage` is a thin orchestrator: it calls 19.4's
  `parseProvesHeader` to get the three required keys, then calls
  19.7's new `parseInteropSurface` (sibling file
  `tooling/audit-write-surfaces/parse-interop-surface.ts`) to
  extract and validate the optional `interopSurface` field. The
  validation enforces: `bucket: cross-tool-interop` ⇒
  `interopSurface` required; otherwise forbidden. This split keeps
  19.4's parser unaware of interop semantics.
- `validateAllowlistAgainstDeclared` rejects allowlist entries that
  name a surface no `@writes` tag declares. Same rot-prevention
  pattern 19.5a uses.

### 3.5 The allowlist —
`tooling/audit-write-surfaces.allowlist.json`

```jsonc
{
  "surfaces": [
    {
      "surface": "<name>",
      "reason": "<why this surface ships without interop coverage>",
      "deferredTo": "<phase tag or null for permanent>"
    }
  ]
}
```

Schema validated at audit start; malformed file fails the audit.
Same shape as `audit-browser-surface.allowlist.json` for review
consistency.

For 19.7's sweep PR, the allowlist opens **empty**. All 14 declared
surfaces ship an interop test in this PR — `config` is covered by a
`readback-only` test, not by allowlist (kinds, not waivers, encode
the comparison contract).

### 3.6 Report — `reports/write-surface-coverage.json`

Written every run (committed, not gitignored — diff visibility).

The audit is **static analysis** — it doesn't invoke `git`. The
report has no `git.version` field; the matrix-specific per-test
artefacts in CI capture which binary executed each interop suite.

```jsonc
{
  "summary": {
    "declared": 14,
    "covered":  14,
    "exempt":   0,
    "gaps":     0
  },
  "covered": [
    {
      "surface": "reflog",
      "kind":    "byte-identical",
      "format":  "git-reflog-line",
      "declaredIn": "src/domain/reflog/reflog-format.ts",
      "coveredBy":  ["test/integration/reflog-writers.test.ts"]
    },
    ...
  ],
  "exempt": [...],
  "gaps":   []
}
```

All lists sorted by surface name (deterministic diff).

### 3.7 Test layout — where do interop tests live?

Two options:

(a) Mix new interop tests into `test/integration/` root with their
peers (reflog precedent uses this).

(b) Move them under `test/integration/interop/` as a sub-directory.

(a) — sticks with the precedent. `reflog-writers.test.ts` is at the
integration root with `bucket: cross-tool-interop`. The 19.4
directory rules (§5.3 of phase-19-4 design) explicitly state
`cross-tool-interop` files live at integration root. Moving them to
a subdir would require widening 19.4's directory rule and adding
another carve-out. The bucket header is already the classifier; no
need to also encode classification in the path.

### 3.8 Git binary discovery and version pinning

Local development uses whatever `git` is on `$PATH`. Tests use
`it.skipIf(!hasGit())` so contributors without git installed still
run the rest of the suite. `hasGit()` is a synchronous check via
`spawnSync('git', ['--version'])` cached at module load.

CI matrix (added to `.github/workflows/ci.yml`):

```yaml
- name: interop (git latest)
  # uses the git binary preinstalled on ubuntu-latest
  run: npm run test:integration -- test/integration/interop

- name: interop (git 2.39 LTS)
  # installs a pinned git via marketplace action or local composite step
  run: npm run test:integration -- test/integration/interop
```

The pin set is `{ latest-stable-on-runner, 2.39 LTS }`. 2.39 is
the version Debian Bookworm and Ubuntu 22.04 ship; it has the
SHA-256 transition and modern packfile defaults. If the audit ever
needs three pins, we add them — but two is the minimum for catching
"new-git regression" vs "pre-existing tsgit bug" attribution.

How the 2.39 pin is installed is an implementation detail of the CI
job: either a marketplace action that wraps `apt-get install git=…`
or a local composite step that builds from the tarball. Whichever
ships first; both are equivalent for the test's purposes. CI
uploads each matrix entry's test output as a separate artefact for
post-mortem.

### 3.9 Wireit integration

New `check:write-surfaces` script joining the `validate` chain:

```jsonc
"check:write-surfaces": {
  "command": "tsx tooling/audit-write-surfaces.ts",
  "files": [
    "src/**/*.ts",
    "test/integration/**/*.test.ts",
    "tooling/audit-write-surfaces.ts",
    "tooling/audit-write-surfaces.allowlist.json",
    "tooling/test-pyramid/parse-proves-header.ts"
  ],
  "output": ["reports/write-surface-coverage.json"]
}
```

Joined alongside `check:browser-surface`, `check:doc-coverage`,
`check:test-pyramid`.

### 3.10 Composition with 19.4's audit

19.4's `parseProvesHeader` is the canonical reader of the three
required keys (`surface`, `bucket`, `unique`). It does **not** know
about `interopSurface`. 19.7 ships its own thin reader
(`parse-interop-surface.ts`) that:

- Parses `interopSurface` from the same JSDoc block (one regex pass).
- Enforces the contract: `bucket: cross-tool-interop` ⇒
  `interopSurface` required; otherwise forbidden.
- Resolves comma-separated lists into a `Set<string>`.

The split — 19.4 owns the three required keys; 19.7 owns the
optional interop key and its bucket-gated semantics — keeps each
audit's surface area independent. A future "wire interop" audit
(deferred) can add another optional key without touching either.

## 4. Comparison strategy — per kind

### 4.1 `byte-identical`

The canonical pattern: drive canonical `git` to produce the same
logical state in a peer tmpdir, then diff the files.

```ts
// Set up peer tmpdir; perform equivalent operations via canonical
// `git`; copy the produced bytes; compare.
const peer = await mkdtemp(...);
execFileSync('git', ['-C', peer, 'init']);
execFileSync('git', ['-C', peer, 'update-ref', 'refs/heads/main', sha]);

// tsgit side
await tsgitWrites(ctx, input);
const ours   = await readFile(path.join(repo, '.git/refs/heads/main'));
const theirs = await readFile(path.join(peer, '.git/refs/heads/main'));
expect(ours).toEqual(theirs);
```

A few surfaces (e.g. loose object files keyed by SHA) can be
directly compared by SHA path — write with tsgit, write the same
content with `git hash-object -w`, read both files, diff bytes. The
peer-tmpdir pattern remains the default; SHA-keyed shortcuts are
opportunistic.

The interop tests never normalise: encoding-line-ending,
canonicalisation, or stat-cache fields stay raw in the diff. Any
needed exclusions are surface-specific (e.g. index stat-cache
mtime/ctime are zeroed before compare per §4.3).

### 4.2 `equivalent-under-readback`

Reserved for surfaces with implementation-defined choices that two
valid Git writers can disagree on bit-wise (packfile delta base
selection, deflate compression level).

```ts
await tsgitWrites(ctx, input);                       // tsgit produces .git/objects/pack/...
execFileSync('git', ['-C', repo, 'fsck', '--strict']); // accepts → 0
// Enumerate objects from ours; compare to a peer-tmpdir packed by
// canonical `git`.
const ours = listObjectsViaGit(repo);
const peer = await mkdtemp(...);
execFileSync('git', ['-C', peer, 'init']);
// Replay the same logical commits in peer via canonical `git`;
// run `git repack` to produce its packfile.
const theirs = listObjectsViaGit(peer);
expect(ours).toEqual(theirs);  // same SHA set, same content
```

`fsck` is the strict acceptance gate. The object-set comparison
catches dropped objects. Compression bytes are explicitly NOT
compared.

### 4.3 `readback-only`

The weakest contract. Used when canonical `git` accepts a wider
input grammar than it produces (config text, today the only
instance). Pattern:

```ts
await tsgitWrites(ctx, input);                       // tsgit writes .git/config
const output = execFileSync('git', ['-C', repo, 'config', '--list']);
expect(parseGitConfigOutput(output)).toEqual(expectedKeyValuePairs);
```

No file diff; the contract is "git reads what we wrote, and the
semantic content matches." Promotion to `byte-identical` is always
possible if a future surface needs the stricter claim.

### 4.4 What we don't compare

- Timestamps in the index stat-cache (intentionally per-host).
- Packfile trailer SHA when the object order differs.
- `gc.auto`-style touched files (`.git/FETCH_HEAD`, `.git/ORIG_HEAD`)
  — out of write-surface scope; those are command-residue files
  that change per-invocation.

## 5. Testing strategy

### 5.1 The interop tests themselves

13 new files (one per surface in §2.2 minus the `reflog` precedent,
which is retagged in-place to add `interopSurface: reflog`). Each
follows the existing `reflog-writers.test.ts` shape:

- Top-of-file `@proves` block with `bucket: cross-tool-interop` +
  `interopSurface: <name>`.
- Setup: build state with tsgit primitives/commands. The interop
  test should drive the **highest-level** API that exercises the
  write — `commit()` rather than `writeObject()` directly — so it
  catches composition bugs too.
- Comparison: per §4 based on kind.
- `it.skipIf(!hasGit())` guard.

### 5.2 Unit tests for the audit

`tooling/test/unit/audit-write-surfaces/` mirrors
`tooling/test/unit/audit-browser-surface/`:

- `parse-writes-tag.test.ts` — exhaustive grammar coverage (every
  error path in §3.2, every happy path).
- `compute-gaps.test.ts` — synthetic `{ surfaces, covered, exempt }`
  → assert gap partitioning.
- `load-allowlist.test.ts` — schema validation, unknown-surface
  rejection.

### 5.3 Integration tests for the audit

`tooling/test/integration/audit-write-surfaces.test.ts`:

- Build a temp tree with three src files (one `@writes`, one
  without, one malformed) and two interop tests (one matching, one
  orphaned).
- Run the audit's `main()`; assert exit code + report content.

### 5.4 What we deliberately don't test

- We don't test against multiple git versions in the unit/audit
  suite. The CI matrix does that. Local runs use one git.
- We don't fuzz the comparison strategy. The interop tests are
  case-based by design — they document specific scenarios. Property
  exercise is 19.6's job.

## 6. Manifest changes

`test-pyramid-budgets.json` already has 19.4's `integrationProof`
heuristic. 19.7 doesn't add a heuristic; it adds a sibling key in
the existing block to declare the new `interopSurface` key as
valid:

```jsonc
"integrationProof": {
  ...,
  "interopSurfaceRegex": "^[a-z][a-zA-Z0-9.-]{1,40}$",
  "interopSurfaceRequiredFor": ["cross-tool-interop"]
}
```

The schema (`tooling/test-pyramid-budgets-schema.json`) gains the
two new keys. `parseManifest` validates the regex compiles and the
required-for list is a non-empty subset of `buckets`.

A new top-level manifest entry isn't needed — 19.7's audit is
a stand-alone tool that loads its own allowlist. The schema
addition is purely so 19.4's audit understands the new
`interopSurface` key it sees on cross-tool-interop test files.

## 7. Sweep — retrofitting existing surfaces

Per §2.2, 14 surfaces. One (`reflog`) already has its interop
test. The PR ships:

- 14 `@writes` JSDoc blocks added to src files (tagging reflog
  too — see below).
- 13 new interop tests (one per uncovered surface).
- 1 in-place test edit (reflog precedent gains `interopSurface:
  reflog`).
- The audit, schema additions, empty allowlist file.

Why tag reflog even though the test exists: `@writes` is the SOURCE
OF TRUTH for "this code emits bytes." If a future refactor of
`reflog-format.ts` doesn't carry the tag forward, the audit will
flag the gap. The test's `interopSurface:` is the coverage claim;
the src tag is the obligation.

Sweep ordering (one commit per surface, atomic):

1. `looseObject` — header.ts + write-object.ts + new test.
2. `tree` — tree.ts + new test.
3. `commit` — commit.ts + new test.
4. `tag` — tag.ts + new test.
5. `looseRef` — loose-ref.ts + new test.
6. `packedRefs` — packed-refs.ts + new test.
7. `symbolicRef` — write-symbolic-ref.ts + new test.
8. `index` — index-writer.ts + new test (v2 + v3 parameterised).
9. `sparseCheckoutFile` — write-sparse-checkout.ts + new test.
10. `shallowFile` — shallow-file.ts + new test.
11. `reflog` — reflog-format.ts tag only; existing test gains
    `interopSurface: reflog`.
12. `packfile` + `packIndex` — pack-writer.ts + pack-index.ts +
    one combined test (they're inherently paired by SHA trailer;
    `interopSurface: packfile, packIndex`).
13. `config` — update-config.ts + new readback-only test.

Each commit follows TDD: write the interop test (red — fails the
audit gap), add the `@writes` tag (audit gap closes), validate,
commit. The audit (and its own unit/integration tests) lands first,
in commit zero, so all subsequent commits run against the gate.

## 8. Key design decisions (ADRs)

- **ADR-137** — Real-`git` integration over snapshot fixtures.
  Snapshots calcify our own encoding; a tsgit mis-encoding becomes
  the golden and we grade our own homework. Canonical `git` keeps
  the oracle external.
- **ADR-138** — Three comparison kinds: `byte-identical` for
  fully-specified formats, `equivalent-under-readback` for surfaces
  with legitimate non-determinism (packfile delta selection,
  compression), `readback-only` for surfaces where `git`'s own
  writer is non-canonical (config text).
- **ADR-139** — Audit gating ramp: warn-only on sweep PR, blocking
  after one merge cycle (same posture as ADR-099, ADR-125).
- **ADR-140** — `@writes` JSDoc tag grammar; single per file;
  `surface`/`kind`/`format` triad; mirrors `@proves` regex for
  surface-name interoperability with 19.4.

(Numbering tentative — actual numbers assigned at land time
against current HEAD, last is ADR-136.)

CI git-version pin set is a pure operational choice (see §3.8),
not user-deliberated — no ADR.

## 9. Risks and trade-offs

- **CI cost.** Two matrix entries × 14 new tests × per-test `git`
  spawn = noticeable wall time. Mitigation: each interop test is a
  single scenario (no parameterisation explosion); peer tmpdirs
  are reused across `it`s where possible; CI runs the matrix only
  on PR + main, not on every push.
- **Git version drift in CI runners.** GitHub's `ubuntu-latest`
  bumps `git` periodically. The `latest-stable` label is
  deliberately not pinned to a version — we WANT to find out when
  `git` ships a format change. The 2.39 pin is the safety net.
- **`config` interop is `readback-only`, not byte-identical.**
  Documented in §2.3. Promotion path is to redeclare the surface
  as `byte-identical` and tighten the test; the kind is a one-line
  change in the `@writes` block.
- **Single `@writes` per file forces clarity.** Like 19.4's single
  `@proves`, a file that writes two surfaces is forced to split or
  pick a primary. Index v2/v3 is the only borderline case today;
  we resolve it via a single `index` surface and parameterise the
  test. If a file genuinely emits two unrelated formats later, the
  resolution is to extract one of them — that's good factoring,
  not pain caused by the rule.
- **Cross-tool-interop bucket already has one resident; this PR
  adds 13 more.** That's a 14× growth of the bucket in one PR.
  Per 19.4 §13 the duplicate detector ignores prose overlap; the
  growth doesn't trip any existing audit. But it does shift the
  bucket distribution noticeably — the 80/15/5 pyramid target
  (19.2) will see integration tier grow. Documented in the design
  so the next pyramid audit run doesn't read as a regression; the
  growth is intentional Wave-0 hardening.
- **`fsck --strict` is the acceptance gate, not a free pass.** Some
  malformations escape fsck (e.g. dangling reflog entries, unused
  pack objects). For surfaces where fsck would be too lenient, the
  test layers an explicit `git cat-file --batch-check` or
  `git ls-files --stage` assertion on top.

## 10. Out of scope (explicit deferrals)

- **Wire-format interop** (smart-HTTP packfile request/response
  framing). The transport-tier integration tests
  (`test/integration/network/`) already run against
  `git-http-backend`; they cover composition, not encoding bytes.
  A future phase (probably 19.8 or 20.x) will add `@writes` /
  interop coverage for transport encoders if/when we decide that's
  necessary.
- **Reading interop.** This phase covers writes only. Reading
  divergence (we accept malformed input, canonical git rejects;
  or vice versa) is a property-testing concern (19.6) and an
  ongoing review concern, not a sweep.
- **Net-new test fixtures.** Existing fixtures
  (`test/fixtures/**`) are not touched. Interop tests build their
  own state in tmpdirs.
- **Mutation budget changes.** 19.1 budgets are per-bucket; the
  new interop tests live in the integration bucket (no per-test
  mutation gate). No budget tweak required.
- **Renaming surfaces post-tag.** Once a `@writes surface:` is
  shipped, renaming it is a breaking change to the audit's input
  and the reports. Like ADR-121 surface names, treat as semi-stable
  identifiers; rename only via a deliberate PR.

## 11. Open questions (resolved before implementation)

- **`@writes` placement — module head or function head?** Module
  head. Mirrors `@proves` and keeps the audit's parser cheap.
- **Allow `interopSurface` to list multiple surfaces?** Yes —
  comma-separated. Concrete need: `packfile` + `packIndex` share
  a single test (they're written together with shared SHA trailer).
- **Should the audit verify that the test actually invokes `git`?**
  No. That's a code-review concern; static detection is brittle
  (`spawn`, `execFileSync`, `execFile`, helper modules). The
  bucket declaration `cross-tool-interop` is the contract; if a
  reviewer accepts a "cross-tool-interop" test that never spawns
  git, that's a review escape, not an audit miss.
- **Tag `git` versions in the audit's report?** No — the audit is
  static analysis and doesn't invoke `git` (§3.6). The per-matrix
  CI artefacts capture which binary executed each interop suite.
- **First-PR scope — all 13 new tests, or split?** All 13. The
  audit is binary; landing it on a partial sweep would mean
  shipping with an allowlist that lies about deferrals. Better to
  do the work once.

## 12. Convergence pass log

- **Pass 1** — initial draft.
- **Pass 2** — reconciled `index` as a single surface (collapsed
  `indexV2`/`indexV3`); promoted `readback-only` from "narrowed
  byte-identical" to a third comparison kind so `config` doesn't
  need an allowlist waiver; dropped `git.version` from the static
  audit report; moved `interopSurface` parsing/validation out of
  19.4's parser into a sibling 19.7 reader; dropped the ADR for
  CI git-version pins (operational, not user-deliberated);
  reconciled sweep counts (14 surfaces, 13 new tests, 1 in-place
  retag); rewrote §4.1 around the peer-tmpdir pattern; added §4.3
  `readback-only` comparison body.
- **Pass 3** — fixed §2.3 heading ("two" → "three"); deleted
  duplicate scanning-rule bullet in §3.4 left over from pass 2;
  removed pass-1 reference to a nonexistent §6 "tsgit-versions
  extension"; rephrased §3.8 CI snippet to remove the imaginary
  `./.github/actions/install-git-version` path; reconciled §9 +
  §11 with the §3.6 decision (audit is static analysis, no
  git-version in report; config kind is `readback-only`, not an
  allowlist case); tidied §5.1 paragraph break.
- **Pass 4 (post-implementation)** — reconciled inventory with the
  reality the audit exposed: all loose-object surfaces are
  `equivalent-under-readback` (zlib level differs between tsgit and
  canonical git), and `packIndex` is absorbed into `packfile`
  (they share `pack-writer.ts`, which ADR-140 limits to one tag).
  Also recorded the trailing-space bug in `serializePackedRefs`
  that the audit caught — fixed in the same PR.

Converged at pass 4 (one post-implementation correction).
