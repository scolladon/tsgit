# Plan — EOL conversion (`core.autocrlf` / `core.eol` / `core.safecrlf`, `text` / `eol` / `crlf` / `ident`, renormalization)

> Source: design doc `docs/design/eol-conversion.md` (commit 9083faf0) · ADRs 950, 951, 952, 953, 954, 955, 956, 957
> The plan is the implementation script AND the knowledge handoff. Part agents start
> with zero context: whatever a part block omits is paid later as agent rediscovery.
> `plan-lint.sh` enforces the schema below — the plan phase cannot close without it.

## Sizing rules

- Every part costs a full agent lifecycle (spin-up, zero-context rebuild, gate) — it
  must earn it. No standalone test-only parts for FEATURE code: coverage/interop/property
  tests fold into the implementation part whose code they exercise. EXCEPTION:
  test-infra-only and docs-only parts (tooling config, test helpers, fixtures,
  harness/ADV/property suites, docs/prose) with no `src/` delta ARE standalone — they
  have no implementation part to fold into.
- A part that would be a pure test pass over already-landed code merges into its
  neighbour.
- A part should land in ~100 tool calls. More than ~5 RED→GREEN cycles, or more than 6
  files in its `### Context` block, is two parts. What counts is a path in backticks:
  backtick the files the part CREATES or EDITS, and write read-only reference paths in
  plain text.

## Rules every part follows

- **Hard inputs.** The design (§D1 pinned matrices against git 2.55.0, §D3 shapes and
  signatures, §D3.5 route table) and ADRs 950–957 are binding. A part reproduces the bytes
  of the §D1 subsection it cites — read the matrix there; it is not re-transcribed here.
  Where this plan and the design disagree, the design wins; stop and escalate
  `{ unit, reason, ≤3 options }`.
- **PIN step.** Where a behaviour is not pinned by the design, the part's FIRST TDD step
  runs the probe with git 2.55.0 in a `mktemp -d` throwaway (never the worktree), using the
  design's pinning harness (§Context "Pinning harness": `env -i`, `GIT_CONFIG_NOSYSTEM=1`,
  `GIT_CEILING_DIRECTORIES`, `-c commit.gpgsign=false`), and records the observed result as
  the expectation of the part's interop row (or unit row where the part has no interop
  file) before any GREEN.
- **Tests.** `describe('Given …')` › `describe('When …')` › `it('Then …')` (or the
  2-level shortcut when one expectation lives under the When), AAA comments, the system
  under test is `sut`. Error assertions read `.data` in try/catch, field by field. Every
  new branch gets its own row in-part (100 % line/branch/function/statement). Parsers,
  converters and scanners get a `*.properties.test.ts` sibling (numRuns 200 for cheap round
  trips, 100 for invariants, 50 for filter-heavy). No ignore/suppression directives, no
  phase/ADR/backlog references in `src/` or `test/`.
- **Opt-in wiring** observable only through a real repo gets a unit-level assertion on the
  callee's captured argument (spy) — the mutation gate runs unit suites only.
- **Interop.** Spawn git only through test/integration/interop-helpers.ts (`runGit`,
  `runGitBytes`, `git`, `tryRunGitWithExit`, `GIT_AVAILABLE`), which scrub `GIT_*` and set
  `GIT_CEILING_DIRECTORIES`. Configuration goes to the repository config (ADR-637), not
  `-c`. Suites run with git 2.55.0 first on PATH: `PATH="<git-2.55.0>/bin:$PATH"`.
  Interop rows whose expectation depends on the native line ending (`core.eol=native`, or
  `core.eol` unset under `text`) take their expectation from `process.platform`, so the
  win32 job pins Git for Windows' native CRLF.
- **Pre-existing failures.** A failure believed to predate the part is verified against `main` (e.g. `git -C <main-repo-dir> …` or a fresh clone in a throwaway), never against an earlier commit of this branch, and never by switching this worktree's branch.
- **Navigation.** Part agents have no MCP tools: locate symbols with `grep -n` and read
  ranges with `sed -n`; never read a whole large file (add.ts 756 lines, merge.ts
  ≈2000, config-read.ts 2807).
- **Public surface.** Each part states public vs internal for every new export. A public
  change regenerates `reports/api.json` with `npm run docs:json` in the same part and commits
  the churn (prepush `check:doc-typedoc` gate). A part not expecting api.json churn still
  runs `npm run docs:json`; if the file changes, the churn is committed with the part.
- **Bundle size.** No part edits `.size-limit.json` or the tarball cap in
  tooling/verify-tarball.sh. Parts 1, 12 and 24 run the measurement
  `rm -rf dist .wireit && WIREIT_CACHE=none npm run build && npx size-limit --json > <scratch>/size.json`
  and list every row with `"passed": false` (name, measured bytes, limit) in the
  hand-back report; the orchestrator lands any cap raise with the user's approval (ADR-904: the
  crossing commit states the measured size).
- **Gates.** Every `### Gate` runs from the worktree root. wireit caches `check:types` and
  `check:spelling` ("Ran 0 scripts and skipped 1" reads like a pass): the bare oracles are
  `npx tsc --noEmit -p tsconfig.json` and `npx cspell --no-progress <files>` (never pass
  cspell.json itself). The phase-boundary `npm run validate` is the orchestrator's.
  Commands run in the foreground; never end a turn waiting on a background notification.

## Public-surface decisions

| Symbol | Decision | Part | Surface gates pre-paid in that part |
|---|---|---|---|
| `src/domain/eol` modules (stats, CRLF action, converters, transforms, ident) | internal — no barrel, not re-exported from src/domain/index.ts; consumers import the module files | 1–3 | none |
| `ParsedConfig.core.{autoCrlf,eol,safeCrlf}` | public (ParsedConfig is in reports/api.json) | 4 | api.json |
| `Context.nativeEol?: 'lf' \| 'crlf'` (+ `CreateContextParts`, `RuntimeFallback`) | public (DC-1) | 5 | api.json |
| `nativeLineEndingFor(platform)` in the node adapter | internal (`@internal`, not in src/adapters/node/index.ts) | 6 | none |
| `AttributeDirection`, `IndexBlobLookup`, `buildAttributeProvider(ctx, direction?)` | internal | 7 | none |
| `EOL_ROUND_TRIP_UNSAFE { path, loss, crlf, loneLf }` | public code (TsgitErrorData union); factory `eolRoundTripUnsafe` internal (like `configBadBooleanValue`) | 8 | `extractDetail` switch, `assertExhaustiveSwitch`, error.test.ts message table, docs/use/errors.md row, api.json |
| `resolve-conversion.ts`, `convert-blob.ts`, `write-converted-entry.ts`, `renormalize-attributes.ts`, `applyChangesetWithAttributes`, `ContentMergeSettings.renormalize`, `buildBlobUnchanged` | internal | 9, 10, 17, 18, 22 | none (ContentMergeSettings is absent from api.json today) |
| `AddResult.eolNotices`, types `EolNotice`, `RoundTripLoss` | public (type-exported from src/application/commands/index.ts beside `AddResult`) | 12 | barrel line, api.json |
| `AddOptions.renormalize` | public | 14 | api.json |
| `StashPushResult` saved variant `eolNotices` | public | 16 | api.json |
| `mergeTrees(…, blobUnchanged?)`, type `BlobUnchanged` | public (mergeTrees and ContentMerger are exported from src/domain/merge/index.ts) | 21 | merge barrel line, api.json |
| `OrtStrategyOptions.renormalize` | not in api.json today (verified: 0 hits) — run docs:json, commit churn if any | 23 | none expected |

No new Tier-1 command or Repository binding: `check:doc-coverage`, the facade key list,
`audit-browser-surface` and the README command count are untouched. Command pages
(docs/use/commands/…) are the documentation phase's (design §D3.11); only
docs/use/errors.md lands in Part 8 because the new code ships there.

## Files shared across parts (intentional)

Parts run sequentially on one working tree; a file appearing in several parts is edited
by each in turn, never concurrently.

- `reports/api.json` — regenerated by every part that changes a public type (4, 5, 8, 12, 14, 16, 21); generated output, not a shared unit of work.
- test/integration/eol-conversion-interop.test.ts — grown route by route (Parts 11–24) so each route lands with its own cross-tool proof (orchestrator guidance).
- add.ts / add.test.ts (Parts 12, 13, 14) — conversion + notices, then the ADR-954 ordering, then the renormalize option: three distinct behaviours, each ≥ 4 RED cycles; merged they exceed the ceiling.
- archive.ts (Parts 7, 20) — Part 7 only re-points the provider factory it deletes; Part 20 converts.
- stash.ts (Parts 16, 19) — push-side to-git conversion vs the untracked restore's to-worktree write.
- merge.ts (Parts 19, 23) — working-tree writes vs `-X` / config wiring.
- apply-merge-to-worktree.ts and its suite (Parts 19, 24) — working-tree writes vs `merge.renormalize` wiring.

## Decision candidates

Load-bearing choices the design and ADRs leave open. The plan is written against the
recommendation; the "if not" column states the re-plan delta.

