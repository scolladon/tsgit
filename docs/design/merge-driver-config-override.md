# Design — merge driver config override (`[merge "<builtin>"] driver`)

> Brief: `namedChoice` in `resolve-merge-driver.ts` short-circuits on the built-in driver name (`text`/`binary`/`union`) and returns the built-in **before** consulting config, so a user-configured `[merge "<name>"] driver = <cmd>` never overrides the built-in — whereas real git lets it. Prime-directive divergence fix surfaced by the 26.12 mutation sweep (two unkillable line-30 mutants).
> Status: accepted — revised against ADRs 496–497 (all decisions ratified, no open forks)

## Context

Once a path's `merge` attribute is resolved (ADR-302), `resolvePathMergeSpec` maps it to a
`MergeDriverChoice` via two private helpers in
`src/application/primitives/resolve-merge-driver.ts`:

- `driverFromMergeValue(ctx, value)` — maps the resolved attribute:
  `value === false` → `BINARY`; `value === true || 'unspecified'` → `TEXT`;
  `value.set` (a driver **name** string) → `namedChoice(ctx, name)`.
- `namedChoice(ctx, name)` — the defect. Current body (lines 28–38):

  ```ts
  const namedChoice = async (ctx: Context, name: string): Promise<MergeDriverChoice> => {
    if (name === 'text') return TEXT;      // line 30 — short-circuits BEFORE config
    if (name === 'binary') return BINARY;
    if (name === 'union') return UNION;
    const driver = (await readConfig(ctx)).merge?.get(name);
    if (driver?.driver === undefined) return TEXT;
    return driver.name === undefined
      ? { kind: 'external', command: driver.driver }
      : { kind: 'external', command: driver.driver, name: driver.name };
  };
  ```

  Because the three built-in names return before `readConfig`, a repo with
  `[merge "text"] driver = <cmd>` and a path carrying `merge=text` runs the **built-in**
  text merge, never the configured command. Git does the opposite: user-configured drivers
  take precedence over built-ins of the same name (git's `find_ll_merge_driver` scans
  `ll_user_merge` first, then the built-in `ll_merge_drv[]` array).

The choice is consumed at the content-merge chokepoint `buildContentMerger`
(`src/application/primitives/build-content-merger.ts`): `kind === 'binary'` →
take-ours conflict; `kind === 'external' && ctx.command !== undefined` → `runMergeDriver`;
otherwise `mergeContent` (built-in, `favor: union|none`). Every 3-way consumer
(`merge` directly; `cherry-pick`/`revert`/`rebase`/`stash` via `applyMergeToWorktree`)
routes through this one closure.

**Constraining prior decisions (read before designing against this):**

- **ADR-496 / ADR-497** — this design's own ratified decisions (see *Decisions (ratified)*).
  ADR-496 fixes user-config-before-built-in precedence for all three built-in names; ADR-497
  reproduces git's lazy driverless refusal. Both refine ADR-303; ADR-497 also sits beside
  ADR-352 as its lazy counterpart.
- **ADR-303** (merge driver selection & built-in coverage) — the selection table this fix
  amends; **now refined by ADR-496 and ADR-497.** Its rows `'text'`/`'binary'`/`'union'` were
  stated unconditionally — ADR-496 refines them to "consult a same-named configured `driver`
  first; built-in only when unconfigured." Its row "`'<name>'` without a configured `driver`
  → fall back to built-in text (git's behaviour)" is **empirically imprecise** (see the pinned
  matrix M4/M5/M8/M10: git refuses **lazily** when the section exists but is driverless) —
  ADR-497 refines it to reproduce that lazy refusal.
- **ADR-304 / ADR-407 / ADR-408** — external-driver dispatch surface (`CommandRunner` port,
  temp-file `%O/%A/%B` orchestration in `run-merge-driver.ts`, off-node inert fallback to the
  built-in text merge when no `CommandRunner` is wired).
