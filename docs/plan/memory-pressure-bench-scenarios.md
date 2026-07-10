# Plan — Memory-pressure bench scenarios (large packs, deep delta chains)

> Source: design doc `docs/design/memory-pressure-bench-scenarios.md` · ADRs 471, 472, 473, 474
> The plan is the implementation script AND the knowledge handoff. Part agents start
> with zero context: whatever a part block omits is paid later as agent rediscovery.
> `plan-lint.sh` enforces the schema below — the plan phase cannot close without it.

## Surface-gate note (read first — applies to every part)

This is an **all-test-infra change: no `src/` delta anywhere**. Every new symbol
(`DELTA_CHAIN_FIXTURE`, `streamEvolvingFastImport`, the `strategy`/`deltaDepth`/`deltaWindow`
`FixtureSpec` fields, `resolveScaledContext(spec?)`, `tooling/bench-memory.ts`, the
`bench:memory` script) lives in `test/bench/support/` or `tooling/`. **None** is exported
from the package entry (`src/index.node.ts`), so **none trips a public-surface gate** — no
`reports/api.json` regeneration, no README command count, no doc-coverage page, no
barrel/facade edit, no exhaustiveness switch. Verified: the package entry re-exports only
`src/**`; nothing here touches it. Implementers must **not** chase phantom surface gates.

Coverage/mutation obligation is **nil** for every touched file. `vitest.config.ts` coverage
`include` is `src/{domain,ports,adapters/node,adapters/memory,operators}/**` (plus the
`tooling/test/{unit,integration}` *test* projects) — `test/bench/**` and `tooling/*.ts`
(non-test) are never instrumented. `tooling/bench-memory.ts` follows the exact precedent of
the already-uncovered `tooling/profile.ts`. Where a genuine pure-function seam exists (the
`verify-pack -v` max-chain-depth parser in Part A, the spread-index computation in Part C/E),
a small optional unit test in `tooling/test/unit` is welcome but **nothing gates it**.

**Pinned against real `git` (isolated `mktemp` throwaway, private `HOME`,
`GIT_CONFIG_NOSYSTEM=1`, `GIT_*` scrubbed, `commit.gpgsign false`)** during planning: the
evolving-4 KiB-blob fixture packed with `git repack -adf --depth=50 --window=250` reaches
**max chain depth 43** (≤ the `MAX_DELTA_CHAIN_DEPTH = 50` cap), and `git verify-pack -v`
prints deltified blob lines as `<oid> blob <size> <packed-size> <offset> <chain-depth> <base-oid>`
(6+ whitespace columns); non-delta base lines have **only** `<oid> blob <size> <packed-size> <offset>`
(5 columns, no chain-depth). Deepest object = the blob line with the maximum column-6 value.

## Sizing rules

- Every part costs a full agent lifecycle (spin-up, zero-context rebuild, gate) — it must
  earn it. This is test-infra-only with no `src/` delta, so per the template exception the
  parts ARE legitimately standalone (they have no implementation part to fold into). Parts
  are partitioned by the design's natural Parts A/B/C/E/D and ordered by dependency.
- Part A is the foundation (generator); B, C, E all depend on it; D is the wiring and lands
  last. Parts share one working tree and build on each other sequentially.

---

## Part 1 — Generator: `'delta-chain'` fixture + strategy discriminant + deepest-object selection

### Context

**File (only file touched):** `test/bench/support/fixture-generator.ts`.

**Current shape being changed:**

- `FixtureSpec` (lines 32-37):
  ```ts
  export interface FixtureSpec {
    readonly label: 'medium' | 'large';
    readonly commits: number;
    readonly blobs: number;
    readonly blobBytes: number;
  }
  ```
- `MEDIUM_FIXTURE` (39-44), `LARGE_FIXTURE` (46-51) — leave both untouched in shape; they
  gain the new fields via the discriminant (see below).
- `ScaledFixture` (53-59): `{ cwd; headCommitId; firstBlobId; spec }`. `firstBlobId` is typed
  `string`. **Do not rename** — it now names the *deepest-chain object* for the delta-chain
  fixture (contract-preserving; the design keeps the field name).
- `FixtureMeta` (61-66) — same three fields cached to `meta.json`; unchanged in shape.
- Module-private helpers (reuse unchanged): `cacheRoot` (76), `cacheDirFor` (82),
  `blobPath` (85, `const`, **module-private — never export or import from a bench**),
  `blobContent` (89, xorshift32 fill), `writeChunk` (103), `runGit` (133, env-isolated via
  `-C` + `execFileAsync`), `assertGitAvailable` (140), `readCachedMeta` (183),
  `ensureScaledFixture` (201, cache + atomic-rename race handling).
- `streamFastImport` (109-131) — the **multi**-blob builder (`BLOBS_PER_COMMIT = 4` fresh
  random blobs/commit). **MUST NOT CHANGE** — keeping it byte-stable is what lets us skip a
  `FIXTURE_GENERATOR_VERSION` bump (ADR-474).
- `generateInto` (148-181): `git init` → `spawn('git', ['fast-import'])` streaming
  `streamFastImport` → `git checkout -f main` → `git repack -ad --quiet` → records
  `headCommitId = rev-parse HEAD` and `firstBlobId = rev-parse HEAD:blobPath(0)`.