| # | Choice | Alternatives (≤3) | Recommendation | Why | If not recommended |
|---|---|---|---|---|---|
| DC-1 | Port slot for the native line ending (ADR-957) | (a) optional `Context.nativeEol?: 'lf' \| 'crlf'`, absent ⇒ `lf`; the Node paths supply it (`createNodeContext` in node-adapter.ts and the node entry's `RuntimeFallback` in index.node.ts); `createMemoryContext` (memory-adapter.ts), `createBrowserContext` (browser-adapter.ts) and the memory/browser entry fallbacks supply `lf` by omission — the `windowsPathSyntax` precedent; (b) required `Context.nativeEol`, supplied by all three adapter factories and all three entry fallbacks (`runtime` precedent); (c) `nativeEol` on `RuntimeFallback` only, read through a helper | (a) | Same shape and absent-semantics as `windowsPathSyntax` (the existing platform fact on Context); test-built and caller-built contexts stay valid; one part. (b) matches the ADR wording literally but touches eight construction sites plus their tests and needs two extra parts. | (b): Part 5 grows memory-adapter.ts, browser-adapter.ts, index.browser.ts, index.default.ts and their tests — split into 5a (port + repository + entries) and 5b (adapter factories). |
| DC-2 | `maybeBuildAttributeProvider` after the runner gate goes (design §D3.4) | (a) redefine it in place (Part 7): always builds the check-in (`worktree-first`) provider over the index; keep the name so its eight call sites need no edit; the refactoring phase renames it; (b) rename now to `buildCheckInAttributeProvider` across all eight call sites (one mechanical part over the 6-file ceiling, or two parts); (c) keep the gate and add a second builder for conversion | (a) | Every compare-family caller (status, rm, clean-work-tree, would-overwrite, racy smudge, stash dirty probe) becomes conversion-aware with zero edits; the rename is behaviour-preserving, exactly the refactoring phase's job. (c) leaves runner-less contexts (memory, browser) ignoring `text`/`eol` attributes — a git divergence. | (b): insert a rename part after Part 7 touching add.ts, apply-changeset.ts, find-would-overwrite.ts, smudge-racily-clean.ts, status.ts, stash.ts, rm.ts, clean-work-tree.ts (split 4 + 4). |
| DC-3 | How `BlobUnchanged` reaches the public `mergeTrees` (ADR-956) | (a) trailing optional positional parameter after `variant`; (b) replace the `labels, renames, variant` tail with an options object (every caller and test updated); (c) an optional property on the `ContentMerger` function value | (a) | Diff-minded: no existing caller changes; the parameter is optional so the public signature stays source-compatible. (b) is the cleaner long-term shape but rewrites three src callers and the three-way-tree suites. (c) hides a tree-level rule inside the per-path merger. | (b): Part 21 grows merge.ts and apply-merge-to-worktree.ts call-site edits (still ≤6 files if api.json and the barrel stay). |
| DC-4 | Attribute direction for the public `applyChangeset` primitive (ADR-951) | (a) keep `ApplyChangesetOpts` unchanged; add internal `applyChangesetWithAttributes(ctx, opts, direction)`; public `applyChangeset` keeps the check-in default; `materializeTree` and sparse apply call the internal one; (b) public optional `ApplyChangesetOpts.attributes?: AttributeDirection` (makes `AttributeDirection` public, barrel + api.json); (c) public `applyChangeset` derives index-first from the changeset's own entries | (a) | No public-surface growth for an internal routing decision; the public primitive keeps its current attribute source. (c) mis-resolves path-restore and sparse changesets that do not carry `.gitattributes`. | (b): Part 18 adds src/application/primitives/index.ts and api.json and drops the sparse unit suite to stay at 6 files. |
| DC-5 | `src/domain/eol` barrel (design §D3.12 P1 lists `index.ts`) | (a) no barrel — internal module, consumers import module files; (b) `src/domain/eol/index.ts` grown by Parts 1–3 | (a) | No consumer needs one (YAGNI); each barrel edit costs a context-file slot in already-full parts. | (b): Parts 1–3 each add the barrel file (Part 2 then needs its transform test folded into the conversion suite). |

## Part 1 — Domain: text statistics and the CRLF action

### Context
Creates (internal, no barrel — DC-5):
- `src/domain/eol/text-stats.ts` — `interface TextStats { nul, loneCr, loneLf, crlf, printable, nonPrintable }` (all `readonly number`), `gatherTextStats(bytes: Uint8Array): TextStats`, `isBinaryText(stats: TextStats): boolean`. Transcribes git `convert.c` `gather_stats` / `convert_is_binary` (design §D1.4 is the proof):
  - scan every byte; `\r` followed by `\n` → `crlf++` and skip the LF; `\r` otherwise → `loneCr++`; `\n` → `loneLf++`; `0x7F` → `nonPrintable++`; bytes `< 0x20`: BS `0x08`, HT `0x09`, ESC `0x1B`, FF `0x0C` → `printable++`, NUL → `nul++` AND `nonPrintable++`, other controls → `nonPrintable++`; bytes `≥ 0x20` (incl. `≥ 0x80`) → `printable++`; after the scan, a last byte `0x1A` decrements `nonPrintable` once.
  - `isBinaryText`: `loneCr > 0 || nul > 0 || (printable >> 7) < nonPrintable`.
- `src/domain/eol/crlf-action.ts` — `AutoCrlf = boolean | 'input'`, `CoreEol = 'lf' | 'crlf' | 'native'`, `LineEnding = 'lf' | 'crlf'`, `CrlfAction = 'binary' | 'text-input' | 'text-crlf' | 'auto' | 'auto-input' | 'auto-crlf'`, `interface EolSettings { autoCrlf: AutoCrlf; coreEol?: CoreEol; safeCrlf: boolean | 'warn'; nativeEol: LineEnding }`, `interface ConversionAttributes { text, crlf, eol: AttributeValue }`, `resolveCrlfAction(attrs, settings): CrlfAction`, `outputLineEnding(action, settings): LineEnding | undefined`. Rules: the five-step table and the `outputLineEnding` paragraph right after it in design §D3.1 (git `convert_attrs`, `text_eol_is_crlf`, `output_eol`). Note step 3 applies whenever the action is not `binary` — including still-undefined (an `eol` attribute alone implies text).
- `test/unit/domain/eol/text-stats.test.ts`, `test/unit/domain/eol/text-stats.properties.test.ts`, `test/unit/domain/eol/crlf-action.test.ts`.

Read-only references: src/domain/attributes/attribute-value.ts (`AttributeValue = true | false | 'unspecified' | { set: string }`); property-test shape and fast-check import style: test/unit/domain/attributes/resolve-attribute.properties.test.ts; layout rules: .claude/workflow/property-testing.md. No import outside `src/domain`.

Pins reproduced: §D1.4 (six heuristic fixtures verbatim), §D1.1 / §D1.2 / §D1.3 reduced to actions (every column of the add and checkout matrices maps to one action per `autocrlf × eol` row), `native` under both `nativeEol` values.

### TDD steps
1. RED `text-stats.test.ts` — `Given the §D1.4 fixture <name>` › `When gathered` › `Then isBinaryText is <bool>` for `nul-far` (binary), `r127` (binary), `r128` (text), `r128eof` (text: trailing `0x1A` discounted), `r128x2eof` (binary), `ctl` (text); plus exact `TextStats` for `a\r\nb\n`, `a\rb\r\n`, `\x7f`, `\x80`, empty. Fails: module `src/domain/eol/text-stats.ts` does not exist.
2. GREEN `gatherTextStats` / `isBinaryText` as transcribed above (one pass, early `continue`s, no nesting > 2).
3. GUARD `text-stats.properties.test.ts` — partition: `printable + nonPrintable + 2·crlf + loneCr + loneLf` equals `length` (minus one when the last byte is `0x1A`; NUL is counted inside `nonPrintable`), 100 runs over `fc.uint8Array`; passes because step 2 counts every byte exactly once.
4. RED `crlf-action.test.ts` — table rows: `text` true/false/`{set:'input'}`/`{set:'auto'}`/`{set:'foo'}`/`unspecified`; legacy `crlf` consulted only when `text` resolves undefined (`text=foo crlf` → converts, `text=foo` → binary under autocrlf false); `eol=lf`/`eol=crlf` turning `auto` → `auto-input`/`auto-crlf` and anything else non-binary → `text-input`/`text-crlf`; `-text eol=crlf` → `binary`; `binary text` (resolved `text` true) → text; step 4 under `autoCrlf` true / `'input'` / false × `coreEol` `lf`/`crlf`/`native`/undefined × `nativeEol` `lf`/`crlf`; step 5 per `autoCrlf`; `outputLineEnding` per action incl. `auto` following step 4. Fails: module does not exist.
5. GREEN `resolveCrlfAction` / `outputLineEnding` (small helpers: `actionFromValue`, `applyEolAttribute`, `textEolIsCrlf`).
6. REFACTOR — named constants for the byte values (`CR`, `LF`, `NUL`, `DEL`, `SUB`), no magic numbers; functions < 20 lines.
7. MEASURE (first src-adding part) — after the gate is green, run the bundle measurement from "Rules every part follows"; list every `passed: false` row in the hand-back report (expected: none — the modules are not yet reachable from an entry).

### Gate
```sh
npx vitest run test/unit/domain/eol/text-stats.test.ts test/unit/domain/eol/text-stats.properties.test.ts test/unit/domain/eol/crlf-action.test.ts \
  && npx tsc --noEmit -p tsconfig.json \
  && ./node_modules/.bin/biome check src/domain/eol test/unit/domain/eol \
  && npx cspell --no-progress src/domain/eol/*.ts test/unit/domain/eol/*.ts
```
Traps: wireit caches `check:types` / `check:spelling` — the bare `tsc` / `cspell` above are the oracles; never pass cspell.json to cspell.

### Commit
`feat(eol): gather text statistics and resolve the CRLF action`

## Part 2 — Domain: CRLF converters and the LF→CRLF stream transform

### Context
Creates (internal, no barrel):
- `src/domain/eol/chunk-transform.ts` — `interface ChunkTransform { readonly push: (chunk: Uint8Array) => ReadonlyArray<Uint8Array>; readonly flush: () => ReadonlyArray<Uint8Array> }` (type only; shared by Part 3's ident transform and Part 10's composition).
- `src/domain/eol/crlf-conversion.ts` — `RoundTripLoss = 'crlf-to-lf' | 'lf-to-crlf'`, `CrlfToGitInput { bytes, action, settings, renormalize, indexHasCrlf: () => Promise<boolean> }`, `LineEndingLoss { loss, crlf, loneLf }`, `EolRoundTrip extends LineEndingLoss { path: FilePath }`, `type EolNotice = EolRoundTrip`, `CrlfToGitResult { bytes; roundTrip?: LineEndingLoss }`, `crlfToGit(input): Promise<CrlfToGitResult>`, `crlfToWorkingTree(bytes, action, settings): Uint8Array`. Signatures: design §D3.1; rules: the paragraph after the §D3.1 table. Transcription of git `crlf_to_git`:
  1. `binary` action or empty bytes → `{ bytes }` (same reference), no loss.
  2. `stats = gatherTextStats(bytes)`; `convert = stats.crlf > 0`.
  3. `auto*` actions: `isBinaryText(stats)` → return unchanged BEFORE any loss check; else, unless `renormalize`, `convert && await indexHasCrlf()` → `convert = false` (the thunk is never called when `crlf === 0` or `renormalize`).
  4. Loss simulation (always computed; the caller decides whether to arm it): copy stats; if `convert` → `loneLf += crlf; crlf = 0` (simulated add); if `willConvertLfToCrlf(copy, action, settings)` → `crlf += loneLf; loneLf = 0` (simulated checkout); `stats.crlf > 0 && copy.crlf === 0` → `{ loss: 'crlf-to-lf' }`, else `stats.loneLf > 0 && copy.loneLf === 0` → `{ loss: 'lf-to-crlf' }`; `crlf` / `loneLf` fields are the ORIGINAL `stats.crlf` / `stats.loneLf` (ADR-952).
  5. `convert` false → unchanged. Otherwise a freshly allocated exact-size array: `auto*` drops every CR; other actions drop a CR only when the next byte is LF.
  - `willConvertLfToCrlf(stats, action, settings)` (git `will_convert_lf_to_crlf`): `outputLineEnding(action, settings) === 'crlf'` and `loneLf > 0`; for `auto*` additionally `loneCr === 0 && crlf === 0 && !isBinaryText(stats)`.
  - `crlfToWorkingTree`: empty or output ≠ `crlf` or `!willConvertLfToCrlf(gatherTextStats(bytes), …)` → same reference; else insert CR before every LF not preceded by CR (fresh array, exact size).
- `src/domain/eol/lf-to-crlf-transform.ts` — `createLfToCrlfTransform(): ChunkTransform`: inserts CR before every LF whose preceding byte (across chunk boundaries) is not CR; holds only the "previous byte was CR" bit, never a byte. Used only for streamed classes (`text-crlf`, never `auto*`), where git streams without a stats pass.
- `test/unit/domain/eol/crlf-conversion.test.ts`, `test/unit/domain/eol/crlf-conversion.properties.test.ts`, `test/unit/domain/eol/lf-to-crlf-transform.test.ts`.

Read-only: Part 1 modules; src/domain/objects/object-id.ts (`FilePath`).

Pins reproduced: §D1.1 cells (`=` / `L`), §D1.2 cells (`=` / `C`), §D1.3 both blocks (trailing lone CR untouched, `crlf-no-eol`, `nul-lf` under `text`), §D1.5 (index-CRLF rule only for `auto*`, bypassed by `renormalize`), §D1.6 loss directions. Field-level expectations from design §Test strategy: `MIXED` under `auto-crlf` → `{ loss: 'lf-to-crlf', crlf: 1, loneLf: 1 }`; `LF` under `auto-crlf` → `{ loss: 'lf-to-crlf', crlf: 0, loneLf: 2 }`; `CRLF` under `auto-input` → `{ loss: 'crlf-to-lf', crlf: 2, loneLf: 0 }`.

### TDD steps
1. RED `crlf-conversion.test.ts` › `Given the §D1.1 fixtures` › `When crlfToGit runs under <action>` › `Then the blob bytes are <cell>` for every action × LF/CRLF/MIXED/NUL/LONE-CR, plus §D1.3 add edges. Fails: module does not exist.
2. GREEN `crlfToGit` steps 1, 2, 3 (binary early return), 5 — no loss yet.
3. RED `Then roundTrip is …` rows (the three field-level expectations above; empty never checked; binary `auto*` input never reports; `text-input` CRLF reports `crlf-to-lf`); and the index rule: `indexHasCrlf` resolving true keeps CRLF for `auto*` and is ignored for `text-*`; `renormalize: true` never calls it; `crlf === 0` never calls it (`vi.fn` thunk, `toHaveBeenCalledTimes(0)`). Fails: `roundTrip` is undefined / thunk not consulted.
4. GREEN step 4 + the index rule.
5. RED `crlfToWorkingTree` rows from §D1.2 and §D1.3 checkout edges (`MIXED` converts under `text-crlf`, not under `auto-crlf`; `nul-lf` converts under `text-crlf` only); identity returns the same reference (`toBe`). Fails: function not exported.
6. GREEN `crlfToWorkingTree`.
7. RED `lf-to-crlf-transform.test.ts` — `\r` at the end of one chunk and `\n` at the start of the next yields no extra CR; LF-first chunk; empty chunk; `flush` returns `[]`. Fails: module does not exist. GREEN `createLfToCrlfTransform`.
8. GUARD `crlf-conversion.properties.test.ts` — (200 runs) for non-binary text without lone CR, `crlfToGit(crlfToWorkingTree(x, 'text-crlf'), 'text-input')` equals `x` with every CRLF replaced by LF; `text-*` output never contains CRLF; both directions idempotent; (100 runs) `createLfToCrlfTransform` over any chunking (`fc.array` of split points) concatenates to `crlfToWorkingTree(x, 'text-crlf', settings)` for `x` containing a lone LF. Passes because steps 2–7 implement the rules.
9. REFACTOR — extract `stripCr` / `insertCr` byte loops; no `subarray` views returned.

### Gate
```sh
npx vitest run test/unit/domain/eol \
  && npx tsc --noEmit -p tsconfig.json \
  && ./node_modules/.bin/biome check src/domain/eol test/unit/domain/eol \
  && npx cspell --no-progress src/domain/eol/*.ts test/unit/domain/eol/*.ts
```
Traps: wireit caches `check:types` / `check:spelling` — the bare `tsc` / `cspell` above are the oracles; never pass cspell.json to cspell.

### Commit
`feat(eol): convert line endings to git and to the working tree`

## Part 3 — Domain: `ident` collapse and git's two expanders

### Context
Creates (internal, no barrel):
- `src/domain/eol/ident.ts` — `identToGit(bytes): Uint8Array`, `identToWorkingTree(bytes, oidHex: string): Uint8Array` (in-core expander). Both return the same reference when nothing changes. Transcription of git `convert.c` (the §D1.9 pins are the arbiter):
  - `countIdent`: for each `$`: need ≥ 3 more bytes and `Id` next; then `$` → count; `:` → scan to the next `$` (count, stop) unless an LF comes first (stop). Zero → identity.
  - `identToGit`: copy through each `$`; when the following bytes are `Id:` and a later `$` exists with no LF between, replace `Id:…$` by `Id$`; an `Id:` with no later `$` ends the scan (rest copied).
  - `identToWorkingTree` (git `ident_to_worktree`): copy through each `$`; if next is `Id$` → emit `Id: <oidHex> $`; if next is `Id:` → find the next `$` (none → stop, rest copied), LF before it → keep; a space found searching from the 5th byte after the `$` (i.e. after `Id:` plus one byte) that sits before the byte preceding the closing `$` → foreign id, keep; otherwise replace the whole keyword by `Id: <oidHex> $`; anything else → keep. Consequences pinned in §D1.9: `$$Id$` expands the second `$`, `$Id:a b$` is kept, `$Id: a\tb $` is replaced.
- `src/domain/eol/ident-transform.ts` — `createIdentTransform(oidHex): ChunkTransform` (git `ident_filter`, streamed): a state machine matching `$Id` byte by byte (state 0–3); a mismatch emits the matched prefix plus the mismatching byte and does NOT re-examine that byte (so `$$Id$` stays, §D1.9); after `$Id`: `$` → emit `$Id: <oidHex> $`; `:` → skipping state collecting bytes until `$` or LF (both kept); on `$` the collected `$Id: …$` is replaced by `$Id: <oidHex> $` unless foreign — foreign means it starts with `$Id: ` (with the space) and some whitespace byte (space, `\t`, `\n`, `\v`, `\f`, `\r`) is not followed by `$`; on LF the collection is emitted verbatim; any other byte after `$Id` → emit and reset. `flush` emits a partial match / collection verbatim. Memory: holds at most one keyword up to the next `$` / LF (design §D3.3).
- `test/unit/domain/eol/ident.test.ts`, `test/unit/domain/eol/ident.properties.test.ts`, `test/unit/domain/eol/ident-transform.test.ts`.

Read-only: `ChunkTransform` from src/domain/eol/chunk-transform.ts (Part 2).

Pins reproduced: §D1.9 rows a–h (collapse and expansion), the foreign-ident row, the divergence blob through both expanders (`attr=[ident]` streamed rows vs `attr=[ident text=auto]` / archive in-core rows), sha1 (40 hex) and sha256 (64 hex, `746298a1…` row) widths — the width is the caller's `oidHex` length.

### TDD steps
1. RED `ident.test.ts` — `identToGit` rows b, c, d, e (kept: LF before `$`), h; the foreign `$Id: has space x $` collapses. Fails: module does not exist. GREEN `identToGit` + `countIdent`.
2. RED `identToWorkingTree` rows a, b, e, f (binary content expands), g, the foreign row kept, the divergence blob → `$$Id: <oid> $\n$Id:a b$\n$Id: <oid> $\n$Id: <oid> $Id$\n`, the 64-hex width. Fails: not exported. GREEN.
3. RED `ident-transform.test.ts` — the divergence blob unchunked → `$$Id$\n$Id: <oid> $\n$Id: a\tb $\n$Id: <oid> $Id$\n`; the same blob split at every byte boundary gives the same output; `$Id` at end of input flushes verbatim. Fails: module does not exist. GREEN `createIdentTransform`.
4. GUARD `ident.properties.test.ts` — (200 runs) `identToGit(identToWorkingTree(x, oid))` equals `identToGit(x)`; (100 runs) the streamed transform over any chunking equals itself unchunked. The in-core vs streamed difference stays example-only (design §Test strategy).
5. REFACTOR — named constants for `$`, `Id`, LF; small state helpers.

### Gate
```sh
npx vitest run test/unit/domain/eol \
  && npx tsc --noEmit -p tsconfig.json \
  && ./node_modules/.bin/biome check src/domain/eol test/unit/domain/eol \
  && npx cspell --no-progress src/domain/eol/*.ts test/unit/domain/eol/*.ts
```
Traps: wireit caches `check:types` / `check:spelling` — the bare `tsc` / `cspell` above are the oracles; never pass cspell.json to cspell.

### Commit
`feat(eol): collapse and expand ident keywords`

## Part 4 — Config: `core.autocrlf`, `core.eol`, `core.safecrlf` and the eager refusal

### Context
Edits:
- `src/application/primitives/config-read.ts` — `ParsedConfig.core` (lines 55–105) gains `autoCrlf?: boolean | 'input'`, `eol?: 'lf' | 'crlf' | 'native'`, `safeCrlf?: boolean | 'warn'`; `MutableCore` (≈ line 1454) the same; parse in `applyCoreEntry` (≈ 1644) beside `logallrefupdates`: a tri-state parser per key mirroring `parseLogAllRefUpdates` (≈ 1694) — `autocrlf`: `input` (case-insensitive) else `parseGitBoolean`; `safecrlf`: `warn` (case-insensitive) else `parseGitBoolean`; a refused value leaves the field absent (lenient read). `eol`: `lf` / `crlf` / `native` case-insensitive, anything else (and valueless — PIN step 1) → absent. Do NOT add `autocrlf` / `safecrlf` to `CORE_BOOLEAN_FIELDS` (the plain boolean finder would misreport `input` / `warn`) — route them like `logallrefupdates` (`CORE_BOOLEAN_KEYS` holds the tri-state key names for dispatch only). `finalizeCoreIdentityFields` (≈ 2306) copies the three fields. New exported finders beside `findFirstInvalidLogAllRefUpdates` (≈ 2706): `findFirstInvalidAutoCrlf`, `findFirstInvalidSafeCrlf` via `findFirstRejectedBoolean(ctx, { section: 'core', keys: [...], accepts, fixedKey })`.
- `src/application/primitives/internal/repo-state.ts` — `assertEagerConfigValid` (≈ line 228): add both finders to the `Promise.all`, push each as `{ kind: 'boolean', line, entry }` into `candidates`; the lowest line wins (existing `pickLowerLine`). The local `CORE_BOOLEAN_KEYS` (line 151) stays without the two keys.
- `test/unit/application/primitives/config-read.test.ts`, `test/unit/application/primitives/config-read.properties.test.ts`, `test/unit/application/primitives/internal/repo-state.test.ts`.
- `reports/api.json` — `ParsedConfig` is public; regenerate.

Read-only: src/domain/config/config-ini.ts `parseGitBoolean` (empty value → false, valueless → true); src/application/primitives/internal/boolean-config-guard.ts.

Pins reproduced: §D1.8 (bad `core.autocrlf` / `core.safecrlf` refuse every command with `CONFIG_BAD_BOOLEAN_VALUE` `{ key: 'core.autocrlf' | 'core.safecrlf', source, value }`; `core.eol=foo` silently unset; `core.autocrlf=` false; valueless `core.autocrlf` true; `INPUT`, `WARN`, `CRLF` case-insensitive). The cross-tool rows land in Part 12's "configuration grammar" block (eol-conversion-interop), where `add` / `status` exist on both sides.

### TDD steps
1. PIN — not pinned in §D1.8: valueless `core.eol`, `core.eol=` (empty), valueless `core.safecrlf`, `core.safecrlf=` (empty): for each, `g -c <cfg> status` exit code and, for safecrlf, `g -c core.autocrlf=true -c <cfg> add lf` exit/warning (refusal ⇒ `true`, warning ⇒ `warn`, silence ⇒ `false`). Record the outcomes as the expectations of step 2's rows.
2. RED `config-read.test.ts` › `Given [core] autocrlf = <v>` / `eol = <v>` / `safecrlf = <v>` › `When readConfig` › `Then core.<field> is <parsed>` for every literal of §D1.8 and step 1, including mixed case and an unrecognised value (absent). Fails: the fields are never populated.
3. GREEN the parsers and `finalizeCoreIdentityFields` copies.
4. RED `repo-state.test.ts` › `Given core.autocrlf = foo` (and separately `core.safecrlf = foo`, each guard isolated) › `When assertEagerConfigValid` › `Then CONFIG_BAD_BOOLEAN_VALUE with key core.autocrlf, value foo` (try/catch on `.data`); `Given autocrlf = foo on line 3 and bare = maybe on line 2` → the line-2 key wins; `core.eol = foo` → no throw; `core.autocrlf = input` → no throw. Fails: no finder runs.
5. GREEN finders + gate wiring.
6. GUARD `config-read.properties.test.ts` — (100 runs) any ASCII casing of `input` / `warn` / `lf` / `crlf` / `native` parses equal to the lower-case literal; passes after step 3.
7. `npm run docs:json`; commit `reports/api.json` churn.

### Gate
```sh
npx vitest run test/unit/application/primitives/config-read.test.ts test/unit/application/primitives/config-read.properties.test.ts test/unit/application/primitives/internal/repo-state.test.ts \
  && npx tsc --noEmit -p tsconfig.json \
  && ./node_modules/.bin/biome check src/application/primitives/config-read.ts src/application/primitives/internal/repo-state.ts test/unit/application/primitives/config-read.test.ts test/unit/application/primitives/config-read.properties.test.ts test/unit/application/primitives/internal/repo-state.test.ts \
  && npx cspell --no-progress src/application/primitives/config-read.ts src/application/primitives/internal/repo-state.ts test/unit/application/primitives/config-read.test.ts test/unit/application/primitives/internal/repo-state.test.ts
```
Traps: wireit caches `check:types` / `check:spelling` — the bare `tsc` / `cspell` above are the oracles; never pass cspell.json to cspell. api.json staleness is a prepush gate, not a validate gate — regenerate it here.

### Commit
`feat(config): read core.autocrlf, core.eol and core.safecrlf`

## Part 5 — Port: the native line ending on the context

### Context
DC-1 option (a). Edits:
- `src/ports/context.ts` — `Context` gains `readonly nativeEol?: 'lf' | 'crlf'` beside `windowsPathSyntax` (line ≈ 358), doc comment: "The host's native line ending (git's `EOL_NATIVE`), supplied by the platform adapter. Absent ⇒ `lf`." The inline literal union avoids importing the domain type into the port (structurally identical to `LineEnding`). `CreateContextParts` (line 361) gains the same optional field so `createNodeContext` can pass it (Part 6).
- `src/repository.ts` — `RuntimeFallback` (line 270) gains `readonly nativeEol?: Context['nativeEol']`; `OptionalCtxInputs` (≈ 506) and `buildOptionalCtxFields` (≈ 528) forward it with the `exactOptionalPropertyTypes` conditional-spread pattern used for `concurrency`; the call site in `openRepository` (≈ 729) passes `nativeEol: fallback.nativeEol` (a runtime fact, not a host-reaching hook, so it comes from `fallback`, not `hostHooks`).
- `test/unit/repository/repository.test.ts` — the fallback literal at line ≈ 30 (`runtime: 'memory'`) is the fixture; add a describe for the forwarding.
- `reports/api.json` — `Context` is public; regenerate.

Not touched (DC-1 (a)): memory and browser adapters, index.browser.ts, index.default.ts — they supply `lf` by omission.

### TDD steps
1. RED `repository.test.ts` › `Given a runtime fallback naming the crlf native line ending` › `When the repository is opened` › `Then ctx.nativeEol is crlf`. Fails: `RuntimeFallback` has no such field (type error) / the field is not forwarded.
2. GREEN — the field on both interfaces and the forwarding.
3. RED-or-GUARD `Given a runtime fallback without a native line ending` › `Then ctx has no nativeEol key` (`'nativeEol' in ctx` is false) — GUARD if step 2's conditional spread already omits it; it pins the `exactOptionalPropertyTypes` arm so the ConditionalExpression mutant dies.
4. `npm run docs:json`; commit the `reports/api.json` churn.

### Gate
```sh
npx vitest run test/unit/repository/repository.test.ts \
  && npx tsc --noEmit -p tsconfig.json \
  && ./node_modules/.bin/biome check src/ports/context.ts src/repository.ts test/unit/repository/repository.test.ts \
  && npx cspell --no-progress src/ports/context.ts src/repository.ts test/unit/repository/repository.test.ts
```
Traps: wireit caches `check:types` / `check:spelling` — the bare `tsc` / `cspell` above are the oracles; never pass cspell.json to cspell.

### Commit
`feat(ports): carry the native line ending on the context`

## Part 6 — Node adapter: supply the platform line ending

### Context
Edits:
- `src/adapters/node/node-adapter.ts` — export `nativeLineEndingFor(platform: NodeJS.Platform): 'lf' | 'crlf'` (`win32` → `crlf`, else `lf`), JSDoc `@internal` with the same "pure helper so both arms are unit-testable on any host" rationale as `selectNativePolicy` in src/adapters/node/path-policy.ts (line ≈ 253); NOT added to src/adapters/node/index.ts. `createNodeContext` (line 91) adds `nativeEol: nativeLineEndingFor(process.platform)` to `parts` beside `windowsPathSyntax`.
- `src/index.node.ts` — the Node runtime fallback object (lines ≈ 155–180, beside `windowsPathSyntax: nativePolicy.windowsSyntax`) adds `nativeEol: nativeLineEndingFor(process.platform)`.
- `test/unit/adapters/node/node-adapter.test.ts` — helper arms (`win32` → crlf; `linux`, `darwin` → lf) and `createNodeContext(...).nativeEol` equals `nativeLineEndingFor(process.platform)`.
- `test/unit/index.node.test.ts` — an opened repository's `ctx.nativeEol` equals `nativeLineEndingFor(process.platform)`.

Public surface: none new (helper internal; `Context` field landed in Part 5). Run `npm run docs:json`; expected no churn.

### TDD steps
1. RED `node-adapter.test.ts` › `Given the win32 platform` › `When nativeLineEndingFor runs` › `Then crlf` (and `linux` / `darwin` → lf). Fails: not exported.
2. GREEN the helper.
3. RED `Given a context built by createNodeContext` › `Then nativeEol equals nativeLineEndingFor(process.platform)`. Fails: field absent. GREEN.
4. RED `index.node.test.ts` › `Given a repository opened through the node entry` › `Then ctx.nativeEol equals nativeLineEndingFor(process.platform)`. Fails: fallback omits it. GREEN.

### Gate
```sh
npx vitest run test/unit/adapters/node/node-adapter.test.ts test/unit/index.node.test.ts \
  && npx tsc --noEmit -p tsconfig.json \
  && ./node_modules/.bin/biome check src/adapters/node/node-adapter.ts src/index.node.ts test/unit/adapters/node/node-adapter.test.ts test/unit/index.node.test.ts \
  && npx cspell --no-progress src/adapters/node/node-adapter.ts src/index.node.ts test/unit/adapters/node/node-adapter.test.ts test/unit/index.node.test.ts
```
Traps: wireit caches `check:types` / `check:spelling` — the bare `tsc` / `cspell` above are the oracles; never pass cspell.json to cspell.

### Commit
`feat(node): supply the platform line ending`

## Part 7 — Attribute providers take a direction

### Context
ADR-951; DC-2 option (a). Edits:
- `src/application/primitives/internal/read-gitattributes.ts` — today: `workTreeDirReader` (line 37), `type DirReader = (ctx, dir) => Promise<ParsedAttributes | undefined>` (46), `assertDeclaredSizeWithinCap` (55), `treeDirReader(tree)` (105), `buildAttributeProviderFrom(ctx, readDir)` (206), `buildAttributeProvider(ctx)` (233), `buildTreeAttributeProvider(ctx, tree)` (237), `requiresAnyFilter` (242), `maybeBuildAttributeProvider(ctx)` (252, runner gate). Change to:
  - `export type IndexBlobLookup = (path: FilePath) => ObjectId | undefined;`
  - `export type AttributeDirection = { kind: 'worktree-first'; index: IndexBlobLookup } | { kind: 'index-first'; index: IndexBlobLookup } | { kind: 'index-only'; index: IndexBlobLookup } | { kind: 'tree'; tree: ObjectId }` (design §D3.4).
  - `indexDirReader(lookup)`: `<dir>/.gitattributes` (root: `.gitattributes`) → `lookup(path)` → blob read with the same guard `treeDirReader` applies (`assertDeclaredSizeWithinCap` + the `MAX_GITATTRIBUTES_BYTES` cap, then parse) — reuse, do not duplicate.
  - `firstOf(primary, fallback): DirReader` — fallback only when primary yields `undefined`.
  - `buildAttributeProvider(ctx, direction?)`: none → `workTreeDirReader` (today's reader for the non-converting consumers: build-content-merger driver lookup, diff-trees, materialise-patch-files, similarity — untouched); `worktree-first` → `firstOf(workTreeDirReader, indexDirReader)`; `index-first` → `firstOf(indexDirReader, workTreeDirReader)`; `index-only` → `indexDirReader`; `tree` → `treeDirReader`. info/attributes and `core.attributesFile` keep applying in every direction (`readInfo` / `readGlobal` are direction-independent).
  - Delete `buildTreeAttributeProvider`; its single caller moves to `{ kind: 'tree', tree }`.
  - `maybeBuildAttributeProvider(ctx)` keeps its name (DC-2) but always builds the check-in provider: read the index once (`readIndex(ctx)`; it is stat-key cached), map stage-0 entries whose path is .gitattributes or ends in /.gitattributes to their ids, return `buildAttributeProvider(ctx, { kind: 'worktree-first', index })`. Return type narrows to `Promise<AttributeProvider>`; callers' `| undefined` checks stay type-valid (their removal is the refactoring phase's, with the rename). Delete `requiresAnyFilter` (dead once the gate goes). Edge to preserve: add.ts `readExistingEntries` (≈ line 571) treats a missing or corrupt index (`INDEX_MISSING_CODES`: `FILE_NOT_FOUND`, `INVALID_INDEX_HEADER`, `INVALID_INDEX_ENTRY`) as empty, and add builds this provider before its own read — so the provider's index read applies the same three codes as "no index `.gitattributes`" (a named constant with a why-comment pointing at that add behaviour) and rethrows every other error. Every other caller reads the index itself first, so the tolerance changes nothing for them.
- `src/application/commands/archive.ts` — `createAttributeCheck` (≈ line 154) calls `buildAttributeProvider(ctx, { kind: 'tree', tree })`.
- `test/unit/application/primitives/internal/read-gitattributes.test.ts` — rewrite the `buildTreeAttributeProvider` / `maybeBuildAttributeProvider` describes; add the direction describes (memory adapter: write blobs with the object-store primitives, seed the worktree file through `ctx.fs`).

Behaviour shift to expect (git-faithful, ADR-950/951): runner-less contexts (memory, browser) now always build a provider, so a malformed `[filter "<d>"] required` refuses once a `filter` attribute engages, as git does. Search the unit suites for tests asserting the old inertness (`grep -rn "maybeBuildAttributeProvider\|without a runner\|runner-less" test/unit`) and update each to the git-faithful outcome, naming the reason in the test title.

Pins reproduced: §D1.7 direction rules (unit level; the cross-tool rows land with the routes in Parts 12 and 18), §D1.12 `index-only` lookups (consumed in Part 22). Internal: every new export.

### TDD steps
1. RED `Given index .gitattributes '*.txt eol=crlf' and no worktree file` › `When a worktree-first provider resolves f.txt` › `Then eol is { set: 'crlf' }`. Fails: `buildAttributeProvider` ignores a second argument (worktree only → unspecified).
2. GREEN `indexDirReader`, `firstOf`, the `worktree-first` arm.
3. RED `Given index '*.txt eol=crlf' and worktree '*.txt eol=lf'` › worktree-first → `lf`; index-first → `crlf`; index-only with the worktree file present → `crlf`; index-first with the index lookup missing → falls back to the worktree `lf`. Fails: those arms do not exist. GREEN.
4. RED `Given an index .gitattributes blob over the size cap` › `Then the read refuses as the tree reader does` (same error data as the existing tree-reader cap test). Fails until the guard is shared. GREEN by reuse.
5. GUARD the `tree` kind reproduces the deleted `buildTreeAttributeProvider` cases (moved tests pass unchanged); archive.test.ts passes unchanged.
6. RED `Given a context without a command runner and no required filter` › `When maybeBuildAttributeProvider runs` › `Then a provider resolving the index .gitattributes is returned` (was `undefined`). Fails: runner gate. GREEN; delete `requiresAnyFilter`.
7. Run the dependent unit suites (add, status, rm, stash, clean-work-tree, find-would-overwrite, smudge-racily-clean, apply-changeset, archive) and update the inertness tests as described in Context.

### Gate
```sh
npx vitest run test/unit/application/primitives/internal/read-gitattributes.test.ts test/unit/application/commands test/unit/application/primitives \
  && npx tsc --noEmit -p tsconfig.json \
  && ./node_modules/.bin/biome check src/application/primitives/internal/read-gitattributes.ts src/application/commands/archive.ts test/unit/application/primitives/internal/read-gitattributes.test.ts \
  && npx cspell --no-progress src/application/primitives/internal/read-gitattributes.ts src/application/commands/archive.ts test/unit/application/primitives/internal/read-gitattributes.test.ts
```
Add any test file updated in step 7 to the biome and cspell lists. Traps: wireit caches `check:types` / `check:spelling` — the bare `tsc` / `cspell` above are the oracles; never pass cspell.json to cspell.

### Commit
`feat(attributes): resolve attribute files by direction`

## Part 8 — Error code `EOL_ROUND_TRIP_UNSAFE`

### Context
ADR-952. Public code; internal factory. Edits:
- `src/domain/commands/error.ts` — `CommandError` union (the block holding `CONFIG_BAD_BOOLEAN_VALUE`, ≈ line 295) gains `| { readonly code: 'EOL_ROUND_TRIP_UNSAFE'; readonly path: FilePath; readonly loss: RoundTripLoss; readonly crlf: number; readonly loneLf: number }` (import `EolRoundTrip` / `RoundTripLoss` from src/domain/eol/crlf-conversion.ts — a domain-internal import); factory `export const eolRoundTripUnsafe = (roundTrip: EolRoundTrip): TsgitError` placed beside `cleanFilterFailed` (≈ line 913), treating `path` as `cleanFilterFailed` does. Not added to src/domain/commands/index.ts (same as `configBadBooleanValue`).
- `src/domain/error.ts` — `extractDetail` (line 284) `case 'EOL_ROUND_TRIP_UNSAFE'`: git's `fatal:` text minus the prefix — `CRLF would be replaced by LF in <path>` for `crlf-to-lf`, `LF would be replaced by CRLF in <path>` for `lf-to-crlf` (§D1.6). This is the error's diagnostic message, not command output (ADR-249 binds results; every code renders a detail).
- `test/unit/domain/exhaustiveness.ts` — `assertExhaustiveSwitch` gains the case beside `CLEAN_FILTER_FAILED`.
- `test/unit/domain/commands/error.test.ts` — a `Given the eolRoundTripUnsafe helper` describe (data field by field, both losses) and two rows in the `extractDetail message formatting` table (≈ line 1632 describe, rows like the `CONFIG_BAD_BOOLEAN_VALUE` one at ≈ 2003).
- `docs/use/errors.md` — a row in `### Index, working tree, sparse, ignore` beside `CLEAN_FILTER_FAILED` (line 118): fields `path, loss, crlf, loneLf`; thrown by `add` (literal, bulk) and `stash push` when `core.safecrlf=true` and the round trip loses a line ending; `crlf` / `loneLf` are tsgit-only counts of the CRLF step's input, git prints neither; git's message is reconstructible from `path` + `loss`.
- `reports/api.json` — regenerate (the union is public).

### TDD steps
1. RED `error.test.ts` › `Given the eolRoundTripUnsafe helper` › `When built from { path: 'b2', loss: 'lf-to-crlf', crlf: 0, loneLf: 2 }` › `Then data carries each field` (and a `crlf-to-lf` row). Fails: factory not exported.
2. GREEN union member + factory. `npx tsc` now fails in `extractDetail` / `assertExhaustiveSwitch` (non-exhaustive) — expected; continue.
3. RED message-table rows for both losses. Fails: `extractDetail` lacks the case. GREEN the case and the exhaustiveness case.
4. Docs row; `npm run docs:json`; commit `reports/api.json`.

### Gate
```sh
npx vitest run test/unit/domain/commands/error.test.ts \
  && npx tsc --noEmit -p tsconfig.json \
  && ./node_modules/.bin/biome check src/domain/commands/error.ts src/domain/error.ts test/unit/domain/exhaustiveness.ts test/unit/domain/commands/error.test.ts \
  && npx cspell --no-progress src/domain/commands/error.ts src/domain/error.ts test/unit/domain/exhaustiveness.ts test/unit/domain/commands/error.test.ts docs/use/errors.md
```
Traps: wireit caches `check:types` / `check:spelling` — the bare `tsc` / `cspell` above are the oracles; never pass cspell.json to cspell.

### Commit
`feat(errors): add EOL_ROUND_TRIP_UNSAFE`

## Part 9 — Resolve a path's conversion from one attribute lookup

### Context
ADR-950. Internal. Creates / edits:
- `src/application/primitives/resolve-conversion.ts` (create) — design §D3.2: `interface Conversion { filter: FilterChoice; crlf: CrlfAction; ident: boolean }`, `IDENTITY_CONVERSION` (filter identity, `'binary'`, `false`), `resolveConversion(ctx, provider, path, settings, options?: { eagerSectionValidation?: boolean }): Promise<Conversion>`, `isIdentityConversion(c)`, `convertsInCore(c)` (= `smudgesInCore(c.filter) || c.crlf === 'auto' || c.crlf === 'auto-crlf'`, git `classify_conv_attrs` / `get_stream_filter`), and `readEolSettings(ctx): Promise<EolSettings>` — from `(await readConfig(ctx)).core`: `autoCrlf ?? false`, `coreEol` = `eol` when present, `safeCrlf ?? 'warn'`, `nativeEol: ctx.nativeEol ?? 'lf'` (the documented absent semantics of the port, DC-1). `readConfig` is memoised per command (ADR-850), so a per-call read costs a map hit.
  - `resolveConversion`: (1) when `options.eagerSectionValidation`, run the same `[filter "<d>"] required` section validation `resolveFilterDriver` runs today, first (observable order unchanged); (2) ONE `provider.sourcesForPath(path)`; (3) R11 fast path: `sources.length === 0 && settings.autoCrlf === false` → return `IDENTITY_CONVERSION` (same reference) without any `resolveAttribute` call; (4) otherwise resolve `filter`, `text`, `crlf`, `eol`, `ident` from those sources (`ident` engaged iff resolved `true`) and `resolveCrlfAction`.
- `src/application/primitives/resolve-filter-driver.ts` — extract the part of `resolveFilterDriver` (line 70) after the lookup into an exported `filterChoiceFromSources(ctx, sources, macros, path): Promise<FilterChoice>` (wraps the existing `choiceFromFilterValue`), so both resolvers share it; `resolveFilterDriver` keeps its signature and behaviour (still used by non-converting callers until the routes move).
- `test/unit/application/primitives/resolve-conversion.test.ts` (create), `test/unit/application/primitives/resolve-filter-driver.test.ts` (extend).

Read-only: src/application/primitives/internal/apply-smudge-filter.ts `smudgesInCore`; src/domain/attributes/resolve-attribute.ts `resolveAttribute(sources, path, name, macros)`; src/domain/attributes/macros.ts (`binary` = `-diff -merge -text`); Part 1 `resolveCrlfAction`. Test providers are plain objects implementing `AttributeProvider.sourcesForPath` (parse rules with src/domain/attributes/parse-gitattributes.ts).

### TDD steps
1. RED `resolve-conversion.test.ts` › `Given repository config without core keys` › `When readEolSettings` › `Then { autoCrlf: false, safeCrlf: 'warn', nativeEol: 'lf' } and no coreEol`; `Given ctx.nativeEol crlf and core.eol native` › `Then nativeEol crlf, coreEol native`. Fails: module does not exist. GREEN.
2. RED `Given a provider whose sources are empty and autocrlf false` › `When resolveConversion` › `Then the result is IDENTITY_CONVERSION (toBe)`; and `Given empty sources and autocrlf true` › `Then crlf is auto-crlf`. Fails: not exported. GREEN.
3. RED `Given '* text eol=crlf ident filter=t' with [filter "t"] clean = x` › `Then { filter: external t, crlf: text-crlf, ident: true }` with `sourcesForPath` called once (`vi.fn`, `toHaveBeenCalledTimes(1)`); `Given '* binary text'` → `text-*`; `Given '* -text eol=crlf'` → `binary`. Fails until the full resolution lands. GREEN with `filterChoiceFromSources`.
4. RED `convertsInCore` / `isIdentityConversion` rows: `auto`, `auto-crlf` → in core; `auto-input`, `text-crlf`, `ident` only → streamed; a driver naming `smudge` → in core; identity → identity. Fails: not exported. GREEN.
5. GUARD `resolve-filter-driver.test.ts` — existing suite passes after the extraction; add one row for `filterChoiceFromSources` with a macro-expanded `filter` attribute.

### Gate
```sh
npx vitest run test/unit/application/primitives/resolve-conversion.test.ts test/unit/application/primitives/resolve-filter-driver.test.ts \
  && npx tsc --noEmit -p tsconfig.json \
  && ./node_modules/.bin/biome check src/application/primitives/resolve-conversion.ts src/application/primitives/resolve-filter-driver.ts test/unit/application/primitives/resolve-conversion.test.ts test/unit/application/primitives/resolve-filter-driver.test.ts \
  && npx cspell --no-progress src/application/primitives/resolve-conversion.ts src/application/primitives/resolve-filter-driver.ts test/unit/application/primitives/resolve-conversion.test.ts test/unit/application/primitives/resolve-filter-driver.test.ts
```
Traps: wireit caches `check:types` / `check:spelling` — the bare `tsc` / `cspell` above are the oracles; never pass cspell.json to cspell.

### Commit
`feat(eol): resolve a path's conversion from one attribute lookup`

## Part 10 — Compose the conversion steps in git's order

### Context
ADRs 950, 952, 953, 955. Internal. Creates / edits:
- `src/application/primitives/internal/convert-blob.ts` (create) — design §D3.3 verbatim signatures: `ConversionRoute = 'write' | 'compare' | 'renormalize'`, `ToGitRequest { path, bytes, conversion, route, settings, indexBlob? }`, `ToGitResult { bytes; notice?: EolNotice }`, `convertToGit(ctx, request)`, `ToWorkingTreeRequest { target: SmudgeTarget; conversion; settings; normalizing? }`, `convertToWorkingTree(ctx, request): Promise<Uint8Array>`, `workingTreeStreamTransform(conversion, blob, settings): ChunkTransform | undefined`, `renormalizeBuffer(ctx, path, bytes, conversion, settings): Promise<Uint8Array>`.
  - `convertToGit` = `applyCleanFilter(ctx, ctx.command, path, bytes, conversion.filter)` → `crlfToGit({ bytes, action: conversion.crlf, settings, renormalize: route === 'renormalize', indexHasCrlf })` → `conversion.ident ? identToGit(bytes) : bytes`. `indexHasCrlf` = `indexBlob === undefined ? false : (stats of readBlob(ctx, indexBlob).content: !isBinaryText && crlf > 0)` (git `has_crlf_in_index`). safecrlf only on route `write`: `roundTrip` present and `settings.safeCrlf === true` → `throw eolRoundTripUnsafe({ path, ...roundTrip })`; `'warn'` → `notice: { path, ...roundTrip }`; `false` → dropped. `compare` / `renormalize` never notice nor throw. Identity conversion returns the input reference (R11).
  - `convertToWorkingTree` = `identToWorkingTree(bytes, target.blob)` when `ident` (in-core expander) → `crlfToWorkingTree` unless `normalizing` and the filter names neither `smudge` nor `process` (git `renormalize_buffer` skips CRLF then) → `applySmudgeFilter(ctx, ctx.command, { ...target, bytes }, conversion.filter)`.
  - `workingTreeStreamTransform`: `undefined` when the conversion is identity or `convertsInCore`; else compose `createIdentTransform(blob)` (when `ident`) then `createLfToCrlfTransform()` (when `outputLineEnding(crlf, settings) === 'crlf'` and the action is not `auto*`) — git `get_stream_filter` cascade; a local `composeTransforms(a, b)` feeds `a`'s outputs into `b`.
  - `renormalizeBuffer` = `convertToWorkingTree({ normalizing: true, target: { path, blob: <hash of bytes>, bytes } })` then `convertToGit({ route: 'renormalize' })`; the blob id for the in-core ident expander comes from `serializeAndHash` (src/application/primitives/internal/serialize-and-hash.ts) only when `conversion.ident`.
  - Symlinks and gitlinks never reach these functions — every caller keeps its mode guard (R12).
- `src/application/primitives/internal/write-working-tree-file.ts` — `writeStreamedBlob(ctx, fullPath, id, mode?, transform?)` (line 209) passes the transform to `writeServedBlob` (≈ 175), which wraps `chunksOf(source)` in an async generator applying `push` per chunk and `flush` at the end, AFTER `openServedBlob` (so the ADR-931/932 empty-file refusal is unchanged — §D1.11). `writeWorkingTreeFileStream` (232) and `writeWorkingTreeEntryStream` (249) gain a trailing optional `transform` passed through. No transform → today's zero-copy path (R11).
- `test/unit/application/primitives/internal/convert-blob.test.ts` (create), `test/unit/application/primitives/internal/write-working-tree-file.test.ts` (extend).

Read-only: src/application/primitives/internal/apply-clean-filter.ts (`applyCleanFilter(ctx, runner, path, bytes, choice)`), src/application/primitives/internal/apply-smudge-filter.ts (`applySmudgeFilter(ctx, runner, target, choice)`, `SmudgeTarget`), src/adapters/memory/memory-command-runner.ts (fake runner for filter steps), src/application/primitives/read-blob.ts, Part 8 `eolRoundTripUnsafe`.

Pins reproduced: §D1.10 order (unit level with a fake runner whose clean emits `Z\r\n$Id: q $\r\n` + input and whose smudge records its input: blob `ZN$Id$NaRNbN`, smudge input carries CRs and the expanded `$Id: <blob oid> $`), §D1.6 route matrix (write vs compare vs renormalize), §D1.11 (the transform does not change the refused-open residue).

### TDD steps
1. RED `convert-blob.test.ts` › `Given autocrlf input and CRLF bytes` › `When convertToGit on route write` › `Then bytes are LF`; `Given an identity conversion` › `Then the same reference (toBe)`. Fails: module does not exist. GREEN the to-git chain without safecrlf.
2. RED route × `safeCrlf` matrix: `write` + `true` → throws, `.data` `{ code: 'EOL_ROUND_TRIP_UNSAFE', path, loss, crlf, loneLf }` field by field; `write` + `warn` → `notice` field by field; `write` + `false` → no notice; `compare` and `renormalize` + `true` → no throw, no notice; the index rule via `indexBlob` (a stored CRLF text blob keeps CRLF under `auto`; `renormalize` converts it). Fails: no arming. GREEN.
3. RED `convertToWorkingTree` — ident then CRLF then smudge, the §D1.10 bytes with the fake runner; `normalizing` skips CRLF unless the driver names `smudge` / `process`. Fails: not exported. GREEN.
4. RED `workingTreeStreamTransform` — identity → `undefined`; `auto-crlf` → `undefined`; `text-crlf` + ident over the divergence blob of §D1.9 → the streamed bytes; `auto-input` + ident → ident only. Fails: not exported. GREEN with `composeTransforms`; `renormalizeBuffer` row (§D1.12: CRLF blob under `text=auto` → LF).
5. RED `write-working-tree-file.test.ts` › `Given a transform` › `When writeStreamedBlob writes a loose blob` › `Then the file holds the transformed bytes`; GUARD `Given a corrupt loose blob and a transform` › `Then the empty file is left` (existing refusal path). Fails: the fifth argument is ignored. GREEN.

### Gate
```sh
npx vitest run test/unit/application/primitives/internal/convert-blob.test.ts test/unit/application/primitives/internal/write-working-tree-file.test.ts \
  && npx tsc --noEmit -p tsconfig.json \
  && ./node_modules/.bin/biome check src/application/primitives/internal/convert-blob.ts src/application/primitives/internal/write-working-tree-file.ts test/unit/application/primitives/internal/convert-blob.test.ts test/unit/application/primitives/internal/write-working-tree-file.test.ts \
  && npx cspell --no-progress src/application/primitives/internal/convert-blob.ts src/application/primitives/internal/write-working-tree-file.ts test/unit/application/primitives/internal/convert-blob.test.ts test/unit/application/primitives/internal/write-working-tree-file.test.ts
```
Traps: wireit caches `check:types` / `check:spelling` — the bare `tsc` / `cspell` above are the oracles; never pass cspell.json to cspell.

### Commit
`feat(eol): compose conversion steps in git's order`

## Part 11 — EOL interop fixtures and git goldens (test infrastructure)

### Context
Test-infra only, no `src/` delta (standalone by the sizing rules). Creates:
- `test/integration/eol-interop-fixtures.ts` — shared by Parts 12–24:
  - fixture bytes: the five matrix fixtures (`LF` `a\nb\n`, `CRLF`, `MIXED`, `NUL`, `LONE-CR`), the §D1.3 edges (`nul-lf`, `lone-cr-lf`, `trail-cr`, `no-eol`, `crlf-no-eol`, `empty`), the §D1.4 heuristic files, the §D1.6 `a1` (CRLF) / `b2` (LF) / `c3` (CRLF) trio, the §D1.9 ident blobs incl. the divergence blob, the §D1.10 filter fixture;
  - `ADD_MATRIX` / `CHECKOUT_MATRIX`: the §D1.1 and §D1.2 tables as data (16 config rows × 7 attribute columns; §D1.2's grouped rows expanded to 16), cell codes `=` / `L` / `C` with a `expectedBytes(code, fixture)` mapper;
  - `initEolRepo(dir, { autoCrlf?, eol?, safeCrlf?, infoAttributes?, gitattributes? })`: `git init -q` with `init.defaultBranch=main`, writes the values with `git config` into the repository config (ADR-637), writes .git/info/attributes lines;
  - readers: `blobAt(dir, path)` (`cat-file blob :<path>` through `runGitBytes`), `looseObjectIds(dir)` (sorted ids under the objects directory, excluding pack and info), `enc(bytes)` (CR→`R`, LF→`N`, NUL→`0`, for readable diffs);
  - `reconstructSafecrlfLine(notice | error data)` — git's warning / fatal line from `path` + `loss` (design §D3.7), so tests compare to git's stderr without the library rendering text (ADR-249).
- `test/integration/eol-conversion-interop.test.ts` — `describe.skipIf(!GIT_AVAILABLE)('eol conversion interop', …)` with a git-only `Given the transcribed matrices` block proving the tables against git 2.55.0: every §D1.1 cell (blob bytes + warning-line count) and every §D1.2 cell (worktree bytes) produced by git alone match `ADD_MATRIX` / `CHECKOUT_MATRIX`. Later parts add the tsgit-vs-git blocks to this file.

Read-only: test/integration/interop-helpers.ts (`runGit`, `runGitBytes`, `git`, `tryRunGitWithExit`, `GIT_AVAILABLE`), test/integration/filter-clean-smudge-interop.test.ts (repo setup and timeout style: `SETUP_TIMEOUT`, `mkdtemp`, `realpath`, cleanup in `afterAll`).

### TDD steps
1. PIN — the git-only goldens ARE the pin: run them under git 2.55.0. A mismatch between git and the design's table is a hard-input conflict: stop and escalate `{ unit: 'Part 11', reason: <cell>, options }` — never edit the table to match silently.
2. GUARD the golden blocks pass (git reproduces §D1.1 and §D1.2 cell by cell; the `native` / unset-`core.eol` rows take `process.platform` into account).
3. REFACTOR — fixture builders small and pure; one `it.each` per matrix.

### Gate
```sh
PATH="<git-2.55.0>/bin:$PATH" npx vitest run test/integration/eol-conversion-interop.test.ts \
  && npx tsc --noEmit -p tsconfig.json \
  && ./node_modules/.bin/biome check test/integration/eol-interop-fixtures.ts test/integration/eol-conversion-interop.test.ts \
  && npx cspell --no-progress test/integration/eol-interop-fixtures.ts test/integration/eol-conversion-interop.test.ts
```
Traps: wireit caches `check:types` / `check:spelling` — the bare `tsc` / `cspell` above are the oracles; never pass cspell.json to cspell. Git 2.55.0 must be first on PATH (the local default may be 2.56).

### Commit
`test(eol): add the EOL interop fixtures and git goldens`

## Part 12 — `add` converts line endings and reports safecrlf notices

### Context
Route: §D3.5 rows "add literal + bulk". ADRs 952, 953. Edits:
- `src/application/commands/add.ts`:
  - `AddResult` (line 95) gains `readonly eolNotices: ReadonlyArray<EolNotice>`; every return (`addLiteralOnly` ≈ 172, `addAll`, `addByPathspec`) sets it (`[]` when none).
  - `addInScope` (line 120): keep `maybeBuildAttributeProvider(ctx)` (now always a check-in provider, Part 7) and read `readEolSettings(ctx)` once; thread `settings` through `Staging` (≈ 178) and `stageWalkedEntries` (263) → `processWalkEntry` → `stageOne` (585) → `stageFromStat` (606) → `writeCleanedBlob` (730).
  - Replace `cleanConversion` / `CleanConversion` / `UNCONVERTED` (≈ 745–772) by `resolveConversion(ctx, provider, path, settings, { eagerSectionValidation: true })`, symlink → `IDENTITY_CONVERSION`; the big-file-threshold condition (`!fresh.isSymbolicLink && !conversion.streams`) becomes `!isSymbolicLink && !streamsThroughFilter(conversion.filter)` (unchanged semantics).
  - `writeCleanedBlob` → `convertToGit(ctx, { path, bytes: raw, conversion, route: 'write', settings, indexBlob: previous?.id })` — `previous` is the stage-0 entry `stageFromStat` already has; returns `{ id, notice? }`; `stageFromStat` returns the entry plus the notice.
  - Notices in index order: literal — `stageLiterals` (189) iterates `[...validated].sort(comparePaths)`, push in that loop; bulk — the walk outcome carries the notice and `stagedOutcomes` (291) collects in walk order, never completion order. Under `core.safecrlf=true` the throw ends `stageLiterals` before `lock.commit` (index untouched; earlier blobs stay, as git). Bulk refusal already surfaces the earliest-walked failure; its exact object set is Part 13.
- `src/application/commands/index.ts` — line 22 becomes `export { type AddOptions, type AddResult, add } from './add.js';` plus `export type { EolNotice, RoundTripLoss } from '../../domain/eol/crlf-conversion.js';`.
- `test/unit/application/commands/add.test.ts` — the three `toEqual({ added, modified, removed })` assertions (lines ≈ 297, 630, 2628) gain `eolNotices: []`; new describes below.
- `test/integration/eol-conversion-interop.test.ts` — tsgit-vs-git blocks: §D1.1 matrix (blob ids per cell, notices count = git's warning-line count), §D1.3 add edges, §D1.4 heuristic, §D1.5 rows except `--renormalize`, §D1.6 add rows (notice / refusal reconstructed with `reconstructSafecrlfLine`; `crlf` / `loneLf` cross-checked against counts computed in the test from the fixture bytes; literal `add a1 b2 c3` refusal: index and loose-object set equal git's — `objects=1`, `a1`'s blob, no `c3` blob), §D1.8 configuration grammar (bad `core.autocrlf` / `core.safecrlf` refuse `add` and `status` on both tools; `core.eol=foo` accepted), §D1.9 collapse rows, the §D1.3 empty-blob row (`text eol=crlf` + `core.safecrlf=true` → exit 0, id `e69de29b…`) and symlink row (blob = raw target).
- `test/integration/filter-clean-smudge-interop.test.ts` — the add half of §D1.10 (`* text ident filter=t`, blob `ZN$Id$NaRNbN` on both tools; node only, the filter is a shell command).
- `reports/api.json` — regenerate (`AddResult` is public).

Read-only: Parts 9–10 modules; src/application/primitives/internal/clean-order.ts (unchanged here); test/unit/application/commands/fixtures.ts `seedRepo`.

### TDD steps
1. RED `add.test.ts` › `Given core.autocrlf input and a CRLF file` › `When add stages it literally` › `Then the staged blob is LF`; same for bulk (`all: true`). Fails: bytes staged raw.
2. GREEN — `resolveConversion` + `convertToGit` in `writeCleanedBlob`, settings threading.
3. RED `Given core.autocrlf true, a LF file b2 and a CRLF file a1` › `When add runs (literal, then bulk)` › `Then eolNotices is [{ path: 'b2', loss: 'lf-to-crlf', crlf: 0, loneLf: 2 }]`; `core.safecrlf false` → `[]`; a MIXED file under autocrlf true reports `lf-to-crlf` (CRLF-loss checked first, §D1.6). Fails: `eolNotices` absent. GREEN.
4. RED `Given core.safecrlf true` › `When add a1 b2 c3 (literal)` › `Then EOL_ROUND_TRIP_UNSAFE for b2` (try/catch `.data` field by field), index unchanged, `a1`'s blob present, no `c3` blob (memory adapter object store). Fails: no throw. GREEN by letting the throw propagate through `stageLiterals`.
5. RED `Given a committed CRLF text blob and text=auto` › `When add re-stages it with a new CRLF line` › `Then the blob keeps CRLF` (§D1.5 index rule via `previous.id`). Fails until `indexBlob` is passed. GREEN.
6. GUARD `Given a symlink whose target holds CRLF under '* text eol=crlf ident'` › `Then the blob is the raw target` (identity for symlinks).
7. Interop blocks (Context list); run them; fix divergences in `src/` only.
8. MEASURE — the bundle measurement (first part wiring `src/domain/eol` into a command); list failing rows in the hand-back report.
9. `npm run docs:json`; commit `reports/api.json`.

### Gate
```sh
npx vitest run test/unit/application/commands/add.test.ts test/unit/application/commands/add-clean-order.test.ts test/unit/application/commands/add-big-file-threshold.test.ts \
  && PATH="<git-2.55.0>/bin:$PATH" npx vitest run test/integration/eol-conversion-interop.test.ts test/integration/filter-clean-smudge-interop.test.ts \
  && npx tsc --noEmit -p tsconfig.json \
  && ./node_modules/.bin/biome check src/application/commands/add.ts src/application/commands/index.ts test/unit/application/commands/add.test.ts test/integration/eol-conversion-interop.test.ts test/integration/filter-clean-smudge-interop.test.ts \
  && npx cspell --no-progress src/application/commands/add.ts src/application/commands/index.ts test/unit/application/commands/add.test.ts test/integration/eol-conversion-interop.test.ts test/integration/filter-clean-smudge-interop.test.ts
```
Traps: wireit caches `check:types` / `check:spelling` — the bare `tsc` / `cspell` above are the oracles; never pass cspell.json to cspell. Git 2.55.0 first on PATH for the interop run.

### Commit
`feat(add): convert line endings and report safecrlf notices`

## Part 13 — `core.safecrlf=true`: bulk `add` writes blobs in index order

### Context
ADR-954; design §D3.7 is the specification (read it whole: "Ordering under `core.safecrlf=true`" and the `clean-order.ts` sketch). Edits:
- `src/application/primitives/internal/clean-order.ts` — today (97 lines): `CleanOrder { enlist, release }`, private `Sequence` with `admit`, `createSequence`, `enlistIn`, `releaseIn`, `advance`, `admitIn`, `withCleanOrder(ctx, body)`, `admitClean(ctx, path)`, `releaseClean(ctx, path)`, a `WeakMap<Context, Sequence>`. Add: `type OrderSpan = 'clean' | 'write'`; `withCleanOrder(ctx, body, span = 'clean')`; `CleanOrder.halt(path, error)`; `admitWrite(ctx, path): Promise<void>` (resolves at once unless a `'write'` span is open; rejects once halted); under `'write'` `releaseClean` is a no-op and `admitClean` resolves at once for the admitted path; a halt rejects every waiter enlisted after the halted path and every later `admitWrite` with that same error; paths before it are unaffected. Under `'clean'` nothing changes. Callers today: `admitClean` / `releaseClean` only from src/application/primitives/internal/apply-clean-filter.ts `runInOrder` (lines 37, 41); `withCleanOrder` from add.ts `dispatchInCleanOrder` (309) and status.ts (283, stays `'clean'`).
- `src/application/commands/add.ts` — `dispatchInCleanOrder` (304) opens `'write'` when `settings.safeCrlf === true`, else `'clean'`; `dispatchWalkEntry` (322) calls `order.halt(path, error)` instead of `release` when the stage failed under `'write'`; `writeCleanedBlob` awaits `admitWrite(ctx, path)` after `readContent` and before `convertToGit`, holding the turn through `writeObject` (released by `dispatchWalkEntry`'s `finally`).
- `test/unit/application/primitives/internal/clean-order.test.ts`, `test/unit/application/commands/add-clean-order.test.ts` (reuse `seedRepo`, `withSlowLstat`, `SETTLE_MS` and the log-driver helpers already in that file).
- `test/integration/eol-conversion-interop.test.ts` — bulk `add .` of the `a1` / `b2` / `c3` trio under `core.safecrlf=true` + `core.autocrlf=true`: refusal names `b2`, index and loose-object set equal git's (`objects=1`, `a1` only).

### TDD steps
1. RED `clean-order.test.ts` › `Given a write span with a, b, c enlisted` › `When admitWrite(c) and admitWrite(b) are awaited` › `Then b is admitted before c, each only after the previous release`. Fails: `admitWrite` not exported.
2. GREEN the span + `admitWrite`.
3. RED `Given a write span` › `When releaseClean(a) runs before a's blob is written` › `Then b is still waiting` (no-op); `When halt(b, err)` › `Then admitWrite(c) and the pending waiter for c reject with err, and a's earlier admission is unaffected`; `Given a clean span` › `Then admitWrite resolves at once`. Fails: no halt / releaseClean advances. GREEN.
4. RED `add-clean-order.test.ts` › `Given core.safecrlf true, core.autocrlf true, a1 CRLF (slow read), b2 LF, c3 CRLF` › `When add all` › `Then the refusal is b2's and the loose-object write spy saw a1's blob only` (a `ctx.fs` proxy recording writes under the objects directory); `Given core.safecrlf warn` › `Then a deferred first write is still pending when the next write starts` and `eolNotices` is `[{ path: 'b2', loss: 'lf-to-crlf', crlf: 0, loneLf: 2 }]`. Fails: writes concurrent under `true`. GREEN the add.ts wiring.
5. Interop bulk row; run.

### Gate
```sh
npx vitest run test/unit/application/primitives/internal/clean-order.test.ts test/unit/application/commands/add-clean-order.test.ts test/unit/application/commands/add.test.ts test/unit/application/commands/status-clean-order.test.ts \
  && PATH="<git-2.55.0>/bin:$PATH" npx vitest run test/integration/eol-conversion-interop.test.ts test/integration/filter-clean-order-interop.test.ts \
  && npx tsc --noEmit -p tsconfig.json \
  && ./node_modules/.bin/biome check src/application/primitives/internal/clean-order.ts src/application/commands/add.ts test/unit/application/primitives/internal/clean-order.test.ts test/unit/application/commands/add-clean-order.test.ts test/integration/eol-conversion-interop.test.ts \
  && npx cspell --no-progress src/application/primitives/internal/clean-order.ts src/application/commands/add.ts test/unit/application/primitives/internal/clean-order.test.ts test/unit/application/commands/add-clean-order.test.ts test/integration/eol-conversion-interop.test.ts
```
Traps: wireit caches `check:types` / `check:spelling` — the bare `tsc` / `cspell` above are the oracles; never pass cspell.json to cspell. Git 2.55.0 first on PATH for the interop run.

### Commit
`feat(add): write blobs in index order under core.safecrlf=true`

## Part 14 — `add({ renormalize: true })`

### Context
ADR-956; git `renormalize_tracked_files`. Edits:
- `src/application/commands/add.ts` — `AddOptions` (line 90) gains `readonly renormalize?: boolean` (public). `addInScope` dispatches to a new `addRenormalized(ctx, paths, provider, settings)` under the index lock: for each stage-0 index entry, in index order — skip unmerged stages, skip modes other than regular / executable / symlink, skip skip-worktree entries, skip entries outside the pathspec (reuse `resolvePathspec` and the matcher `addByPathspec` builds); then re-read and re-hash WITHOUT the stat-clean shortcut (`restagesAsIs` bypassed) through `convertToGit(…, route: 'renormalize')` (no safecrlf, index rule ignored); symlinks re-hash raw. Untracked paths are never added; the worktree is never written; `eolNotices` is always `[]`. `added` is empty; `modified` lists entries whose id changed.
- `test/unit/application/commands/add.test.ts` — a `Given the renormalize option` describe tree.
- `test/integration/eol-conversion-interop.test.ts` — §D1.5 last row (`text=auto` + `add --renormalize` → `aNbNcN`), §D1.5 status pair (`status` clean, then `add --renormalize .` stages `M  f`), §D1.6 `add --renormalize .` row, §D1.12 `add --renormalize` paragraph (sparse cone `in`/`out`, modified `m`, untracked `u`, worktree untouched).
- `reports/api.json` — regenerate (`AddOptions` is public).

### TDD steps
1. PIN — not pinned: (a) `git add --renormalize` with no pathspec (exit code, stderr, index), (b) `git add --renormalize -A` with an untracked file and a deleted tracked file (staged? removed?), (c) `git add --renormalize f` where `f` was deleted from the worktree. Record each as an interop row expectation; tsgit's empty-pathspec / `all` handling follows the pins (if (a) matches plain `git add`'s "Nothing specified", keep the existing `emptyPathspec` refusal).
2. RED `Given a committed CRLF blob under '* text=auto' and an untouched worktree` › `When add renormalize '.'` › `Then the entry's blob is LF and modified lists it` (the stat-clean entry is NOT skipped). Fails: option ignored (stat-clean path re-staged as-is).
3. GREEN `addRenormalized`.
4. RED skips: skip-worktree entry untouched; untracked file not added; unmerged stage untouched; worktree bytes unchanged; `eolNotices` `[]` under `core.safecrlf=true` with a lossy file (never refuses). Fails per guard until each skip lands (one isolated test per guard). GREEN.
5. RED the step-1 PIN rows that differ from the current behaviour. GREEN.
6. Interop rows; `npm run docs:json`; commit `reports/api.json`.

### Gate
```sh
npx vitest run test/unit/application/commands/add.test.ts \
  && PATH="<git-2.55.0>/bin:$PATH" npx vitest run test/integration/eol-conversion-interop.test.ts \
  && npx tsc --noEmit -p tsconfig.json \
  && ./node_modules/.bin/biome check src/application/commands/add.ts test/unit/application/commands/add.test.ts test/integration/eol-conversion-interop.test.ts \
  && npx cspell --no-progress src/application/commands/add.ts test/unit/application/commands/add.test.ts test/integration/eol-conversion-interop.test.ts
```
Traps: wireit caches `check:types` / `check:spelling` — the bare `tsc` / `cspell` above are the oracles; never pass cspell.json to cspell. Git 2.55.0 first on PATH for the interop run.

### Commit
`feat(add): add the renormalize option`

## Part 15 — Comparison routes compare converted bytes (status, rm, clean-work-tree, would-overwrite, racy smudge)

### Context
Route: §D3.5 rows "status, rm, …" and "racy-clean smudge" (git `ce_compare_data`, no object write, safecrlf never). Edits:
- `src/application/primitives/compare-working-tree-entry.ts` — `cleanWorktreeBytes` (line ≈ 73) becomes the conversion step: `settings = await readEolSettings(ctx)`, `conversion = await resolveConversion(ctx, provider ?? EMPTY_PROVIDER, entry.path, settings, { eagerSectionValidation: true })`, `bytes = (await convertToGit(ctx, { path, bytes: raw, conversion, route: 'compare', settings, indexBlob: entry.id })).bytes`. `EMPTY_PROVIDER` (module constant: `sourcesForPath` → no sources, empty macro registry) keeps `core.autocrlf` applying when a caller passes no provider (public `compareWorkingTreeEntry(ctx, entry)`). The existing symlink rule stays (targets hashed raw, R12). `streamsThroughDriver` (≈ 118) and `readThresholdBeforeHashing` keep their semantics, reading `conversion.filter`. `statOnlyVerdict` (≈ 95) — see PIN step 1.
- Callers are untouched: status.ts:188, rm.ts:160, stash.ts:150, internal/clean-work-tree.ts:59, find-would-overwrite.ts:109, internal/smudge-racily-clean.ts:117 all pass the provider from `maybeBuildAttributeProvider`, which is the check-in provider since Part 7 (DC-2).
- `test/unit/application/primitives/compare-working-tree-entry.test.ts`, `test/unit/application/primitives/internal/smudge-racily-clean.test.ts`.
- `test/integration/status-racy-clean-interop.test.ts` — §D1.13 racy rows (`autocrlf=true` checkout, `update-index --really-refresh`, then status: with autocrlf the entry keeps size 6; without, smudged to 0). Use git to produce the worktree (tsgit checkout converts only from Part 17).
- `test/integration/eol-conversion-interop.test.ts` — status rows: §D1.5 (`status=[]` with index CRLF + new `text=auto`), §D1.13 (LF blob checked out CRLF by git under `autocrlf=true` → tsgit status clean; without autocrlf → ` M f`; index CRLF + autocrlf; `text eol=crlf` LF worktree), §D1.9 (git-expanded `$Id: <oid> $` worktree reads clean; foreign ident row reads ` M a`).

Read-only: src/application/primitives/internal/is-entry-stat-clean.ts (`isEntryStatClean`, size comparison at line ≈ 56).

### TDD steps
1. PIN — the `statOnlyVerdict` size shortcut (memory: unpinned in the design): `statOnlyVerdict` reports `modified` whenever `entry.fileSize !== stat.size`, while git falls back to a content compare when the recorded size is 0 (`ie_modified`). Probe with git 2.55.0 in a throwaway: `core.autocrlf=true`, commit LF `f`, `checkout -- f` (CRLF worktree), then (i) `reset -q --mixed HEAD~1`-style index rewrites, (ii) `read-tree HEAD`, (iii) `update-index --index-info` with the blob size — record `ls-files --debug` size and `status --porcelain` for each. Then list every tsgit route that records an index `fileSize` without stat-ing the converted file (grep `fileSize:` in src/application) and whether tsgit's status matches git on each. Record the git rows as interop expectations; a tsgit mismatch becomes a RED here.
2. RED `compare-working-tree-entry.test.ts` › `Given an LF blob, core.autocrlf true and a CRLF worktree file with a non-stat-clean entry` › `When compared` › `Then unchanged`; `Given no autocrlf` › `Then modified`; `Given no provider and core.autocrlf true` › `Then unchanged` (EMPTY_PROVIDER arm). Fails: raw bytes hashed.
3. GREEN the conversion step.
4. RED `Given an index CRLF text blob, '* text=auto' and the same CRLF worktree` › `Then unchanged` (index rule via `indexBlob: entry.id`); `Given core.safecrlf true and a lossy worktree file` › `Then no throw` (route compare). Fails until `indexBlob` / route are passed. GREEN.
5. RED (if step 1 found a mismatch) the `statOnlyVerdict` row reproducing git; GREEN the minimal fix (e.g. a recorded size 0 falls through to the content compare). Otherwise GUARD the pinned rows.
6. RED `smudge-racily-clean.test.ts` › `Given core.autocrlf true, a racily-clean entry for an LF blob and its CRLF checkout` › `When smudging racily-clean entries` › `Then the entry is kept (size unchanged)` — §D1.13; fails before step 3 lands only if run first; after step 3 it is a GUARD (write it as GUARD, citing that `compareWorkingTreeDelta` now converts).
7. Interop rows; run.

### Gate
```sh
npx vitest run test/unit/application/primitives/compare-working-tree-entry.test.ts test/unit/application/primitives/internal/smudge-racily-clean.test.ts test/unit/application/commands/status.test.ts test/unit/application/commands/status-clean-order.test.ts test/unit/application/commands/rm.test.ts test/unit/application/commands/internal/clean-work-tree.test.ts test/unit/application/primitives/find-would-overwrite.test.ts \
  && PATH="<git-2.55.0>/bin:$PATH" npx vitest run test/integration/status-racy-clean-interop.test.ts test/integration/eol-conversion-interop.test.ts \
  && npx tsc --noEmit -p tsconfig.json \
  && ./node_modules/.bin/biome check src/application/primitives/compare-working-tree-entry.ts test/unit/application/primitives/compare-working-tree-entry.test.ts test/unit/application/primitives/internal/smudge-racily-clean.test.ts test/integration/status-racy-clean-interop.test.ts test/integration/eol-conversion-interop.test.ts \
  && npx cspell --no-progress src/application/primitives/compare-working-tree-entry.ts test/unit/application/primitives/compare-working-tree-entry.test.ts test/unit/application/primitives/internal/smudge-racily-clean.test.ts test/integration/status-racy-clean-interop.test.ts test/integration/eol-conversion-interop.test.ts
```
Traps: wireit caches `check:types` / `check:spelling` — the bare `tsc` / `cspell` above are the oracles; never pass cspell.json to cspell. Git 2.55.0 first on PATH; racy rows need > 1 s settle sleeps (git's racy guard is second-resolution).

### Commit
`feat(status): compare converted working-tree bytes`

## Part 16 — `stash push` converts line endings

### Context
Route: §D3.5 row "stash push W-tree" (git `index_path` + write; safecrlf armed). ADRs 952, 953, 954. Edits:
- `src/application/commands/stash.ts`:
  - `StashPushResult` (line 80) saved variant gains `readonly eolNotices: ReadonlyArray<EolNotice>` (public); `no-local-changes` unchanged.
  - `hashFileAt(ctx, workDir, path, stat)` (line 123; today raw read + `hashBlob(ctx, content, { write: true })`, no clean step) takes a conversion scope `{ provider, settings, indexBlob? }` and returns `{ id, mode, notice? }`: symlink → raw; regular → `resolveConversion` + `convertToGit(…, route: 'write')`. `core.safecrlf=true` throws `EOL_ROUND_TRIP_UNSAFE` — stash push writes no stash commit and no ref (git: "Cannot save the current worktree state").
  - `projectWorkingTree` (143) already iterates `index.entries` serially in index order with `provider = await maybeBuildAttributeProvider(ctx)`; pass `indexBlob: entry.id` and collect notices in that order. `collectUntracked` (≈ 201, `stash -u`) also goes through `hashFileAt` (no `indexBlob`) — PIN step 1 decides notice order.
  - The push flow (≈ 236–272) returns `{ kind: 'saved', stash, message, eolNotices }`.
- `test/unit/application/commands/stash.test.ts`.
- `test/integration/stash-interop.test.ts` — §D1.13 stash row (`autocrlf=true`, worktree `a\r\nb\r\nc\r\n` → stash blob `aNbNcN`); §D1.6 rows `stash` under `core.safecrlf=true` (refused, compare loose blobs with git) and under default `warn` (one notice, saved).
- `reports/api.json` — regenerate.

### TDD steps
1. PIN — (a) the full loose-object set git leaves after a `core.safecrlf=true` refused `stash push` (blobs AND any tree/commit objects; design §Test strategy asks for it); (b) `git stash push -u` with an untracked CRLF file and a tracked LF edit under `core.autocrlf=true`: untracked blob bytes, warning lines and their order. Record as stash-interop expectations. A non-blob object difference between git and tsgit's natural behaviour is a finding: escalate `{ unit: 'Part 16', reason, options }` before coding around it.
2. RED `stash.test.ts` › `Given core.autocrlf true and a CRLF edit of an LF-tracked file` › `When stash push` › `Then the W-tree blob is LF`. Fails: raw bytes hashed.
3. GREEN conversion in `hashFileAt` with the scope.
4. RED `Given core.autocrlf true and an LF edit` › `Then the saved result's eolNotices is [{ path, loss: 'lf-to-crlf', crlf: 0, loneLf: n }]`; `Given core.safecrlf true` › `Then EOL_ROUND_TRIP_UNSAFE (try/catch .data) and refs/stash is absent and the worktree unchanged`; `Given core.safecrlf false` › `[]`. Fails: no notices / no refusal. GREEN.
5. RED / GUARD the step-1 (b) order row for `-u`. GREEN if needed.
6. Interop rows; `npm run docs:json`; commit `reports/api.json`.

### Gate
```sh
npx vitest run test/unit/application/commands/stash.test.ts \
  && PATH="<git-2.55.0>/bin:$PATH" npx vitest run test/integration/stash-interop.test.ts \
  && npx tsc --noEmit -p tsconfig.json \
  && ./node_modules/.bin/biome check src/application/commands/stash.ts test/unit/application/commands/stash.test.ts test/integration/stash-interop.test.ts \
  && npx cspell --no-progress src/application/commands/stash.ts test/unit/application/commands/stash.test.ts test/integration/stash-interop.test.ts
```
Traps: wireit caches `check:types` / `check:spelling` — the bare `tsc` / `cspell` above are the oracles; never pass cspell.json to cspell. Git 2.55.0 first on PATH for the interop run.

### Commit
`feat(stash): convert line endings on stash push`

## Part 17 — Checkout writes convert blobs (streamed or in core, by class)

### Context
Route: §D3.5 row "switch, reset --hard, clone, worktree add, sparse apply, path restore" (git `checkout_entry`). ADRs 950, 955; R8, R11, R12. Creates / edits:
- `src/application/primitives/internal/write-converted-entry.ts` (create, internal) — the single to-worktree writer every route uses (ADR-950: no call site composes steps):
  ```ts
  export interface WorkingTreeWriterScope {
    readonly provider: () => Promise<AttributeProvider>;
    readonly settings: () => Promise<EolSettings>;
    readonly limiter: ConcurrencyLimiter;          // bounds smudge subprocesses (cpuBound)
    readonly metadata?: CheckoutMetadata;
  }
  export interface WorkingTreeWriter {
    readonly writeBlob: (path: FilePath, id: ObjectId, mode: FileMode, scanner?: LeadingPathScanner) => Promise<void>;
    readonly writeBytes: (path: FilePath, bytes: Uint8Array, mode: FileMode, scanner?: LeadingPathScanner) => Promise<void>;
  }
  export const createWorkingTreeWriter = (ctx: Context, scope: WorkingTreeWriterScope): WorkingTreeWriter;
  ```
  `writeBlob`: GITLINK → today's empty entry; SYMLINK → raw blob (both moved verbatim from `writeBlobToWorkingTree`); else `resolveConversion(…, { eagerSectionValidation: true })`; `convertsInCore` → `readBlob` → `convertToWorkingTree` (under `scope.limiter` only when `smudgesInCore(conversion.filter)`, as today) → `writeWorkingTreeEntry` (a refused read leaves no file, §D1.11 `text=auto`); otherwise `writeWorkingTreeEntryStream(…, workingTreeStreamTransform(conversion, id, settings))` (refused open leaves the empty file, §D1.11). `writeBytes` (used from Part 19 by merge-family in-memory bytes): identity → write as is; in core → `convertToWorkingTree` with `target.blob` from `serializeAndHash` of the bytes; streamed class → run the stream transform over `[bytes]` (push + flush) so the streamed ident expander applies (§D3.5 merge-family row).
- `src/application/primitives/apply-changeset.ts` — `writeBlobToWorkingTree` (line 224) delegates to a writer built once per apply in `applyChangesetInScope` (≈ 553) from `createLazyProvider` (532; now always a provider), a lazy `readEolSettings`, and `createSmudging`'s limiter/metadata. The dirty probe: `blobMatches` (90) / public `isWorkingTreeDirty(ctx, absPath, expectedId)` (119, public — signature unchanged) compare through `convertToGit(…, route: 'compare', indexBlob: expectedId)` with the check-in provider (git's `verify_uptodate` runs before the checkout direction is set); derive the repo-relative path from `absPath` and `ctx.layout.workDir`; symlinks raw. Add an internal variant taking a prebuilt provider/settings so `checkDirty` (≈ 140) does not rebuild them per entry.
- `test/unit/application/primitives/internal/write-converted-entry.test.ts` (create), `test/unit/application/primitives/apply-changeset.test.ts`.
- `test/integration/eol-conversion-interop.test.ts` — §D1.2 checkout matrix (tsgit `checkout(ctx, { paths })`-style path restore vs `git checkout --`, all cells), §D1.3 checkout edges + symlink row (link target unchanged), §D1.9 streamed rows (`ident`, `ident eol=crlf`, `ident -text`) vs in-core row (`ident text=auto`), sha256 width, §D1.11 corrupt loose object residue (`eol=crlf` / `ident` → empty file; `text=auto` → no file).
- `test/integration/filter-clean-smudge-interop.test.ts` — the checkout half of §D1.10 (`autocrlf=true`, smudge `tr 'R$\r' 'r#R'` receives CRs and the expanded `$Id: <oid> $`).

Read-only: Part 10 `convertToWorkingTree`, `workingTreeStreamTransform`; src/application/primitives/internal/write-working-tree-file.ts `writeWorkingTreeEntry`, `writeWorkingTreeEntryStream`.

### TDD steps
1. RED `write-converted-entry.test.ts` › `Given '* eol=crlf' and an LF blob` › `When writeBlob` › `Then the file holds CRLF and writeWorkingTreeEntryStream received a transform` (spy on the captured argument — R11 wiring); `Given no attributes and autocrlf false` › `Then no transform is passed`. Fails: module does not exist.
2. GREEN streamed arm + identity arm.
3. RED `Given '* text=auto' and core.autocrlf true` › `Then the blob is read in core and written converted` (spy: `writeWorkingTreeEntry` called, stream writer not); the divergence blob under `ident text=auto` → in-core expander bytes; under `ident` → streamed expander bytes. Fails: in-core arm missing. GREEN.
4. RED `writeBytes` rows: identity, streamed `ident` over in-memory bytes, in-core `auto-crlf`. Fails: not implemented. GREEN.
5. RED `apply-changeset.test.ts` › `Given core.autocrlf true, an LF blob checked out as CRLF and a switch that rewrites the path` › `When applyChangeset (not forced)` › `Then no would-overwrite refusal` (dirty probe converts); and `isWorkingTreeDirty` public signature row. Fails: raw hash says dirty. GREEN; delegate `writeBlobToWorkingTree`.
6. GUARD symlink and gitlink rows (unchanged writes); existing smudge-filter tests in apply-changeset.test.ts pass through the writer.
7. Interop rows; run.

### Gate
```sh
npx vitest run test/unit/application/primitives/internal/write-converted-entry.test.ts test/unit/application/primitives/apply-changeset.test.ts test/unit/application/primitives/materialize-tree.test.ts test/unit/application/commands/checkout.test.ts \
  && PATH="<git-2.55.0>/bin:$PATH" npx vitest run test/integration/eol-conversion-interop.test.ts test/integration/filter-clean-smudge-interop.test.ts \
  && npx tsc --noEmit -p tsconfig.json \
  && ./node_modules/.bin/biome check src/application/primitives/internal/write-converted-entry.ts src/application/primitives/apply-changeset.ts test/unit/application/primitives/internal/write-converted-entry.test.ts test/unit/application/primitives/apply-changeset.test.ts test/integration/eol-conversion-interop.test.ts test/integration/filter-clean-smudge-interop.test.ts \
  && npx cspell --no-progress src/application/primitives/internal/write-converted-entry.ts src/application/primitives/apply-changeset.ts test/unit/application/primitives/internal/write-converted-entry.test.ts test/unit/application/primitives/apply-changeset.test.ts test/integration/eol-conversion-interop.test.ts test/integration/filter-clean-smudge-interop.test.ts
```
Traps: wireit caches `check:types` / `check:spelling` — the bare `tsc` / `cspell` above are the oracles; never pass cspell.json to cspell. Git 2.55.0 first on PATH for the interop run.

### Commit
`feat(checkout): convert blobs written to the working tree`

## Part 18 — Checkout reads attributes in git's checkout direction

### Context
ADR-951; DC-4 option (a); pins §D1.7. Edits:
- `src/application/primitives/apply-changeset.ts` — export internal `applyChangesetWithAttributes(ctx, opts: ApplyChangesetOpts, direction: AttributeDirection)` (not in src/application/primitives/index.ts); public `applyChangeset(ctx, opts)` (line 509) keeps the check-in default (`maybeBuildAttributeProvider`). The writer's provider (Part 17) is `buildAttributeProvider(ctx, direction)`; the dirty probe keeps the check-in provider.
- `src/application/primitives/materialize-tree.ts` — `materializeTree` (≈ line 234) chooses the direction from `planMaterialize` (≈ 200): `opts.paths !== undefined` (path restore: `checkout [<rev>] -- <p>`) → `worktree-first` over the current index overlaid with `plan.target` for the restored paths; otherwise (switch, reset --hard, clone, worktree add, merge fast-forward, stash, pull) → `index-first` over the RESULT index — `plan.target` plus `plan.excluded` (sparse) `.gitattributes` ids. Then calls `applyChangesetWithAttributes`.
- `src/application/commands/internal/apply-sparse-checkout.ts` — the `applyChangeset` call at line ≈ 207 becomes `applyChangesetWithAttributes(…, { kind: 'index-first', index: <current index .gitattributes lookup> })` (git's sparse reapply is an `unpack_trees` checkout).
- `test/unit/application/primitives/materialize-tree.test.ts`, `test/unit/application/commands/internal/apply-sparse-checkout.test.ts`.
- `test/integration/eol-conversion-interop.test.ts` — the §D1.7 checkout rows on both tools: switch introducing `*.txt eol=crlf`; index `eol=crlf` vs worktree `eol=lf` for `checkout -- f.txt` and `checkout HEAD -- f.txt` (worktree wins), `reset --hard` and `checkout -f HEAD` (index wins); worktree `.gitattributes` deleted (index fallback); untracked worktree `.gitattributes` with nothing in the index + `reset --hard` (worktree fallback). (`restore` / `checkout-index` have no tsgit surface.)

### TDD steps
1. RED `materialize-tree.test.ts` › `Given index .gitattributes '*.txt eol=crlf', worktree '*.txt eol=lf' and an LF f.txt blob` › `When materializeTree rewrites f.txt for a target tree` › `Then f.txt is CRLF` (index wins); `When restoring paths ['f.txt']` › `Then LF` (worktree wins). Fails: the default check-in provider is used for both.
2. GREEN `applyChangesetWithAttributes` + the direction choice.
3. RED `Given a target tree that introduces '*.txt eol=crlf'` › `Then the switch writes f.txt CRLF` (result-index lookup, §D1.7 first row); `Given only an untracked worktree .gitattributes` › `Then reset-style materialisation uses it` (worktree fallback). Fails until the result-index lookup covers `plan.target` / `plan.excluded`. GREEN.
4. RED `apply-sparse-checkout.test.ts` › `Given index '*.txt eol=crlf' and worktree '*.txt eol=lf'` › `When a path enters the cone` › `Then it is written CRLF`. Fails: check-in default. GREEN.
5. Interop §D1.7 rows; run.

### Gate
```sh
npx vitest run test/unit/application/primitives/materialize-tree.test.ts test/unit/application/commands/internal/apply-sparse-checkout.test.ts test/unit/application/primitives/apply-changeset.test.ts test/unit/application/commands/checkout.test.ts test/unit/application/commands/reset.test.ts \
  && PATH="<git-2.55.0>/bin:$PATH" npx vitest run test/integration/eol-conversion-interop.test.ts \
  && npx tsc --noEmit -p tsconfig.json \
  && ./node_modules/.bin/biome check src/application/primitives/materialize-tree.ts src/application/primitives/apply-changeset.ts src/application/commands/internal/apply-sparse-checkout.ts test/unit/application/primitives/materialize-tree.test.ts test/unit/application/commands/internal/apply-sparse-checkout.test.ts test/integration/eol-conversion-interop.test.ts \
  && npx cspell --no-progress src/application/primitives/materialize-tree.ts src/application/primitives/apply-changeset.ts src/application/commands/internal/apply-sparse-checkout.ts test/unit/application/primitives/materialize-tree.test.ts test/unit/application/commands/internal/apply-sparse-checkout.test.ts test/integration/eol-conversion-interop.test.ts
```
Traps: wireit caches `check:types` / `check:spelling` — the bare `tsc` / `cspell` above are the oracles; never pass cspell.json to cspell. Git 2.55.0 first on PATH for the interop run. Run `npm run docs:json` — no api.json churn expected (DC-4).

### Commit
`feat(checkout): read attributes in git's checkout direction`

## Part 19 — Merge-family working-tree writes convert (and smudge)

### Context
Route: §D3.5 row "merge, cherry-pick, revert, rebase, pull, stash apply/pop outcome writes" — today these writes run neither conversion nor smudge (adopted under ADR-226, design §D3.5 note). Every write goes through the Part 17 `WorkingTreeWriter`, provider `index-first` over the merge RESULT. Edits:
- `src/application/commands/merge.ts` — `writeOutcomeToTree` (line ≈ 1743): `unchanged` / `resolved-known` → `writer.writeBlob(path, id, mode, scanner)`; `resolved-merged` → `writer.writeBytes(path, bytes, mode, scanner)`; `writeConflictToTree` (≈ 1783): marker bytes → `writer.writeBytes`; `distinct-types` → `writeDistinctTypesSides` with the writer. Thread one writer per merge from the callers (`grep -n "writeOutcomeToTree\|writeConflictToTree" src -r`).
- `src/application/primitives/apply-merge-to-worktree.ts` — `writeChangedOutcome` (185) and `writeMarkedConflict` (154, exported) the same way; `writeConflictWorktree` (239) builds the writer once (its scanner is already shared). The clean path already goes through `materializeTree` (index-first since Part 18).
- `src/application/primitives/internal/write-distinct-types-sides.ts` — `writeDistinctTypesSides` (line 13) writes both sides through `writer.writeBlob` (the `~ours` / `~theirs` paths resolve their own attributes).
- `src/application/commands/stash.ts` — the untracked restore loop (≈ line 445, `writeWorkingTreeFileStream` per untracked entry) → `writer.writeBlob` with `index-first` over that untracked tree's entries (git restores untracked files through a checkout of a temporary index).
- `test/unit/application/primitives/apply-merge-to-worktree.test.ts`.
- `test/integration/eol-conversion-interop.test.ts` — §D1.13 merge rows under `core.autocrlf=true` (conflict worktree `<<<<<<< HEAD\r\ny\r\n=======\r\nx\r\n>>>>>>> s\r\nb\r\n`; clean-merged worktree `xRNbRNyRN`, blob `xNbNyN`), §D1.13 stash pop row (`wt=[aRNbRNcRN]`, `status=[ M f]`), the PIN rows of step 1.

Result-index lookup for merge writes: from the merge outcomes — `unchanged` / `resolved-known` → their id; `resolved-merged` → id of the merged bytes (`serializeAndHash`); a content-conflicted `.gitattributes` → PIN step 1.

### TDD steps
1. PIN — not pinned (design §D3.4): which `.gitattributes` content governs conversion of the merge-family WRITES when `.gitattributes` itself is content-conflicted (the marker-bearing result blob, or a stage?). Probe: base `* text`, ours and theirs change the same line of `.gitattributes` differently (`* text eol=crlf` vs `* text eol=lf`), both sides edit `f` in a way that merges cleanly or conflicts; record `f`'s worktree bytes per case under `merge` (and `cherry-pick`). Record as interop expectations and implement the lookup to match.
2. RED `apply-merge-to-worktree.test.ts` › `Given core.autocrlf true and a content conflict` › `When the merge is applied` › `Then the conflict markers and lines are CRLF in the worktree`; `Given a clean content merge` › `Then the worktree is CRLF and the index blob LF`. Fails: bytes written raw.
3. GREEN `writeChangedOutcome` / `writeMarkedConflict` through the writer.
4. RED `Given a [filter "up"] smudge driver (fake runner) and a merged path` › `Then the smudge driver received the merged bytes` (merge writes gain smudge). Fails before step 3 only — after step 3 it is a GUARD (write as GUARD, citing the writer).
5. RED merge.ts arms: a unit row through `merge(ctx, …)` on the memory adapter with `core.autocrlf true` (conflicted and clean). Fails: merge.ts writes raw. GREEN; then write-distinct-types-sides and the stash untracked restore (RED via an apply-merge-to-worktree distinct-types row; the stash row is pinned by interop).
6. Interop rows; run.

### Gate
```sh
npx vitest run test/unit/application/primitives/apply-merge-to-worktree.test.ts test/unit/application/commands/merge.test.ts test/unit/application/commands/stash.test.ts test/unit/application/commands/cherry-pick.test.ts \
  && PATH="<git-2.55.0>/bin:$PATH" npx vitest run test/integration/eol-conversion-interop.test.ts test/integration/stash-interop.test.ts \
  && npx tsc --noEmit -p tsconfig.json \
  && ./node_modules/.bin/biome check src/application/commands/merge.ts src/application/primitives/apply-merge-to-worktree.ts src/application/primitives/internal/write-distinct-types-sides.ts src/application/commands/stash.ts test/unit/application/primitives/apply-merge-to-worktree.test.ts test/integration/eol-conversion-interop.test.ts \
  && npx cspell --no-progress src/application/commands/merge.ts src/application/primitives/apply-merge-to-worktree.ts src/application/primitives/internal/write-distinct-types-sides.ts src/application/commands/stash.ts test/unit/application/primitives/apply-merge-to-worktree.test.ts test/integration/eol-conversion-interop.test.ts
```
Traps: wireit caches `check:types` / `check:spelling` — the bare `tsc` / `cspell` above are the oracles; never pass cspell.json to cspell. Git 2.55.0 first on PATH; pin `merge.conflictStyle=merge` in both repos.

### Commit
`feat(merge): convert merge-family working-tree writes`

## Part 20 — `blame` worktree side and `archive` entries convert

### Context
Routes: §D3.5 rows "blame worktree side" (to-git, check-in, safecrlf never) and "archive" (to-worktree, tree attributes, always in core, in-core ident expander, BEFORE `export-subst`). Edits:
- `src/application/commands/blame.ts` — `readWorkingFile(ctx, workDir, path)` (line 255): symlink raw (unchanged); regular → `convertToGit(…, route: 'compare', indexBlob: <stage-0 entry id of path, if any>)` with `maybeBuildAttributeProvider(ctx)` and `readEolSettings(ctx)` built once per blame (git `fake_working_tree_commit` converts with the index).
- `src/application/commands/archive.ts` — `createAttributeCheck` (≈ 154) and the content read share ONE tree provider (`buildAttributeProvider(ctx, { kind: 'tree', tree })`, Part 7). `readEntryContent` (168): regular files resolve the conversion (settings from `readEolSettings`); identity → today's path (`readRegularContent`, which may stream); otherwise `readInCore` → `convertToWorkingTree(ctx, { target: { path, blob: entry.id, bytes }, conversion, settings })` (ident in-core expander, LF→CRLF, smudge) → then `subst.expandFile` when `export-subst` is set (git `archive.c` order).
- `test/unit/application/commands/blame.test.ts`, `test/unit/application/commands/archive.test.ts`.
- `test/integration/archive-interop.test.ts` — §D1.7 archive rows (tree `*.txt eol=crlf` wins over a worktree `-text -ident`; .git/info/attributes `*.dat eol=crlf`; no attribute + `core.autocrlf=true`), tar and zip; §D1.9 archive in-core expander row for the divergence blob.
- `test/integration/eol-conversion-interop.test.ts` — §D1.13 blame rows (`autocrlf=true` CRLF worktree → three lines, lines 1–2 attributed to the commit; no conversion → all three uncommitted).

### TDD steps
1. RED `blame.test.ts` › `Given core.autocrlf true, a committed LF file and its CRLF worktree copy with a third line` › `When blame runs on the working tree` › `Then lines 1–2 are attributed to the commit and line 3 is uncommitted`. Fails: raw CRLF lines differ from the committed LF lines.
2. GREEN blame conversion.
3. RED `archive.test.ts` › `Given a tree with '*.txt eol=crlf' and an LF f.txt` › `When archived` › `Then the entry content is CRLF`; `Given '* ident'` › in-core expander bytes for the divergence blob; `Given export-subst and eol=crlf` › conversion runs before substitution. Fails: content read raw.
4. GREEN archive conversion with the shared provider.
5. GUARD identity paths keep `readRegularContent` (spy: `readInCore` not called for an unattributed path).
6. Interop rows; run.

### Gate
```sh
npx vitest run test/unit/application/commands/blame.test.ts test/unit/application/commands/archive.test.ts test/unit/application/commands/archive-revision-reads.test.ts \
  && PATH="<git-2.55.0>/bin:$PATH" npx vitest run test/integration/archive-interop.test.ts test/integration/eol-conversion-interop.test.ts \
  && npx tsc --noEmit -p tsconfig.json \
  && ./node_modules/.bin/biome check src/application/commands/blame.ts src/application/commands/archive.ts test/unit/application/commands/blame.test.ts test/unit/application/commands/archive.test.ts test/integration/archive-interop.test.ts test/integration/eol-conversion-interop.test.ts \
  && npx cspell --no-progress src/application/commands/blame.ts src/application/commands/archive.ts test/unit/application/commands/blame.test.ts test/unit/application/commands/archive.test.ts test/integration/archive-interop.test.ts test/integration/eol-conversion-interop.test.ts
```
Traps: wireit caches `check:types` / `check:spelling` — the bare `tsc` / `cspell` above are the oracles; never pass cspell.json to cspell. Git 2.55.0 first on PATH; zip rows run with `TZ=UTC` as the existing zip suites do.

### Commit
`feat(eol): convert blame's working-tree side and archive entries`

## Part 21 — Tree merge: modify/delete resolves when the blob is unchanged after renormalization

### Context
ADR-956 (git merge-ort `process_entry` modify/delete arm + `blob_unchanged`); DC-3 option (a). Public (`mergeTrees` is exported from src/domain/merge/index.ts). Edits:
- `src/domain/merge/three-way-tree.ts` — `export type BlobUnchanged = (path: FilePath, base: FlatTreeEntry, side: FlatTreeEntry) => Promise<boolean>;` `mergeTrees(base, ours, theirs, contentMerger, labels?, renames?, variant?, blobUnchanged?)` (line 655) stores it on `PathScope` (≈ line 508, today `{ labels, reserved, variant }`). `resolvePath` (515) passes the scope to `resolveOneSideAbsent` (141), which becomes async-capable: base present and `!entriesEqual(base, present)` → when `scope.blobUnchanged` is set and `base.mode === present.mode` and `await scope.blobUnchanged(path, base, present)` → `{ status: 'resolved-deleted', path }`; otherwise today's `modifyDeleteConflict`. Rename involvement keeps the conflict (ort's `path_conflict`): rename/delete arrives as a forced conflict (`settleSplitRenames` / `forcedConflicts`, never reaching `resolveOneSideAbsent`), and `resolvePaths` (716) must not consult the callback for `located.fileLocations` paths (they stay conflicted through `asFileLocation`) — verify both with a test. git's `blob_unchanged` semantics live in the callback (Part 22): mode check first, equal ids → unchanged, else compare renormalized bytes.
- `src/domain/merge/index.ts` — line 43 becomes `export type { BlobUnchanged, ContentMerger } from './three-way-tree.js';`.
- `test/unit/domain/merge/three-way-tree.test.ts` — a `Given a blobUnchanged callback` describe tree.
- `reports/api.json` — regenerate.

Pins reproduced (unit level; cross-tool in Part 24): §D1.12 modify/delete rows (`merge side` → `CONFLICT (modify/delete)`; `-X renormalize` → clean, `f` stays deleted).

### TDD steps
1. RED `Given base f, ours deletes f, theirs changes f, and a callback answering true` › `When mergeTrees` › `Then f resolves deleted and the merge is clean`. Fails: the eighth argument is ignored (modify/delete conflict).
2. GREEN — scope field + async `resolveOneSideAbsent` arm.
3. RED isolated guards: callback answering false → conflict; modes differ → conflict without calling the callback (`vi.fn`, not called); no callback → conflict (today's behaviour, GUARD); the mirrored side (theirs deletes) → resolved-deleted. Fails per guard until each condition lands. GREEN.
4. RED `Given a directory-rename file location for f` › `Then f stays conflicted and the callback is not consulted`; GUARD rename/delete stays conflicted (forced conflict path).
5. GUARD three-way-tree.properties.test.ts passes unchanged (optional parameter).
6. `npm run docs:json`; commit `reports/api.json`.

### Gate
```sh
npx vitest run test/unit/domain/merge/three-way-tree.test.ts test/unit/domain/merge/three-way-tree.properties.test.ts test/unit/domain/merge/three-way-content.test.ts \
  && npx tsc --noEmit -p tsconfig.json \
  && ./node_modules/.bin/biome check src/domain/merge/three-way-tree.ts src/domain/merge/index.ts test/unit/domain/merge/three-way-tree.test.ts \
  && npx cspell --no-progress src/domain/merge/three-way-tree.ts src/domain/merge/index.ts test/unit/domain/merge/three-way-tree.test.ts
```
Traps: wireit caches `check:types` / `check:spelling` — the bare `tsc` / `cspell` above are the oracles; never pass cspell.json to cspell.

### Commit
`feat(merge): resolve modify/delete when renormalized blobs match`

## Part 22 — Content merger normalizes sides; `merge.renormalize` read

### Context
ADR-956; design §D3.8, §D1.12. Internal. Creates / edits:
- `src/application/primitives/internal/merge-rename-config.ts` — `readMergeRenormalize(ctx): Promise<boolean | undefined>` beside `readConflictStyle` (line 109): `findLastEntry(ctx, 'merge', 'renormalize')`; valueless → true; `parseGitBoolean` failure → throw `configBadBooleanValue(key, source, value)` (§D1.8: `bad boolean config value 'foo' for 'merge.renormalize'`); absent → `undefined`. Callers (Parts 23, 24) read it only in merge-family commands, so `status` / `stash list` never refuse.
- `src/application/primitives/internal/renormalize-attributes.ts` (create) — `renormalizeAttributeLookup(base, ours, theirs: FlatTree | undefined): IndexBlobLookup` per §D1.12 ("Attribute source for the renormalization is the merged `.gitattributes`"): only the ROOT `.gitattributes` entry is looked up (merge-ort `initialize_attr_index` reads `GITATTRIBUTES_FILE` only — PIN step 1); resolved without a content merge (ours equals theirs; or one side equals base → the other side's entry, a deletion → none) → that entry; otherwise (a content merge was needed, clean or not) → base when present, else ours, else theirs (lowest stage present).
- `src/application/primitives/build-content-merger.ts` — `ContentMergeSettings` (line 37) gains `readonly renormalize?: { readonly attributes: IndexBlobLookup }`; when set, `buildContentMerger` (75) builds ONE `index-only` provider lazily (`buildAttributeProvider(ctx, { kind: 'index-only', index: attributes })`) and `readEolSettings(ctx)`, and passes ours / theirs / base through `renormalizeBuffer` BEFORE `resolvePathMergeSpec` (line ≈ 105) — so external, union and binary drivers all see normalized bytes; the merged result is returned as is (no second to-git pass). The driver lookup keeps today's direction-less provider (line 82). Export `buildBlobUnchanged(ctx, renormalize): BlobUnchanged` — git `blob_unchanged`: modes differ → false; ids equal → true; else read both blobs, `renormalizeBuffer` each under the same `index-only` provider, equal bytes → true.
- `test/unit/application/primitives/internal/merge-rename-config.test.ts`, `test/unit/application/primitives/internal/renormalize-attributes.test.ts` (create), `test/unit/application/primitives/build-content-merger.test.ts`.

Read-only: Part 10 `renormalizeBuffer`; Part 7 `buildAttributeProvider` directions; src/domain/merge/three-way-tree.ts `BlobUnchanged` (Part 21); git's conflict-marker and driver paths in build-content-merger.ts lines 93–135.

### TDD steps
1. PIN — not pinned: a NESTED `sub/.gitattributes` under `merge -X renormalize` (base CRLF `sub/f`, side adds `sub/.gitattributes` `* text=auto` and renormalizes + edits line 1, main edits line 3 in CRLF): does the nested file govern the normalization (clean merge) or not (conflict)? Record the outcome as a `renormalize-attributes.test.ts` row (nested entry consulted or not) and implement `renormalizeAttributeLookup`'s scope to match (root-only if git ignores the nested file); Part 24 adds the cross-tool row.
2. RED `merge-rename-config.test.ts` › `Given merge.renormalize = foo` › `When readMergeRenormalize` › `Then CONFIG_BAD_BOOLEAN_VALUE { key: 'merge.renormalize', value: 'foo' }`; valueless → true; `false` → false; absent → undefined. Fails: not exported. GREEN.
3. RED `renormalize-attributes.test.ts` — the five §D1.12 attribute-source rows as tree triples (added by one side only → that side; base `text=auto` with conflicting ours/theirs → base; no base, ours `-text`, theirs `text=auto` → ours; no base, ours `text=auto`, theirs `-text` → ours; base `* -text` with ours line-1 edit and theirs line-5 edit → base). Fails: module does not exist. GREEN.
4. RED `build-content-merger.test.ts` › `Given renormalize with '* text=auto' and a CRLF base, an LF-renormalized edited theirs and a CRLF edited ours` › `When the merger runs` › `Then the merge is clean with LF bytes` (§D1.12 first row bytes `ANbNCN`); `Given an external driver` › `Then the driver received normalized bytes` (fake runner capturing input). Fails: sides passed raw. GREEN.
5. RED `buildBlobUnchanged` rows: equal ids → true without reading blobs; CRLF base vs LF-renormalized side under `text=auto` → true; real content change → false; mode change → false. Fails: not exported. GREEN.

### Gate
```sh
npx vitest run test/unit/application/primitives/internal/merge-rename-config.test.ts test/unit/application/primitives/internal/renormalize-attributes.test.ts test/unit/application/primitives/build-content-merger.test.ts \
  && npx tsc --noEmit -p tsconfig.json \
  && ./node_modules/.bin/biome check src/application/primitives/internal/merge-rename-config.ts src/application/primitives/internal/renormalize-attributes.ts src/application/primitives/build-content-merger.ts test/unit/application/primitives/internal/merge-rename-config.test.ts test/unit/application/primitives/internal/renormalize-attributes.test.ts test/unit/application/primitives/build-content-merger.test.ts \
  && npx cspell --no-progress src/application/primitives/internal/merge-rename-config.ts src/application/primitives/internal/renormalize-attributes.ts src/application/primitives/build-content-merger.ts test/unit/application/primitives/internal/merge-rename-config.test.ts test/unit/application/primitives/internal/renormalize-attributes.test.ts test/unit/application/primitives/build-content-merger.test.ts
```
Traps: wireit caches `check:types` / `check:spelling` — the bare `tsc` / `cspell` above are the oracles; never pass cspell.json to cspell. The PIN probe needs git 2.55.0 first on PATH.

### Commit
`feat(merge): normalize content-merge sides when renormalizing`

## Part 23 — `merge -X renormalize`, `-X no-renormalize` and `merge.renormalize` on merge and pull

### Context
ADR-956; design §D3.8. Edits:
- `src/domain/merge/strategy-options.ts` — `OrtStrategyOptions` (line 23) gains `readonly renormalize?: boolean`; `parseOrtStrategyOptions` (≈ 135) returns `{ ...parsed.settings, ...(parsed.renormalize !== undefined && { renormalize: parsed.renormalize }) }` instead of throwing at lines 139–140 (the last of `renormalize` / `no-renormalize` wins, as `applyOption` already tracks); drop the `unsupportedOperation` import if now unused.
- `src/application/commands/merge.ts` — the option doc at lines 220–228 drops "a standing `renormalize` … refuse with `UNSUPPORTED_OPERATION`" and documents `renormalize` / `no-renormalize` and `merge.renormalize`; `ortSettings` (≈ 763) always reads `readMergeRenormalize(ctx)` (an invalid value refuses the merge even with `-X`, as git reads it at startup) and resolves `renormalize = xOptions.renormalize ?? configured ?? false`; `computeMergeTreeResult` (≈ 1252) — when renormalizing: `attributes = renormalizeAttributeLookup(base, ours, theirs)`, pass `{ ...strategy, renormalize: { attributes } }` to `buildContentMerger` and `buildBlobUnchanged(ctx, { attributes })` as `mergeTrees`' new last argument. pull: verify (`grep -n "from './merge.js'" src/application/commands/pull.ts`) that pull's merge path runs `ortSettings` — git pull's merge reads `merge.renormalize` the same way; if pull bypasses it, wire it there and add the file to this part's commit (escalate if that would exceed the ceiling).
- `test/unit/domain/merge/strategy-options.test.ts` — the refusal describes at ≈ lines 206–225 become `renormalize` results (`renormalize` → true, `no-renormalize` → false, last wins).
- `test/unit/domain/merge/strategy-options.properties.test.ts` — the property asserting the `-Xrenormalize` refusal (≈ lines 50–57) becomes "`renormalize` in the list ⇒ result's `renormalize` equals the last of the two options".
- `test/unit/application/commands/merge-strategy-options.test.ts` — the refusal row at ≈ line 182 becomes a clean renormalizing merge on the memory adapter; add `merge.renormalize=true` default, `-X no-renormalize` over config, invalid `merge.renormalize` refusal (try/catch `.data`).
- `test/integration/merge-strategy-options-interop.test.ts` — its `renormalize` refusal row becomes the §D1.12 primary pair on both tools: `merge side` → content conflict; `merge -X renormalize side` → clean, blob `24938456d42b76634c499d30bb6db8c59df815ec`.

### TDD steps
1. RED `strategy-options.test.ts` › `Given the option renormalize` › `When parsed` › `Then renormalize is true` (and the other rows). Fails: throws `UNSUPPORTED_OPERATION`.
2. GREEN the parser; update the properties sibling (step-1 semantics).
3. RED `merge-strategy-options.test.ts` › `Given the §D1.12 history and -X renormalize` › `When merge` › `Then clean and f's blob is A\nb\nC\n`; `Given merge.renormalize true` › clean; `Given merge.renormalize true and -X no-renormalize` › conflict; `Given merge.renormalize = foo` › `CONFIG_BAD_BOOLEAN_VALUE`; `Given the modify/delete history and -X renormalize` › clean, `f` deleted. Fails: renormalize not wired in merge.ts.
4. GREEN `ortSettings` + `computeMergeTreeResult` wiring.
5. Interop row update; run.

### Gate
```sh
npx vitest run test/unit/domain/merge/strategy-options.test.ts test/unit/domain/merge/strategy-options.properties.test.ts test/unit/application/commands/merge-strategy-options.test.ts test/unit/application/commands/merge.test.ts test/unit/application/commands/pull.test.ts \
  && PATH="<git-2.55.0>/bin:$PATH" npx vitest run test/integration/merge-strategy-options-interop.test.ts \
  && npx tsc --noEmit -p tsconfig.json \
  && ./node_modules/.bin/biome check src/domain/merge/strategy-options.ts src/application/commands/merge.ts test/unit/domain/merge/strategy-options.test.ts test/unit/domain/merge/strategy-options.properties.test.ts test/unit/application/commands/merge-strategy-options.test.ts test/integration/merge-strategy-options-interop.test.ts \
  && npx cspell --no-progress src/domain/merge/strategy-options.ts src/application/commands/merge.ts test/unit/domain/merge/strategy-options.test.ts test/unit/domain/merge/strategy-options.properties.test.ts test/unit/application/commands/merge-strategy-options.test.ts test/integration/merge-strategy-options-interop.test.ts
```
Traps: wireit caches `check:types` / `check:spelling` — the bare `tsc` / `cspell` above are the oracles; never pass cspell.json to cspell. Git 2.55.0 first on PATH. Run `npm run docs:json` — `OrtStrategyOptions` is absent from api.json today; commit churn if any appears.

### Commit
`feat(merge): accept -X renormalize and merge.renormalize`

## Part 24 — `merge.renormalize` on cherry-pick, revert, rebase and stash apply; final measurements

### Context
ADR-956: consumers without `-X` read the config only. Edits:
- `src/application/primitives/apply-merge-to-worktree.ts` — `applyMergeToWorktree` (line 364; callers: replay-sequence.ts:179 for cherry-pick / revert / rebase, rebase-merges-steps.ts:144, stash.ts:587 for stash apply/pop) and `mergeTreesToTree` (417; stash apply `--index`) read `readMergeRenormalize(ctx)` (refusing an invalid value — git's sequencer and stash read it through `merge_recursive_config`); when true, compute `renormalizeAttributeLookup(base, ours, theirs)`, pass `renormalize: { attributes }` into the `buildContentMerger` settings (line 376 / 435) and `buildBlobUnchanged` as `mergeTrees`' last argument (379 / 431). `mergeCollidingRenameSources` receives the same merger.
- `test/unit/application/primitives/apply-merge-to-worktree.test.ts` — renormalize describes.
- `test/integration/eol-conversion-interop.test.ts` — the remaining §D1.12 rows on both tools: `merge.renormalize=true` cherry-pick, rebase, revert (`blob=[ANbNcN]`), stash apply (`wt=[ANbNCN]`); their no-config counterparts conflicting; the no-attributes `core.autocrlf=true` row (`blob=[ANbNCN]`, worktree CRLF — the to-worktree route of Part 19); the conflicted-`.gitattributes` rows; the Part 22 PIN row (nested `.gitattributes`); §D1.6 `merge -X renormalize` under `core.safecrlf=true` (no warning, no refusal).
- `test/integration/merge-driver-interop.test.ts` — renormalize before an external driver: the driver receives normalized bytes on both tools.

### TDD steps
1. RED `apply-merge-to-worktree.test.ts` › `Given merge.renormalize true and the §D1.12 cherry-pick history` › `When applyMergeToWorktree` › `Then clean with f's blob A\nb\nC\n`; `Given no config` › conflict; `Given merge.renormalize = foo` › `CONFIG_BAD_BOOLEAN_VALUE`; `Given the modify/delete history` › clean delete; `mergeTreesToTree` row for stash `--index`. Fails: config not read.
2. GREEN the wiring in both functions.
3. Interop rows; run the full set listed in the Gate.
4. MEASURE (last part) — the bundle measurement; list every `passed: false` row (name, measured bytes, limit) in the hand-back report. Also run `bash tooling/verify-tarball.sh` (or the npm script that wraps it) and report the tarball size against its cap. Do not edit any cap.
5. BENCH (R11) — quiet-machine check first (`uptime`; no foreign Stryker or vitest process: `ps -ax | grep -E "stryker|vitest"`), then `npm run bench:ab -- main HEAD` in the foreground (long timeout); report the add, status and checkout scenario deltas (base vs head, best-of-rounds) in the hand-back report. No commit unless a bench file changed. The driver creates and removes its own temporary worktrees; it must not touch this worktree's branch, index or stash.

### Gate
```sh
npx vitest run test/unit/application/primitives/apply-merge-to-worktree.test.ts test/unit/application/commands/cherry-pick.test.ts test/unit/application/commands/revert.test.ts test/unit/application/commands/rebase.test.ts test/unit/application/commands/stash.test.ts \
  && PATH="<git-2.55.0>/bin:$PATH" npx vitest run test/integration/eol-conversion-interop.test.ts test/integration/merge-driver-interop.test.ts test/integration/stash-interop.test.ts test/integration/filter-clean-smudge-interop.test.ts test/integration/archive-interop.test.ts test/integration/status-racy-clean-interop.test.ts \
  && npx tsc --noEmit -p tsconfig.json \
  && ./node_modules/.bin/biome check src/application/primitives/apply-merge-to-worktree.ts test/unit/application/primitives/apply-merge-to-worktree.test.ts test/integration/eol-conversion-interop.test.ts test/integration/merge-driver-interop.test.ts \
  && npx cspell --no-progress src/application/primitives/apply-merge-to-worktree.ts test/unit/application/primitives/apply-merge-to-worktree.test.ts test/integration/eol-conversion-interop.test.ts test/integration/merge-driver-interop.test.ts
```
Traps: wireit caches `check:types` / `check:spelling` — the bare `tsc` / `cspell` above are the oracles; never pass cspell.json to cspell. Git 2.55.0 first on PATH. The measurement and bench steps report in the hand-back report; the cap raises and the phase-boundary `npm run validate` are the orchestrator's.

### Commit
`feat(merge): renormalize cherry-pick, revert, rebase and stash apply`
