# Plan — merge driver config override (`[merge "<builtin>"] driver`)

> Source: design doc `docs/design/merge-driver-config-override.md` · ADRs `496, 497`
> (constrained by ADR-303 selection table, ADR-352 eager valueless guard, ADR-304/407/408
> external-driver dispatch, ADR-249 structured-data-only, ADR-305 region engine — all untouched)
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

**Why two parts, in this order.** Part 1 lands ADR-496 (the core precedence fix + the
`missing-command` choice variant on the file-private union) and its interop override pins.
Part 2 lands ADR-497 (the lazy driverless refusal: the new public error code + the per-path
chokepoint throw) and its refusal/boundary pins. The order is forced by two verified facts:
(a) `MergeDriverChoice` is file-private (grep: the type name is referenced ONLY in
`resolve-merge-driver.ts`); `build-content-merger.ts` consumes the returned choice
**structurally** via `.kind` with **no** exhaustive `switch`/`assertNever` over the union
anywhere in `src/` — so Part 1 can add the 5th variant and Part 1's `missing-command`
values fall through to `mergeContent` (built-in text) until Part 2 adds the throw, with no
compile break; (b) the M1/M2/M3 override cases dispatch through the pre-existing `external`
branch, so they pin green in Part 1 without the Part 2 throw. Each part compiles green and
passes its gate on its own. Neither is a standalone test-only part: each folds its own
unit + interop tests into the source delta it introduces.

## Part 1 — Config-first driver selection + `missing-command` choice variant (ADR-496)

### Context

**The defect + the fix.** `src/application/primitives/resolve-merge-driver.ts`, symbol
`namedChoice` (file-private arrow, current lines 29–38; sole caller `driverFromMergeValue`
at line 44, same file). Current body short-circuits the three built-in names **before**
reading config, so a repo with `[merge "text"] driver = <cmd>` on a `merge=text` path runs
the built-in text merge, never the command. Real git's `find_ll_merge_driver` scans
user-configured drivers (`ll_user_merge`) first, then the built-in name table
(`ll_merge_drv[]`). Rewrite `namedChoice` to consult config first — **copy the design's
"faithful reorder" verbatim**:

```ts
const namedChoice = async (ctx: Context, name: string): Promise<MergeDriverChoice> => {
  const driver = (await readConfig(ctx)).merge?.get(name);
  if (driver?.driver !== undefined) {
    return driver.name === undefined
      ? { kind: 'external', command: driver.driver }
      : { kind: 'external', command: driver.driver, name: driver.name };
  }
  // Registered but driverless: a non-empty record (name/recursive set) with no driver command
  // → git's lazy "lacks command line" refusal (M4/M5/M8/M10), thrown per-path at the
  // content-merge chokepoint so an unused section stays inert (M9). Must precede the name fallback.
  if (driver !== undefined && (driver.name !== undefined || driver.recursive !== undefined)) {
    return { kind: 'missing-command', name };
  }
  // No registered driver record (no section / empty {} / unknown-key-only) → built-in by name.
  if (name === 'binary') return BINARY;
  if (name === 'union') return UNION;
  return TEXT; // 'text' or any unknown name defaults to built-in text
};
```

This removes the old line 30 (`if (name === 'text') return TEXT`) that carried the two
unkillable mutants (ConditionalExpression + StringLiteral `'text'` — surfaced by the 26.12
sweep). The relocated `binary`/`union` guards are killed by the existing no-section
built-in cases.

**The 5th choice variant.** In the same file, extend the `MergeDriverChoice` type
(lines 18–22) with a fifth arm and update its leading doc comment (lines 11–17) with a
`missing-command` bullet:

```ts
export type MergeDriverChoice =
  | { readonly kind: 'text' }
  | { readonly kind: 'union' }
  | { readonly kind: 'binary' }
  | { readonly kind: 'external'; readonly command: string; readonly name?: string }
  | { readonly kind: 'missing-command'; readonly name: string };
```