- **ADR-305** — the per-region engine backing `text` (`favor:none`) and `union`
  (`favor:union`); untouched here (this fix changes *selection*, not the merge algorithm).
- **ADR-352** — `ensureNoValuelessMergeDriver` in `build-content-merger.ts` eagerly scans the
  whole `[merge *]` table for a **valueless** `driver`/`name` key (`value === null`) and
  refuses with `configMissingValue` at the content-merge chokepoint; `namedChoice` no longer
  carries its own valueless guard. This fix must leave that eager guard byte-identical
  (matrix M11/M12/M15).

`namedChoice` is file-private; `driverFromMergeValue` is its only caller; the exported
`resolvePathMergeSpec` signature is unchanged. No public/Tier-1 surface changes.

## Requirements

What must be true when this ships (verified against the pinned matrix, git 2.55.0):

- **R1** — A path resolving `merge=text` with `[merge "text"] driver = <cmd>` configured
  runs `<cmd>` (external driver), not the built-in text merge (M1).
- **R2** — The same holds uniformly for `merge=binary` with `[merge "binary"] driver` (M2)
  and `merge=union` with `[merge "union"] driver` (M3): all three built-in names consult a
  same-named configured `driver` first (ADR-496).
- **R3** — When the resolved name has **no registered driver record** (no section, an empty
  section, or an unknown-key-only section that tsgit records as `{}`), resolution falls back
  to the built-in selected **by name** (`text`→TEXT, `binary`→BINARY, `union`→UNION, any
  other name → TEXT). Every existing unit case and M6/M7/M17 keep today's output. (A
  **non-empty** driverless record instead refuses — see R8.)
- **R4** — The boolean/macro paths are unchanged and consult **no** config: `merge`
  (`true`)/`unspecified` → TEXT; `-merge`/`binary` macro (`false`) → BINARY, even when a
  `[merge "binary"] driver` is configured (M14). `driverFromMergeValue`'s `false`/`true`
  short-circuits stay as-is.
- **R5** — The two surviving line-30 mutants (ConditionalExpression `name === 'text'`,
  StringLiteral `'text'`) become killable: a passing unit test selects the **external** driver
  for `merge=text` + a configured `[merge "text"] driver`, which the pre-fix short-circuit
  makes impossible.
- **R6** — ADR-352's eager valueless-key guard is preserved byte-identical for `driver`/`name`
  (a valueless `driver`/`name` under any `[merge *]` subsection still refuses eagerly at the
  chokepoint, M11/M12/M15, selected or not) AND extended to also scan `recursive`: a valueless
  `[merge "<name>"] recursive` now refuses eagerly with the same `CONFIG_MISSING_VALUE` shape git
  emits (verified exit 128, `missing value for 'merge.<name>.recursive'`), closing the last
  valueless merge-key gap. The guard is also made **subsection-aware**: a subsectionless
  `[merge] <key>` (no `[merge "<name>"]` header) is inert, matching git (which ignores merge-driver
  keys without a subsection) — fixing a pre-existing subsectionless over-refusal for `driver`/`name`
  (folded in per review; see ADR-497 Consequences).
- **R7** — No public API change; `resolvePathMergeSpec` signature and the memory/browser
  off-node fallback (ADR-304/408) are preserved. Off-node, a configured override resolves to
  `{ kind: 'external' }` and — with no `CommandRunner` — falls back to the built-in text merge,
  the same inert behaviour any external driver already has off-node.
