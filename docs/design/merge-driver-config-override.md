# Design — merge driver config override (`[merge "<builtin>"] driver`)

> Brief: `namedChoice` in `resolve-merge-driver.ts` short-circuits on the built-in driver name (`text`/`binary`/`union`) and returns the built-in **before** consulting config, so a user-configured `[merge "<name>"] driver = <cmd>` never overrides the built-in — whereas real git lets it. Prime-directive divergence fix surfaced by the 26.12 mutation sweep (two unkillable line-30 mutants).
> Status: draft → self-reviewed ×3

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

- **ADR-303** (merge driver selection & built-in coverage) — the selection table this fix
  amends. Its rows `'text'`/`'binary'`/`'union'` are stated unconditionally, and its row
  "`'<name>'` without a configured `driver` → fall back to built-in text (git's behaviour)"
  is **empirically imprecise** (see the pinned matrix M4/M5/M8/M10: git refuses when the
  section exists but is driverless).
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
- **R2** *(scope-dependent — Decision 1)* — The same holds for `merge=binary` with
  `[merge "binary"] driver` (M2) and `merge=union` with `[merge "union"] driver` (M3).
- **R3** — With no `driver` command configured for the resolved name, resolution falls back
  to the built-in selected **by name** (`text`→TEXT, `binary`→BINARY, `union`→UNION, any
  other name → TEXT). Every existing unit case and M6/M7 keep today's output.
- **R4** — The boolean/macro paths are unchanged and consult **no** config: `merge`
  (`true`)/`unspecified` → TEXT; `-merge`/`binary` macro (`false`) → BINARY, even when a
  `[merge "binary"] driver` is configured (M14). `driverFromMergeValue`'s `false`/`true`
  short-circuits stay as-is.
- **R5** — The two surviving line-30 mutants (ConditionalExpression `name === 'text'`,
  StringLiteral `'text'`) become killable: a passing unit test selects the **external** driver
  for `merge=text` + a configured `[merge "text"] driver`, which the pre-fix short-circuit
  makes impossible.
- **R6** — ADR-352's eager valueless-key guard is byte-unchanged: a valueless `driver`/`name`
  under any `[merge *]` subsection still refuses eagerly at the chokepoint (M11/M12/M15),
  selected or not.
- **R7** — No public API change; `resolvePathMergeSpec` signature and the memory/browser
  off-node fallback (ADR-304/408) are preserved. Off-node, a configured override resolves to
  `{ kind: 'external' }` and — with no `CommandRunner` — falls back to the built-in text merge,
  the same inert behaviour any external driver already has off-node.
- **R8** *(Decision 3)* — Behaviour when a `[merge "<name>"]` section exists but configures no
  `driver` command: either preserve today's fall-back-to-text (bounded), or reproduce git's
  lazy `custom merge driver <name> lacks command line` refusal (full-faithful).

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
| M11 | `data.txt merge=mydrv`| `driver` (valueless, no `=`)          | **128**  | `ours`      | 0        | `error: missing value for 'merge.mydrv.driver'` + `fatal: bad config variable … at line N` (eager, ADR-352) |
| M12 | *(no merge attr)*     | `[merge "mydrv"] driver` (valueless)  | **128**  | `ours`      | 0        | same as M11 — eager whole-table (ADR-352 M4) |
| M13 | `data.txt merge=mydrv`| `driver =` (empty valued string)      | 1        | conflict    | 3        | empty command = external that fails at runtime (`error: cannot run :`) → conflict |
| M14 | `data.txt -merge`     | `[merge "binary"] driver = cp %B %A`  | 1        | `ours`      | 3        | boolean-`false` path is **not** config-overridable |
| M15 | `data.txt merge=mydrv`| `name` (valueless) + `driver = cp …`  | **128**  | `ours`      | 0        | valueless `name` refuses eagerly even with a valued `driver` (ADR-352) |
| M16 | `data.txt merge=x`    | `[merge "x"] foo = bar` (unknown key)  | **128**  | `ours`      | 0        | git registers a user entry on **any** first key → driverless → "lacks command line" |
| M17 | `data.txt merge=x`    | `[merge "x"]` (empty, header only)     | 1        | conflict    | 3        | empty section registers **nothing** → default built-in text |

**What the matrix establishes:**

1. **Override (M1–M3):** a user driver of *any* name — including the three built-ins — with a
   valued `driver` command overrides the built-in. Precedence: user config **before** built-in.
   This is the core fix.