The `name` field carries the **resolved driver name** (the `namedChoice` param), not the
config `name` value — e.g. for `merge=custom` + `[merge "custom"] name = My Driver` the
variant is `{ kind: 'missing-command', name: 'custom' }`.

**Config-map model (do not re-derive).** `readConfig(ctx)` (`config-read.ts:124`) is a
per-`Context` cached single-flight read; `.merge` is a `ReadonlyMap<string, { name?: string;
driver?: string; recursive?: string }>` (`config-read.ts:1030/1576`). `mergeMergeDriver`
(`config-read.ts:1283–1301`) **skips null-valued keys** (valueless key → treated absent),
**ignores unknown keys**, then unconditionally `set(name, next)` — so a valueless `driver`
key, an empty section, and an unknown-key-only section ALL land as an empty `{}` record
(this is why M16 and M17 are indistinguishable — the documented ADR-497 residual). The new
`missing-command` guard therefore keys off a **non-empty** record (`name`/`recursive` set);
an empty `{}` falls through to the name fallback (→ text).

**Surface decision — INTERNAL, no gates in this part.** `MergeDriverChoice` is file-private
(grep-confirmed: type name referenced only in `resolve-merge-driver.ts`); `resolvePathMergeSpec`'s
exported signature is unchanged. No new public export, no Tier-1 command, no error code in this
part → **no** api.json / barrel / facade / doc-coverage impact here (that all lands in Part 2's
error code). Verified against `.claude/workflow/surface-gates.md`.

**Consumer safety (why this compiles green without Part 2).** `build-content-merger.ts`
(lines 67–85) branches `binary` → `external` → else `mergeContent`; there is NO exhaustive
`switch`/`never`-check over `MergeDriverChoice.kind` anywhere in `src/` (grep-confirmed — the
other `choice.kind` hits in `apply-changeset.ts`/`add.ts`/`compare-working-tree-entry.ts` are
a DIFFERENT filter-driver type). So a `missing-command` value falls through to `mergeContent`
(built-in text) until Part 2 adds the throw — no compile break, no collateral test break.

**Unit test file** — `test/unit/application/primitives/resolve-merge-driver.test.ts`. Helpers
(reuse verbatim): `seed(ctx, attrs?, config?)` writes `.gitattributes` (workDir) + `config`
(gitDir); `choose(ctx, path)` → `.driver`; `spec(ctx, path)` → full `PathMergeSpec`;
`createMemoryContext()`. GWT/AAA, `sut` names the SUT choice.

- PRESERVE unchanged (regression net): no-attr → text (l.29), `* merge` → text (l.44),
  `merge=text` → text (l.60), `-merge` → binary (l.76), `merge=binary` no-section → binary
  (l.92 — now also kills the relocated `binary` guard), binary macro → binary (l.108),
  `merge=union` no-section → union (l.124 — now also kills the `union` guard), `merge=custom`
  name+driver → external+name (l.140), `merge=custom` driver-only → external (l.160),
  `merge=custom` no-section → text (l.192), the valueless-block no-section → text and valued
  driver+name → external+name (l.208–242), and the valueless `driver` under `[merge "mydriver"]`
  → text (l.244–260). These stay green: a valueless `driver` is null-skipped by
  `mergeMergeDriver` → empty `{}` → not `missing-command` → text.
- CHANGE — assertion flip (M5-shaped, non-empty driverless): the existing case at l.174–188
  (`* merge=custom` + `[merge "custom"]\n  name = My Driver\n`) flips its assertion from
  `{ kind: 'text' }` to `{ kind: 'missing-command', name: 'custom' }` and its `it` title from
  "Then it falls back to the text driver" to a refusal-choice title. It stayed green pre-fix
  ONLY because today's code fell back to text.
