# Plan — Per-command profile capture (`npm run profile <cmd>`); commit baseline

> Source: design doc `docs/design/per-command-profile-capture.md` · ADRs 475, 476, 477, 478
> The plan is the implementation script AND the knowledge handoff. Part agents start
> with zero context: whatever a part block omits is paid later as agent rediscovery.
> `plan-lint.sh` enforces the schema below — the plan phase cannot close without it.

## Scope note — this is TOOLING work (read before touching any part)

Every part touches `tooling/**` (plus its optional test siblings under `tooling/test/unit/**`)
and the generated `docs/perf/**` artifact. **No `src/` change, no public API change** — ADR-477
confirms this is tooling-only, so there is **no** faithfulness matrix, interop test, barrel,
facade, `api.json`, README-count, doc-coverage, or browser-surface gate to pay. The
surface-gates checklist (`.claude/workflow/surface-gates.md`) does not fire: nothing here adds a
library-user-reachable export.

`tooling/**` is **outside** the coverage/mutation `include` (`vitest.config.ts` instruments only
`src/{domain,ports,adapters/node,adapters/memory,operators}/**`), so **no 100%-coverage / 0-mutant
obligation** applies to any file this plan creates. The unit tests folded into Parts 1, 2, 4 and 5
are *optional-but-worthwhile* asserting tests over the genuinely-pure helpers (they document the
parser/resolver/writer contracts and give the part-gate's `vitest run` something to assert); they
are **not** coverage-gated. Parts 3 and 6 have no asserting test — the scratch factory and the
`profile.ts` orchestration are "verified by running the tool" (design Test/faithfulness plan), so
their part-gate reduces to `check:types` + `biome check` over the touched files. This is **not** a
"test-only part" problem in reverse: these are production-tooling parts whose behaviour is exercised
end-to-end by Part 7's real profiler run.

**Resolved config question (the invocation flagged it):** `vitest.config.ts` line 22 includes
`tooling/test/unit/**/*.test.ts` in the `unit` project, and `tooling/test/unit/` already holds pure-parser
tests (`max-chain-depth-oid.test.ts`, `bench-to-snapshot.test.ts`) imported via a `.js`-suffixed
relative path (e.g. `../../bench-to-snapshot.js`). So the optional unit tests DO have a config home and
DO run under the part-gate. No new vitest wiring is needed.

**Every part lands as ONE atomic conventional commit.** No phase/ADR/backlog refs in code, test names,
or commit messages — the commit is the join point. Run the gate green before committing; never commit red.

## Sizing rules

- Every part costs a full agent lifecycle (spin-up, zero-context rebuild, gate) — it
  must earn it. No standalone test-only parts for FEATURE code: coverage/interop/property
  tests fold into the implementation part whose code they exercise. EXCEPTION:
  test-infra-only and docs-only parts (tooling config, test helpers, fixtures,
  harness/ADV/property suites, docs/prose) with no `src/` delta ARE standalone — they
  have no implementation part to fold into. **Every part here is a tooling-infra part with
  no `src/` delta**, so each is legitimately standalone; the asserting unit tests are folded
  into the part that creates the module they exercise (not split out).
- A part that would be a pure test pass over already-landed code merges into its neighbour.

## Ordering (dependency-natural, leaf-first — each part type-checks and passes biome in isolation)

1. `profile-env.ts` — leaf, no tooling deps (imported by Parts 3 and 4).
2. `profile-digest.ts` — leaf parser, no tooling deps (imported by Parts 5 and 6; NOT by the registry).
3. `profile-scratch-repo.ts` — imports `profile-env` (Part 1) + dist/`src` types (imported by Parts 4 and 6).
4. `profile-registry.ts` — imports `profile-env` (Part 1), `profile-scratch-repo` types+`PROFILE_AUTHOR` (Part 3), and `fixture-generator` (imported by Part 6). It does NOT import `profile-digest`.
5. `profile-baseline.ts` — imports `profile-digest`'s `DigestPartition` type (Part 2) (imported by Part 6).
6. `profile.ts` orchestration swap — wires Parts 1–5, replaces `HOT_PATHS`/`runChild`/parent loop.
7. Generated baseline — run `npm run profile`, commit `docs/perf/baseline.{json,md}`.

A part may import a sibling not yet wired into `profile.ts`; the import graph is acyclic —
`env` is a leaf; `digest` is a leaf; `scratch-repo → env`; `registry → env + scratch-repo`;
`baseline → digest`; only Part 6 (`profile.ts`) imports all of them — so every part compiles
on its own before Part 6 wires the entry point.

## Decision candidates (surface to the ADR/user conversation before Part 6 — do NOT decide unilaterally)

The design ratified DC-1..DC-6 (ADRs 475–478). One residual sub-choice the design leaves to the
planner is recorded here; it is small and does not block Parts 1–5, but the implementer of Part 6
must pick before wiring the parent loop:

- **DC-A — how many top frames land in `hotShares`/`setupShares` and the noise-floor cutoff.**
  ADR-475 says "normalised tsgit-frame self-shares" but does not fix (i) the minimum self-share a
  frame must clear to be recorded (the noise-floor threshold below which a frame is dropped) nor
  (ii) whether the array is capped (e.g. top-N frames) or full. Candidates:
  - **(a) Record every tsgit frame with `self ≥ 0.01` (1%), uncapped, ordered by descending share.**
    Simplest, fully deterministic in shape, no magic top-N. *(recommendation — smallest reviewed
    constant, one threshold; a trivially-fast command with no frame ≥1% records empty `hotShares`
    + warning per ADR-475/D3.)*
  - (b) Top-N (e.g. N=10) frames regardless of share. Bounded artifact size, but N is a second
    magic constant and can truncate a legitimately flat profile.
  - (c) Every tsgit frame, no threshold. Maximal signal but re-admits the sub-1% noise the shares
    normalisation is meant to suppress; the artifact churns on run-to-run sampling luck at the tail.
  The threshold is a single named constant in `profile-digest.ts` (Part 2) — Part 2 implements it as
  `(a)` unless the conversation overrides, and Part 2's test pins the chosen threshold's behaviour.
  Because it is a one-constant tuning of a design-ratified shape (not a new load-bearing fork), the
  recommendation is carried into Part 2; flag it if the reviewer wants (b)/(c).

## Part 1 — `profile-env.ts` (scrub + pin env helper)

### Context

Create `tooling/profile-env.ts` exporting `profileEnv(): NodeJS.ProcessEnv`. It is the single
env-isolation idiom every new `git`-spawning / library-writing surface reuses (design §D2
"Env-isolation obligation", ADR-476/477).

**Copy the exact idiom from `test/bench/name-rev.bench.ts` lines 21–33 (`benchEnv`)** — do not invent a
new shape:
- start from `process.env` with every key starting `GIT_` stripped:
  `Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')))`
  (identical to `fixture-generator.ts` `gitEnv()` line 241–242 and `bench-memory.ts` line 148–149).
- spread the scrubbed env, then re-add the pinned identity + `GIT_CONFIG_NOSYSTEM`:
  `GIT_AUTHOR_NAME`/`GIT_COMMITTER_NAME = 'profile'`,
  `GIT_AUTHOR_EMAIL`/`GIT_COMMITTER_EMAIL = 'profile@tsgit.invalid'`,
  `GIT_CONFIG_NOSYSTEM: '1'`. (Design pins the identity strings as `profile` /
  `profile@tsgit.invalid` — the profiler's analogue of the bench's `bench` / `bench@tsgit.invalid`.)
- **Dates:** `benchEnv()` omits `GIT_AUTHOR_DATE`/`GIT_COMMITTER_DATE` and callers add them only
  where a deterministic oid is required (see `name-rev.bench.ts` `ensurePrunableTaggedTip` lines 57–58,
  which builds a `datedEnv = { ...env, GIT_AUTHOR_DATE, GIT_COMMITTER_DATE }` per call). Mirror that:
  `profileEnv()` returns the **dateless** base; a second exported helper
  `withPinnedDate(env: NodeJS.ProcessEnv, epochSeconds: number): NodeJS.ProcessEnv` returns
  `{ ...env, GIT_AUTHOR_DATE: `${epochSeconds} +0000`, GIT_COMMITTER_DATE: `${epochSeconds} +0000` }`
  for the read-preamble/merge-scratch call sites that need byte-stable oids. Keeping the date opt-in
  matches the bench precedent and avoids pinning a date on `git tag -f` where it is irrelevant.

No `src/` import, no dist-import — pure `process.env` transformation. This module is imported by
Part 3 (`profile-scratch-repo.ts`) and Part 4 (`profile-registry.ts`).

Public-surface decision: these are **internal tooling exports** (`profileEnv`, `withPinnedDate`),
consumed only by sibling `tooling/` modules — no library surface, no gate.

### TDD steps

Create `tooling/test/unit/profile-env.test.ts` (imports `../../profile-env.js`), GWT/AAA, `sut` =
the function under test.

- RED 1: `Given process.env carries a GIT_DIR, When profileEnv() runs, Then the result has no GIT_DIR key`
  — arrange by temporarily setting `process.env.GIT_DIR` in the test (restore in a `finally`/`afterEach`),
  assert `'GIT_DIR' in result` is `false`. Fails: module does not exist.
- RED 2: `Given any process.env, When profileEnv() runs, Then GIT_AUTHOR_NAME/EMAIL, GIT_COMMITTER_NAME/EMAIL
  are the pinned profile identity and GIT_CONFIG_NOSYSTEM is '1'` — assert each of the five values exactly
  (`profile`, `profile@tsgit.invalid`, `1`). Fails: module does not exist.
- RED 3: `Given a base env and an epoch, When withPinnedDate(env, 1700000000) runs, Then GIT_AUTHOR_DATE and
  GIT_COMMITTER_DATE are '1700000000 +0000' and the base keys survive` — assert both date strings + that a
  base key (e.g. GIT_CONFIG_NOSYSTEM) is preserved. Fails: helper does not exist.
- GREEN: implement `profileEnv` (scrub + spread + pin) and `withPinnedDate` (spread + two date keys),
  each a small pure arrow with an early return of the built object. No mutation of `process.env`.
- REFACTOR: extract the scrub into a private `stripGitEnv()` if it reads cleaner; keep functions <20 lines.

### Gate

`npx vitest run tooling/test/unit/profile-env.test.ts && npm run check:types && ./node_modules/.bin/biome check tooling/profile-env.ts tooling/test/unit/profile-env.test.ts`

### Commit

`feat(profile): add scrub-and-pin env helper for the profiler`

## Part 2 — `profile-digest.ts` (`--prof-process` parser + setup/command partition)

### Context

Create `tooling/profile-digest.ts` — the one new parsing surface (ADR-475 §Consequences; design §D3).
It reads a `node --prof-process` digest **string** (the exact output `processProfile` in `profile.ts`
lines 79–94 already produces) and returns normalised tsgit-frame self-shares, partitioning write-command
frames into `command` vs `setup` (ADR-478).

**Digest format to parse** (pinned in the design §"empirical pin", lines 183–196 — reproduce a fixed
sample as the test fixture, do NOT run `node --prof` in the test):
```
Statistical profiling result from isolate-0x…-v8.log, (66 ticks, 31 unaccounted, 0 excluded).

 [Shared libraries]:
   ticks  total  nonlib   name
     23   34.8%          /System/Library/…/CoreAudio
      6    9.1%          /Users/…/.n/bin/node
 [JavaScript]:
      6    9.1%   16.2%  JS: *<anonymous> /private/var/…/work.js:1:1
 [Summary]:
      6    9.1%   16.2%  JavaScript
     29   43.9%          Shared libraries
     31   47.0%          Unaccounted
```
Load-bearing readings the parser must honour (design §crux + D3):
- **Drop the noise floor:** `[Shared libraries]`, `Unaccounted`, node-internal frames
  (`/…/bin/node`, `node:` internals, `Builtin:`/`Stub:`/`RegExp:` lines) are NOT tsgit frames — exclude them.
- **Keep tsgit's own frames:** the `[JavaScript]` (and the bottom-up) section lines whose location
  resolves into tsgit code — for the `dist/` run these appear as `dist/esm/…` paths. A tsgit frame line
  has the shape `<ticks> <total%> <nonlib%> <symbol> <location>`; the frame name is the symbol
  (e.g. `walkCommitsByDate`, `writeCommitObject`, `init`) — extract it, not the raw line.
- **Self-normalise:** compute each kept frame's share as `frameTicks / sum(all kept tsgit frame ticks)`
  so shares sum to 1.0 over the tsgit surface (not over the whole process). Round to 2 decimals for the
  committed artifact (matches the design's `0.41` / `0.33` examples).
- **Noise-floor threshold + ordering:** per **DC-A** (default (a)): drop kept frames whose self-share
  `< 0.01`, order the survivors by descending self-share. If ZERO frames survive, return an empty
  `hotShares` — Part 5/Part 6 emit the ADR-475 warning; the parser never fabricates a frame.

**Write-command partition (ADR-478, design §D2 layer 3):** the parser takes an optional
`setupFrames: ReadonlySet<string>` (the `SETUP_FRAMES` denylist). Define the denylist as a small named
`const SETUP_FRAMES = new Set([...])` covering the primitives the scratch build reaches but the command
under measurement does not — from the real symbols on the `init`/first-`commit`/`add`-build path:
`'bootstrapRepository'`, `'init'` and the index/blob/tree write primitives used only during build. **Verify
the exact symbol names against `src/application/commands/init.ts` (`bootstrapRepository`, line 4/32) and the
build path before finalising the set** — the frame name the digest shows is the JS function symbol, so the
denylist entries must be those symbol names. A frame present in a write digest that IS in `SETUP_FRAMES`
→ `setupShares`; every other tsgit frame → `hotShares`. **Shared frames resolve to `command`** (never
under-report): a frame is `setup` ONLY if it is in the denylist AND not… — simplest correct rule: `setup`
iff `SETUP_FRAMES.has(frame)`; the denylist deliberately excludes frames the command also reaches
(e.g. `writeObject`, `writeTree`), so those stay in `hotShares`. Document in a `why` comment that the
denylist lists *build-only* primitives, and that shared object-write frames are intentionally attributed
to `command`.

Exported surface (internal tooling):
- `type FrameShare = { readonly frame: string; readonly self: number }`
- `type DigestPartition = { readonly hotShares: ReadonlyArray<FrameShare>; readonly setupShares?: ReadonlyArray<FrameShare> }`
- `const SETUP_FRAMES: ReadonlySet<string>` (the reviewed denylist constant)
- `parseDigest(digestText: string): ReadonlyArray<FrameShare>` — read-command path (no partition).
- `partitionWriteDigest(digestText: string, setupFrames?: ReadonlySet<string>): DigestPartition` — write path
  (defaults `setupFrames` to `SETUP_FRAMES`); reuses `parseDigest`'s frame extraction then splits.

Keep the two exports thin over a shared private `extractTsgitFrames(digestText): Array<{frame,ticks}>`.

Public-surface decision: **internal tooling exports** — consumed by Part 5 (baseline writer) and Part 6
(`profile.ts`). No library surface, no gate.

### TDD steps

Create `tooling/test/unit/profile-digest.test.ts` (imports `../../profile-digest.js`), GWT/AAA, `sut` =
the parser function. Build fixed digest strings inline (mirror `max-chain-depth-oid.test.ts`'s
inline-`.join('\n')` fixtures — no real profiling).

- RED 1: `Given a digest with one tsgit dist frame and shared-library + Unaccounted noise, When parseDigest
  runs, Then only the tsgit frame is returned with self === 1.00` — proves the noise floor is dropped and
  self-normalisation is over the tsgit surface. Fails: module absent.
- RED 2: `Given a digest with two tsgit frames at 3:1 tick ratio, When parseDigest runs, Then shares are
  [0.75, 0.25] ordered descending` — proves normalisation + descending order. Assert the exact `.self`
  numbers and the frame order (kills a swapped-sort mutant).
- RED 3: `Given a digest whose only tsgit frame has self below the 1% floor, When parseDigest runs, Then it
  returns an empty array` — pins DC-A threshold (no fabricated frame). Assert `result` deep-equals `[]`.
- RED 4: `Given a write digest containing a build-only frame (init/bootstrapRepository) and a command frame
  (writeCommitObject), When partitionWriteDigest runs with the default denylist, Then the build-only frame is
  in setupShares and the command frame is in hotShares` — assert both arrays' `.frame` membership exactly.
- RED 5: `Given a write digest containing a shared object-write frame (writeObject) that is NOT in the
  denylist, When partitionWriteDigest runs, Then writeObject lands in hotShares (conservative attribution)` —
  the guard that shared frames are never under-reported to setup. Isolated test per the guard-clause rule.
- GREEN: implement `extractTsgitFrames` (line scan: split into lines, regex/columns to pull
  `ticks + symbol + location`, keep only tsgit-location lines, drop node/shared/unaccounted), then
  `parseDigest` (normalise → threshold → sort) and `partitionWriteDigest` (extract → split by `SETUP_FRAMES`).
- REFACTOR: name the section/threshold constants (`NOISE_FLOOR_SELF = 0.01`); keep each function <20 lines,
  early-return on empty input. Watch for dead guards (`lines.length === 0` after `split('\n')` is unreachable —
  do not add it).

### Gate

`npx vitest run tooling/test/unit/profile-digest.test.ts && npm run check:types && ./node_modules/.bin/biome check tooling/profile-digest.ts tooling/test/unit/profile-digest.test.ts`

### Commit

`feat(profile): add prof-process digest parser with setup/command partition`

## Part 3 — `profile-scratch-repo.ts` (write-command scratch factory)

### Context

Create `tooling/profile-scratch-repo.ts` — the write-command scratch-repo factory (design §D2
"The scratch-repo factory"). It builds a tiny deterministic repo per iteration via **the library's own
structured API** (never by spawning `git`) and returns a disposable handle.

**Exact facade signatures the `build*Scratch` and `run` closures call** (verified against source — do NOT
trust the design's illustrative shapes):
- `openRepository({ cwd }): Promise<Repository>` — the **single-arg** runtime form exported from
  `dist/esm/index.node.js` (`src/index.node.ts` line 42 wraps the two-arg `openRepositoryCore`). Import it
  dynamically from `DIST_ENTRY` exactly as `bench-memory.ts` lines 30–46 do
  (`type OpenRepository = typeof import('../src/index.node.ts').openRepository;` +
  `await import(pathToFileURL(DIST_ENTRY).href)`), so the scratch build runs against compiled `dist/`.
- `repo.init(): Promise<InitResult>` — `InitOptions { initialBranch?, bare? }` both optional; defaults
  `initialBranch:'main'`, `bare:false`. **Throws `ALREADY_INITIALIZED` if `<gitDir>/HEAD` already exists**
  (`src/application/commands/init.ts` line 26–34), so call it once on a fresh empty `mkdtemp` dir.
- `repo.add(paths: ReadonlyArray<string>, opts?: { force?: boolean; all?: boolean }): Promise<AddResult>`
  (`src/application/commands/add.ts` line 78–82). Literal-path mode: `repo.add(['a.txt'])`. Bulk mode:
  `repo.add([], { all: true })`. Requires non-bare + a working tree.
- `repo.commit({ message, author?, committer? }): Promise<CommitResult>` — `CommitOptions.message` is
  **required**; `author`/`committer` are `AuthorIdentity` (`src/application/commands/commit.ts` line 60–63).
  Requires non-bare (`assertNotBare`) + a **staged index** (throws `NOTHING_TO_COMMIT` on an empty/unchanged
  tree unless `allowEmpty`). So `buildCommitScratch` must stage one file before returning.
- `repo.branch.create({ name }): Promise<…>` and `repo.checkout({ rev }): Promise<…>` — the branch/checkout
  idiom is the one `add-add-content-interop.test.ts` uses (lines 140–145):
  `await repo.branch.create({ name })` then `await repo.checkout({ rev: name })`.
- `repo.merge.run({ rev, message?, author?, committer?, fastForward? }): Promise<MergeResult>` —
  `MergeRunInput` (`src/application/commands/merge.ts` line 68–80); `fastForward` is `'only' | 'never' |
  'allow'`. Use `fastForward: 'never'` so `buildMergeScratch` always produces a true merge commit even when a
  fast-forward is possible (the representative shape). Divergent branches (disjoint edits) → clean three-way merge.

**`AuthorIdentity` shape** (`src/domain/objects/author-identity.ts` line 3–8) — all four fields required:
`{ name: string; email: string; timestamp: number; timezoneOffset: string }`. Pin it as a module const,
mirroring `add-add-content-interop.test.ts` lines 33–38:
`const AUTHOR: AuthorIdentity = { name: 'profile', email: 'profile@tsgit.invalid', timestamp: 1_700_000_000, timezoneOffset: '+0000' }`.
Import the type from the source tree for typing only (`import type { AuthorIdentity } from '../src/domain/objects/index.ts'`
— type-only imports are erased by the strip-only runtime, safe like `bench-memory.ts` line 23).

**Directory + teardown idiom** (copy `clone-small-repo.bench.ts` lines 57–80 + design §D2 layer 1):
- cwd: `await mkdtemp(path.join(os.tmpdir(), 'tsgit-prof-scratch-'))` (`mkdtemp` from `node:fs/promises`,
  already imported in `profile.ts` line 18).
- working-tree files: `await writeFile(path.join(cwd, rel), content)` (`writeFile` from `node:fs/promises`).
- `dispose(): Promise<void>` = `await repo.dispose(); await rm(cwd, { recursive: true, force: true })`
  (`rm` from `node:fs/promises`). Deferred off the sampled loop by the caller (Part 6), so `dispose` here is
  just the teardown primitive.

Exported surface (internal tooling):
- `type ScratchRepo = { readonly cwd: string; readonly repo: Repository; dispose(): Promise<void> }`
  (`import type { Repository } from '../src/repository.ts'` — type-only).
- `buildCommitScratch(env: NodeJS.ProcessEnv): Promise<ScratchRepo>` — `mkdtemp` → `openRepository` →
  `repo.init()` → write one small file → `repo.add([file])` (staged, ready for `commit`; do NOT commit here —
  the measured `run` is the first `commit`).
- `buildAddScratch(env): Promise<ScratchRepo>` — `mkdtemp` → `openRepository` → `repo.init()` → write a
  fixed set of small unstaged working-tree files (the `run` will `repo.add([...], { all: true })`).
- `buildMergeScratch(env): Promise<ScratchRepo>` — `mkdtemp` → `openRepository` → `repo.init()` → root
  commit → `branch.create({ name: 'side' })` → checkout side → edit file B → commit → checkout main →
  edit file A → commit (two branches diverging by one disjoint-file commit each). Return with HEAD on `main`,
  so `run` does `repo.merge.run({ rev: 'side', fastForward: 'never', author: AUTHOR, committer: AUTHOR })`.

`env` is `profileEnv()` from Part 1 — pass it for parity even though identity is pinned through the
structured `author`/`committer` options (the library resolves identity from options, not just `GIT_*`; design
§env-isolation). For deterministic merge-branch oids, pin dates through the API by setting
`timestamp`/`timezoneOffset` on the `AUTHOR` const (already fixed) — no `withPinnedDate` needed here since the
library takes identity via options, not env dates.

The scratch repos are **tiny and fixed** (a handful of small files, two one-commit branches) —
deliberately not scaled (design §D2). Errors surface loud: a failed `build*Scratch` rejects; partially-built
dirs are still `rm`'d by the caller's deferred teardown (Part 6).

Public-surface decision: **internal tooling exports** — consumed by Part 4 (`WORKLOADS` write descriptors)
and Part 6. No library surface, no gate.

### TDD steps

**No asserting unit test** — the factory drives real library I/O (`init`/`add`/`commit`/`merge.run` against
`mkdtemp` dirs) and is verified end-to-end by Part 7's profiler run (design: "the tool is verified by running
it"). A unit test would need the built `dist/` present and would duplicate Part 7's coverage. The part-gate's
`vitest run` clause therefore has no test file to run — that is expected for this tooling part, not a
"test-only" violation.

- GREEN: implement the three `build*Scratch` factories + `ScratchRepo` per the pinned signatures above; each
  a small async function with early returns; dynamic dist-import of `openRepository` (mirror `bench-memory.ts`
  `loadOpenRepository`). Keep each factory <20 lines by extracting a private
  `newScratch(env): Promise<{ cwd; repo }>` that does `mkdtemp → openRepository → repo.init()`.
- REFACTOR: hoist the shared `AUTHOR` const and small filenames to named constants; ensure `dispose` closes
  the repo before `rm`. No mutation of shared state; every dir is a fresh `mkdtemp`.
- Type-check is the real proof here: `npm run check:types` must accept every facade call shape — a wrong
  option shape (e.g. `merge.run({ ref })` instead of `{ rev }`) fails the gate.

### Gate

`npm run check:types && ./node_modules/.bin/biome check tooling/profile-scratch-repo.ts`

### Commit

`feat(profile): add write-command scratch-repo factory`

## Part 4 — `profile-registry.ts` (`WORKLOADS` map, descriptors, arg resolution)

### Context

Create `tooling/profile-registry.ts` — the `WORKLOADS` registry replacing the hardcoded
`HOT_PATHS = ['log','status','pack-read']` triple (`profile.ts` line 25), plus the descriptor types and
arg/command resolution (design §D1, ADR-476).

**Descriptor types** (design §D1 — refine the illustrative shapes to compile against the real facade):
```
type ReadWorkload = {
  readonly kind: 'read';
  readonly fixture: FixtureSpec;                              // import from fixture-generator.ts
  readonly setup?: (fixtureCwd: string, env: NodeJS.ProcessEnv) => Promise<unknown>;
  readonly run: (repo: Repository, fixture: ScaledFixture, target: unknown) => Promise<void>;
  readonly perIterationRepo?: boolean;                        // pack-read: fresh repo per iter
  readonly iterations?: number;                               // override CHILD_ITERATIONS
};
type WriteWorkload = {
  readonly kind: 'write';
  readonly build: (env: NodeJS.ProcessEnv) => Promise<ScratchRepo>;   // from Part 3
  readonly run: (repo: Repository, scratch: ScratchRepo) => Promise<void>;
  readonly iterations?: number;                               // smaller write default
};
type ProfileWorkload = ReadWorkload | WriteWorkload;
```
Type imports (type-only, erased by strip-only runtime): `FixtureSpec`, `ScaledFixture` from
`../test/bench/support/fixture-generator.ts`; `Repository` from `../src/repository.ts`; `ScratchRepo` from
`./profile-scratch-repo.ts` (Part 3). `MEDIUM_FIXTURE` value from `fixture-generator.ts`.

**Read members** (facade calls verified against `repository.ts` — the `Repository` interface):
- `log` → `run: async (repo) => { await repo.log(); }` (in-place, `MEDIUM_FIXTURE`, iterations 100).
- `status` → `await repo.status();`.
- `pack-read` → `perIterationRepo: true`, `run: async (repo, fixture) => { await repo.primitives.readBlob(fixture.firstBlobId); }`
  (the current `runChild` else-branch, `profile.ts` line 51–56 — a fresh repo per iter reads `firstBlobId`).
- Additional reads the bench suite already covers (add each only if it has a clean idempotent preamble
  against the tag-less medium fixture; omit any that don't — design §D1 "A read command with no clean
  idempotent preamble … is omitted"):
  - `describe` → `setup` = the `ensureNearTag` idiom (`describe.bench.ts` lines 19–37: `git tag -f -a <name>
    HEAD~10` under `profileEnv()`), `run: async (repo) => { await repo.describe(); }`.
  - `name-rev` → `setup` = the `ensurePrunableTaggedTip` idiom (`name-rev.bench.ts` lines 52–64: `commit-tree`
    + `tag -f -a` with `withPinnedDate(profileEnv(), tipDate + DAY_AND_A_BIT)`), returning the target oid;
    `run: async (repo, _f, target) => { await repo.nameRev(target as string); }`.
  - `blame`/`diff`/`show`/`cat-file`/`rev-parse` — the design lists these as candidates, but each needs a
    concrete representative call + (for `blame`/`show`/`cat-file`) a real path/rev against the medium fixture.
    **Ship `log`, `status`, `pack-read`, `describe`, `name-rev` in the initial read set** (the three legacy +
    the two bench-proven preambles); the remaining reads are a registry-edit follow-up. **Per the repo's
    no-silent-follow-ups default, call this initial-set decision out to the user in the plan review** rather
    than silently dropping them — do not add a `blame`/`diff`/`show`/`cat-file`/`rev-parse` entry that needs a
    fixture path/rev this plan hasn't pinned.
- Any `setup` that spawns `git` MUST use `profileEnv()`/`withPinnedDate` (Part 1) and be idempotent against
  the shared cache-keyed medium fixture (`tag -f` / deterministic `commit-tree` — never grow/move a branch;
  design §D1 obligations). Spawn `git` via `execFile` + `promisify` with `env` set (copy `name-rev.bench.ts`
  `gitOut` lines 35–42), `-C <fixtureCwd>` — do NOT reuse the fixture cache dir for writes other than
  idempotent tags.

**Write members** (`kind: 'write'`, build from Part 3, iterations default smaller — design §D1/D2; pick a
concrete default such as 10 and expose it as `WRITE_ITERATIONS`):
- `commit` → `build: buildCommitScratch`, `run: async (repo) => { await repo.commit({ message: 'profile', author: AUTHOR, committer: AUTHOR }); }`.
- `add` → `build: buildAddScratch`, `run: async (repo) => { await repo.add([], { all: true }); }`.
- `merge` → `build: buildMergeScratch`, `run: async (repo) => { await repo.merge.run({ rev: 'side', fastForward: 'never', author: AUTHOR, committer: AUTHOR }); }`.
  (Reuse the same `AUTHOR` const as Part 3 — export it from Part 3 and import it here, or re-declare;
  prefer exporting `PROFILE_AUTHOR` from `profile-scratch-repo.ts` and importing it to avoid duplication.)

**Registry + arg resolution:**
- `const WORKLOADS: Record<string, ProfileWorkload>` with the members above.
- `resolveWorkloads(cmd: string | undefined): ReadonlyArray<[string, ProfileWorkload]>` — no arg → all
  entries (`Object.entries(WORKLOADS)`); a known `cmd` → the single `[cmd, WORKLOADS[cmd]]`; an unknown `cmd`
  → **throw a typed usage error** carrying the message `usage: profile <cmd> (one of: <sorted keys>)`
  (mirror `gen-bench-fixture.ts` lines 30–33 which writes the usage to stderr + `process.exit(1)` — but keep
  the *resolver pure* by throwing/returning a sentinel, and let Part 6's `main()` do the stderr-write +
  `exit(1)`, so the resolver stays unit-testable without spawning a process).
  Concretely: export `class UnknownCommandError extends Error` (or a discriminated return) whose message is
  the usage line; `main()` catches it, writes the message, exits 1.

Public-surface decision: **internal tooling exports** — consumed only by Part 6. No library surface, no gate.

### TDD steps

Create `tooling/test/unit/profile-registry.test.ts` (imports `../../profile-registry.js`), GWT/AAA,
`sut` = `resolveWorkloads`. Only the **pure arg resolver** is unit-tested (the `run`/`build`/`setup` closures
drive real I/O and are exercised by Part 7).

- RED 1: `Given no cmd argument, When resolveWorkloads(undefined) runs, Then it returns every registry entry`
  — assert the returned keys equal the sorted `Object.keys(WORKLOADS)`. Fails: module absent.
- RED 2: `Given a known cmd 'commit', When resolveWorkloads('commit') runs, Then it returns exactly that one
  entry` — assert length 1 and key `'commit'`. Fails: module absent.
- RED 3: `Given an unknown cmd 'nope', When resolveWorkloads('nope') runs, Then it throws UnknownCommandError
  whose message lists the valid set` — use try/catch + assert `err.message` contains `usage: profile <cmd>`
  AND contains a known key (e.g. `commit`) — specific message assertion per the mutation-resistant-test rule
  (never a bare `toThrow(Class)`). Fails: module absent.
- RED 4: `Given the registry, When inspected, Then commit/add/merge are kind 'write' and log/status/pack-read
  are kind 'read'` — assert `WORKLOADS.commit.kind === 'write'` and `WORKLOADS.log.kind === 'read'` (pins the
  descriptor discrimination; kills a swapped-kind mutant). This asserts on the exported constant, not a call.
- GREEN: implement the descriptor types, `WORKLOADS`, `WRITE_ITERATIONS`, `UnknownCommandError`, and
  `resolveWorkloads` (early return on `undefined`; lookup + `if (entry === undefined) throw`).
- REFACTOR: build the usage string from `Object.keys(WORKLOADS).sort().join(', ')` once; keep `resolveWorkloads`
  <20 lines; no magic literals (name `WRITE_ITERATIONS`, `READ_ITERATIONS = 100`).

### Gate

`npx vitest run tooling/test/unit/profile-registry.test.ts && npm run check:types && ./node_modules/.bin/biome check tooling/profile-registry.ts tooling/test/unit/profile-registry.test.ts`

### Commit

`feat(profile): add command→workload registry and arg resolution`

## Part 5 — `profile-baseline.ts` (docs/perf/baseline.{json,md} writer)

### Context

Create `tooling/profile-baseline.ts` — the committed-artifact writer (design §D5, ADR-475). It takes the
per-command partitions (from Part 2's parser, keyed by command name) plus a machine banner, and writes
`docs/perf/baseline.json` + a sibling `docs/perf/baseline.md`.

**Artifact shape** (design §D5 / ADR-475 — pin exactly):
```
{
  "generatedOn": "<platform-arch> / node vX / <CPU>",   // metadata, NOT compared
  "commands": {
    "log":    { "hotShares": [ { "frame": "walkCommitsByDate", "self": 0.41 }, … ] },
    "commit": { "hotShares": [ … ], "setupShares": [ … ] }   // write cmds add setupShares
  }
}
```
Read commands carry `hotShares` only; write commands additionally carry `setupShares` (the `DigestPartition`
from Part 2 — `setupShares` is optional and omitted for reads). `generatedOn` is metadata only.

**Machine banner** — reuse the `bench-memory.ts` / `bench-summarize.ts` banner idiom: `process.platform`,
`process.arch`, `process.version`, and the CPU model from `os.cpus()[0]?.model`. Compose
`` `${process.platform}-${process.arch} / node ${process.version} / ${cpuModel}` ``. (Design §D5 records the
banner as metadata "never as a compared value" — Part 6's determinism check compares only `commands`, never
`generatedOn`.)

**Output paths** (new tracked directory — no `.gitignore` change, confirmed: `.gitignore` ignores only
`reports/*` with `!reports/api.json`; `docs/` is fully tracked):
- `ROOT/docs/perf/baseline.json` — `JSON.stringify(baseline, null, 2) + '\n'`.
- `ROOT/docs/perf/baseline.md` — human-readable: a per-command section with a `| frame | self |` table for
  `hotShares` and, for write commands, a second `setupShares` table plus a one-line note that shared
  object-write frames are attributed to `command` (ADR-478 auditability). Mirror `bench-memory.ts`
  `toMarkdown`/`toMarkdownRow` (lines 193–202) for the table idiom.
- `await mkdir(path.join(ROOT, 'docs', 'perf'), { recursive: true })` before writing (mirror
  `bench-memory.ts` `emitReports` line 205).

Exported surface (internal tooling):
- `type CommandBaseline = DigestPartition` (import the type from `./profile-digest.js`).
- `type Baseline = { readonly generatedOn: string; readonly commands: Record<string, CommandBaseline> }`.
- `machineBanner(): string`.
- `renderBaselineJson(baseline: Baseline): string` (pure — the JSON text).
- `renderBaselineMarkdown(baseline: Baseline): string` (pure — the markdown text).
- `writeBaseline(baseline: Baseline, root: string): Promise<void>` — mkdir + write both files (impure,
  thin over the two pure renderers). Keep render/write split so the renderers are unit-testable (CQS).

Public-surface decision: **internal tooling exports** — consumed only by Part 6. No library surface, no gate.

### TDD steps

Create `tooling/test/unit/profile-baseline.test.ts` (imports `../../profile-baseline.js`), GWT/AAA, `sut` =
the pure renderer. Test the pure render functions only (the `writeBaseline` I/O + real banner are exercised by
Part 7).

- RED 1: `Given a baseline with a read command's hotShares, When renderBaselineJson runs, Then the JSON parses
  back to the same commands object and omits nothing` — arrange a fixed `Baseline`, `JSON.parse(sut(baseline))`,
  assert `.commands` deep-equals the input's `commands`. Fails: module absent.
- RED 2: `Given a write command with hotShares and setupShares, When renderBaselineMarkdown runs, Then the
  markdown contains a hotShares table row for each command frame AND a setupShares table row for each setup
  frame` — assert the rendered string contains each `frame` name and its `self` value in a table row. Fails:
  module absent.
- RED 3: `Given a read command (no setupShares), When renderBaselineMarkdown runs, Then no setupShares table is
  emitted for it` — assert the read command's section does not contain a `setupShares` heading. Isolates the
  optional-block branch (kills a mutant that always emits the setup table).
- GREEN: implement `machineBanner`, `renderBaselineJson` (`JSON.stringify(..., 2) + '\n'`),
  `renderBaselineMarkdown` (map commands → sections/tables), `writeBaseline` (mkdir + two `writeFile`s).
- REFACTOR: extract a `frameTableRow`/`frameTable` helper mirroring `bench-memory.ts`; keep functions <20
  lines; name the `docs/perf` path segments as constants.

### Gate

`npx vitest run tooling/test/unit/profile-baseline.test.ts && npm run check:types && ./node_modules/.bin/biome check tooling/profile-baseline.ts tooling/test/unit/profile-baseline.test.ts`

### Commit

`feat(profile): add docs/perf baseline JSON+markdown writer`

## Part 6 — wire `profile.ts` to the registry, digest, baseline, scratch factory

### Context

Rewrite `tooling/profile.ts` (currently `HOT_PATHS`-driven, lines 25–149) to orchestrate Parts 1–5. This is
the entry-point swap (design §D4): registry + digest parser + baseline writer + scratch factory replace the
hardcoded triple and the git-ignored `reports/profiles/*.txt` output.

**Keep unchanged** (reuse verbatim from the current `profile.ts`):
- `spawnToCompletion` (lines 66–77), `processProfile` (lines 79–94) — the `--prof` child spawn and
  `--prof-process` digest capture. `captureProfile` (lines 96–114) keeps its `mkdtemp` + `--prof` spawn +
  isolate-log discovery, but instead of `writeFile(...reports/profiles/<hotPath>.txt, digest)` it now
  **returns the raw digest string** to the parent for parsing.
- `DIST_ENTRY`, `SCRIPT_PATH`, `ROOT` constants (lines 29–32); the `--child` marker convention (line 117);
  the top comment block (update its wording — no phase refs).

**Replace:**
- `HOT_PATHS`/`HotPath`/`isHotPath` → `resolveWorkloads` + `WORKLOADS` (Part 4). The `--child <cmd>` marker
  now carries a registry key (or, for the no-arg run, the parent spawns one child per resolved entry).
- `runChild` (lines 39–62) → a child dispatcher on the descriptor `kind`:
  - `kind: 'read'` → `ensureScaledFixture(workload.fixture)`; if `workload.setup`, run it (env-isolated,
    idempotent) to get `target`; open the repo (or, for `perIterationRepo`, open a fresh repo per iter);
    loop `workload.iterations ?? READ_ITERATIONS` times calling `workload.run(repo, fixture, target)`. Mirror
    the current shared-repo-vs-fresh-repo split (lines 43–58).
  - `kind: 'write'` → the deferred-teardown loop from design §D2 layer 1:
    ```
    const scratches: ScratchRepo[] = [];
    for (let i = 0; i < (workload.iterations ?? WRITE_ITERATIONS); i += 1) {
      const scratch = await workload.build(profileEnv());
      scratches.push(scratch);                 // defer dispose off the sampled path
      await workload.run(scratch.repo, scratch);
    }
    for (const s of scratches) await s.dispose();   // teardown after the loop
    ```
    Optionally run a few untracked warm-up iterations first (design §D2 layer 2 — JIT tiering only; NOT the
    pollution fix). The parser denylist (Part 2) is the real separator.
- The parent per-command loop (lines 138–143): for each resolved `[name, workload]`, `captureProfile` →
  digest string → `parseDigest` (read) or `partitionWriteDigest` (write) → accumulate into a `Baseline`
  `commands[name]`; after all, `machineBanner()` + `writeBaseline(baseline, ROOT)` (Part 5). The output is now
  `docs/perf/baseline.{json,md}`, NOT `reports/profiles/*.txt` — drop `PROFILE_DIR` and its `mkdir`.
- `main()` (lines 116–144): parse `process.argv[2]` as `<cmd>` (the child marker `--child` still uses
  `indexOf('--child')`); resolve via `resolveWorkloads(cmd)`, catching `UnknownCommandError` → write its
  message to stderr + `process.exit(1)` (the design's usage path). **Graceful-degrade refinement (design
  §Error semantics):** the up-front `ensureScaledFixture(MEDIUM_FIXTURE)` guard (lines 127–136) must fire
  **only when a read workload is in scope** — a run selecting ONLY write command(s) builds its own scratch
  repos and must NOT hard-fail on absent `git`/fixture. Gate the guard on
  `resolved.some(([, w]) => w.kind === 'read')`. A mixed no-arg run still degrades as today when the fixture
  is unavailable (the read slice cannot run) — surface that loud, never swallow.

**DC-A** (see Decision candidates): the noise-floor threshold/cutoff lives in Part 2; Part 6 just consumes the
parser output. If the reviewer chose (b)/(c), Part 2's constant already reflects it — no Part 6 change.

**`package.json` — no change needed.** The `profile` script is `npm run build && node
--experimental-strip-types tooling/profile.ts` (line 193). npm forwards trailing args to the script's argv, so
`npm run profile log` already reaches `process.argv[2]` — **verify this holds** (`npm run profile -- log` also
works) and do NOT edit the script line unless the argv does not flow (it does). The top-of-file doc comment in
`profile.ts` should be updated to describe the new `<cmd>` behaviour + the `docs/perf/` output (no phase refs).

No `src/` change, no public-API change (ADR-477). No asserting test for this part — the orchestration is
verified by Part 7's real run; the gate is `check:types` + `biome`.

### TDD steps

**No asserting unit test** — `profile.ts` is the orchestration entry point (spawns children, drives real
`--prof` captures, writes the artifact); it is verified end-to-end by Part 7. Its sub-logic (parsing,
registry, rendering) is already unit-tested in Parts 2/4/5. The part-gate's `vitest run` has no new test file
here — expected for this tooling entry-point part, not a "test-only" violation.

- GREEN: perform the swap above. Reuse `spawnToCompletion`/`processProfile`/`captureProfile` (return-digest
  variant). Import `resolveWorkloads`/`WORKLOADS`/`UnknownCommandError`/`READ_ITERATIONS`/`WRITE_ITERATIONS`
  from Part 4, `parseDigest`/`partitionWriteDigest` from Part 2, `machineBanner`/`writeBaseline`/`Baseline`
  from Part 5, `profileEnv`/`withPinnedDate` from Part 1, `buildCommitScratch`/… from Part 3.
- Keep `main().catch(...)` bottom handler (lines 146–149) — errors surface loud + exit 1 (design: never
  swallowed).
- REFACTOR: extract the child read-loop and write-loop into two small named functions (`runReadChild`,
  `runWriteChild`) so `main`'s branching stays shallow (<2 nesting); name `READ_ITERATIONS`/`WRITE_ITERATIONS`.
- Proof is the gate + a **manual smoke** the implementer runs locally before committing: `npm run profile
  status` (a single fast read command) should build `dist/`, capture, and write
  `docs/perf/baseline.json` with a `status` entry — but **do NOT commit that smoke artifact here** (Part 7
  commits the full baseline). If the smoke run dirties `docs/perf/`, `git checkout -- docs/perf` before
  committing Part 6 so this commit is code-only.

### Gate

`npm run check:types && ./node_modules/.bin/biome check tooling/profile.ts`

### Commit

`refactor(profile): drive per-command capture from the registry and commit-shape baseline`

## Part 7 — generate and commit the per-command baseline

### Context

Run the full profiler and commit the generated artifact — the "commit baseline" half of the item (design
§requirement 3–4, D5). This part produces `docs/perf/baseline.json` + `docs/perf/baseline.md` for the whole
registry and commits them.

**This is a genuinely long-running part — budget for it, do not time out silently:**
- `npm run profile` first runs `npm run build` (compiles `dist/`), then executes **one `node --prof` child
  capture per resolved registry entry**: the initial registry is `log`, `status`, `pack-read`, `describe`,
  `name-rev` (5 read) + `commit`, `add`, `merge` (3 write) = **8 captures** (not 13 — the read set shipped in
  Part 4 is 5, not 10; if the plan-review conversation adds `blame`/`diff`/`show`/`cat-file`/`rev-parse`, it
  rises accordingly). Each read capture loops `READ_ITERATIONS` (100); each write capture loops
  `WRITE_ITERATIONS` (~10) with a scratch build+teardown per iter.
- The read captures need the **medium fixture** (5k commits / 20k blobs / ~50 MB), generated from `git` on
  first use via `ensureScaledFixture(MEDIUM_FIXTURE)` — **slow the first time** (fast-import + repack). Warm
  it first: `npm run bench:fixture -- medium` (design §gen-bench-fixture), so the profiling run itself does
  not pay generation cost. Requires the `git` CLI on PATH.
- Run detached/backgrounded and poll (this sandbox reaps long foreground bash — see the project memory on
  running interop/Stryker/validate detached): e.g. `nohup npm run profile > /tmp/profile-run.log 2>&1 &` then
  poll the log / `docs/perf/baseline.json` for completion.

**The numbers are host-specific (this machine's) — that is intended.** ADR-475 commits *normalised shares*
(portable in rank/share, not absolute ticks); the machine banner is recorded as metadata, never compared. The
regeneration cadence (fixed runner vs committed-vs-fresh) is 26.5's decision, out of scope here — this part
just commits *a* baseline generated on this host.

**Determinism-in-shape check before committing** (design Test/faithfulness plan): run `npm run profile` a
second time (or at least `npm run profile status`) and confirm the **frame set + share ordering** (and the
`command`/`setup` partition for write commands) is stable across the two runs — the `self` values may wobble
slightly (sampling), but the frame names and their descending order should match. The committed file is
simply the **last full run's output** (the second full run overwrites the first — that is fine; both are
valid host-specific baselines). If instead you shape-check with `profile status` (single command), re-run the
full `npm run profile` last so the committed artifact covers the whole registry, then commit. If a command's
`hotShares` is empty with a warning (a trivially-fast command below the noise floor — ADR-475), note it in
the commit context / plan-review: it is a signal that command may not belong in the registry, not a bug to
paper over.

**Confirm the artifact path is tracked:** after the run, `git status docs/perf/` must show the two files as
untracked/added (NOT ignored) — `.gitignore` ignores only `reports/*`, so `docs/perf/` is tracked; if
`git status --ignored` shows them ignored, something regressed and must be fixed before committing.

Files to commit: `docs/perf/baseline.json`, `docs/perf/baseline.md` (and the new `docs/perf/` directory).
No code change in this part.

### TDD steps

**No test** — this is a docs/artifact-generation part (generated data + prose, no `src/` delta), legitimately
standalone per the sizing rules. Its "gate" is that the profiler run completes successfully and produces a
tracked, shape-stable artifact.

- Run `npm run bench:fixture -- medium` (warm the fixture), then `npm run profile` (detached + poll).
- Verify `docs/perf/baseline.json` parses and has a `commands` entry per registry command, each with a
  non-empty `hotShares` (or a documented empty+warning case); write commands additionally carry `setupShares`.
- Verify `docs/perf/baseline.md` renders the tables.
- Run the profiler once more (or `profile status`) and diff the frame set/order for shape stability.
- `git add docs/perf/baseline.json docs/perf/baseline.md`.

### Gate

Artifact-generation part — no `vitest`/`check:types`/`biome` delta over source (nothing in `src/`/`tooling/`
changed). The operative check is: `npm run profile` exits 0, `docs/perf/baseline.{json,md}` exist, parse, and
`git status --ignored docs/perf/` shows them **tracked, not ignored**. (Running `npm run check:types` here is a
harmless no-op and may be run for parity.)

### Commit

`chore(profile): commit per-command performance baseline`