- **R8** — When a `[merge "<name>"]` section registers a **non-empty driverless** record
  (`name` and/or `recursive` set, no `driver` command) and that name is **selected** for a
  content merge, resolution refuses with git's lazy `custom merge driver <name> lacks command
  line.` (exit 128), thrown **per-path** at the content-merge chokepoint (M4/M5/M8/M10). An
  **unused** driverless section stays inert (M9). This is distinct from — and layered after —
  ADR-352's eager valueless-key refusal (ADR-497).

## Design

### Pinned faithfulness matrix (git 2.55.0)

Pinned empirically in a `mktemp` throwaway — `GIT_CONFIG_NOSYSTEM=1`, isolated `HOME`, all
`GIT_*` scrubbed, signing off. **Setup (constant):** `data.txt` diverges base→`theirs\n` on
one branch and base→`ours\n` on the other (whole-file different, so the built-in text merge
conflicts). Driver command `cp %B %A` copies *theirs* over *ours* and exits 0.

| #   | `.gitattributes`      | `[merge "X"]` config                  | git exit | `data.txt`  | unmerged | Interpretation |
|-----|-----------------------|---------------------------------------|----------|-------------|----------|----------------|
| M1  | `data.txt merge=text` | `driver = cp %B %A`                   | 0        | `theirs`    | 0        | user **text** driver overrides built-in text |
| M2  | `data.txt merge=binary`| `driver = cp %B %A`                  | 0        | `theirs`    | 0        | user **binary** driver overrides built-in binary |
| M3  | `data.txt merge=union`| `driver = cp %B %A`                   | 0        | `theirs`    | 0        | user **union** driver overrides built-in union |
| M4  | `data.txt merge=text` | `name = X` (no `driver`)              | **128**  | `ours`      | 0        | `fatal: custom merge driver text lacks command line.` |
| M5  | `data.txt merge=custom`| `name = X` (no `driver`)             | **128**  | `ours`      | 0        | `fatal: custom merge driver custom lacks command line.` |
| M6  | `data.txt merge=custom`| *(no section)*                       | 1        | conflict    | 3        | unknown name → default built-in text (conflict) |
| M7  | `data.txt merge=text` | *(no section)*                        | 1        | conflict    | 3        | built-in text baseline |
| M8  | `data.txt merge=text` | `recursive = text` (no `driver`)      | **128**  | `ours`      | 0        | driverless section (any key) still "lacks command line" |
| M9  | *(no merge attr)*     | `[merge "unused"] name = X`           | 1        | conflict    | 3        | driverless section **unused** → inert (lazy) |
| M10 | `data.txt merge=unused`| `[merge "unused"] name = X`          | **128**  | `ours`      | 0        | driverless section **selected** → "lacks command line" (lazy, per-path) |
| M11 | `data.txt merge=my-driver`| `driver` (valueless, no `=`)      | **128**  | `ours`      | 0        | `error: missing value for 'merge.my-driver.driver'` + `fatal: bad config variable … at line N` (eager, ADR-352) |
| M12 | *(no merge attr)*     | `[merge "my-driver"] driver` (valueless) | **128** | `ours`     | 0        | same as M11 — eager whole-table (ADR-352 M4) |
| M13 | `data.txt merge=my-driver`| `driver =` (empty valued string)  | 1        | conflict    | 3        | empty command = external that fails at runtime (`error: cannot run :`) → conflict |
| M14 | `data.txt -merge`     | `[merge "binary"] driver = cp %B %A`  | 1        | `ours`      | 3        | boolean-`false` path is **not** config-overridable |
| M15 | `data.txt merge=my-driver`| `name` (valueless) + `driver = cp …` | **128** | `ours`     | 0        | valueless `name` refuses eagerly even with a valued `driver` (ADR-352) |
| M16 | `data.txt merge=x`    | `[merge "x"] foo = bar` (unknown key)  | **128**  | `ours`      | 0        | git registers a user entry on **any** first key → driverless → "lacks command line" |
| M17 | `data.txt merge=x`    | `[merge "x"]` (empty, header only)     | 1        | conflict    | 3        | empty section registers **nothing** → default built-in text |

**What the matrix establishes:**

1. **Override (M1–M3):** a user driver of *any* name — including the three built-ins — with a
   valued `driver` command overrides the built-in. Precedence: user config **before** built-in.
   This is the core fix.
2. **Driverless-but-registered (M4/M5/M8/M10):** a `[merge "<name>"]` section that registers a
   user entry (git creates one on the first `merge.<name>.<key>` it sees) but has **no**
   `driver` command → git dies **lazily** `custom merge driver <name> lacks command line.`
   (exit 128) *when that driver is dispatched for a content merge*, and stays **inert** when
   unused (M9). This is distinct from ADR-352's eager valueless refusal (M11/M12/M15). **This
   fix reproduces the lazy refusal** (ADR-497), correcting ADR-303's imprecise "git's
   behaviour" fall-back-to-text.
3. **Unknown / no section (M6/M7):** an unknown name with no registered section → git's default
   built-in text merge. tsgit already matches this; must be preserved.
4. **Boolean path untouched (M14):** the `-merge`/`binary`-macro (`value === false`) path never
   consults config. `driverFromMergeValue` stays as-is.
5. **ADR-352 untouched (M11/M12/M15):** valueless `driver`/`name` under any `[merge *]`
   subsection still refuses eagerly at the chokepoint. `namedChoice` never re-adds a valueless
   guard.

### The faithful reorder (core fix — required)

Rewrite `namedChoice` to consult config **first**, then fall back to the built-in by name:

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

This satisfies R1–R7 and yields R8's `missing-command` choice (its refusal is thrown at the
chokepoint, below); it removes line 30 entirely. The order maps 1:1 onto git's
`find_ll_merge_driver`: the user-config lookup (`ll_user_merge`) runs before the built-in
name table (`ll_merge_drv[]`), and an unmatched name defaults to text. `readConfig` is a
per-`Context` cached single-flight read (`config-read.ts`), so consulting it on the common
built-in path adds one in-memory map lookup, not a second file read.

**Mutation impact (R5):** the pre-fix `if (name === 'text') return TEXT` line — carrying the
two unkillable mutants — is gone. The relocated `if (name === 'binary')` / `if (name === 'union')`
guards are killed by the existing `merge=binary`→BINARY and `merge=union`→UNION built-in cases
(a mutated guard mis-routes those names), and the new override cases (M1–M3) prove config is
consulted before *any* name short-circuit, so no `name === '…'` guard can fire ahead of it.
The new `missing-command` guard (`driver !== undefined && (driver.name !== undefined ||
driver.recursive !== undefined)`) is killed by two **isolated** driverless cases — one with only
`name` set (M4-shaped), one with only `recursive` set (M8-shaped) — each refusing independently
(per the guard-clause rule); an empty-`{}` record case (M17-shaped, selected → text) proves the
guard does **not** fire for an empty record (killing a condition-forced-true mutant) and pins the
M16/M17 boundary.

**Off-node / no `CommandRunner` (R7, ADR-304/408):** an override resolves to
`{ kind: 'external', command }`; `build-content-merger` runs it only when
`ctx.command !== undefined`, else falls to `mergeContent(..., favor: 'none')` = built-in text.
So off-node a configured override is *inert* and yields the built-in text merge — identical to
how any external driver (including today's `merge=custom`) already behaves off-node, and
matching ADR-408's "inert = no-driver baseline". For a configured `text` override this is
exactly the un-overridden `merge=text` output (fully clean). One honest second-order note: for
a configured `binary`/`union` override, off-node the fallback is built-in **text**, not
built-in binary/union — pre-fix `merge=binary` off-node gave built-in binary, so this exotic
config (a same-named override run in memory/browser) shifts to text off-node. That target is
ADR-304-governed (external → built-in-text fallback), not a new decision; on-node — where the
interop/faithfulness suite runs and the runner is always present — the driver runs and the
result is byte-faithful. No new off-node code path. The `missing-command` refusal (R8) is
orthogonal to the runner: it is thrown before the `ctx.command` branch, so a selected driverless
section refuses identically on- and off-node (git refuses regardless of platform).

### Interaction with ADR-352 (eager, unchanged) and the lazy driverless refusal (ADR-497)

Two refusals coexist at the content-merge chokepoint, in this order:

1. **ADR-352 — eager, whole-table, valueless keys (unchanged).** `ensureNoValuelessMergeDriver`
   runs **first** (before `resolvePathMergeSpec`), scanning the whole `[merge *]` table for a
   valueless `driver`/`name` (`value === null`) and refusing with `configMissingValue`
   (M11/M12/M15), selected or not. The reorder does **not** touch it; `namedChoice` never
   re-adds a valueless guard. M15 (valueless `name` beside a valued `driver`) still refuses
   here, ahead of any driver dispatch.
2. **ADR-497 — lazy, per-path, driverless-but-registered (new).** `namedChoice` yields the new
   `missing-command` choice for a **non-empty driverless** record; the chokepoint throws git's
   `custom merge driver <name> lacks command line.` only for the path that selected it.

Pre-fix, `namedChoice('text')` returned TEXT via the line-30 short-circuit; the driverless-but-
registered case fell back to built-in text (ADR-303's imprecise "git's behaviour"). This design
replaces that fall-back with git's lazy refusal, closing the divergence (ADR-497).

#### The `missing-command` choice variant

`MergeDriverChoice` gains a fifth variant:

```ts
export type MergeDriverChoice =
  | { readonly kind: 'text' }
  | { readonly kind: 'union' }
  | { readonly kind: 'binary' }
  | { readonly kind: 'external'; readonly command: string; readonly name?: string }
  | { readonly kind: 'missing-command'; readonly name: string };