- CHANGE — comment only (l.262–277): `* merge=text` + valueless `[merge "text"]\n\tdriver\n`
  keeps asserting `{ kind: 'text' }`, but rewrite the now-false "without consulting config"
  comment — config IS consulted under the reorder; it resolves the empty `{}` record to text.
- ADD — override selected (kills the line-30 mutants; proves config-before-name for all three,
  ADR-496): `merge=text` + `[merge "text"]\n\tdriver = run %A\n` → `{ kind: 'external',
  command: 'run %A' }`; sibling `merge=binary` + `[merge "binary"]\n\tdriver = run %A\n` →
  external; `merge=union` + `[merge "union"]\n\tdriver = run %A\n` → external.
- ADD — override with name: `merge=text` + `[merge "text"]\n\tname = X\n\tdriver = run %A\n`
  → `{ kind: 'external', command: 'run %A', name: 'X' }`.
- ADD — isolated driverless guard cases (guard-clause rule: each `||` side alone): `merge=text`
  + `[merge "text"]\n\tname = X\n` (name only, no driver) → `{ kind: 'missing-command', name:
  'text' }`; `merge=text` + `[merge "text"]\n\trecursive = text\n` (recursive only, no driver)
  → `{ kind: 'missing-command', name: 'text' }`.
- ADD — empty-record boundary (M16/M17 residual → text; proves the guard does NOT fire for an
  empty `{}`): `merge=text` + `[merge "text"]\n\tfoo = bar\n` (unknown key → `{}`) →
  `{ kind: 'text' }`.
- ADD — boolean path unchanged (R4): `-merge` + `[merge "binary"]\n\tdriver = run %A\n` →
  `{ kind: 'binary' }` (config not consulted — `driverFromMergeValue` short-circuits on
  `value === false`).

**Interop test file** — `test/integration/merge-driver-interop.test.ts` (`describe.skipIf(
!GIT_AVAILABLE)`, twin-repo harness). Helpers: `makePeerPair('merge-driver')`,
`setupDiverged(attributes, driver?)` (diverges `data.txt` base→theirs on one branch,
base→ours on the other — whole-file different so the built-in text merge conflicts),
`configureDriverBoth(driver)`, `headOf`/`stageOf`/`read`, `runGit`/`tryRunGit`, `COMMIT_ENV`,
`repo.merge.run(...)`. **CAVEAT (verified):** `configureDriverBoth` HARD-CODES the
`merge.custom.driver` key (l.90–94); the built-in-name cases must key the driver to the
built-in subsection — set it inline on both dirs
(`runGit(['-C', dir, 'config', 'merge.text.driver', 'cp %B %A'])`, `merge.binary.driver`,
`merge.union.driver`) rather than reuse `configureDriverBoth` verbatim. Driver `cp %B %A`
copies theirs over ours and exits 0.

- ADD M1/M2/M3 override pins: both tools set `[merge "text|binary|union"] driver = cp %B %A`
  + `data.txt merge=text|binary|union`, diverged whole-file → assert `result.kind === 'merge'`,
  `headOf(ours) === headOf(peer)`, `stageOf(ours) === stageOf(peer)`, `data.txt === 'theirs\n'`.
  These fail pre-fix (built-in conflicts, exit 1 / 3 unmerged) and pass post-reorder via the
  existing `external` dispatch branch — no chokepoint throw needed.
- PRESERVE the six existing interop cases green (clean exit-0 driver, conflicting driver,
  `-merge` binary, `merge=union`, `merge=text`).

### TDD steps

1. RED — add the "override selected" unit cases (`merge=text|binary|union` + configured
   `driver`) and flip the l.174–188 case to `missing-command`. Run
   `npx vitest run test/unit/application/primitives/resolve-merge-driver.test.ts`: the override
   cases fail (pre-fix line-30 short-circuits `text` → `{ kind: 'text' }`; `binary`/`union`
   short-circuit before config); the flipped case fails (returns `{ kind: 'text' }`).
