# Implementation plan — Custom merge drivers

Bottom-up TDD. Each slice is one atomic commit, `npm run validate` green before commit.
GWT/AAA, `sut`, 100% coverage, mutation-resistant assertions (specific error data; isolated
guard tests). Parser/matcher slices ship a `*.properties.test.ts` sibling per the four
property-test lenses.

Conventions: `domain/attributes/` is pure (depends only on `domain/pathspec` `compileGlob`,
like `domain/ignore`). No phase/ADR refs in source or test code.

---

## Slice 1 — `.gitattributes` parser (domain, pure)

**Files:** `src/domain/attributes/attribute-value.ts`, `parse-gitattributes.ts`, `index.ts`;
tests `parse-gitattributes.test.ts` + `parse-gitattributes.properties.test.ts` +
`arbitraries.ts`.

- `AttributeValue = true | false | 'unspecified' | { readonly set: string }`.
- `interface AttributeRule { pattern; compiled: GlobMatcher; anchored; directoryOnly;
  lineNumber; attributes: ReadonlyMap<string, AttributeValue> }`.
- `interface MacroDef { name; attributes: ReadonlyMap<string, AttributeValue> }`.
- `interface ParsedAttributes { rules: ReadonlyArray<AttributeRule>; macros: ReadonlyArray<MacroDef> }`.
- `parseGitattributes(text): ParsedAttributes`:
  - split lines; skip blank / `#`-comment lines.
  - `[attr]<name> <tokens...>` → a `MacroDef`.
  - else first whitespace-delimited token (honour `"…"` C-quoting) = pattern; remaining
    tokens = attribute assignments.
  - tokenize each attr: `name` → `true`; `-name` → `false`; `!name` → `'unspecified'`;
    `name=value` → `{ set: value }`.
  - compile pattern via `compileGlob` reusing `.gitignore` anchor/dir-only rules (negation
    `!` is NOT a pattern prefix here — a leading `!` only appears on attribute tokens).
  - **RED:** assert each token form, quoted pattern, macro line, comment/blank skip, last-token-wins within a line.
- **Properties** (lens 1 round-trip + lens 4 counting): `parseGitattributes(serialize(rules))`
  re-parses to an equivalent ruleset; token-count invariants (`-`/`!`/`=` forms map 1:1).

## Slice 2 — attribute resolution + macros (domain, pure)

**Files:** `src/domain/attributes/macros.ts`, `resolve-attribute.ts`, extend `index.ts`;
tests `resolve-attribute.test.ts` (+ `.properties.test.ts` — matcher invariants, lens 2).

- `BUILTIN_MACROS`: `binary = { diff:false, merge:false, text:false }`.
- `expandMacros(parsed): ReadonlyMap<string, AttributeValue>`-producing matcher that, given a
  resolved attribute set, applies macro expansion (a matched macro name sets its listed
  attributes unless already explicitly set — git's "macro does not override an explicit set").
- `interface AttributeSource { basedir: FilePath | ''; parsed: ParsedAttributes }`.
- `resolveAttribute(sources: ReadonlyArray<AttributeSource>, path: FilePath, name: string,
  macros): AttributeValue`:
  - sources are pre-ordered highest→lowest precedence by the caller.
  - scan sources in order; within a source scan rules **last-match-wins**; for each matching
    rule, compute its **effective** attribute map by expanding macros (an explicit token —
    e.g. `binary` → `merge:false,diff:false,text:false`), with an explicit direct assignment
    of `name` overriding a macro-derived one; then look up `name`. First source that yields a
    defined value wins; else `'unspecified'`. (So `*.bin binary` resolves `merge` → `false`.)
  - path matched **relative to each source's `basedir`** (reuse the `.gitignore` basedir
    convention via `compiled.matches`).
  - **RED:** precedence (info beats root beats global), last-match-wins within a file,
    `binary` macro → `merge:false`, unspecified fallthrough, basedir-relative match. Isolated
    guard tests per condition.
- **Properties** (lens 2): empty sources → `'unspecified'`; appending a matching `merge` set
  makes the verdict that value; appending `!merge` (unspecified) after it restores fallthrough.

## Slice 3 — driver-command placeholder substitution (domain, pure)

**Files:** `src/domain/attributes/driver-command.ts`, extend `index.ts`; test `driver-command.test.ts`.

- `substituteDriverPlaceholders(template, { O, A, B, L, P }): string`:
  - replace `%O %A %B %P` with the given strings, `%L` with the marker size, `%%` → `%`.
  - unknown `%x` → emitted literally (the `%` and the char), git-lenient.
  - **RED:** each placeholder, `%%` escape, repeated placeholders, unknown `%x` literal,
    adjacent placeholders, value containing a literal `%`.