2. **Driverless-but-registered (M4/M5/M8/M10):** a `[merge "<name>"]` section that registers a
   user entry (git creates one on the first `merge.<name>.<anykey>` it sees) but has **no**
   `driver` command → git dies **lazily** `custom merge driver <name> lacks command line.`
   (exit 128) *when that driver is dispatched for a content merge*, and stays **inert** when
   unused (M9). This is distinct from ADR-352's eager valueless refusal (M11/M12/M15). Today
   tsgit falls back to built-in text for this case (ADR-303's stated — but empirically
   imprecise — "git's behaviour"). See **Decision 3**.
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
  // No configured driver command → built-in selected by name (default text).
  if (name === 'binary') return BINARY;
  if (name === 'union') return UNION;
  return TEXT; // 'text', unknown name, or a driverless section
};
```

This satisfies R1–R7 and removes line 30 entirely. The order maps 1:1 onto git's
`find_ll_merge_driver`: the user-config lookup (`ll_user_merge`) runs before the built-in
name table (`ll_merge_drv[]`), and an unmatched name defaults to text. `readConfig` is a
per-`Context` cached single-flight read (`config-read.ts`), so consulting it on the common
built-in path adds one in-memory map lookup, not a second file read.

**Mutation impact (R5):** the pre-fix `if (name === 'text') return TEXT` line — carrying the
two unkillable mutants — is gone. The relocated `if (name === 'binary')` / `if (name === 'union')`
guards are killed by the existing `merge=binary`→BINARY and `merge=union`→UNION built-in cases
(a mutated guard mis-routes those names), and the new override cases (M1–M3) prove config is
consulted before *any* name short-circuit, so no `name === '…'` guard can fire ahead of it.

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
result is byte-faithful. No new off-node code path.

### Interaction with ADR-352 (unchanged) and the driverless refusal (Decision 3)

The reorder does **not** touch `ensureNoValuelessMergeDriver`; the eager valueless guard fires
first at the chokepoint exactly as today (M11/M12/M15).

Under the reorder **as written above**, the driverless-but-registered case (M4/M5/M8/M10)
still falls back to built-in text — **identical to today's behaviour** for every name. The
reorder introduces **no new divergence**: pre-fix, `namedChoice('text')` returned TEXT via the
line-30 short-circuit; post-fix it returns TEXT via the driverless fall-through. The `custom`
driverless case (already tested to fall back to text) is unchanged.

Reproducing git's lazy `lacks command line` refusal (M4/M5/M8/M10) is a **separate**,
pre-existing faithfulness gap (ADR-303 mislabels the fall-back as "git's behaviour"). It is
larger than the reorder and is surfaced as **Decision 3**, because it requires:

- A new `MergeDriverChoice` variant (e.g. `{ kind: 'missing-command'; name }`) returned when
  the section registered an entry but no `driver` command, dispatched to a **new** lazy throw
  in `build-content-merger`'s per-path closure (the refusal is per-path/at-dispatch, not eager
  — M9 proves an unused driverless section is inert).
- A new error constructor beside `configMissingValue` reconstructing
  `custom merge driver <name> lacks command line.` (exit 128), pinned by interop.
- Handling the **registration mismatch** between git and tsgit's config map: git creates a
  user entry on the *first key of any name* under `[merge "<name>"]`, so `[merge "x"] foo=bar`
  registers a driverless entry and refuses if selected (**pinned M16**), while an **empty**
  `[merge "x"]` section registers nothing and defaults to text (**pinned M17**). tsgit's
  `merge` map records only `name`/`driver`/`recursive` and *does* record both an empty section
  and an unknown-key-only section as `{}` (see `mergeMergeDriver`, `config-read.ts`), so it
  cannot distinguish M16 from M17. A faithful-enough proxy: refuse only when `merge.get(name)`
  has a non-empty record (`name`/`recursive` set) but no `driver` — matching git for the common
  driverless section (M4/M5/M8/M10) and the empty section (M17), diverging only for the exotic
  unknown-key-only section (M16) tsgit does not model. This residual is the reason 3(a) is a
  distinct decision, not a silent add.

## Decision candidates

| # | Choice | Alternatives (≤3) | Recommendation | Why |
|---|---|---|---|---|
| 1 | **Scope of the override** — which built-in names consult config first | (a) all three built-ins (`text`/`binary`/`union`) consult config first; (b) `text`-only per the backlog's literal wording | **(a)** | Matrix M1/M2/M3 empirically prove `binary` and `union` are config-overridable *identically* to `text` — git's `find_ll_merge_driver` treats all three uniformly. (a) is the faithful, symmetric, minimal-branching fix; (b) would knowingly leave M2/M3 divergent and require re-touching this function later. |
| 2 | **ADR relationship to ADR-303** | (a) a **new** ADR records user-config-before-built-in precedence and annotates/supersedes ADR-303's imprecise "`'<name>'` without a configured `driver` → fall back to built-in text (git's behaviour)" row; (b) amend ADR-303 in place | **(a)** | A new ADR keeps ADR-303's accepted record intact and dated, cross-links the correction, and gives the prime-directive divergence fix its own citable decision. Amending in place rewrites accepted history and loses the "why it changed" trail. |
| 3 | **Driverless-registered section** (`[merge "<name>"]` with keys but no `driver`) — M4/M5/M8/M10 | (a) also fix now: reproduce git's lazy `custom merge driver <name> lacks command line` refusal (new choice variant + new error + chokepoint throw + registration-mismatch handling); (b) keep today's fall-back-to-built-in (the reorder introduces **no new divergence**; leave the pre-existing, ADR-303-sanctioned gap); (c) refuse only for the built-in names, keep `custom` falling back | **(b)** | The core 26.13 fix is the driver-**present** override; (b) delivers it bounded, with zero new divergence and no widened refusal surface, honouring the "bounded scope" constraint. This driverless gap is pre-existing (present today on the `custom` path, ADR-303-labelled), **not** exposed by the line-30 mutants, and carries real added surface (new variant/error, empty-vs-unknown-key registration edge). **Warn:** (a) closes a genuine faithfulness gap in one PR (consistent with the include-everything default) at that added cost; (c) is inconsistent (two rules for the same shape) — not advised. The user picks (a) vs (b) in the ADR phase. |

## Test strategy

**Unit — `test/unit/application/primitives/resolve-merge-driver.test.ts`** (extend; same
`seed`/`choose`/`spec` helpers, GWT/AAA/`sut`):

- Override selected (kills the line-30 mutants, R5): `merge=text` + `[merge "text"] driver = run %A` → `{ kind: 'external', command: 'run %A' }`. Add sibling cases for `merge=binary` and `merge=union` (Decision 1a).
- Override with `name`: `[merge "text"] name = X\n driver = run %A` → `{ kind: 'external', command: 'run %A', name: 'X' }`.
- Built-in fallback preserved (R3, kills the new `binary`/`union` guards): `merge=binary` no section → `BINARY`; `merge=union` no section → `UNION`; `merge=text`/unknown no section → `TEXT`. The existing built-in cases (lines 26–205) stay green unchanged.
- The existing valueless/driverless cases (lines 244–277) keep asserting `{ kind: 'text' }` —
  still correct under the reorder (a valueless `driver` is skipped by `mergeMergeDriver` →
  driverless record → text). **No assertion changes**, but **update the now-inaccurate
  "without consulting config" comment** on the `merge=text` + `[merge "text"] driver`-valueless
  case (262–277): config *is* now consulted; it resolves driverless to text. The ADR-352
  no-regression intent is unchanged (valueless is handled at the chokepoint, not here).
- Boolean path (R4): `-merge` + a configured `[merge "binary"] driver` still → `{ kind: 'binary' }` (config not consulted).
- *(Decision 3a only)* driverless-registered `[merge "x"] name = X` selected → the
  `missing-command` variant; unused → not selected (inert).

**Unit — `test/unit/application/primitives/build-content-merger.test.ts`** *(Decision 3a
only)*: the `missing-command` choice throws the lazy `lacks command line` error at the per-path
closure; an unused driverless section does not throw (memory adapter + fake `CommandRunner`).

**Interop (faithfulness pin) — `test/integration/merge-driver-interop.test.ts`** (extend the
existing twin-repo harness — `makePeerPair`, `configureDriverBoth`, `setupDiverged`,
`headOf`/`stageOf`/`read`): add an M1 case — both tools set `[merge "text"] driver = cp %B %A`
and `data.txt merge=text`, diverged whole-file; assert `result.kind === 'merge'`, HEAD, index
(`ls-files --stage`) and worktree byte-identical, `data.txt === 'theirs\n'`. This is the
byte-for-byte pin the backlog requires and fails against the pre-fix code (which conflicts).
Add M2 (`merge=binary`) and M3 (`merge=union`) siblings for Decision 1a. **Note:** the existing
`configureDriverBoth` hard-codes the `merge.custom.driver` key; the built-in-name cases need
the driver keyed to the built-in subsection (`merge.text.driver`, …), so parameterize the
driver-name (or set the config inline) rather than reuse `configureDriverBoth` verbatim. *(Decision 3a)* add an
M10-shaped case asserting both tools refuse when a driverless section is selected. The existing
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
- Decision 3(a)'s exotic unknown-key-only `[merge "x"]` registration (git registers, tsgit's
  map does not model it) — noted as a residual edge if 3(a) is chosen; not a goal.