2. RED — add the isolated guard cases (name-only, recursive-only → `missing-command`), the
   empty-record boundary (`foo = bar` → text), the override-with-name case, and the boolean
   path case. The two `missing-command` guard cases fail (pre-fix returns text). Add the
   M1/M2/M3 interop pins; run
   `npx vitest run test/integration/merge-driver-interop.test.ts` — they fail (pre-fix built-in
   text merge conflicts instead of the driver taking theirs).
3. GREEN — add the `missing-command` arm to `MergeDriverChoice` and rewrite `namedChoice` per
   the reorder pseudocode above. All new unit + interop cases pass; every preserved case stays
   green.
4. REFACTOR — update the `MergeDriverChoice` doc comment (add the `missing-command` bullet) and
   the stale l.262–277 comment. Run `mcp__serena__get_diagnostics_for_file` on
   `resolve-merge-driver.ts`; confirm `npm run check:types` is green (the new variant compiles
   with no exhaustive-switch break in `build-content-merger.ts`).

### Gate

`npx vitest run test/unit/application/primitives/resolve-merge-driver.test.ts test/integration/merge-driver-interop.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/primitives/resolve-merge-driver.ts test/unit/application/primitives/resolve-merge-driver.test.ts test/integration/merge-driver-interop.test.ts`

### Commit

`fix(merge): configured driver overrides same-named built-in`

## Part 2 — Lazy driverless refusal: `MERGE_DRIVER_MISSING_COMMAND` + chokepoint throw (ADR-497)

### Context

Depends on Part 1 (the `missing-command` variant already exists on `MergeDriverChoice`). This
part adds the new error and the per-path throw that turns a selected non-empty driverless
section into git's lazy `fatal: custom merge driver <name> lacks command line.` (exit 128).

**Public-surface decision — PUBLIC error code; pre-pay the gates here.** The new code joins
`CommandError`, which is composed into `TsgitErrorData` and re-exported from the typedoc entry
point `src/domain/index.ts` (`export type { … TsgitErrorData } from './error.js';`). Existing
codes (`WORKING_TREE_DIRTY`, `CONFIG_MISSING_VALUE`, …) already appear in `reports/api.json`
(grep-confirmed), so the new arm changes api.json. Per `.claude/workflow/surface-gates.md`
("New error code / discriminated-union member"):
1. **Add the code to the error union** — `src/domain/commands/error.ts`, `CommandError`. Add
   `| { readonly code: 'MERGE_DRIVER_MISSING_COMMAND'; readonly name: string }` (place beside
   the `CONFIG_MISSING_VALUE` arm, ~l.143–148). Add the constructor beside `configMissingValue`
   (l.530): `export const mergeDriverMissingCommand = (name: string): TsgitError => new
   TsgitError({ code: 'MERGE_DRIVER_MISSING_COMMAND', name });`. `name` is the resolved driver
   name (already validated/attribute-derived); no sanitisation wrapper needed (mirrors the
   plain `configMissingValue` factory).
2. **Wire the exhaustiveness switch** — the ONLY `never`-check over `data.code` is
   `extractDetail` in `src/domain/error.ts` (`default: { const _exhaustive: never = data; … }`,
   l.516–519); grep-confirmed there is NO separate `exhaustiveness.ts` and no other
   `assertNever`. Add, before `default:`, `case 'MERGE_DRIVER_MISSING_COMMAND': return
   \`custom merge driver ${data.name} lacks command line.\`;`. Omitting it fails
   `npm run check:types` (the `never` assignment) — this is the compiler-enforced half of the
   gate. Message text: ADR-249 — the library emits the structured code + `name`; the interop
   test reconstructs git's `fatal:`-prefixed line + exit 128 from it.
3. **No barrel-surface error-code snapshot test exists** — grep-confirmed: error codes are
   asserted per-command individually (via `err.data.code`), never as an exhaustive set. Nothing
   to update there.