## Slice 4 — `[merge "<driver>"]` config parsing

**Files:** extend `src/application/primitives/config-read.ts`; tests in `config-read.test.ts`.

- `ParsedConfig.merge?: ReadonlyMap<string, { name?: string; driver?: string; recursive?: string }>`.
- `mergeMergeSection` (subsection = driver name; case-insensitive keys `name`/`driver`/`recursive`);
  wire into `dispatchSection` (`sec.section === 'merge' && subsection !== undefined`) +
  `MutableParsedConfig` + `finalize`.
- **RED:** parse `[merge "custom"]` with driver/name/recursive; multiple drivers; missing
  keys; subsectionless `[merge]` ignored.

## Slice 5 — `CommandRunner` port + node adapter + memory fake

**Files:** `src/ports/command-runner.ts`; `src/adapters/node/node-command-runner.ts`;
`src/adapters/memory/memory-command-runner.ts` (configurable test fake); extend `Context` +
`CreateContextParts` (`command?: CommandRunner`); barrels (`adapters/node/index.ts`,
`adapters/memory/index.ts`). Tests `node-command-runner.test.ts` (injected spawn fake) +
`memory-command-runner.test.ts`.

- Port: `CommandRequest { command; cwd; env; signal? }`, `CommandResult { exitCode }`,
  `CommandRunner { run }`.
- `NodeCommandRunner`: spawn `sh -c <command>` (Windows: `cmd /c`? — match `NodeHookRunner`'s
  shell story; node `sh` on posix, `process.platform` branch) with injectable `spawn`
  (`CommandRunnerOps` mirroring `HookRunnerOps`), `cwd`, `env`, abort-kill, never rejects on
  non-zero exit; exit code from `close` (`code ?? SIGNAL_KILLED_EXIT`).
- `MemoryCommandRunner`: a fake constructed with a `run` behaviour callback — used by
  primitive tests to simulate a driver editing `%A` on the shared `ctx.fs`.
- **RED:** node — exit 0 / non-zero, abort kills child, env carries `GIT_DIR`, never rejects;
  memory — invokes the behaviour and returns its exit code.

## Slice 6 — read attribute sources (primitive, I/O)

**Files:** `src/application/primitives/internal/read-gitattributes.ts`; test alongside.

- Mirror `read-gitignore`: `readGitattributes(ctx, dir)` (worktree `.gitattributes`),
  `readInfoAttributes(ctx)` (`${commonGitDir}/info/attributes`), `readGlobalAttributes(ctx)`
  (`core.attributesFile`, `~`-expand via `homeDir`). Size cap (reuse / add `MAX_GITATTRIBUTES_BYTES`).
- `buildAttributeSourcesForPath(ctx, path): Promise<{ sources: AttributeSource[]; macros }>`:
  assemble precedence-ordered sources (info → path dir → parents → root → global), lazily
  loading + caching each dir's `.gitattributes` per Context; collect macro defs (built-in +
  user) for expansion.
- **RED:** ordering, missing files → skipped, caching (one read per dir), global `~`-expand
  miss when `homeDir` undefined.

## Slice 7 — resolve a path to a driver choice (primitive)

**Files:** `src/application/primitives/resolve-merge-driver.ts`; test alongside.

- `type MergeDriverChoice = { kind: 'text' } | { kind: 'binary' } | { kind: 'external'; command: string; name?: string }`.
- `resolveMergeDriver(ctx, path): Promise<MergeDriverChoice>`:
  - resolve the `merge` attribute over the path's sources (slice 6 + slice 2).
  - map per ADR-303: unspecified/true/`text` → text; false/`binary` → binary; `union` → text
    (deferred); named with `[merge].driver` → external; named w/o driver → text.
  - cache the assembled sources per Context (a `WeakMap<Context, …>` like `readConfig`).
- **RED:** every row of the ADR-303 table, incl. `binary` macro path and named-without-driver
  fallback. Specific assertions on the returned `kind`/`command`.

## Slice 8 — run an external driver (primitive)

**Files:** `src/application/primitives/run-merge-driver.ts`; test alongside.

- `runMergeDriver(ctx, { command; base; ours; theirs; path; markerSize }): Promise<ContentMergeResult>`:
  - write `%O`(base ?? empty), `%A`(ours), `%B`(theirs) to unique temp paths under
    `${gitDir}` via `ctx.fs` (`%A` seeded with ours).
  - `substituteDriverPlaceholders(command, { O, A, B, L: String(markerSize), P: path })`.
  - `await ctx.command.run({ command, cwd: workDir, env: { GIT_DIR }, signal })`.
  - read `%A` back via `ctx.fs`; delete the three temp files (best-effort, in `finally`).
  - exit 0 → `{ status: 'clean', bytes }`; non-zero → `{ status: 'conflict',
    conflictType: 'content', markedBytes }`.