- `FIXTURE_GENERATOR_VERSION = 1` (25) — **DO NOT BUMP** (ADR-474: pure addition; a new
  `delta-chain-v1` cache dir is created, `medium`/`large` shapes untouched). Editing this file
  already re-keys CI's `actions/cache` (keyed on `hashFiles('…/fixture-generator.ts')`).

**Changes (ADR-471 + ADR-474):**

1. Extend `FixtureSpec` with a discriminant + delta knobs:
   ```ts
   export interface FixtureSpec {
     readonly label: 'medium' | 'large' | 'delta-chain';
     readonly strategy: 'multi' | 'evolving';
     readonly commits: number;
     readonly blobs: number;         // led by strategy; for 'evolving' it is NOT a file count
     readonly blobBytes: number;
     readonly deltaDepth?: number;   // repack --depth, evolving only
     readonly deltaWindow?: number;  // repack --window, evolving only
   }
   ```
   Add `strategy: 'multi'` to `MEDIUM_FIXTURE` and `LARGE_FIXTURE` (their cache shape is
   unchanged — `strategy`/knobs are not serialised in a way that alters the pack).
2. Add the new spec:
   ```ts
   const DELTA_CHAIN_COMMITS = 300;
   const DELTA_CHAIN_BLOB_BYTES = 4_096;
   export const DELTA_CHAIN_FIXTURE: FixtureSpec = {
     label: 'delta-chain',
     strategy: 'evolving',
     commits: DELTA_CHAIN_COMMITS,
     blobs: 1,                 // one evolving path
     blobBytes: DELTA_CHAIN_BLOB_BYTES,
     deltaDepth: 50,           // hard ceiling — --depth>50 → chains >50 → DELTA_CHAIN_TOO_DEEP
     deltaWindow: 250,         // wide window needed to reach near-cap depth (default 10 → only 37)
   };
   ```
   Named constants — no magic values (`~/.claude` coding-style: named constants, small
   functions, immutable).
3. Add `streamEvolvingFastImport(stdin, spec)` **alongside** `streamFastImport` (do not
   fold into it). It writes **one path** `evolving.dat` re-content each commit from a
   seeded xorshift32 mutation of the previous bytes (~1 % of `blobBytes` flipped per commit).
   Use the same `blob`/`mark :n`/`data <len>` + `M 100644 :n evolving.dat` fast-import
   grammar as `streamFastImport`, one distinct mark per commit; same pinned
   author/committer/timestamp lines (`AUTHOR`, `BASE_TIMESTAMP + commit`) — never
   `GIT_*`-inherited. Seed the base bytes once; keep xorshift32 as the PRNG family for
   consistency. Small functions, early returns; no nesting > 2.
4. In `generateInto`, select the builder + repack off the **strategy discriminant** (not the
   label):
   - `strategy === 'evolving'` → stream `streamEvolvingFastImport`, then
     `git repack -adf --depth=${spec.deltaDepth} --window=${spec.deltaWindow} --quiet`
     (the `-f` forces full recompute so `--depth`/`--window` apply). Guard the knobs are
     present (they are, on the evolving spec).
   - `strategy === 'multi'` → today's `streamFastImport` + `git repack -ad --quiet`
     UNCHANGED.
   Keep the shared `git checkout -f main` step for both (harmless one-file checkout for
   evolving; no branch needed).
5. `firstBlobId` for the evolving strategy = the **deepest-chain object**, read from
   `git verify-pack -v`. Extract a **pure helper** `maxChainDepthOid(verifyPackOutput: string): string`:
   split lines, keep tokens where `tokens[1] === 'blob'` and `tokens.length >= 6` (deltified
   lines only; base lines have 5 columns and no chain-depth), parse `Number(tokens[5])` as the
   chain depth, return `tokens[0]` of the max. This is the natural pure seam — see TDD steps for
   its unit test. In `generateInto`, for `strategy === 'evolving'`, after repack:
   locate the pack `.idx` (`ls .git/objects/pack/*.idx` via `runGit` `rev-parse --git-path` or
   read the dir), run `git verify-pack -v <idx>` env-isolated (through `runGit` with a larger
   `maxBuffer` if needed — 300 lines is tiny), and set
   `firstBlobId = maxChainDepthOid(output)`. For `strategy === 'multi'`, keep
   `firstBlobId = rev-parse HEAD:blobPath(0)` unchanged.
   - `verify-pack -v` line format (pinned against real git): deltified =
     `<oid> blob <size> <packed-size> <offset> <chain-depth> <base-oid>`; base =
     `<oid> blob <size> <packed-size> <offset>` (no chain-depth). Also present: non-blob
     lines (commit/tree lines, header/footer, `chain length = N:` histogram lines) — the
     `tokens[1] === 'blob'` filter excludes all of them, and `.length >= 6` excludes base
     blob lines. Pinned result: max chain depth **43**.

**Determinism:** fixed `BASE_TIMESTAMP + commit` author/committer dates, seeded xorshift32
mutation, one file → fully reproducible pack, cache-keyed by label (`delta-chain-v1`). Same
seed + same git → same pack → same deepest object.

**No provenance refs** (no ADR/phase/backlog numbers) in the source. Comments explain *why*
(e.g. "git deltifies backwards in time — HEAD is the base, an older version is the deepest"),
never *what*.

### TDD steps

TDD nuance: `test/bench/support/fixture-generator.ts` is **outside the coverage include**, so
there is no coverage obligation. The one genuine pure-function seam — `maxChainDepthOid` — gets
a real RED→GREEN unit test in `tooling/test/unit` (it is pure, string-in/string-out, trivially
isolatable). The rest of the generator is verified by generating the fixture and inspecting the
pack (generate-once artefact, not a unit SUT).