4. **api.json is a PREPUSH gate, not a validate gate.** Regenerate `reports/api.json` with
   `npm run docs:json` and stage it IN THIS PART (the large typedoc-id diff is normal). Skipping
   it leaves `check:doc-typedoc` red at prepush.

**The chokepoint throw.** `src/application/primitives/build-content-merger.ts`, the returned
closure (l.54–86). After `const { driver, markerSize } = await resolvePathMergeSpec(ctx, await
provider(), mergeCtx.path);` (l.66) and BEFORE `if (driver.kind === 'binary')` (l.67) — hence
before the `driver.kind === 'external' && ctx.command !== undefined` check (l.70), making the
refusal **platform-independent** — insert:

```ts
if (driver.kind === 'missing-command') {
  throw mergeDriverMissingCommand(driver.name);
}
```

Add `mergeDriverMissingCommand` to the existing import from `../../domain/commands/error.js`
(the file already imports `configMissingValue` from there, l.1). Leave
`ensureNoValuelessMergeDriver` (ADR-352 eager guard, l.49–55) **byte-identical** — it runs
first (l.55, before `resolvePathMergeSpec`), so a valueless key (M11/M12/M15) still wins ahead
of this throw. No change to `resolve-merge-driver.ts` in this part.

**Unit test file** — `test/unit/application/primitives/build-content-merger.test.ts`. Helpers:
`blob(ctx, content)`, `mergeCtxFor(ctx, { base?, ours, theirs, path? })`, `createMemoryContext`,
`MemoryCommandRunner` (`src/adapters/memory/memory-command-runner.ts`). The closure is invoked
as `sut(mergeCtx, undefined, new Uint8Array(0), new Uint8Array(0))` (mirror the existing call
shape). The valueless block already has a try/catch `.data`-extraction helper `mergeData`
(l.262–273, local to that describe); add a NEW top-level `describe('Given a registered-but-
driverless merge driver')` with its own equivalent helper. Assert `.data` fields directly
(NOT `toThrow(type)` — mutation-resistant, per CLAUDE.md).

- ADD — selected driverless section throws (M5-shaped): `.gitattributes` `* merge=custom\n` +
  config `[merge "custom"]\n\tname = X\n` (valued name, no driver) + diverged blobs
  (`{ base: 'b', ours: 'OURS', theirs: 'THEIRS' }`) → closure throws; assert
  `err.data.code === 'MERGE_DRIVER_MISSING_COMMAND'` AND `err.data.name === 'custom'`.
- ADD — platform-independent (no `CommandRunner`): SAME setup with `createMemoryContext()` (no
  `command`) still throws `MERGE_DRIVER_MISSING_COMMAND` with `name === 'custom'` (the throw
  precedes the `ctx.command` branch).
- ADD — unused driverless section is inert (M9, lazy): config `[merge "unused"]\n\tname = X\n`
  configured but the path carries no `merge` attribute (or `merge=text`) → the closure does NOT
  throw and returns a normal merge result (`status` `clean`/`conflict` per the diverged blobs).
- PRESERVE the existing ADR-352 valueless cases (l.261–435) and every other existing case green
  — the eager guard is unchanged, so `CONFIG_MISSING_VALUE` still fires first for valueless keys.

**Interop test file** — `test/integration/merge-driver-interop.test.ts` (extend again; same
harness + the Part 1 additions). `tryRunGit` returns `{ ok, stdout, stderr }` for a git command
expected to fail. Reconstruct git's `fatal:` line from the structured tsgit error (ADR-249).
CAVEAT as in Part 1: set config inline (do NOT reuse `configureDriverBoth`, which hard-codes
`merge.custom.driver`).