- **RED (memory fs + `MemoryCommandRunner`):** clean (driver writes %A, exit 0), conflict
  (exit 1), temp files removed afterward, base-undefined writes an empty `%O`, abort signal
  threaded. Specific assertions on result bytes.

## Slice 9 — shared driver-aware `ContentMerger` + consolidation

**Files:** `src/application/primitives/build-content-merger.ts`; rewire
`commands/merge.ts` + `primitives/apply-merge-to-worktree.ts` to import it (delete both local
`buildContentMerger` closures). Test `build-content-merger.test.ts`.

- `buildContentMerger(ctx): ContentMerger` — per path:
  - read ours/theirs/base blobs (capped `MAX_CONFLICT_OUTPUT_BYTES`, parallel — preserve the
    existing equivalent-mutant annotations).
  - `resolveMergeDriver(ctx, path)`:
    - `text` → `mergeContent(base, ours, theirs)` (unchanged default).
    - `binary` → `{ status: 'conflict', conflictType: 'binary', markedBytes: ours }`.
    - `external` → `ctx.command` present ? `runMergeDriver(...)` : `mergeContent(...)`
      (no-runner fallback, ADR-304).
- **RED:** default path byte-identical to `mergeContent`; binary → ours conflict; external
  with fake runner → driver result; external w/o runner → built-in fallback. Then the
  existing `merge` / `cherry-pick` / `revert` / `stash` / `rebase` suites must stay green
  (consolidation is behaviour-preserving on the default path).

## Slice 10 — wire `NodeCommandRunner` into the context + facade

**Files:** `src/index.node.ts`, `src/adapters/node/node-adapter.ts`, `src/repository.ts`
(facade `command?: CommandRunner | false` option mirroring `hooks?`), `ports/context.ts`
already extended in slice 5. Regenerate `reports/api.json`.

- node entrypoints attach `command: new NodeCommandRunner()`; facade lets a host override or
  disable (`false`); `worktree-context.ts` strips `command` like it strips `hooks`/`promisor`.
- **RED:** facade wiring test (option present / `false` disables); api.json committed.

## Slice 11 — real-git interop

**Files:** `test/integration/merge-driver-interop.test.ts`.

- Twin git/tsgit repos (scrubbed `GIT_*`, shared `beforeAll` repo per the interop-flake note).
  Cases:
  - `.gitattributes`: `* merge=custom`; `.git/config` `[merge "custom"] driver = <script>`
    where the script deterministically writes `%A` (e.g. concatenates a marker) — assert
    merged blob + index stage-0 + worktree bytes parity for **clean** (exit 0).
  - same driver returning exit 1 → **conflict**: assert worktree bytes + index stages parity.
  - `*.bin -merge` (binary): both sides change → conflict, worktree = ours, stages 1/2/3.
  - `*.txt merge=text` no-op: identical to a plain merge.
- Reconstruct nothing rendered — these assert on-disk/object state directly (the data
  surface), per the prime directive.

## Slice 12 — backlog follow-ups + docs

**Files:** `docs/BACKLOG.md` (flip 24.9 → `[x]`; add follow-ups), `README.md`,
`RUNBOOK.md`, `docs/use/` page.

- Flip **24.9** to done with a summary line.
- Add follow-ups in dependency order:
  - `union` built-in driver (depends on the per-region merge rework).
  - `conflict-marker-size` attribute / `merge.conflictMarkerSize` (`%L`) + `%S/%X/%Y` labels.
  - System-wide `/etc/gitattributes` (parking lot — only on community traction).
- README: mention custom merge drivers in the feature list / count if it tracks command count
  (verify — drivers are not a new Tier-1 command, so the command count is unchanged).
- A `docs/use/` page documenting `.gitattributes merge=` + `[merge "<d>"] driver=` support
  and the documented non-goals.

---

## Validation gates (Steps 6–11 of the workflow)

- review ×3 (typescript / security / tests), fix-all-until-converged.
- architecture refactor pass (the consolidation in slice 9 is already the main structural
  gain; re-scan for residual duplication, e.g. shared temp-file helper, attribute-source
  caching shape vs `readConfig`).
- mutation: 0 killable survivors on the touched domain + primitives.
- `npm run validate` green throughout.
