# Plan — filter / clean-smudge / textconv driver port

Source: design doc `docs/design/lfs-filter-driver-port.md` · ADRs `406, 407, 408`

This plan is the implementation script AND the knowledge handoff. Slice agents start
with zero context; whatever a slice block omits, that agent re-discovers. Every cited
file/symbol/line below was verified against the worktree with Serena. `plan-lint.sh`
gates this phase on the `## Slice N` / `### Context` / `### TDD steps` / `### Gate` /
`### Commit` schema.

## Sizing rules

- Every slice costs a full agent lifecycle (spin-up, zero-context rebuild, gate) — it
  must earn it. No standalone test-only slices: every interop / unit test folds into
  the slice whose code it exercises (TDD: RED test + GREEN code in the same slice).
- Sequential slices share one working tree and build on landed predecessors. Order:
  config parse → port extension → resolvers → run-primitives → consumer chokepoints
  (textconv@diff, clean@add, smudge@checkout + F1) → cross-adapter parity.

## Public-surface decisions (decided up front, per ADR)

- **`ParsedConfig.diff?` / `ParsedConfig.filter?` arms (Slice 1)** — `ParsedConfig` is
  PUBLIC (barrel-exported from `src/application/primitives/index.ts:12`, re-exported by
  `src/public-types.ts:10`, present in `reports/api.json` — 9 occurrences). Extending it
  changes the api.json surface → Slice 1 pre-pays `npm run docs:json` + commits
  `reports/api.json` (prepush `check:doc-typedoc` gate = `git diff --exit-code -- reports/api.json`).
- **`CommandRequest.stdin?` / `CommandResult.stdout?` (Slice 2)** — `CommandRunner` is
  PUBLIC (`src/ports/index.ts:2` → `src/public-types.ts:49`; asserted in
  `test/unit/public-types.test.ts:107`). `CommandRequest` (10×) and `CommandResult` (6×)
  both already appear in `reports/api.json` (pulled transitively through `CommandRunner.run`).
  Extending the two interfaces changes api.json → Slice 2 pre-pays `npm run docs:json` +
  commits `reports/api.json`.
- **`CLEAN_FILTER_FAILED` error code (Slice 6)** — NO existing error code fits F3. The
  merge driver maps a non-zero exit to a `conflict` *status* (never a thrown error), and
  `operationAborted` carries no driver/exit data. A new `CommandError` union member is
  required. It is barrel-reachable through `TsgitError.data` (public), so Slice 6 wires
  the exhaustiveness switch in `extractDetail` (`src/domain/error.ts:472`, the
  `const _exhaustive: never = data` arm) and pre-pays `npm run docs:json` + `reports/api.json`.
- **New primitives** `resolve-textconv-driver`, `resolve-filter-driver`,
  `run-filter-driver`, `apply-textconv` and their choice types `TextconvChoice` /
  `FilterChoice`: INTERNAL. Mirror the merge precedent exactly — `resolve-merge-driver`
  and `run-merge-driver` are NOT in the primitives barrel (`src/application/primitives/index.ts`)
  and NOT in `public-types.ts`; they are imported directly by their consumers. The new
  primitives follow suit: no barrel entry, no api.json delta, no doc page.

---

## Slice 1 — config parse: `[diff "<name>"]` + `[filter "<name>"]` arms

### Context

- File: `src/application/primitives/config-read.ts`. The merge arm is the verbatim
  precedent — mirror it for `diff` and `filter`. Verified there is **zero** existing
  `[filter "`/`[diff "` parse today (clean grep).
- Touch FIVE spots, each next to its `merge` sibling:
  1. `ParsedConfig` interface (line ~41, after the `merge?` field, line 42-45): add
     ```ts
     /** `[diff "<name>"]` — configured diff/textconv drivers. */
     readonly diff?: ReadonlyMap<string, { readonly textconv?: string; readonly cachetextconv?: boolean }>;
     /** `[filter "<name>"]` — configured clean/smudge filter drivers. */
     readonly filter?: ReadonlyMap<string, { readonly clean?: string; readonly smudge?: string; readonly process?: string; readonly required?: boolean }>;
     ```
  2. `MutableParsedConfig` interface (line 957-974, after `merge?: Map<...>` line 972):
     add `diff?: Map<...>` and `filter?: Map<...>` mutable shapes (non-readonly).
  3. `dispatchSection` (line 976-992): add two arms next to the `merge` arm (line 987):
     `else if (sec.section === 'diff' && sec.subsection !== undefined) mergeDiffDriver(acc, sec.subsection, sec);`
     and the symmetric `filter` arm → `mergeFilterDriver`.
  4. New `mergeDiffDriver` + `mergeFilterDriver` functions, modelled on `mergeMergeDriver`
     (line 1185-1203). Keys: `textconv` (string, skip null) / `cachetextconv` (boolean via
     `parseGitBoolean`, line 1295 — boolean keys do NOT skip null) for diff;
     `clean`/`smudge`/`process` (string, skip null) / `required` (boolean via
     `parseGitBoolean`) for filter. Lower-case key compare (`key.toLowerCase()`), exactly
     like `mergeMergeDriver`.
  5. `finalize` (line 1241-1287): add `if (acc.diff !== undefined && acc.diff.size > 0) out.diff = acc.diff;`
     and the `filter` twin, next to the `merge` finalize line (1285). Also widen the
     local `out` shape type at line 1242-1268 to carry `diff`/`filter` (mirror the
     `merge?: ReadonlyMap<...>` line 1266).