- ADD — M10 refusal pin (selected, lazy): both tools set `[merge "x"] name = x` (valued name,
  no driver — `runGit(['-C', dir, 'config', 'merge.x.name', 'x'])` on both) + `data.txt
  merge=x`, diverged whole-file → assert BOTH refuse. Peer: `tryRunGit([... 'merge', '--no-ff',
  '-m', 'm', 'theirs'])` `.ok === false` and `.stderr` contains
  `custom merge driver x lacks command line.`. tsgit: `repo.merge.run({ rev: 'theirs', … })`
  rejects — try/catch → `err.data.code === 'MERGE_DRIVER_MISSING_COMMAND'`, `err.data.name ===
  'x'`. Both leave `data.txt === 'ours\n'` and a clean index (`stageOf` shows 0 unmerged — no
  stage 1/2/3 rows). Fails pre-Part-2 (tsgit falls back to built-in text → conflict, not a
  refusal).
- ADD — M17 boundary pin (empty registration → built-in text, NOT a refusal): `data.txt
  merge=x` with no driver-command registration for `x` on either tool (an empty/absent
  `[merge "x"]`), diverged whole-file → both fall to the built-in text merge and conflict
  identically (`result.kind === 'conflict'`, `stageOf(ours) === stageOf(peer)` with stage
  1/2/3 rows, `data.txt` conflict markers agree). Verify the empty-section registration against
  real git in a `mktemp` throwaway; since tsgit records an empty section and no-section alike
  as no `missing-command` record (→ text), and git registers nothing for an empty header (→
  text), the faithful representation is `merge=x` with no `merge.x.*` key configured. This
  proves the non-empty-record gate: an empty registration does NOT trip the refusal.
- Do NOT pin M16 (`[merge "x"] foo = bar` — the documented ADR-497 residual divergence).
- PRESERVE the six original + the Part 1 M1/M2/M3 interop cases green.

Interop notes (from repo memory): git-spawning, `describe.skipIf(!GIT_AVAILABLE)`; the helpers
already scrub `GIT_*` via `runGitEnv()`; `setupDiverged` re-opens `repo` after config writes so
the merge reads fresh config.

### TDD steps

1. RED — add the "selected driverless throws" + "no CommandRunner still throws" + "unused
   section inert" unit cases in a new describe block. Run
   `npx vitest run test/unit/application/primitives/build-content-merger.test.ts`: the two
   throw cases fail (no `missing-command` branch — the value falls through to `mergeContent`,
   returning a result instead of throwing). At this point `npm run check:types` is also red
   until step 2 adds the exhaustiveness arm.
2. GREEN — add the `MERGE_DRIVER_MISSING_COMMAND` arm + `mergeDriverMissingCommand` constructor
   (`src/domain/commands/error.ts`); add the `extractDetail` case rendering `custom merge driver
   <name> lacks command line.` (`src/domain/error.ts`); add the chokepoint throw + import
   (`src/application/primitives/build-content-merger.ts`). Unit cases pass; `check:types` green.
3. RED→GREEN — add the M10 refusal and M17 boundary interop pins; run
   `npx vitest run test/integration/merge-driver-interop.test.ts`. M10 passes once the throw is
   wired (already done in step 2); confirm M17 stays a built-in-text conflict on both tools.
4. REFACTOR — regenerate and stage `reports/api.json` via `npm run docs:json` (prepush gate).
   Run `mcp__serena__get_diagnostics_for_file` on the three edited source files. Confirm the
   existing ADR-352 valueless build-content-merger cases (l.261–435) remain green and the
   eager guard is byte-unchanged.

### Gate

`npx vitest run test/unit/application/primitives/build-content-merger.test.ts test/integration/merge-driver-interop.test.ts && npm run check:types && ./node_modules/.bin/biome check src/domain/commands/error.ts src/domain/error.ts src/application/primitives/build-content-merger.ts test/unit/application/primitives/build-content-merger.test.ts test/integration/merge-driver-interop.test.ts`

Plus (prepush gate, verified at the phase-boundary validate): regenerate + stage
`reports/api.json` via `npm run docs:json` — a new public error code makes it stale.

### Commit

`fix(merge): lazily refuse a selected driverless merge driver`