```

`namedChoice` returns it when `merge.get(name)` is a **non-empty** record (`name` and/or
`recursive` set) with `driver === undefined` — see the reorder above. The `name` field carries
the resolved driver name for the refusal message.

#### The per-path chokepoint throw

`buildContentMerger`'s returned closure gains a branch **before** the `binary`/`external`
dispatch (and before the `ctx.command` external check, so the refusal is platform-independent):

```ts
const { driver, markerSize } = await resolvePathMergeSpec(ctx, await provider(), mergeCtx.path);
if (driver.kind === 'missing-command') {
  throw mergeDriverMissingCommand(driver.name);
}
if (driver.kind === 'binary') { /* … */ }
```

Because the throw lives in the per-path closure (invoked once per merged path), an **unused**
driverless section is never dispatched and stays inert (M9), matching git's laziness. The eager
ADR-352 guard already ran above it, so a valueless key still wins (M15).

#### The new error constructor

Beside `configMissingValue` in `src/domain/commands/error.ts`, a `mergeDriverMissingCommand(name)`
constructor builds a `TsgitError` on a new `MERGE_DRIVER_MISSING_COMMAND` code carrying `name`
(a new arm in the error-data union there); the message renderer in `src/domain/error.ts` renders
`custom merge driver <name> lacks command line.` (per ADR-249 the library emits the structured
code + `name`; the interop test reconstructs git's `fatal:`-prefixed line and exit 128 from it).
Pinned by interop against real git (M4/M5/M8/M10).

#### The registration-mismatch proxy (M16 residual)

git creates a user driver entry on the **first key of any name** under `[merge "<name>"]`, so
`[merge "x"] foo = bar` registers a driverless entry and refuses when selected (**M16**), while
an **empty** `[merge "x"]` header registers nothing and defaults to text (**M17**). tsgit's
`merge` map records only `name`/`driver`/`recursive`: `mergeMergeDriver` (`config-read.ts`)
skips null-valued keys, ignores unknown keys, then unconditionally `set(name, next)`, so both an
empty section and an unknown-key-only section land as an **empty `{}`** record (confirmed against
`mergeMergeDriver`). tsgit therefore cannot distinguish M16 from M17.

The `missing-command` rule keys off a **non-empty** record (`name`/`recursive` set), so it:

- refuses for the common driverless section (M4/M5/M8/M10) — matching git;
- falls back to text for the empty section (M17) — matching git;
- falls back to text for the exotic unknown-key-only section (M16) — **diverging** from git's
  refusal. This is the one **documented residual** (ADR-497), tied to tsgit's config-map model,
  not a goal, and deliberately **not** interop-pinned (it is a known, bounded divergence).

## Decisions (ratified)

Settled with the user in the ADR phase and recorded as ADR-496 and ADR-497 (both refine
ADR-303; ADR-497 also sits beside ADR-352 as its lazy counterpart). No open forks remain — the
firm requirements and design above already fold these in.

| # | Decision | Ratified choice | ADR |
|---|---|---|---|
| 1 | **Scope of the override** — which built-in names consult config first | **(a) all three built-ins** (`text`/`binary`/`union`) consult a same-named configured `driver` first (matrix M1/M2/M3, git's `find_ll_merge_driver` treats them uniformly). Matched the design's recommendation. | ADR-496 |
| 2 | **ADR relationship to ADR-303** | **New ADRs** — 496/497 record the corrections and refine ADR-303 (and ADR-352) rather than amend accepted history in place. | ADR-496, ADR-497 |
| 3 | **Driverless-registered section** (`[merge "<name>"]` with keys but no `driver`) — M4/M5/M8/M10 | **(a) fix now** — reproduce git's lazy `custom merge driver <name> lacks command line.` refusal (new `missing-command` choice variant + new error constructor + per-path chokepoint throw + the M16 registration-mismatch proxy). **Deviated** from the design's original (b) "bounded / keep fall-back-to-text" recommendation; the user chose to close the divergence in this PR (prime directive, ADR-226). | ADR-497 |

The M16 residual (git registers a driverless entry on any first key; tsgit's `merge` map records
unknown-key-only and empty sections alike as `{}`) is documented in ADR-497, not a goal: the
`missing-command` rule keys off a **non-empty** record, matching git on M4/M5/M8/M10 and M17 and
diverging only on the exotic M16.

## Test strategy

**Unit — `test/unit/application/primitives/resolve-merge-driver.test.ts`** (extend; same
`seed`/`choose`/`spec` helpers, GWT/AAA/`sut`):

- Override selected (kills the line-30 mutants, R5): `merge=text` + `[merge "text"] driver = run %A` → `{ kind: 'external', command: 'run %A' }`. Add sibling cases for `merge=binary` and `merge=union` (ADR-496 — all three names uniform).
- Override with `name`: `[merge "text"] name = X\n driver = run %A` → `{ kind: 'external', command: 'run %A', name: 'X' }`.
- Built-in fallback preserved (R3, kills the new `binary`/`union` guards): `merge=binary` no section → `BINARY`; `merge=union` no section → `UNION`; `merge=text`/unknown no section → `TEXT`. The existing built-in, override, and no-section cases stay green unchanged (only the one driverless case below flips).
- **Assertion flip (R8, ADR-497):** the existing `merge=custom` + `[merge "custom"] name = My
  Driver` case (test lines 174–188) — a **non-empty** driverless record (M5-shaped) — must flip
  from `{ kind: 'text' }` to `{ kind: 'missing-command', name: 'custom' }`, and its `it` title
  ("Then it falls back to the text driver") rewritten to the refusal. This is the concrete
  existing-test change D3=(a) requires; it stays green pre-fix only because today's code falls
  back to text.
- The existing **valueless-`driver`** cases (test lines 244–277) keep asserting `{ kind: 'text' }`
  — still correct under the reorder: a valueless `driver` is skipped by `mergeMergeDriver`, leaving
  an **empty `{}`** record (no `name`/`recursive`), which is *not* a `missing-command` record and
  falls back to text. **No assertion change** for these two, but **update the now-inaccurate
  "without consulting config" comment** on the `merge=text` + `[merge "text"] driver`-valueless
  case (262–277): config *is* now consulted; it resolves the empty record to text. The ADR-352
  no-regression intent is unchanged (valueless is handled at the chokepoint, not here).
- Boolean path (R4): `-merge` + a configured `[merge "binary"] driver` still → `{ kind: 'binary' }` (config not consulted).
- Driverless refusal, **isolated guard cases** (R8, ADR-497): `[merge "text"] name = X` (no
  `driver`) selected → `{ kind: 'missing-command', name: 'text' }`; `[merge "text"] recursive =
  text` (no `driver`) selected → `{ kind: 'missing-command', name: 'text' }`. Each triggers one
  side of the `name || recursive` guard alone (per the guard-clause rule). An **empty /
  unknown-key** record selected (`[merge "text"] foo = bar` → `{}`) → `TEXT` (M17 boundary;
  proves the guard does not fire for an empty record and pins the M16 residual resolving to text).

**Unit — `test/unit/application/primitives/build-content-merger.test.ts`** (R8, ADR-497): a
selected driverless section (`missing-command` choice) throws `mergeDriverMissingCommand` at the
per-path closure — assert the error `.data` (`code: 'MERGE_DRIVER_MISSING_COMMAND'`, `name`) via
try/catch, not `toThrow(type)`; an **unused** driverless section does **not** throw (M9 inert).
Assert the throw fires with **no** `CommandRunner` wired too (platform-independent refusal, thrown
before the `ctx.command` branch). Memory adapter + fake `CommandRunner`.

**Interop (faithfulness pin) — `test/integration/merge-driver-interop.test.ts`** (extend the
existing twin-repo harness — `makePeerPair`, `configureDriverBoth`, `setupDiverged`,
`headOf`/`stageOf`/`read`): add an M1 case — both tools set `[merge "text"] driver = cp %B %A`
and `data.txt merge=text`, diverged whole-file; assert `result.kind === 'merge'`, HEAD, index
(`ls-files --stage`) and worktree byte-identical, `data.txt === 'theirs\n'`. This is the
byte-for-byte pin the backlog requires and fails against the pre-fix code (which conflicts).
Add M2 (`merge=binary`) and M3 (`merge=union`) siblings (R2, ADR-496 — all three names). **Note:** the existing
`configureDriverBoth` hard-codes the `merge.custom.driver` key; the built-in-name cases need
the driver keyed to the built-in subsection (`merge.text.driver`, …), so parameterize the
driver-name (or set the config inline) rather than reuse `configureDriverBoth` verbatim. Add an
M10-shaped case (R8, ADR-497): both tools set `[merge "x"] name = x` (no `driver`) and
`data.txt merge=x`, diverged whole-file; assert **both refuse** — git exit 128 with
`custom merge driver x lacks command line.`, tsgit throws `MERGE_DRIVER_MISSING_COMMAND` — and
leave `data.txt` = `ours` with a clean (0 unmerged) index. Also pin the M17 boundary (empty
`[merge "x"]` header, `data.txt merge=x`, diverged → both fall to the built-in text merge and
conflict identically). Do **not** pin M16 (a known residual divergence). The existing
`merge=custom` / `-merge` / `merge=union` / `merge=text` cases must stay green.

**Property tests:** not applicable — `namedChoice` is enum/config dispatch (a small closed set
of names), not a parser/matcher/round-trip pair (per the repo's four-lens test).

## Out of scope

- The `merge.default` config key (git's `default_ll_merge` for `ATTR_UNSET`) — tsgit maps
  `unspecified` → built-in text directly; not part of this defect.
- Marker size / labels `%L/%P/%S/%X/%Y` and `recursive` driver selection — governed by their
  own ADRs (304/305), untouched here.
- The content-merge algorithm (`domain/merge/`) — this fix changes *selection*, not merging.
- Empty-string driver command (M13) — already an `{ kind: 'external', command: '' }` that
  fails at runtime; no resolution change.
- The exotic unknown-key-only `[merge "x"] foo = bar` registration (M16) — git registers a
  driverless entry and refuses when selected; tsgit's `merge` map records it as an empty `{}`
  and falls back to text. A **documented residual** (ADR-497), not a goal, and deliberately not
  interop-pinned (a known, bounded divergence, not a faithful match).