- Booleans: `cachetextconv` and `required` are git booleans — a valueless key (`value === null`,
  git's internal NULL) is boolean-true. Use `parseGitBoolean(value)` which already maps
  `null → true` (line 1295). String keys (`textconv`/`clean`/`smudge`/`process`) skip null
  (`if (value === null) continue;`), matching the merge string-key handling.
- PUBLIC SURFACE: `ParsedConfig` is barrel-exported and in api.json (see header). After the
  parse change, regenerate and commit `reports/api.json` IN THIS SLICE.
- Test file: `test/unit/application/primitives/config-read.test.ts` (extend; do not create new).
  Seed config text and assert the parsed `diff`/`filter` maps. Pin: a `[diff "upper"]\n\ttextconv = up`
  yields `diff.get('upper') === { textconv: 'up' }`; `cachetextconv = true` → `{ textconv, cachetextconv: true }`;
  a valueless `required` under `[filter "f"]` → `required: true`; a `[filter "f"]` with only
  `clean` → `{ clean }` (no `smudge`); an absent section ⇒ `diff`/`filter` undefined.

### TDD steps

- RED: add `config-read.test.ts` cases for the `diff`/`filter` arms (parse a `[diff "upper"]`
  textconv, a `[filter "myf"]` clean+smudge+required). Fails: `ParsedConfig` has no `diff`/`filter`
  field and `dispatchSection` ignores the sections (the maps are `undefined`).
- GREEN: add the interface fields, `MutableParsedConfig` shapes, `dispatchSection` arms,
  `mergeDiffDriver`/`mergeFilterDriver`, and the `finalize` projection.
- REFACTOR: factor the shared "string key skip-null, boolean key parseGitBoolean" loop body
  only if it reads cleaner than the two sibling functions — the merge precedent kept them
  separate; match that unless extraction is obviously DRYer.
- Pre-pay surface: `npm run docs:json` then `git add reports/api.json` (the regenerated
  typedoc-id diff is large and expected).

### Gate

`npx vitest run test/unit/application/primitives/config-read.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/primitives/config-read.ts test/unit/application/primitives/config-read.test.ts reports/api.json`

### Commit

`feat(config): parse [diff] and [filter] driver sections`

---

## Slice 2 — extend the `CommandRunner` port + `NodeCommandRunner` stdio

### Context

- Ports file: `src/ports/command-runner.ts`. Today `CommandRequest` has
  `command`/`cwd`/`env`/`signal?` (line 5-14); `CommandResult` has only `exitCode` (line 20-22).
  Add two purely-additive optional fields:
  ```ts
  readonly stdin?: Uint8Array;   // CommandRequest — bytes fed to the child's stdin (clean/smudge input)
  readonly stdout?: Uint8Array;  // CommandResult — bytes captured from the child's stdout
  ```
  Update the doc comments: the port now carries TWO output conventions — a merge driver
  reads its `%A` file (ignores `stdout`); textconv/filter read `result.stdout`.
- Node adapter: `src/adapters/node/node-command-runner.ts`. Current `CommandRunnerOps.spawn`
  options type pins `stdio: 'ignore'` (line 25); `spawnCommand` passes `stdio: 'ignore'`
  (line 41). Change to a piped stdio: `stdio: ['pipe', 'pipe', 'inherit']` (stdin pipe,
  stdout pipe, stderr inherited — F3/F4 stderr is git's own concern, not the port's). The
  `CommandChild` interface (line 10-14) must grow `stdin` (writable) and `stdout` (readable)
  surfaces so the fake can drive them; widen `CommandRunnerOps.spawn`'s `stdio` option type
  to the tuple. In `spawnCommand` (line 31-61): when `request.stdin !== undefined`, write it
  to `child.stdin` and `end()`; accumulate `child.stdout` `data` chunks into a `Uint8Array`;
  return `{ exitCode, stdout }` on `close`. Keep abort/kill (line 44-48), env-merge
  (`{ ...process.env, ...request.env }`, line 40), and the idempotent `finish` (line 51-54).
- BYTE-UNCHANGED MERGE CALLER (asserted): `run-merge-driver.ts` (line 62) calls
  `runner.run({ command, cwd, env, signal })` with no `stdin` and ignores `result.stdout`.
  A request without `stdin` must still resolve on `exitCode` alone, with `stdout` ignorable.
  The adapter test MUST include a no-`stdin` case proving `exitCode` resolves and the merge
  shape is unaffected.
- The `MemoryCommandRunner` test double (`src/adapters/memory/memory-command-runner.ts`,
  line 22-25) returns `{ exitCode }` only. DO NOT change it in this slice — it stays
  `stdout`-less; ADR-408 makes memory inert (no smudge/clean run there). Leave it for the
  parity slice to confirm inertness.
- PUBLIC SURFACE: `CommandRunner`/`CommandRequest`/`CommandResult` are in api.json (see
  header). After editing `command-runner.ts`, regenerate and commit `reports/api.json`.
- Test file: `test/unit/adapters/node/node-command-runner.test.ts` (extend; the `FakeChild`
  EventEmitter harness is at line 11-38, `makeHarness` at line 26, `baseRequest` at line 40).
  Extend `FakeChild` with a fake `stdin` (capture `write`/`end`) and `stdout` (an EventEmitter
  emitting `data` then triggering `close`). Pin: a request with `stdin` writes those bytes to
  the child's stdin; `result.stdout` carries the captured `data` bytes; a request WITHOUT
  `stdin` still resolves with `exitCode` and `stdout` undefined-or-ignorable. Keep every
  existing case green (the `stdio` assertion at line 64 changes from `'ignore'` to the tuple).
- `public-types.test.ts` (line 107) asserts `CommandRunner` is never-free — leave it; the
  additive optional fields keep it satisfied. Run it as part of check:types coverage.

### TDD steps

- RED: add `node-command-runner.test.ts` cases for stdin-feed + stdout-capture (fake child
  with stdin/stdout streams). Fails: `CommandRequest` has no `stdin`, `CommandResult` no
  `stdout`, and `spawnCommand` ignores stdio.
- GREEN: add the two optional port fields; rewire `NodeCommandRunner` to pipe stdin and
  capture stdout; update the `CommandChild`/`CommandRunnerOps` types and the existing
  `stdio: 'ignore'` assertion.
- REFACTOR: extract the stdout-accumulation helper if `spawnCommand` exceeds ~20 lines.
- Pre-pay surface: `npm run docs:json` then `git add reports/api.json`.

### Gate

`npx vitest run test/unit/adapters/node/node-command-runner.test.ts test/unit/public-types.test.ts && npm run check:types && ./node_modules/.bin/biome check src/ports/command-runner.ts src/adapters/node/node-command-runner.ts test/unit/adapters/node/node-command-runner.test.ts reports/api.json`

### Commit

`feat(ports): CommandRunner stdin input + stdout capture`

---

## Slice 3 — `resolve-textconv-driver` primitive (internal)

### Context

- New file: `src/application/primitives/resolve-textconv-driver.ts`. Mirror
  `src/application/primitives/resolve-merge-driver.ts` exactly (that file: `MergeDriverChoice`
  discriminated union line 18-22, `namedChoice` line 29-38, `driverFromMergeValue` line 41-45,
  `resolvePathMergeSpec(ctx, provider, path)` line 58-69 doing one `provider.sourcesForPath(path)`
  + `resolveAttribute(sources, path, 'merge', macros)`).
- Define INTERNAL `TextconvChoice` discriminated union:
  ```ts
  export type TextconvChoice =
    | { readonly kind: 'none' }                              // raw diff (today's behaviour)
    | { readonly kind: 'external'; readonly command: string };
  ```
  NOT barrel-exported, NOT in public-types (matches `MergeDriverChoice`, which is not barrelled).
- `resolveTextconvDriver(ctx, provider, path) → Promise<TextconvChoice>`: one
  `provider.sourcesForPath(path)`, then `resolveAttribute(sources, path, 'diff', macros)`
  (import `resolveAttribute` from `src/domain/attributes/index.js`, line 22). Map the
  resolved `AttributeValue` (type at `src/domain/attributes/attribute-value.ts:9` —
  `true | false | 'unspecified' | { readonly set: string }`) per §3.6:
  - `false` (`-diff`, incl. via the `binary` macro `-diff -merge -text`,
    `src/domain/attributes/macros.ts:8-17`) → `{ kind: 'none' }` (no textconv).
  - `true` / `'unspecified'` → `{ kind: 'none' }`.
  - `{ set: name }` → consult `(await readConfig(ctx)).diff?.get(name)`; if `textconv`
    is a non-empty string → `{ kind: 'external', command: textconv }`; if absent OR
    empty-string → `{ kind: 'none' }` (T2 fallback; T2e empty-string folded to fallback
    per §3.5 note — do NOT reproduce git's fatal-on-empty).
- `readConfig` is at `src/application/primitives/config-read.ts:75` and is per-`Context`
  cached. `provider` comes from `buildAttributeProvider(ctx)` (`src/application/primitives/internal/read-gitattributes.ts:65`).
- Test file: `test/unit/application/primitives/resolve-textconv-driver.test.ts` (new). Mirror
  `resolve-merge-driver.test.ts` structure (line 1-25: `createMemoryContext`, `buildAttributeProvider`,
  a `seed(ctx, attrs, config)` helper writing `.gitattributes` + `${gitDir}/config`). Cover
  EVERY §3.6 row as ISOLATED guard tests (mutation-resistant — assert the exact
  `{ kind, command }`, never a truthy):
  - no `diff` attribute ⇒ `{ kind: 'none' }`.
  - `a.x diff=upper` + `[diff "upper"]\n\ttextconv = up` ⇒ `{ kind: 'external', command: 'up' }`.
  - `a.x diff=upper` + NO `[diff "upper"]` section ⇒ `{ kind: 'none' }` (T2).
  - `[diff "upper"]\n\ttextconv =` (empty) ⇒ `{ kind: 'none' }` (T2e→fallback).
  - `a.x -diff` ⇒ `{ kind: 'none' }`.
  - `a.x binary` (macro) ⇒ `{ kind: 'none' }` (the `binary` macro sets `diff: false`).
  - `a.x diff` (bare true) ⇒ `{ kind: 'none' }`.

### TDD steps

- RED: write the resolver tests; they fail (module does not exist).
- GREEN: create `resolve-textconv-driver.ts` with `TextconvChoice` + `resolveTextconvDriver`.
- REFACTOR: keep `namedChoice`-style helper private if it tightens the `{ set }` arm.

### Gate

`npx vitest run test/unit/application/primitives/resolve-textconv-driver.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/primitives/resolve-textconv-driver.ts test/unit/application/primitives/resolve-textconv-driver.test.ts`

### Commit

`feat(primitives): resolve-textconv-driver over diff attribute`

---

## Slice 4 — `resolve-filter-driver` primitive (internal)

### Context

- New file: `src/application/primitives/resolve-filter-driver.ts`. Same shape as Slice 3 /
  `resolve-merge-driver.ts`, resolving the `filter` attribute against the `[filter "<name>"]`
  config arm (added in Slice 1).
- Define INTERNAL `FilterChoice`:
  ```ts
  export type FilterChoice =
    | { readonly kind: 'identity' }                                                        // raw clean + identity smudge
    | { readonly kind: 'external'; readonly clean?: string; readonly smudge?: string; readonly required: boolean };
  ```
  `required` defaults `false` when the config key is absent. A missing `clean` ⇒ identity
  clean; a missing `smudge` ⇒ identity smudge (F2). NOT barrel-exported, NOT public.
- `resolveFilterDriver(ctx, provider, path) → Promise<FilterChoice>`: one
  `provider.sourcesForPath(path)` + `resolveAttribute(sources, path, 'filter', macros)`. Map
  per §3.6 filter table:
  - `false` (`-filter`) / `'unspecified'` / `true` → `{ kind: 'identity' }`.
  - `{ set: name }` → `(await readConfig(ctx)).filter?.get(name)`; if the section is absent
    ⇒ `{ kind: 'identity' }` (unconfigured / ADR-408 inert); else
    `{ kind: 'external', clean?, smudge?, required: section.required ?? false }`. The
    `binary` macro sets `-diff -merge -text`, NOT `-filter` — a `binary` path with a
    `filter=` mapping still resolves external (§3.6 last paragraph).
- Test file: `test/unit/application/primitives/resolve-filter-driver.test.ts` (new). Mirror
  `resolve-merge-driver.test.ts`. ISOLATED guard tests per §3.6 row:
  - no `filter` attribute / `-filter` / `'unspecified'` ⇒ `{ kind: 'identity' }`.
  - `*.y filter=myf` + `[filter "myf"]\n\tclean=up\n\tsmudge=down` ⇒
    `{ kind: 'external', clean: 'up', smudge: 'down', required: false }`.
  - `[filter "c"]\n\tclean=up` (no smudge) ⇒ `{ kind: 'external', clean: 'up', required: false }`
    (smudge undefined ⇒ identity smudge).
  - `[filter "f"]\n\tclean=false\n\trequired=true` ⇒ `required: true`.
  - `filter=myf` + NO `[filter "myf"]` section ⇒ `{ kind: 'identity' }`.

### TDD steps

- RED: write the resolver tests; fail (module missing).
- GREEN: create `resolve-filter-driver.ts`.
- REFACTOR: private `namedFilterChoice` helper if the `{ set }` arm grows past 2 lines.

### Gate

`npx vitest run test/unit/application/primitives/resolve-filter-driver.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/primitives/resolve-filter-driver.ts test/unit/application/primitives/resolve-filter-driver.test.ts`

### Commit

`feat(primitives): resolve-filter-driver over filter attribute`

---

## Slice 5 — `apply-textconv` primitive + textconv@diff chokepoint + interop

### Context

- This slice wires textconv into the diff surface (R1-R5) and proves it against real git.
- NEW primitive: `src/application/primitives/apply-textconv.ts` (internal).
  `applyTextconv(ctx, runner, command, content) → Promise<Uint8Array>`: mirror
  `run-merge-driver.ts` (`src/application/primitives/run-merge-driver.ts`) temp-file
  lifecycle. Per T-EXEC (§3.4): write `content` to a temp file under `gitDir` (use
  `ctx.layout.gitDir`, e.g. `${gitDir}/TEXTCONV_INPUT`; `run-merge-driver` uses fixed temp
  names under gitDir, line 43-45 — diffs run one path-side at a time so no collision, but
  textconv diffs both sides per file; use TWO names or a per-side suffix to avoid the
  old/new collision within one `materialiseOne`), run the command with that path as
  `argv[1]` (the command string is `${command} ${tmpPath}` — git appends the blob path as
  the single argv), NO `stdin`, read the transformed bytes from `result.stdout` (Slice 2),
  `finally`-cleanup the temp file(s). Thread `ctx.signal` like `run-merge-driver` (line 66).
  If `result.stdout` is undefined (defensive — should not happen for a real textconv), treat
  as empty `Uint8Array`.
- CHOKEPOINT: `src/application/primitives/materialise-patch-files.ts`. `materialiseOne`
  (line 36-68) is the single place both diff surfaces get content: `buildEdits` patch hunks
  AND `computeStatFields` numstat both consume `PatchFile.{oldContent,newContent}` (fed at
  `diff-trees.ts:99` → `applyLinePassAndStat`). Add a textconv transform per side INSIDE /
  right after `materialiseOne` so both surfaces see transformed bytes with one transform
  per side:
  - `materialisePatchFiles` (line 29-34) currently takes `(ctx, changes)`. The textconv
    needs the provider + runner. Thread a per-call provider (built once via
    `buildAttributeProvider(ctx)`) and resolve the textconv per changed path; apply only
    under the §3.3 guard: `ctx.command !== undefined` AND `resolveTextconvDriver` returns
    `{ kind: 'external' }`. Build the provider LAZILY (mirror `build-content-merger.ts:45-47`
    `providerPromise ??= buildAttributeProvider(ctx)`) so a no-driver diff forces NO
    attribute read (R11, byte- and cost-identical to today).
  - Per existing side: `add` runs textconv on the new side only (line 37-41), `delete` on
    the old side only (line 42-46), `modify`/`type-change` on both (line 63-67),
    `rename`/`copy` on both when content is loaded (line 47-54). Apply
    `applyTextconv(ctx, ctx.command, command, sideBytes)` to each loaded side after
    `readBlob`/`resolveSide`.
  - GITLINK SIDES EXCLUDED: `materialiseOne` synthesises `Subproject commit <oid>\n`
    (`synthesizeGitlink`, line 13-15) for gitlink sides; git does NOT run textconv on
    gitlinks (§3.2). Skip textconv when `isGitlink(mode)` (the `isGitlink` guard already
    gates each arm, line 38/43/59). The textconv composes onto the NON-gitlink branch only.
- OID INVARIANCE (R2, T6): `DiffChange` (its OIDs/mode/type/name-status) is computed from
  tree OIDs BEFORE materialisation (`domainDiffTrees`/`diffRecursive` in `diff-trees.ts:45-48`),
  so `--raw`/`index`-line OIDs stay raw. Do NOT touch `DiffChange` — only `PatchFile` content
  is transformed. Assert this in the interop (T6).
- DEFAULT-PATH GUARD: `diff.ts` command (`src/application/commands/diff.ts`) threads
  `DiffOptions` → `diffTrees` → `materialisePatchFiles`. `ctx.command` absent ⇒ raw diff.
  Add a unit assertion that the default `diff` path (no `ctx.command`) is unchanged.
- Unit test files:
  - `test/unit/application/primitives/materialise-patch-files.test.ts` (extend — 16.6KB,
    existing add/delete/rename/modify/gitlink cases). Add: both-sides textconv transform
    via a fake `CommandRunner` (returns `{ exitCode: 0, stdout: <uppercased bytes> }`);
    add-side-only / delete-side-only; gitlink side NOT transformed; `ctx.command` absent ⇒
    raw content byte-identical. (If the textconv arm reads cleaner as a dedicated
    `apply-textconv.test.ts`, split the `applyTextconv` unit there and keep the chokepoint
    wiring tests in `materialise-patch-files.test.ts` — but no test-only slice; both land here.)
- INTEROP (folds in here — proves the textconv surface): NEW
  `test/integration/diff-textconv-interop.test.ts`. Mirror `merge-driver-interop.test.ts`
  (`describe.skipIf(!GIT_AVAILABLE)`, `makePeerPair`, `runGit`/`runGitEnv`, `lsStage`,
  COMMIT_ENV, one shared `beforeAll` repo with `SETUP_TIMEOUT = 60_000` per the interop
  load→validate flake note). Drivers are trivial portable scripts (`LC_ALL=C tr a-z A-Z`).
  Pin T1 (both-sides transform + raw `index` OIDs), T1n (`--numstat`), T2 (named-but-unconfigured
  fallback), T-ADD (add side only — driver called once), T5 (`diff=`-only committed raw + diffed
  via textconv), T6 (`--raw` OIDs raw), and the `binary`-macro ⇒ no-textconv interplay (§3.6).
  Reconstruct git's patch from the structured `TreeDiff` fields (ADR-249 — the library emits
  no display string) and compare to real git, mirroring `lfs-pointer-interop.test.ts`'s
  reconstruction approach. Scrubbed `GIT_*`, `GIT_CONFIG_NOSYSTEM=1`, isolated `HOME`, signing
  off, `--no-ext-diff` on every scripted `git diff`.
- REGRESSION: `test/integration/lfs-pointer-interop.test.ts` (the ADR-398 no-driver baseline,
  already pins the declared-but-inert `diff=lfs`-no-driver case at line 359) stays green
  unchanged — the live resolver now falls back rather than crashing. Do NOT edit it; run it
  in the gate to confirm green.

### TDD steps

- RED: add `materialise-patch-files.test.ts` both-sides-textconv case (fake runner) + the
  `diff-textconv-interop.test.ts` T1 case. Fail: `applyTextconv` missing; `materialiseOne`
  returns raw bytes.
- GREEN: create `apply-textconv.ts`; thread the lazy provider + runner into
  `materialisePatchFiles`/`materialiseOne`; apply textconv per existing non-gitlink side
  under the guard.
- REFACTOR: extract the per-side "transform if external else raw" helper if `materialiseOne`
  exceeds ~20 lines; keep gitlink/add/delete arm shapes intact.

### Gate

`npx vitest run test/unit/application/primitives/materialise-patch-files.test.ts test/integration/diff-textconv-interop.test.ts test/integration/lfs-pointer-interop.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/primitives/apply-textconv.ts src/application/primitives/materialise-patch-files.ts test/unit/application/primitives/materialise-patch-files.test.ts test/integration/diff-textconv-interop.test.ts`

### Commit

`feat(diff): textconv driver transforms both diff sides`

---

## Slice 6 — `run-filter-driver` primitive + `CLEAN_FILTER_FAILED` error

### Context

- This slice builds the clean/smudge orchestration primitive AND the F3 fatal error code —
  the shared engine consumed by Slices 7 (clean@add), 8 (smudge@checkout), 9 (F1 status).
- NEW primitive: `src/application/primitives/run-filter-driver.ts` (internal). Per F-EXEC
  (§3.4): NO temp file — pure stdin→stdout. `runFilterDriver(ctx, runner, command, input) →
  Promise<Uint8Array>`: `runner.run({ command, cwd: ctx.layout.workDir, env: { GIT_DIR: gitDir },
  stdin: input, signal? })` (Slice 2's extended port), return `result.stdout ?? new Uint8Array(0)`.
  This is strictly simpler than `apply-textconv` (no temp file at all). Mirror
  `run-merge-driver.ts` for the env/cwd/signal shape (line 62-67) but drop the temp-file
  block.
- The `required` failure decision is per-CALLER (clean@add throws fatal on `required`; F4
  stores raw). Keep `run-filter-driver` policy-free: it returns the exit code + stdout so the
  caller decides. Shape: return a discriminated result
  `{ ok: true; bytes: Uint8Array } | { ok: false; exitCode: number }` so the clean caller can
  branch on `required` (F3/F4) and the smudge caller can decide its own handling. (git's
  smudge failure is non-fatal even when required for checkout in the v1 surface; the firm
  pins are F3/F4 on the CLEAN side — keep the result generic.)
- NEW ERROR CODE (F3): `src/domain/commands/error.ts`. NO existing code fits (the merge
  driver returns a `conflict` status, never throws; `operationAborted` carries no exit data).
  Add to the `CommandError` union (after `HOOK_FAILED`, line 106-111, the closest sibling —
  an external-command failure):
  ```ts
  | {
      readonly code: 'CLEAN_FILTER_FAILED';
      readonly path: FilePath;
      readonly filter: string;     // the filter name from filter=<name>
      readonly exitCode: number;
    }
  ```
  Add a factory `cleanFilterFailed(path, filter, exitCode)` near `hookFailed` (line 422).
  Wire the exhaustiveness switch: `extractDetail` in `src/domain/error.ts` (the
  `const _exhaustive: never = data` arm at line 472-475 is the compiler-enforced
  exhaustiveness check — add a `case 'CLEAN_FILTER_FAILED':` arm returning a message like
  ``clean filter '${data.filter}' failed for ${basename(data.path)} (exit ${data.exitCode})``).
  The command surface maps it to git's exit 128 (§3.2a) — the library throws the structured
  error; exit mapping is the consumer's job (ADR-249).
- PUBLIC SURFACE: `CommandError` rides `TsgitError.data` (public). Adding the union member
  changes api.json → regenerate and commit `reports/api.json` IN THIS SLICE. Check whether
  any barrel-surface test enumerates the error-code union; if `test/unit/public-types.test.ts`
  or a domain error test exhaustively lists codes, extend it.
- Test files:
  - `test/unit/application/primitives/run-filter-driver.test.ts` (new). Via a fake
    `CommandRunner` (returns `{ exitCode, stdout }`): feeds `stdin`, reads `result.stdout`;
    exit-0 ⇒ `{ ok: true, bytes }`; non-zero ⇒ `{ ok: false, exitCode }`; abort signal threads
    through (`ctx.signal`). Assert the request shape (command/cwd/env/stdin) and the captured
    bytes — specific data assertions, not truthy.
  - The new error: assert `cleanFilterFailed(...)` builds the exact `{ code, path, filter,
    exitCode }` data and that `extractDetail` renders it (add to the existing domain error
    test file if one enumerates codes; otherwise assert via a `new TsgitError(...).message`).
    Mutation-resistant: assert `.data.code === 'CLEAN_FILTER_FAILED'` AND `.data.exitCode`,
    not `toThrow(TsgitError)`.

### TDD steps

- RED: write `run-filter-driver.test.ts` (stdin/stdout via fake runner) + the
  `cleanFilterFailed` data/message test. Fail: module + error code missing.
- GREEN: create `run-filter-driver.ts`; add the `CLEAN_FILTER_FAILED` union member, the
  factory, and the `extractDetail` arm.
- REFACTOR: none expected; the primitive is ~10 lines.
- Pre-pay surface: `npm run docs:json` then `git add reports/api.json`.

### Gate

`npx vitest run test/unit/application/primitives/run-filter-driver.test.ts test/unit/domain/error.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/primitives/run-filter-driver.ts src/domain/commands/error.ts src/domain/error.ts reports/api.json`

### Commit

`feat(primitives): run-filter-driver and clean-filter-failed error`

---

## Slice 7 — clean@add chokepoint (`stageFromStat`) + F3/F4 + add interop

### Context

- CHOKEPOINT: `src/application/commands/add.ts` `stageFromStat` (line 318-349). The clean
  filter hooks BETWEEN `readContent(ctx, path, fresh)` (line 343) and `writeObject(ctx, {
  type: 'blob', content: bytes })` (line 344). `bytes` is the only place worktree content
  passes before hashing/storing, and BOTH add modes funnel here: literal
  (`addLiteralOnly`→`stageOne`→`stageFromStat`, line 99-122/312-316) and walk
  (`addByPathspec`/`addAll`→`processWalkEntry`→`stageFromStat`, line 142-217/269-294). One
  hook reaches every staging path.
- The provider must be built ONCE per `add` invocation and threaded to `stageFromStat`
  (it is called in a loop). `buildAttributeProvider(ctx)` (`src/application/primitives/internal/read-gitattributes.ts:65`)
  builds a fresh provider each call (its own internal dirCache) — do NOT call it per file.
  Build it lazily/once in `addLiteralOnly`/`addByPathspec`/`addAll` (or pass an optional
  provider param into `stageFromStat`, defaulting to a lazily-built one). Under the §3.3
  guard, resolve only when `ctx.command !== undefined`; otherwise skip the provider build
  entirely (R11, byte- and cost-identical to today).
- Data flow (§3.2a):
  1. Resolve `filter=<name>` via `resolveFilterDriver(ctx, provider, path)` (Slice 4).
  2. `{ kind: 'identity' }` or `clean` undefined ⇒ stage raw `bytes` (today's path).
  3. `{ kind: 'external', clean, required }` with `clean` defined ⇒
     `runFilterDriver(ctx, ctx.command, clean, bytes)` (Slice 6).
     - result `{ ok: true, bytes: cleaned }` ⇒ pass `cleaned` to `writeObject` (the committed
       blob OID is the OID of cleaned content — F1).
     - result `{ ok: false, exitCode }` AND `required === true` ⇒ throw
       `cleanFilterFailed(path, name, exitCode)` (F3 — refuse the stage, nothing staged; the
       throw aborts the whole `add` under the index lock, consistent with `stageFromStat`'s
       existing `operationAborted` throw at line 335).
     - result `{ ok: false }` AND `required === false` ⇒ stage the RAW `bytes` and succeed
       (F4 — git warns, exit 0; the library surfaces no display string, ADR-249).
- SYMLINKS NOT FILTERED: `readContent`'s symlink arm (line 357-368) returns the link target;
  git filters file content, not link targets. Apply clean only when `!fresh.isSymbolicLink`
  (the regular-file path, i.e. when `readContent` took `readFile`, line 369).
- `resolveFilterDriver` needs the filter NAME for the error (the `{ set: name }` value). The
  resolver returns `clean`/`smudge`/`required` but not the name today — either add the name
  to `FilterChoice` (extend Slice 4's type with `readonly name?: string` on the external arm)
  or re-resolve the attribute for the name at the throw site. Prefer adding `name` to the
  external `FilterChoice` arm in this slice (small, internal type).
- Test file: `test/unit/application/commands/add.test.ts` (extend). Use the memory adapter +
  a fake/`MemoryCommandRunner`-style runner returning `{ exitCode, stdout }`. ISOLATED tests:
  - active clean stores the CLEANED blob OID (assert the stored blob content via `cat-file`/
    `readBlob`, byte-checked uppercase).
  - `required`-true clean failure (`exitCode !== 0`) ⇒ throws with `.data.code ===
    'CLEAN_FILTER_FAILED'` AND `.data.exitCode`; assert NOTHING is staged (index unchanged —
    `ls-files` empty). Use try/catch + `.data` assertions (mutation-resistant), not
    `toThrow(Class)`.
  - `required`-absent clean failure ⇒ stages RAW bytes (assert raw blob OID) and the call
    SUCCEEDS (no throw).
  - symlink staging is NOT filtered (the clean runner is never invoked for a symlink path).
  - `ctx.command` absent ⇒ raw stage (R11 fallback, no provider build, no runner call).
- INTEROP (folds in here — the clean@add half of F1/F3/F4): start
  `test/integration/filter-clean-smudge-interop.test.ts` (new, firm v1). Same isolation as
  `merge-driver-interop.test.ts` (peer pair, scrubbed env, signing off). Pin in THIS slice:
  **F3** (`required=true` + failing clean ⇒ tsgit throws the structured `CLEAN_FILTER_FAILED`;
  git exits 128, `ls-files` shows the path NOT staged — reconstruct git's refusal from the
  structured error per ADR-249, do NOT byte-match git's stderr), **F4** (`required` absent ⇒
  exit 0, raw bytes staged — assert the raw blob OID parity vs git via `cat-file`), and the
  clean@add half of **F1** (clean stores the cleaned blob — assert committed-blob OID parity
  vs git + `cat-file` UPPERCASE). The smudge@checkout + F1-no-diff halves land in Slice 8/9
  in the SAME file. If `beforeAll` grows heavy (it spawns git for add per case), use
  `SETUP_TIMEOUT = 120_000` (the #194 gitlink-interop precedent).

### TDD steps

- RED: add `add.test.ts` clean cases (cleaned OID, F3 throw, F4 raw stage, symlink unfiltered,
  fallback) + `filter-clean-smudge-interop.test.ts` F3/F4/clean-F1. Fail: `stageFromStat`
  stores raw bytes, never resolves a filter.
- GREEN: build the provider once per add invocation (guarded by `ctx.command`); thread it to
  `stageFromStat`; insert the clean branch between `readContent` and `writeObject`; add the
  `name` field to `FilterChoice`'s external arm.
- REFACTOR: extract a `cleanContent(ctx, provider, path, bytes, isSymlink)` helper if
  `stageFromStat` exceeds ~20 lines (it is currently ~30 incl. comments — keep it lean).

### Gate

`npx vitest run test/unit/application/commands/add.test.ts test/integration/filter-clean-smudge-interop.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/commands/add.ts src/application/primitives/resolve-filter-driver.ts test/unit/application/commands/add.test.ts test/integration/filter-clean-smudge-interop.test.ts`

### Commit

`feat(add): clean filter on stage with required failure semantics`

---

## Slice 8 — smudge@checkout chokepoint (`writeBlobToWorkingTree`) + F2 identity

### Context

- CHOKEPOINT: `src/application/primitives/apply-changeset.ts` `writeBlobToWorkingTree`
  (line 159-176) — the one function every checkout add/update entry routes through (via
  `applyEntry`, line 178-192; `applyChangeset`, line 194-230; reached by `checkout` →
  `materializeTree` → `applyChangeset`). Today: gitlink arm (line 165-168) writes empty;
  symlink arm (line 169-173) `readBlob` + `writeWorkingTreeEntry`; regular arm (line 174-175)
  `streamBlob` + `writeWorkingTreeEntryStream`.
- Add EXACTLY ONE branch to the regular-file arm (§3.2b). Gitlink + symlink arms UNTOUCHED
  (git smudges regular file content only).
  - Resolve `filter=<name>` per path via `resolveFilterDriver(ctx, provider, path)` under the
    §3.3 guard (`ctx.command !== undefined`). The provider must be built once per
    `applyChangeset` invocation (loop at line 211) and threaded down — `applyChangeset`
    →`applyEntry`→`writeBlobToWorkingTree` thread an optional provider, lazily built (mirror
    `build-content-merger.ts:45-47`). No runner / no filter ⇒ identity, no provider build (R11).
  - **No smudge (clean-only or identity) ⇒ F2 identity:** the regular-file arm is UNCHANGED —
    `streamBlob(ctx, id)` → `writeWorkingTreeEntryStream(ctx, path, stream, mode)` (line
    174-175), preserving the streaming write path (commit c661f52d). This IS git's identity
    smudge (F2: clean-only checkout writes blob bytes verbatim).
  - **Active smudge ⇒ buffered capture-then-write:** `{ kind: 'external', smudge }` with
    `smudge` defined → materialise the blob bytes via `readBlob(ctx, id)` (`src/application/primitives/read-blob.ts:6`,
    returns `Blob{content}`), `runFilterDriver(ctx, ctx.command, smudge, blob.content)`
    (Slice 6), then write the smudged bytes via the NON-streaming
    `writeWorkingTreeEntry(ctx, path, smudgedBytes, mode)`
    (`src/application/primitives/internal/write-working-tree-file.ts:69`, the same primitive
    the symlink arm uses, line 171). Smudge content does NOT stream — streaming is retained
    only for the identity path. (run-filter-driver result `{ ok: false }` on smudge: write the
    raw blob bytes — smudge failure is not a firm-pinned fatal in v1; do not throw.)
- Test file: `test/unit/application/primitives/apply-changeset.test.ts` (extend). Memory
  adapter + fake runner returning `{ exitCode: 0, stdout: <lowercased bytes> }`. ISOLATED:
  - active smudge ⇒ worktree file is the SMUDGED bytes (assert via `ctx.fs.read`), written
    through the buffered branch.
  - no-smudge (clean-only / identity) ⇒ the `streamBlob` streaming write is taken verbatim
    (F2 identity — assert blob bytes written unchanged; the runner is NOT invoked).
  - gitlink arm unchanged (empty file); symlink arm unchanged (target written).
  - `ctx.command` absent ⇒ identity, runner never invoked (R11).

### TDD steps

- RED: add `apply-changeset.test.ts` smudge cases (active smudge bytes, F2 identity stream,
  gitlink/symlink untouched, fallback). Fail: regular arm always streams the raw blob.
- GREEN: thread the lazy provider through `applyChangeset`/`applyEntry`/`writeBlobToWorkingTree`;
  add the single active-smudge branch to the regular-file arm.
- REFACTOR: keep the gitlink/symlink early-returns; the new branch is one `if` before the
  `streamBlob` fallback.

### Gate

`npx vitest run test/unit/application/primitives/apply-changeset.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/primitives/apply-changeset.ts test/unit/application/primitives/apply-changeset.test.ts`

### Commit

`feat(checkout): smudge filter writes smudged working-tree bytes`

---

## Slice 9 — F1 worktree-side clean re-application (`compareWorkingTreeDelta`) + interop close

### Context

- THE LEAST-LOCATED CHOKEPOINT (§3.2c). git's working-tree-vs-HEAD/index status applies
  CLEAN to the worktree side before comparing it to the cleaned blob, so a smudged-then-
  unmodified file shows NO change. In tsgit, `diff.ts` is tree-to-tree ONLY (verified:
  `DiffOptions.from`/`to` are treeish, `src/application/commands/diff.ts`) — it has no
  worktree path. The F1 "no diff after checkout" is observed through **status**.
- EXACT SURFACE: `src/application/primitives/compare-working-tree-entry.ts`
  `compareWorkingTreeDelta` (line 56-87) — the single source of truth for "is this index
  entry dirty in the working tree?". It reads worktree bytes at line 74-76 (`ctx.fs.read(absPath)`
  for a regular file; symlink target for a link) and hashes via `serializeAndHash` (line 77),
  comparing the hash to `entry.id` (line 80). Consumed by `status` (`src/application/commands/status.ts`,
  via `compareWorkingTreeDelta` at line 163) and by `rm`/`stash`/clean-work-tree/apply-merge
  (via the `compareWorkingTreeEntry` enum projection, line 94-97).
- THE FIX: route the regular-file worktree bytes through CLEAN before hashing, when a
  `filter=<name>` resolves and `ctx.command` is present (§3.3 guard). After
  `content = await ctx.fs.read(absPath)` (line 75, the regular-file branch), resolve
  `resolveFilterDriver(ctx, provider, entry.path)`; for an external clean, replace `content`
  with `runFilterDriver(ctx, ctx.command, clean, content).bytes` (on `{ ok: false }`, fall
  back to raw content — match `add`'s F4 graceful path). The symlink branch (line 74) is NOT
  cleaned (git filters file content, not link targets — same boundary as Slice 7's add).
  Hash the cleaned bytes (line 77) so the comparison against the cleaned blob OID matches and
  the path reports `unchanged` (F1: status clean after smudge checkout).
- Provider once per status scan: `status`'s `scanWorkingTree` (line 155-168) calls
  `compareWorkingTreeDelta` per entry in a `Promise.all`. Build the provider once and thread
  it (optional param, lazily built when `ctx.command` defined). NOTE `compareWorkingTreeDelta`
  has OTHER callers (`rm`/`stash` via `compareWorkingTreeEntry`) — add the provider as an
  OPTIONAL trailing param so existing callers stay byte-identical; when omitted (and/or
  `ctx.command` absent), the raw-bytes path is taken (R11). Confirm no caller breaks (check
  `find_referencing_symbols` of `compareWorkingTreeDelta`/`compareWorkingTreeEntry`).
- Without this fix a checked-out (smudged) file would diff against its own cleaned blob and
  show a spurious change on every status — the regression this slice closes.
- Unit test file: `test/unit/application/primitives/compare-working-tree-entry.test.ts`
  (extend). Memory adapter + fake clean runner (`{ exitCode: 0, stdout: <uppercased> }`).
  ISOLATED:
  - a smudged worktree file (lowercase) under an active `filter=<name>` whose CLEANED
    (uppercase) hash equals the cleaned blob OID ⇒ `status: 'unchanged'` (F1 worktree-side
    re-application).
  - a genuinely-modified worktree file (cleaned hash differs) ⇒ `status: 'modified'`.
  - `ctx.command` absent / no filter ⇒ raw-bytes path (existing behaviour unchanged).
  - symlink entry ⇒ target hashed raw, NOT cleaned.
- INTEROP (closes `filter-clean-smudge-interop.test.ts` started in Slice 7): add the
  smudge@checkout + F1-no-diff + F2 + F-EXEC cases to the SAME file:
  - **F1** smudge half: after `checkout` of a smudged file, `git status` (peer) is clean and
    tsgit `repo.status()` reports `clean: true` / the path absent from `changes` — the
    worktree-side clean re-application. Assert smudge@checkout writes lowercase worktree bytes
    (parity vs git's worktree file).
  - **F2** (clean-only ⇒ identity smudge — worktree after checkout = verbatim blob bytes).
  - **F-EXEC** (the stdin→stdout contract via a logging driver — driver sees `argc=0`, content
    on stdin, result on stdout).
  - Use `SETUP_TIMEOUT = 120_000` since this `beforeAll` now spawns git for add + checkout +
    status/diff per case (the interop load→validate flake note).

### TDD steps

- RED: add `compare-working-tree-entry.test.ts` F1 cases + the `filter-clean-smudge-interop.test.ts`
  F1-no-diff/F2/F-EXEC cases. Fail: `compareWorkingTreeDelta` hashes RAW worktree bytes, so a
  smudged file reads `modified`.
- GREEN: thread the optional provider; clean the regular-file worktree bytes before hashing
  (guarded by `ctx.command` + external filter); thread the provider through `status`'s
  `scanWorkingTree`.
- REFACTOR: extract a `cleanWorktreeBytes(ctx, provider, path, content)` helper shared in
  spirit with Slice 7's add-side clean (do not over-couple — a small local helper is fine).

### Gate

`npx vitest run test/unit/application/primitives/compare-working-tree-entry.test.ts test/integration/filter-clean-smudge-interop.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/primitives/compare-working-tree-entry.ts src/application/commands/status.ts test/unit/application/primitives/compare-working-tree-entry.test.ts test/integration/filter-clean-smudge-interop.test.ts`

### Commit

`feat(status): clean working-tree bytes before dirty comparison`

---

## Slice 10 — cross-adapter parity (memory ≡ node-with-no-driver, ADR-408)

### Context

- ADR-408 / §3.7a: with no `CommandRunner` wired (memory/browser, or node with none), all
  three surfaces fall back to the no-driver baseline — textconv yields raw bytes, clean yields
  identity (raw stage), smudge yields identity (verbatim checkout). Mechanically this IS the
  §3.3 guard (`ctx.command === undefined` fails condition (a)). No throw.
- This slice is the parity assertion that ties the feature off: a memory repo declaring
  `filter=lfs diff=lfs` with NO runner diffs raw, stages raw, checks out verbatim — IDENTICAL
  to node with `ctx.command` undefined. Parity is CROSS-ADAPTER ONLY; it does NOT prove
  faithfulness (the interop files in Slices 5/7/9 do that against real git).
- The `MemoryCommandRunner` (`src/adapters/memory/memory-command-runner.ts`) exists but is a
  test double; ADR-408 keeps memory inert by leaving `ctx.command` undefined (the default —
  `createMemoryContext` does not wire a runner unless asked). Confirm `createMemoryContext`'s
  default leaves `ctx.command` undefined (check `src/adapters/memory/memory-adapter.ts`
  `command?` option, line ~25 — default undefined).
- This is the one slice that is legitimately near test-only, BUT it carries no `src/` delta
  ONLY if every guard already short-circuits correctly. If parity reveals a missing
  `ctx.command` guard on any surface, the fix lands HERE (it would be a real code delta). If
  all guards are already correct (Slices 5/7/9 each added their guard + a fallback unit test),
  this slice asserts the END-TO-END parity that no single prior slice covered — a memory repo
  with the full `filter=lfs diff=lfs` `.gitattributes` exercised across add + checkout + diff
  + status in ONE scenario. That cross-surface, cross-adapter scenario is not redundant with
  the per-chokepoint fallback unit tests; it is the integration proof of the inert baseline.
- Test file: prefer extending an existing cross-adapter parity test if one covers
  memory-vs-node (search `test/` for `parity` / `cross-adapter`); otherwise add
  `test/integration/filter-driver-parity.test.ts` (memory adapter, no real git needed — pure
  cross-adapter). Scenario: a memory repo, commit `.gitattributes` `*.bin filter=lfs diff=lfs`
  + a tracked file, then add a modified version, checkout, status, diff — assert add stores
  raw bytes, checkout writes verbatim, status reports based on raw bytes, diff is the raw
  (no-driver) diff. Assert identical structured results to a node context with `command`
  undefined (or simply assert the inert raw-bytes outcomes hold — the ADR-408 contract).
- If, after Slices 5/7/9, parity passes with zero `src/` change, this slice is a
  test-bearing slice (the parity scenario IS its code — not a no-op): it adds the integration
  test that proves inertness end-to-end. It still earns its lifecycle.

### TDD steps

- RED: add the parity scenario (memory, `filter=lfs diff=lfs`, no runner) asserting raw
  stage / verbatim checkout / raw diff / raw-based status. If a guard is missing, it fails on
  a spurious driver attempt or a crash.
- GREEN: if a guard is missing on any surface, add it (the §3.3 `ctx.command !== undefined`
  short-circuit); otherwise the scenario passes on the landed guards.
- REFACTOR: none.

### Gate

`npx vitest run test/integration/filter-driver-parity.test.ts && npm run check:types && ./node_modules/.bin/biome check test/integration/filter-driver-parity.test.ts`

### Commit

`test(filter): cross-adapter inert-fallback parity for all three surfaces`