- **RED** — add `tooling/test/unit/max-chain-depth-oid.test.ts` (Given/When/Then describe tree,
  AAA body, `sut` = the `maxChainDepthOid` function). Export `maxChainDepthOid` from
  `fixture-generator.ts` so the tooling test can import it (a `test/bench/support` export — no
  package-surface gate; it is not re-exported from the entry). Cases:
  1. Given a `verify-pack -v` output with several deltified blob lines of chain depths
     `[1, 40, 43, 42]` interleaved with base blob lines (5 columns) and non-blob lines
     (commit/tree/histogram) → Then returns the oid whose chain-depth column is 43.
  2. Given output where the deepest is not the last line → Then still returns the max (proves
     it scans all, not last-wins).
  3. Given two blob lines tied at the max depth → Then returns a deterministic one (first
     encountered) — pins tie-break so the fixture is reproducible.
  Expected failure: `maxChainDepthOid` does not exist yet (import fails / not exported).
- **GREEN** — implement `maxChainDepthOid` as the pure parser above (split lines, filter
  `tokens[1]==='blob' && tokens.length>=6`, max by `Number(tokens[5])`, return `tokens[0]`).
  Run the unit test green.
- **GREEN (generator wiring)** — add `FixtureSpec` fields, `strategy: 'multi'` to the two
  existing specs, `DELTA_CHAIN_FIXTURE`, `streamEvolvingFastImport`, and the discriminant
  branch in `generateInto` (builder + repack + verify-pack deepest-object selection).
  Functional proof (not an automated assertion — generate-once artefact): from the worktree run
  `rm -rf ~/.cache/tsgit-bench/delta-chain-v1 && npx node --experimental-strip-types
  tooling/gen-bench-fixture.ts delta-chain` **after Part 5 wires the argv case** — but for THIS
  part, prove it directly with a one-shot node snippet or by temporarily calling
  `ensureScaledFixture(DELTA_CHAIN_FIXTURE)` and then
  `git -C ~/.cache/tsgit-bench/delta-chain-v1 verify-pack -v <idx>` to confirm the max
  chain-depth column ∈ **[30, 50]** (pinned ≈ 43) and that the recorded `firstBlobId` matches the
  max-depth blob line's oid. (This manual check is documented, not committed as a test.)
- **REFACTOR** — extract any helper > 20 lines; ensure `streamEvolvingFastImport` stays small
  (early returns, no nesting > 2); confirm `streamFastImport` is byte-identical to before
  (`git --no-ext-diff diff` on that function shows no change). Confirm no
  `FIXTURE_GENERATOR_VERSION` bump.

### Gate

`tooling/` + `test/bench/**` are outside `vitest run`'s default unit path, but the new pure
helper test lives in the `tooling/test/unit` vitest project which `npx vitest run` picks up.

```
npx vitest run tooling/test/unit/max-chain-depth-oid.test.ts \
  && npm run check:types \
  && ./node_modules/.bin/biome check test/bench/support/fixture-generator.ts tooling/test/unit/max-chain-depth-oid.test.ts
```

Plus the functional generator proof (manual, not gated): generate the `delta-chain` fixture and
confirm via `git verify-pack -v` that max chain depth ∈ [30, 50] and `firstBlobId` = the
max-depth oid.

### Commit

`test(bench): add delta-chain evolving-blob fixture to the scaled generator`

---

## Part 2 — Deep-delta bench scenario + resolver generalisation

### Context

**Files:**
- Edit `test/bench/support/scaled-bench.ts` — generalise the resolver (ADR-474 candidate #6).
- New `test/bench/delta-chain-read.bench.ts` — the scenario (naming mirrors
  `pack-read-scale.bench.ts` / `read-blob.bench.ts`).

**Current `scaled-bench.ts` shape being changed:**
- `resolveScaledContext = async (): Promise<ScaledContext>` (line 23): picks
  `LARGE_FIXTURE` if `TSGIT_BENCH_LARGE` set else `MEDIUM_FIXTURE`, builds
  `given = 'Given a ${spec.label} repo (${spec.commits} commits, ${spec.blobs} blobs)'`,
  skips under `STRYKER_MUTANT_ID`, `try { ensureScaledFixture } catch { return { given } }`.
- `ScaledContext = { fixture?: ScaledFixture; given: string }`.
- `scaledScenario(ctx, whenThen, build)` (36) — registers `benchScenario` with
  `{ skip: fixture === undefined }`; guard-throws if `fixture` undefined inside `build`.

**Generalisation (ADR-474 candidate #6, default MUST preserve all 5 zero-arg call sites):**
- Change signature to `resolveScaledContext = async (spec?: FixtureSpec): Promise<ScaledContext>`.
- Default: `const resolved = spec ?? (process.env.TSGIT_BENCH_LARGE !== undefined ? LARGE_FIXTURE : MEDIUM_FIXTURE)`.
- Branch the `given` phrase on `resolved.strategy` so it reads sensibly for the evolving shape:
  - `strategy === 'evolving'` → e.g. `'Given a ${resolved.label} repo (${resolved.commits} commits, deep delta chains)'`
  - `strategy === 'multi'` → today's `'Given a ${resolved.label} repo (${resolved.commits} commits, ${resolved.blobs} blobs)'` **byte-for-byte** (the 5 existing scenarios' describe titles must not shift).
  Small helper (`givenPhrase(spec)`) with early returns — no nesting.
- Everything else (Stryker skip, try/catch, `ScaledContext`, `scaledScenario`) unchanged.
- Import `FixtureSpec` type from `./fixture-generator.js` (already imports from it).
- **The 5 zero-arg call sites** — `describe.bench.ts:39`, `status-scale.bench.ts:13`,
  `pack-read-scale.bench.ts:19`, `log-scale.bench.ts:13`, `name-rev.bench.ts:66` — call
  `await resolveScaledContext()` with no arg and MUST keep producing identical `given`
  strings (multi strategy path). This is the compatibility contract; verify their describe
  titles are unchanged.

**New `delta-chain-read.bench.ts` (mirror `pack-read-scale.bench.ts` exactly):**
- Imports: `import * as fs from 'node:fs'`, `import * as git from 'isomorphic-git'`,
  `import { afterAll } from 'vitest'`,
  `import type { ObjectId } from '../../src/domain/objects/index.js'`,
  `import { openRepository } from '../../src/index.node.js'`,
  `import { resolveScaledContext, scaledScenario } from './support/scaled-bench.js'`,
  `import { DELTA_CHAIN_FIXTURE } from './support/fixture-generator.js'`.
- `const ctx = await resolveScaledContext(DELTA_CHAIN_FIXTURE);` — passes the explicit spec,
  so it does NOT ride `TSGIT_BENCH_LARGE`. Reuses the same skip/Stryker/unavailable logic.
- Cold scenario (mirror `pack-read-scale.bench.ts` lines 21-41):
  `scaledScenario(ctx, 'When readBlob() reads a deep-chain leaf from a cold pack, Then compare tsgit against isomorphic-git', (fixture) => { const deepId = fixture.firstBlobId as ObjectId; const sut = async () => { const repo = await openRepository({ cwd: fixture.cwd }); try { await repo.primitives.readBlob(deepId); } finally { await repo.dispose(); } }; return { sut, baseline: async () => { await git.readBlob({ fs, dir: fixture.cwd, oid: fixture.firstBlobId }); } }; })`.
- Warm scenario (mirror lines 43-64): one shared `openRepository`, prime with
  `await repo.primitives.readBlob(deepId)`, `afterAll(() => repo.dispose())`, `sut` re-reads →
  LRU base hits; same iso-git baseline.
- `deepId = fixture.firstBlobId as ObjectId` — for this fixture `firstBlobId` holds the
  **deepest-chain object** (Part 1), so reading it walks the longest chain (depth ≈ 43).
- **Baseline = comparative** (ADR-474 candidate #5): include the iso-git baseline — the
  fixture is tiny, iso-git runs fine, a comparative delta-chain-reader number is the point.
- The tsgit closure is named `sut`; Given/When/Then via the describe title; body AAA.

### TDD steps

TDD nuance for a bench scenario: RED→GREEN = "scenario is registered and runs green under
`npm run test:bench` on the default path (delta-chain fixture generated, both cold+warm
scenarios execute), and skips cleanly when `git` is absent / under Stryker (reused
`FixtureUnavailableError` → skip path)". No unit-coverage obligation (`test/bench/**` outside
the include).

- **RED** — write `delta-chain-read.bench.ts` importing `DELTA_CHAIN_FIXTURE` and passing it to
  the generalised `resolveScaledContext(spec?)`. Before the resolver generalisation lands,
  `resolveScaledContext(DELTA_CHAIN_FIXTURE)` is a type error (`resolveScaledContext` takes no
  arg) — `npm run check:types` fails. Expected failure reason: resolver does not accept a spec
  yet.
- **GREEN** — generalise `resolveScaledContext(spec?)` in `scaled-bench.ts` (default preserves
  the env-driven medium/large + the 5 zero-arg call sites; `given` branches on `strategy`).
  Now the bench file type-checks and the scenario resolves `DELTA_CHAIN_FIXTURE`.
- **GREEN (functional)** — pre-warm the fixture (`ensureScaledFixture(DELTA_CHAIN_FIXTURE)` via
  a one-shot, or after Part 5's argv case) then `npm run test:bench`. Confirm both delta-chain
  scenarios run (tsgit + isomorphic-git benches present), the 5 existing scaled scenarios still
  run with unchanged describe titles, and the run is green. Confirm `reports/benchmarks/summary.md`
  gains the two delta-chain rows (generic flattener — no tooling change).
- **REFACTOR** — de-duplicate the shared iso-git baseline closure if it reads cleaner; keep
  `givenPhrase` small (early returns); confirm no describe-title drift on the 5 existing benches
  (`git --no-ext-diff diff` shows only the intended `scaled-bench.ts` change).

### Gate

Bench `.bench.ts` files run under `vitest bench`, not `vitest run`, so `<touched-tests>` is
empty for the plain unit runner. The functional check is `npm run test:bench`.

```
npm run check:types \
  && ./node_modules/.bin/biome check test/bench/support/scaled-bench.ts test/bench/delta-chain-read.bench.ts \
  && npm run test:bench
```

(`npm run test:bench` requires the `delta-chain` fixture in `~/.cache/tsgit-bench`; pre-warm it
first — a one-shot `ensureScaledFixture(DELTA_CHAIN_FIXTURE)` or, once Part 5 lands the argv
case, `npm run bench:fixture -- delta-chain`. Without `git`/fixture the scenario skips cleanly
and the run is still green.)

### Commit

`test(bench): add deep-delta-chain read scenario with iso-git baseline`

---

## Part 3 — Large-pack spread scenario (extend `pack-read-scale.bench.ts`)

### Context

**File (extend, not new):** `test/bench/pack-read-scale.bench.ts` (ADR-472: the home of
pack-read scenarios, already resolves the scaled context via `resolveScaledContext()` at line 19).

**Current shape:** two `scaledScenario` blocks (cold + warm single-blob `readBlob`) against the
env-driven medium/large fixture. `const ctx = await resolveScaledContext();` (line 19,
zero-arg — stays zero-arg, env-driven).

**Change (ADR-472: reuse `LARGE_FIXTURE`, spread read, tsgit-only, gated by `TSGIT_BENCH_LARGE`):**
- Add a **third** `scaledScenario` — a spread read across the pack — that only runs under the
  **large** fixture. The existing `ctx` is env-driven: it resolves `LARGE_FIXTURE` when
  `TSGIT_BENCH_LARGE` is set, `MEDIUM_FIXTURE` otherwise. The spread scenario is the net-new
  "large pack" signal, so gate it to the large path. Two acceptable gating styles — pick the
  cleaner:
  - (a) register it only when `process.env.TSGIT_BENCH_LARGE !== undefined` (a plain guard
    around the `scaledScenario` call); OR
  - (b) resolve a **second** context explicitly for the large fixture
    `const largeCtx = await resolveScaledContext(LARGE_FIXTURE)` and register the spread against
    it, but still guard the registration on `TSGIT_BENCH_LARGE` so nightly CI (no env) skips it.
  Prefer (a): it matches how the existing two scenarios already swap medium↔large via the env,
  and keeps a single `ctx`. Import `LARGE_FIXTURE` only if you choose (b).
- **Spread workload (applies the pressure):** read a **spread of N object ids spanning the
  pack index** in one measured `sut` call — touches many fanout buckets / pack regions without
  the scenario buffering the whole pack. This is the net-new signal beyond the existing
  single-object cold read.
- **Resolving the spread ids (deterministic, out of the measured `sut`):** `blobPath(blobIndex)`
  in the generator is **module-private** and MUST NOT be imported. Reproduce its convention in
  the bench: the generator writes `d${Math.floor(i / 512)}/f${i}.dat` for blob index `i`
  (`SHARD_SIZE = 512`). For `LARGE_FIXTURE` (`blobs: 200_000`) pick a fixed spread of indices,
  e.g. `SPREAD = [0, 25_000, 50_000, …, 175_000]` (8 evenly-spaced indices across the pack), map
  each to its path `d${Math.floor(i/512)}/f${i}.dat`, resolve each to an oid **in `build`** via
  `git rev-parse HEAD:<path>` (spawn env-isolated — a fresh `execFile('git', ['-C', fixture.cwd,
  'rev-parse', ...])`, or reuse `openRepository`'s resolveRef if simpler), cast the resulting
  id strings `as ObjectId`, and store the array. **Resolution happens once in `build`, never in
  the timed `sut`** (ADR-472: measure the reads, not the id lookup). Name the spread constants
  (no magic values). Reproducing the path convention is the design's preferred path (it avoids
  exporting the private `blobPath`); if the implementer would rather export `blobPath` from the
  generator and import it, that is an acceptable alternative (trivial, side-effect-free, no
  surface gate) — but the reproduce-convention path is simpler and keeps the generator surface
  minimal.
- `sut` = fresh `openRepository({ cwd })` → loop `for (const id of spread) await
  repo.primitives.readBlob(id)` → `dispose()` (cold spread — full fanout per read across many
  regions). A warm variant is optional and not required; the cold spread is the signal.
- **Baseline = tsgit-only** (ADR-472): no `baseline` field (`BenchComparison.baseline` is
  optional) — iso-git's repeated `readBlob` over a 200k pack is impractically slow; matches
  `log-scale`/`status-scale`.
- Symbols already imported at top of the file: `ObjectId`, `openRepository`,
  `resolveScaledContext`, `scaledScenario`. Add `LARGE_FIXTURE` from
  `./support/fixture-generator.js` only if you pick gating style (b).

### TDD steps

Bench-scenario RED→GREEN = "registered, runs green under `TSGIT_BENCH_LARGE=1 npm run
test:bench` against the large fixture, and skips cleanly (never registers) in nightly CI where
`TSGIT_BENCH_LARGE` is unset". No unit-coverage obligation.

- **RED** — add the spread `scaledScenario`, gated on `TSGIT_BENCH_LARGE`. Without the large
  fixture cached, `TSGIT_BENCH_LARGE=1 npm run test:bench` cannot run the spread (fixture
  unavailable → the `scaledScenario` skip path). Expected pre-implementation state: the scenario
  is not registered / not measurable. (Type-level: `npm run check:types` catches a wrong
  `readBlob` id type.)
- **GREEN** — implement the spread-id resolution in `build` (reproduce `blobPath` convention,
  `rev-parse HEAD:<path>` per index, cast `as ObjectId`), the cold-spread `sut`, tsgit-only
  return. Pre-warm the large fixture (`TSGIT_BENCH_LARGE=1 npm run bench:fixture -- large`, or
  reuse an existing cache) and run `TSGIT_BENCH_LARGE=1 npm run test:bench`; confirm the spread
  scenario runs (tsgit bench present, no isomorphic-git bench) and is green.
- **GREEN (gating proof)** — run plain `npm run test:bench` (no env): confirm the spread scenario
  does **not** register/run (nightly-CI-safe), while the medium cold+warm scenarios still run.
- **REFACTOR** — name the spread indices/count as constants; keep id resolution out of `sut`;
  ensure the loop body is a single early-return-free small function.

### Gate

```
npm run check:types \
  && ./node_modules/.bin/biome check test/bench/pack-read-scale.bench.ts \
  && npm run test:bench
```

(Plain `npm run test:bench` proves the medium path is green and the spread scenario is correctly
gated OFF. The large-path proof — `TSGIT_BENCH_LARGE=1 npm run test:bench` with the ~500 MB
`large` fixture cached — is a local/manual confirmation, not part of the committed gate, since
nightly CI never sets `TSGIT_BENCH_LARGE` and the large fixture is a local escape hatch.)

### Commit

`test(bench): add gated large-pack spread-read scenario`

---

## Part 4 — Memory probe (`tooling/bench-memory.ts`) + `bench:memory` script

### Context

**Files:**
- New `tooling/bench-memory.ts` (mirrors `tooling/profile.ts` idioms verbatim where possible).
- Edit `package.json` — add the `bench:memory` script.

**`tooling/profile.ts` idioms to reuse (read it — lines cited):**
- Shebang `#!/usr/bin/env node`; `SCRIPT_PATH = fileURLToPath(import.meta.url)` (29),
  `ROOT = path.resolve(path.dirname(SCRIPT_PATH), '..')` (30); a report dir constant
  (`profile.ts` → `reports/profiles`; **this → `reports/benchmarks`**),
  `await mkdir(REPORT_DIR, { recursive: true })` (138).
- Booting a repo: `const fixture = await ensureScaledFixture(SPEC)` (40) then
  `const repo = await openRepository({ cwd: fixture.cwd })` (43), `try { … } finally { await
  repo.dispose() }` (44-61). For the cold-chain workload, re-open a fresh repo per iteration
  exactly like `profile.ts`'s `pack-read` branch (51-56):
  `openRepository → primitives.readBlob(fixture.firstBlobId) → dispose`.
- Reading through the primitive the bench uses: `repo.primitives.readBlob(id)`.
  `fixture.firstBlobId` is a `string` on `ScaledFixture` — cast `as ObjectId`.
- Graceful-degrade guard: `main()`'s `try { await ensureScaledFixture(…) } catch (err) {
  process.stderr.write('…fixture unavailable… install the git CLI…'); process.exit(1); }`
  (127-136), and the top-level `main().catch((err) => { …; process.exit(1); })` (146-149).

**Import-path nuance (verified):** `profile.ts` imports `openRepository` from the built
`dist/esm/index.node.js` (32, 41) because it runs under plain `node --prof`. The memory probe
runs under `node --expose-gc --experimental-strip-types` (like `gen-bench-fixture.ts`, which
imports the generator `.ts` source directly), so it imports **source**, no `dist/` build:
- `import { openRepository } from '../src/index.node.ts'` — verified `src/index.node.ts`
  exports `openRepository` (line 42).
- `import type { ObjectId } from '../src/domain/objects/index.ts'` — verified `ObjectId`
  branded type is exported there (`src/domain/objects/object-id.ts:7`, re-exported via the
  barrel).
- `import { ensureScaledFixture, DELTA_CHAIN_FIXTURE, LARGE_FIXTURE } from
  '../test/bench/support/fixture-generator.ts'` — the `.ts` extension, exactly like
  `gen-bench-fixture.ts:12-16` and `profile.ts:23`.

**What it measures (new — `profile.ts` does CPU `--prof`, not memory):** around each workload,
sample `process.memoryUsage()` (`rss` + `heapUsed`) at three points: **before** (post-GC
baseline), **peak** (max sampled across the workload run), **after** (post-workload, post-GC).
Force GC before each baseline reading via `global.gc()` for stability → the script runs under
**`node --expose-gc`**. Guard `if (typeof global.gc !== 'function') throw new Error('bench-memory
requires --expose-gc for stable baselines')` and **fail loud** (thrown error, non-zero exit) if
omitted — a real error, never a silent skip (design + ADR-473). `global.gc` is not typed on the
Node globals by default; declare it locally (`declare global { var gc: (() => void) | undefined }`
or a narrow `const gc = (globalThis as { gc?: () => void }).gc`) — **no `@ts-ignore`, no `any`**;
use `unknown`/narrowing. Peak = sample `process.memoryUsage()` immediately after each
`readBlob` in the workload loop and keep the max (sampling is *outside* any timed region — there
is no wall-clock measurement here, which is exactly why memory lives here and not in the
`.bench.ts` timed `sut`).

**Workloads (reuse generator fixtures — no new fixture):**
1. **Deep-delta chain** — `ensureScaledFixture(DELTA_CHAIN_FIXTURE)`; cold read of the
   deepest-chain object (`fixture.firstBlobId`) with a **fresh repo per iteration** (empty LRU →
   full chain replay, allocation-heavy). Reports before/peak/after RSS + heapUsed. Fast + small
   → runs on the **default path**.
2. **Large-pack spread** — `ensureScaledFixture(LARGE_FIXTURE)`; the **same deterministic
   index-derived spread as Part 3** (reproduce `blobPath` convention `d${Math.floor(i/512)}/f${i}.dat`,
   resolve each via env-isolated `git rev-parse HEAD:<path>` at setup, cast `as ObjectId`), read
   in one pass. **Gated behind `TSGIT_BENCH_LARGE`** (skip the workload when unset), mirroring
   the timing scenario, so the ~500 MB fixture never generates in nightly CI. (Consider a tiny
   shared spread-index helper to keep Part 3 and Part 4 in sync — an optional `tooling/test/unit`
   test seam, not gated.)

**What it emits and where (its own artifact — never merged into the timing summary):**
- `reports/benchmarks/memory.json` — structured, one entry per workload:
  `{ workload, rss: { before, peak, after }, heapUsed: { before, peak, after }, node, platform }`.
- `reports/benchmarks/memory.md` — a human-readable sibling table.
- Keep `bench-summarize.ts` / `summary.md` **untouched** (it keys on `tsgit`/`isomorphic-git`
  bench names and only knows timing). The probe writes alongside it in the same dir.

**Env-isolation:** the probe spawns `git` only for spread-id `rev-parse` at setup (env-isolate
it: `execFile('git', ['-C', fixture.cwd, 'rev-parse', …])`, no `GIT_*` inheritance) and drives
`git` otherwise only through `ensureScaledFixture` (unchanged). No new fixture-writing `git`
surface.

**`package.json` script** — add alongside `bench:fixture` (192) / `profile` (193):
```json
"bench:memory": "node --expose-gc --experimental-strip-types tooling/bench-memory.ts"
```
(Mirrors the `node --experimental-strip-types tooling/<script>.ts` form of `bench:fixture`;
adds `--expose-gc`. No prior `build` — it reads source, unlike `profile`.) The large-pack
workload is reached by `TSGIT_BENCH_LARGE=1 npm run bench:memory`.

**Error semantics (design):** `--expose-gc` omitted → throw loudly, non-zero exit. `git` absent →
`ensureScaledFixture` throws → print "fixture unavailable — install the `git` CLI", non-zero exit
(mirror `profile.ts:127-136`). Large fixture without `TSGIT_BENCH_LARGE` → skip that workload
only, delta-chain still runs.

**No provenance refs** in the tooling source; comments explain *why* (e.g. "GC before each
baseline so RSS/heap are comparable across workloads"), never *what*.

### TDD steps

TDD nuance: `tooling/*.ts` (non-test) is **outside the coverage include** (exact `profile.ts`
precedent), so the probe carries no coverage/mutation obligation and the memory numbers are
host-specific artefacts, not assertable SUTs. The "RED→GREEN" is "emits the expected
`memory.json` shape under `--expose-gc`, fails loud without it, degrades gracefully without
`git`". If a pure helper is extracted (spread-index computation shared with Part 3, or the
`{before,peak,after}` aggregation), fold an optional `tooling/test/unit` test for it — a genuine
pure seam, but nothing gates it.

- **RED** — write `tooling/bench-memory.ts` and add the `bench:memory` script. Before the
  implementation compiles, `npm run check:types` fails (the file/script does not exist / imports
  unresolved). Expected failure reason: probe not implemented.
- **GREEN** — implement: `--expose-gc` guard (throw if missing), delta-chain workload
  (fresh-repo-per-iteration cold chain replay, sampled before/peak/after), large-pack workload
  gated on `TSGIT_BENCH_LARGE`, emit `memory.json` + `memory.md`, graceful `git`-absent exit.
  Add the script. Pre-warm the delta-chain fixture, then run `npm run bench:memory`; confirm it
  emits `reports/benchmarks/memory.json` (correct shape: `workload`, `rss.{before,peak,after}`,
  `heapUsed.{before,peak,after}`, `node`, `platform`) and `memory.md` for the delta-chain
  workload, and **skips** the large-pack workload (no `TSGIT_BENCH_LARGE`). Confirm `summary.md`
  is **untouched**.
- **GREEN (loud-fail + graceful-degrade proofs)** — run `node --experimental-strip-types
  tooling/bench-memory.ts` (no `--expose-gc`): confirm it throws loudly, non-zero exit. With
  `git` unavailable (or an unbuildable fixture), confirm the "fixture unavailable — install
  git" message + non-zero exit. `TSGIT_BENCH_LARGE=1 npm run bench:memory` (large fixture
  cached, local only): confirm it additionally emits the large-pack workload numbers.
- **REFACTOR** — extract small functions (`sampleMemory()`, `runDeltaChainWorkload()`,
  `runLargePackWorkload()`, `emitReports()`); early returns; no nesting > 2; declare the `gc`
  global without `any`/`@ts-ignore`.

### Gate

```
npm run check:types \
  && ./node_modules/.bin/biome check tooling/bench-memory.ts \
  && npm run bench:memory
```

(`npm run bench:memory` runs under `--expose-gc` and must emit `reports/benchmarks/memory.json`
+ `memory.md` for the delta-chain workload — requires the `delta-chain` fixture cached, pre-warm
first. If a `tooling/test/unit` helper test is added, prepend
`npx vitest run tooling/test/unit/<helper>.test.ts &&` and add the test file to the `biome check`
list.)

### Commit

`test(bench): add RSS/heap memory probe for delta-chain and large-pack workloads`

---

## Part 5 — Wiring: fixture pre-warm argv case + CI steps

### Context

**Files:**
- `tooling/gen-bench-fixture.ts` — add the `'delta-chain'` argv case.
- `.github/workflows/bench.yml` — add the delta-chain pre-warm + memory-probe steps.
- (`package.json` `bench:memory` script already landed in Part 4 — no change here.)

**`tooling/gen-bench-fixture.ts` current shape (lines 18-25):**
```ts
const label = process.argv[2];
const spec =
  label === 'large' ? LARGE_FIXTURE : label === 'medium' ? MEDIUM_FIXTURE : undefined;
if (spec === undefined) { process.stderr.write('usage: gen-bench-fixture <medium|large>\n'); process.exit(1); }
```
- Add a `'delta-chain'` branch → `DELTA_CHAIN_FIXTURE`; import `DELTA_CHAIN_FIXTURE` from
  `../test/bench/support/fixture-generator.ts` (alongside `LARGE_FIXTURE`, `MEDIUM_FIXTURE`,
  `ensureScaledFixture` at lines 12-16). Update the usage string to
  `usage: gen-bench-fixture <medium|large|delta-chain>`. So
  `npm run bench:fixture -- delta-chain` pre-warms it.

**`.github/workflows/bench.yml` current shape (read it — 38 lines):**
- Step "Pre-warm the medium fixture" (30-31): `run: npm run bench:fixture -- medium`.
- `run: npm run bench:summary` (32).
- `actions/upload-artifact` (33-37): `path: reports/benchmarks/` (whole dir — already carries
  any new files, no path change needed).
- Cache key (29): `hashFiles('test/bench/support/fixture-generator.ts')` — editing the
  generator in Part 1 **already re-keys** it; no key edit here.

**Changes (design Part D + ADR-473 wiring):**
- Add a sibling pre-warm step after the medium one:
  `- name: Pre-warm the delta-chain fixture` / `run: npm run bench:fixture -- delta-chain`
  (fast, small — safe on the default path). The large-pack scenario stays gated (no
  `TSGIT_BENCH_LARGE` in CI) → skipped, costs nothing.
- Add a `bench:memory` step **after** `bench:summary`:
  `- name: Capture memory probe` / `run: npm run bench:memory`. Under `node --expose-gc`
  (baked into the script) it measures the delta-chain workload and **skips** the large-pack one
  (no `TSGIT_BENCH_LARGE`). Its `memory.json`/`memory.md` land in `reports/benchmarks/` and ride
  the existing `upload-artifact` (`path: reports/benchmarks/`) — **no path change**.
- **No change** to `tooling/bench-summarize.ts` / `bench-to-snapshot.ts` — both flatten
  `raw.files[].groups[].benchmarks[]` generically (verified: `bench-summarize.ts:71`
  `raw.files.flatMap(file => file.groups)`; `bench-to-snapshot.ts:46-48` nested `flatMap`), so
  the new delta-chain rows appear automatically. The memory probe writes its own artifacts and
  never touches `summary.md`/`snapshot.json`.

### TDD steps

RED→GREEN = "the new argv case pre-warms the delta-chain fixture; the CI steps are valid and
ordered". No unit-coverage obligation (`tooling/*.ts` + `.github` outside the include). CI-yaml
correctness is proven by running the referenced npm commands locally, not by an automated test.

- **RED** — before the argv case, `npm run bench:fixture -- delta-chain` prints
  `usage: gen-bench-fixture <medium|large>` and exits 1 (no `delta-chain` branch). Expected
  failure: the label is unrecognised.
- **GREEN** — add the `'delta-chain'` case + `DELTA_CHAIN_FIXTURE` import + updated usage string.
  Run `npm run bench:fixture -- delta-chain`: confirm it generates (or cache-hits) the
  `delta-chain-v1` fixture and prints the ready line (`… fixture ready in …s` with path + HEAD).
  Then confirm `git -C ~/.cache/tsgit-bench/delta-chain-v1 verify-pack -v <idx>` shows max chain
  depth ∈ [30, 50] (≈ 43) — the end-to-end Part 1 proof now runnable via the public script.
- **GREEN (CI wiring)** — edit `bench.yml`: add the delta-chain pre-warm step and the
  `bench:memory` step. Validate the YAML parses (`npx --yes yaml-lint .github/workflows/bench.yml`
  or an equivalent, or `python3 -c 'import yaml,sys; yaml.safe_load(open("...")'`). Confirm the
  step order: checkout → setup → cache restore → pre-warm medium → pre-warm delta-chain →
  bench:summary → bench:memory → upload-artifact. Confirm `upload-artifact` `path` is unchanged
  (`reports/benchmarks/`).
- **REFACTOR** — keep the argv mapping a small chained ternary (matches the existing style);
  ensure no magic label strings beyond the three recognised labels.

### Gate

```
npm run check:types \
  && ./node_modules/.bin/biome check tooling/gen-bench-fixture.ts \
  && npm run bench:fixture -- delta-chain
```

(`biome check` covers only `.ts` files; `bench.yml` is validated by the YAML-parse check above,
not by biome. `npm run bench:fixture -- delta-chain` proves the argv case end-to-end: the
fixture generates and — via a follow-on `git verify-pack -v` — max chain depth lands in the
pinned [30, 50] band. Requires the `git` CLI; without it the command exits with the
fixture-unavailable error, which is the correct degrade.)

### Commit

`test(bench): wire delta-chain fixture pre-warm and memory probe into CI`
