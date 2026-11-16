# Design — long-pathspec-refusals

> Brief: backlog 32.40 — a pathspec or a working-tree path is refused for its length where git stages it,
> removes it, restores it, greps it or reports that it matched nothing; remove every length refusal git
> does not make, and read an OS "name too long" on an `add` pathspec probe as git does.
> Status: draft → self-reviewed ×3 → accepted

## Context

### The corrected backlog statement

32.40 was filed against git 2.55 on 36a8b9b7. Both halves reproduce on main 92912f7f against git
2.56.0 (macOS, APFS, `NAME_MAX` 255, `PATH_MAX` 1024):

- (a) `add` of an existing 805-byte path: git stages it (exit 0); tsgit throws
  `INVALID_OPTION { option: 'paths', reason: 'pattern exceeds max length 256 bytes' }`.
- (b) a 300-byte single component: git says `pathspec '<p>' did not match any files` (exit 128);
  tsgit throws `PATHSPEC_OUTSIDE_REPO`.

The family is wider than the entry. (1) A second budget, the four-`**` limit, refuses patterns git
accepts. (2) Both budgets refuse exclusions (`!<long>`), which git never refuses. (3) `rm`, `checkout`
paths and `grep` share the budgets and the caps. (4) An index-only entry with a long name cannot be
named. (5) On APFS and NTFS a component of more than 255 UTF-8 bytes is a real name: 100 × U+6F22 is
300 bytes, and APFS creates it (probed; 86 characters = 258 bytes too). Today tsgit refuses it in
`add`, `status`, `rm`, `mv`, `checkout`, `grep` and worktree `blame`, on a well-formed repository.
The 256-byte budget also refuses a 257-byte path (`<m127>/<n129>`) that every host can hold.

### Code map (names, not line numbers)

| Where | Symbol | Role today |
|---|---|---|
| `src/application/commands/internal/resolve-pathspec.ts` | `MAX_PATHSPEC_PATTERN_BYTES` (256), `MAX_DOUBLE_STAR_PER_PATTERN` (4), `PATTERN_ENCODER`, `enforcePatternBudget`, `countDoubleStars` (holds two `Stryker disable` equivalence marks) | the two budgets, both `invalidOption('paths', …)`, called from `resolvePathspec` over every raw pattern, negated ones included |
| same file | `validatePathspecBody` ← `collapsePattern` ← `resolvePathspec` | runs `validatePath` on the body (with `\` read as `x`) and rethrows **any** failure as `pathspecOutsideRepo(body)`. This turns the length caps below into the outside-repository refusal |
| same file | `assertNoSymlinkedLeadingPath(ctx, targets)` | git's `has_symlinked_leading_path` over `symlinkScanTargets`. Only consumer: `add.ts` (two sites) |
| `src/application/commands/internal/pathspec-intake.ts` | `resolveCommandPathspec(host, paths)` | the intake for `add.ts` (two sites), `rm.ts`, `checkout.ts` (paths form) and `grep.ts`. `add.ts` also compiles `WHOLE_TREE_MATCHER` through `resolvePathspec` |
| `src/domain/working-tree-path.ts` | `MAX_PATH_BYTES` (4096) in `rejectInputShape`; `MAX_COMPONENT_BYTES` (255) in `rejectTraversalShape`, with an `asciiOnly` flag, `byteLength` and `PATH_ENCODER` used only for that cap | the two length caps, `PATHSPEC_OUTSIDE_REPO` |
| same file | `validateWorkingTreePath`, `validateWorkingTreePathOn`, `validateWalkedEntryPath` | the three exported validators; all reach `rejectInputShape` + `rejectTraversalShape` |
| `src/application/commands/internal/working-tree.ts` | `validatePath` (alias of `validateWorkingTreePath`), `materializeFile`, `removeFile`, `removeDirectory`, `renameInWorkingTree` | writers that validate their own path |
| `src/application/commands/mv.ts` | `mv` validates each source and the destination with `validatePath` directly, not through the pathspec intake; `lstatOrUndefined` (folds every failure), `isDirectoryOnDisk` | mv never had the 256 budget, only the caps |
| `src/application/commands/blame.ts` | `seedWorkingTree` → `validateWorkingTreePath` | worktree-mode blame |
| `src/application/primitives/walk-working-tree.ts` | `stepEntry` → `validateWalkedEntryPath(path, ctx)` on every `readdir` entry; `readDirectoryFrame`; `maxDepth` → `TREE_DEPTH_EXCEEDED` | `status`, `add .`, worktree `grep`, `stash`… |
| `src/application/commands/add.ts` | `lstatOrMissing` (folds `FILE_NOT_FOUND`) ← `lstatOrBeneathFile` (adds `NOT_A_DIRECTORY`) | see the consumer list below |
| `src/application/primitives/internal/symlinked-leading-path.ts` | `createLeadingPathScanner` → `lstatPrefix` (folds `FILE_NOT_FOUND` only) | used by 16 modules besides its own; only `add` reaches it with pathspec text |
| `src/adapters/node/node-file-system.ts` | `mapErrno`: `ENAMETOOLONG` → `pathTooLong(path)` (`src/domain/error.ts`, `PATH_TOO_LONG { path }`) | the memory adapter has no length limit and never raises it |
| `src/domain/pathspec/wildcard.ts` → `src/domain/refs/ref-glob.ts` | `compileWildcard` → `compileRefGlobBytes` | tokenised, non-backtracking backward dynamic program over two rows; a run of `*` is one token under flags 0 |

The `add` disk-probe consumers, listed from the primitive (lesson 038):

| Primitive | Caller | What it stats |
|---|---|---|
| `lstatOrMissing` | `lstatOrBeneathFile` | (wrapper) |
| `lstatOrMissing` | `renormalizeOne` | a **tracked** entry's path |
| `lstatOrMissing` | `presentOnDisk` | a **tracked** entry's path (removal pass) |
| `lstatOrBeneathFile` | `literalStats` | a **pathspec** body (literal fast path) |
| `lstatOrBeneathFile` | `namesOnDisk` (← `refuseUnseenRenormalized`) | a **pathspec** body (`file_exists` escape) |
| `lstatOrBeneathFile` | `namesDiskPath` (← `refuseUnseenWalked`) | a **pathspec** body (`file_exists` escape) |
| `lstatOrBeneathFile` | `hiddenWalkEntryOf` | a **tracked** entry's path |
| `lstatOrBeneathFile` | `movedGitlinkOf` | a **tracked** gitlink's path |

So no shared helper serves the pathspec probes alone. A fold inside either one widens tracked-entry
stats.

### Constraining ADRs

- ADR-226 (prime directive) and ADR-249 (structured output only): fields, never rendered text. Interop
  tests rebuild git's view from fields.
- ADR-1033 (wildmatch dialect), ADR-1034 (glob-special set; its consequence line "the 256-byte and
  `**`-count budgets are unchanged" is history), ADR-1035 (add refuses an unmatched pathspec under the
  lock, before any object write), ADR-1036 (an unmatched glob whose verbatim path exists is not
  refused), ADR-1037 (`PATHSPEC_NO_MATCH { pattern, patterns }`), ADR-1042, ADR-1044 (a backslash body
  on POSIX), ADR-1045 (an unseen literal naming an unignored path on disk), ADR-1051, ADR-1053, ADR-1004.
- ADR-1043 ratified keeping both budgets "to stay in scope". It records that the `**` cap exists "for a
  RegExp reason that ADR-077 removed; git has no such cap", and names dropping it a separate faithful
  follow-up. This change is that follow-up.
- ADR-1048 (removing a refusal git does not make shipped as `fix`); ADR-1190 (a new refusal marked
  breaking); ADR-1024 (removing a union member is breaking). These are release-marking precedents for
  D6.
- ADR-1170 (filing bar): every row below is a refusal mismatch or wrong result on a well-formed
  repository, so it is in scope. The deferred rows go to impact triage, not to the ledger by default.

## Requirements

Axes: **command** (add, rm, checkout paths, grep, mv, plus the validator's other consumers: status walk,
worktree blame, writers) × **shape** (literal, wildcard, exclusion, directory-only `/`) × **length
class** (L1 total > 256 bytes, every component ≤ 255; L2 a component > 255 UTF-8 bytes that exists;
L3 a component the host cannot hold; L4 total > 4096 bytes; L5 an existing path past the host
`PATH_MAX`) × **where the name lives** (disk, index only, nowhere).

- **R1 — shape: no pattern budget.** No command refuses a pathspec of any shape for its byte length or
  for its count of `*` or `**`. `resolvePathspec` refuses only by the shape rules of R2: traversal, an
  absolute path, NUL or control bytes, `.git` aliases, a leading `:` or drive letter, and `\` under
  Windows path syntax.
- **R2 — validators: no length rule.** `validateWorkingTreePath`, `validateWorkingTreePathOn` and
  `validateWalkedEntryPath` refuse no input for its total byte length or for a component's byte length.
  Every other rule is unchanged, and so is the error (`PATHSPEC_OUTSIDE_REPO { path }`). Afterwards
  length is decided by the adapter: the node adapter's OS → `PATH_TOO_LONG`; the memory adapter → no
  limit. Walk depth is decided by `maxDepth` → `TREE_DEPTH_EXCEEDED`, and by the OS refusing a
  `readdir`.
- **R3 — disk, L1/L2 (exists).** A name that exists is acted on as git acts on it, for every shape.
  `add` stages it, `rm` / `rm --cached` removes it, `checkout -- p` / `checkout HEAD -- p` restores it,
  `grep -- p` reports its hit, `mv` moves it from or to that name, `status` reports it, worktree `blame`
  reads it.
- **R4 — nowhere, L1–L4.** A positive pathspec that matches nothing ends in the command's existing
  no-match outcome, whatever its length. `add`: `PATHSPEC_NO_MATCH` with the first unmatched pattern.
  `rm`: `PATHSPEC_NO_MATCH` with the first. `checkout`: `PATHSPEC_NO_MATCH` with all of them. `grep`:
  success with `{ paths: [] }`. `mv` source: `MV_SOURCE_NOT_TRACKED`, or `MV_BAD_SOURCE` when the entry
  is tracked but absent from disk. It is never `INVALID_OPTION`, `PATHSPEC_OUTSIDE_REPO` or
  `PATH_TOO_LONG`.
- **R5 — add's pathspec probes read "too long" as absent.** When the OS refuses an `add` pathspec-body
  probe with `PATH_TOO_LONG`, that probe reads as "nothing on disk" (git's `file_exists` / `lstat`
  read any failure that way). This covers `literalStats`, `namesOnDisk`, `namesDiskPath` and
  `assertNoSymlinkedLeadingPath`'s scan of pathspec targets. Tracked-entry stats (`presentOnDisk`,
  `renormalizeOne`, `hiddenWalkEntryOf`, `movedGitlinkOf`) and the other 16 scanner consumers keep
  propagating `PATH_TOO_LONG`.
- **R6 — index only, L2–L4.** A long name that lives only in the index is matched from the index:
  `rm --cached` removes it, `grep --cached` reports its hit, and a glob reaching it removes it beside
  its on-disk siblings. git's `warning: failed to stat` has no structured analogue (D5).
- **R7 — exclusion, every length class.** An exclusion is never refused for its length. `add . !<long>`
  stages everything else, whether `<long>` exists (L1) or cannot exist (L3), and whether its leading
  component can be read by `lstat` or not.
- **R8 — mv to a name the OS refuses.** `mv` to a destination the OS cannot create refuses and moves
  nothing: index and disk are unchanged (git: 128 `renaming '…' to '…' failed: File name too long`).
  The refusal's code and `path` field are D4. `mv -n` (dry run) returns the plan for that destination,
  as git does (exit 0).
- **R9 — platform.** No expectation hard-codes a host limit. A row that needs an L2 name probes
  whether the host can create one (APFS / NTFS: 255 UTF-16 units; ext4: 255 bytes). On a host that
  cannot, the row takes its L3 arm (R4) or is skipped. A row that needs an L1 name asserts its absolute
  length is below the host `PATH_MAX` before it runs. L3 rows use ASCII names over 255 bytes (no
  supported file system holds them). L4 rows use a 4999-byte path, past every `PATH_MAX` (1024 macOS,
  4096 Linux).
- **R10 — cost.** The matcher is unchanged. The cost per path is bounded by the path's own length
  times the largest bracket expression in the pattern, as git's `wildmatch` is (measured below). No new
  cap is added unless D1 chooses one.
- **R11 — output.** No result type changes and no error code is added or removed (unless D4/D5 choose
  otherwise). `docs/use` stops claiming a cap that no longer exists.

### Every pinned row against its requirement

Fixture names: `<a200>` is 200 × `a`, and so on. `P805` = `<a200>/<b200>/<c200>/<d200>/x` (805 bytes,
tracked), and `DIR805` is its directory. `P256` / `P257` = `<m127>/<n128>` / `<m127>/<n129>` (tracked).
`S255` = 255 × `s` (tracked). `S256` and `S300` cannot exist on any host. `P5000` = 98 × `<q50>/` +
`x` (4999 bytes). `P1408` = `DIR805/<e200>/<f200>/<g200>/x`, created by stepping `cd`, past the macOS
`PATH_MAX`. `CJK100` = 100 × U+6F22 (300 UTF-8 bytes, 100 UTF-16 units). git exclusions are spelled
`:!p` and tsgit's `!p`. Probe scripts and raw outputs: `<scratch>` (twin probe on main, on a scratch
copy with the budgets and caps removed, and on that copy plus the R5 folds).

`=` means git and tsgit end in the same state (`ls-files -s` + `status --porcelain`). "After" is the
outcome this design gives, checked on a scratch copy of `src` with the budgets and caps removed and, for
R5, the probe fold applied.

| # | Row (git 2.56.0 → tsgit main) | Req | After |
|---|---|---|---|
| B1 | add P805 modified / sibling untracked / `DIR805/*` / `*<b200>/<c200>/<d200>/x` / `DIR805/` — git stages; tsgit `INVALID_OPTION` | R1 R3 | staged, = |
| B2 | add P257 modified — git 0; tsgit `INVALID_OPTION` (P256 passes on both) | R1 R3 | staged, = |
| B3 | add `.` `!P805` — git 0, `base` staged; tsgit `INVALID_OPTION` | R1 R7 | `base` staged, = |
| B4 | add `DIR805/nope`, `P805/` — git 128 did not match; tsgit `INVALID_OPTION` | R1 R4 | `PATHSPEC_NO_MATCH`, = |
| B5 | rm P805, rm --cached P805, rm `DIR805/*` — git 0 | R1 R3 | removed, = |
| B6 | checkout -- P805, checkout HEAD -- P805, checkout -- `DIR805/*` — git 0, restored | R1 R3 | restored, = |
| B7 | checkout -- `DIR805/nope` — git 1 did not match | R1 R4 | `PATHSPEC_NO_MATCH`, = |
| B8 | grep -- P805, `DIR805/*`, HEAD -- P805 — git one hit | R1 R3 | one hit |
| B9 | grep -- `DIR805/nope` — git 1, no output | R1 R4 | `{ paths: [] }` |
| T1 | add / rm / checkout -- / grep -- `**a**b**c**d**x` (5 `**`) — git acts on P805 | R1 R3 | acts on P805, = |
| T2 | add `**********` with `base` modified — git stages | R1 R3 | staged, = |
| T3 | add `**/**/**/**/**/x` — git 128 did not match | R1 R4 | `PATHSPEC_NO_MATCH`, = |
| T4 | add `**a**b**c**x` (4 `**`) — both 0 | R1 | unchanged, = |
| C1 | add S256 / S300 / `S300*` / `?S255` / P5000 / `P5000/*` — git 128 did not match | R2 R4 R5 | `PATHSPEC_NO_MATCH`, = (needs R5: without it these leak `PATH_TOO_LONG`) |
| C2 | add `sub/S300` — git 128 did not match | R2 R4 | `PATHSPEC_NO_MATCH` (parent absent: `FILE_NOT_FOUND` first), = |
| C3 | add `S300/x` — git 128 did not match | R2 R4 R5 | `PATHSPEC_NO_MATCH`, = (needs R5's **scan** fold; see Design §4) |
| C4 | add `base` + S300 — git 128, names S300 only | R4 R5 | `PATHSPEC_NO_MATCH { pattern: S300 }`, = |
| C5 | add `.` `!S300`, `base` modified — git 0, `base` staged | R2 R7 | `base` staged, = |
| C6 | add `.` `!S300/x`, `base` modified — git 0 (new row) | R7 R5 | `base` staged, = (needs the scan fold) |
| C7 | rm / rm --cached S300, `S300*`, P5000, `S300/x` — git 128 did not match | R2 R4 | `PATHSPEC_NO_MATCH`, = |
| C8 | checkout -- / HEAD -- S300, `S300*`, P5000, `S300/x` — git 1 did not match | R2 R4 | `PATHSPEC_NO_MATCH`, = |
| C9 | grep -- S300 / `S300*` / P5000 / `S300/x` / HEAD -- S300 — git 1, no output | R2 R4 | `{ paths: [] }` |
| I1 | rm --cached S300, index-only — git 0, removed (+ warning) | R2 R6 | removed, = |
| I2 | rm --cached P5000, index-only — git 0, removed | R2 R6 | removed, = |
| I3 | grep --cached -- S300, index-only — git one hit | R2 R6 | one hit |
| I4 | rm --cached `<s254>*` with index-only S300 — both remove S255 + S300 | R6 | unchanged, = |
| K1 | add CJK100 (untracked / modified), add `.` — git stages | R2 R3 R9 | staged, = (host-conditional) |
| K2 | rm, rm --cached CJK100 — git 0 | R2 R3 R9 | removed, = |
| K3 | mv CJK100 → short, mv base → CJK100 — git 0 | R2 R3 R9 | moved, = |
| K4 | checkout -- CJK100 — git 0 | R2 R3 R9 | restored, = |
| K5 | status (untracked / modified), grep -- CJK100, worktree blame CJK100 — git reports | R2 R3 R9 | reported |
| K6 | grep (no pathspec), switch across a commit holding CJK100 — both 0 | R2 | unchanged, = |
| M1 | mv P805 → moved; base → `DIR805/z`; base → 257-byte destination — both 0 | R3 | unchanged, = |
| M2 | mv base → S300; base → `DIR805/S300` — git 128 rename failed: File name too long | R2 R8 | refusal, nothing moved, = (code/`path` per D4) |
| M3 | mv S300 (missing) → short; P5000 (missing) → short; `DIR805/nope` → short — git 128 bad source | R2 R4 | `MV_SOURCE_NOT_TRACKED`, = |
| M4 | mv S300 (index-only) → short — git 128 bad source | R2 R4 | `MV_BAD_SOURCE`, = |
| M5 | mv base → P5000 — git 128 rename failed: File name too long | R2 R8 | refusal, nothing moved, = (`MV_DESTINATION_DIRECTORY_MISSING` today, D4) |
| M6 | mv -n base → S300 — git 0, prints the rename | R2 R8 | `{ moved: [{ from: 'base', to: S300 }] }`, = |
| M7 | mv -k S300 (missing) → short — git 0, nothing moved | R2 R4 | `skipped: [{ reason: 'source-not-tracked' }]`, = |
| X1 | mv -k base → S300 — git 0, nothing moved | — | **out of scope** (`skipErrors` does not cover a failed rename) |
| X2 | add P1408, add `.` / status / add `DIR805/<e200>` with P1408 on disk — git warns `could not open directory`, then 128 / 0 | — | **out of scope**: after R2 + R5 the refusal moves to the walk's `readDirectoryFrame` (probed). See Out of scope |
| X3 | add `.` with index-only S300, `base` modified — git 0, stages `base` | — | **out of scope** (tracked-entry stat) |
| X4 | checkout -- `.` / `<s254>*` with index-only S300 — git 255, restores the rest | — | **out of scope** (create failure stops the restore) |
| X5 | grep --cached with index-only P5000 — git 0 + attributes warning | — | **out of scope** (attributes lookup) |
| X6 | rm S300 (worktree removal), index-only — git 128 `File name too long` | — | **out of scope** (`removeFile` catch-all) |
| X7 | switch to a commit holding S300; status with index-only S300 | — | already faithful before and after |

No pinned row is left without a requirement or an explicit out-of-scope line. Walking the rows against
the requirements found three things the summary missed. (1) C3 and C6 are not cured by the probe fold
alone: the leading-symlink scan stats `S300` first (scratch run: `PATH_TOO_LONG { path:
'<tmp>/…/<s300>' }` with the fold, `PATHSPEC_NO_MATCH` once the scan reads it as absent). (2) C6 is a
new DIFF row (git 0, tsgit `PATH_TOO_LONG`). (3) The P1408 literal row moves to the walk and becomes
part of X2.

## Design

### 1. `resolve-pathspec.ts` — delete both budgets

Delete `MAX_PATHSPEC_PATTERN_BYTES`, `MAX_DOUBLE_STAR_PER_PATTERN`, `PATTERN_ENCODER`,
`enforcePatternBudget`, `countDoubleStars` (with its two `Stryker disable` comments), the
`for (const raw of wellFormedPatterns) enforcePatternBudget(raw);` line in `resolvePathspec`, the
budget comment block above `ResolvedPathspec`, and the budget paragraph of the `resolvePathspec`
comment. `invalidOption` leaves the import list if nothing else in the file uses it (today nothing
does). `validatePathspecBody` keeps its signature and its catch-all. After §2 the only failures left
are shape refusals, and all of them already raise `PATHSPEC_OUTSIDE_REPO`. Its doc comment drops
"length" from the list of rules that still apply.

```ts
export const resolvePathspec = (patterns: ReadonlyArray<string>): ResolvedPathspec => {
  const collapsed = patterns.map(wellFormed).map(collapsePattern);
  const matcher = compilePathspec(collapsed);
  // literalMustMatch / hasGlob / symlinkScanTargets unchanged
};
```

#### What the budgets protected, measured

The comment claims a hostile pattern "chooses how much work it asks for". Measured on the scratch
copy (raw outputs in `<scratch>`):

| Pattern | Path | Cost |
|---|---|---|
| `*a` × N + `b` (no match), 130 B → 131 KB | 2000 short paths | compile 0.2 → 6.6 ms; match 1.4–3.3 ms total (flat) |
| `?` × N (wrong length), 64 B → 64 KB | 2000 paths | 51–63 ms total (flat) |
| five `**` joined by `a` | 2000 paths | 6.3 ms total |
| 64 / 1024 `**` tokens | 2000 paths | 61–63 ms total (flat) |
| `*a` × 128 + `*` (257 B) | one 100-byte path | 51 µs |
| `*a` × 65536 + `*` (131 KB) | one 100-byte path | 39 µs |
| `*a` × 128 + `*` (257 B) | one 4000-byte path | 1.8 ms |
| `*a` × 1024 + `*` (2 KB) | one 4000-byte path | 13.6 ms |
| `*a` × 65536 + `*` (131 KB) | one 4000-byte path | 48.7 ms (no match) |
| `*a` × 2000 + `*` (4 KB, matches) | one 4000-byte path | 24.2 ms |

Compile is linear in the pattern. Matching is `O(live tokens × path bytes)` per path. Every non-star
token consumes at least one byte, so at most `2 × path bytes + 1` tokens are ever live: the cost is
bounded by the **path**, at worst quadratic in it, for `*` and `?` tokens. A `[…]` token tests each
byte against its members one by one, as git's `wildmatch` does, so its cost also grows with the
bracket's size: a 100 000-byte bracket over 2000 short paths takes 8.5 s in tsgit and 4.6 s in git
2.56 (`git ls-files` with the same pattern). That is git-shaped cost, not a new class: git has no
pattern cap either.
A `*` run is one token, so the `**` count bounds nothing; that budget is a leftover of the RegExp
compiler that ADR-077 removed. The byte budget does cap live tokens at about 256. For a 4000-byte path
that is 1.8 ms against 13.6–48.7 ms. That is a constant-factor saving that exists only on paths far
longer than usual, and it is bought by refusing patterns git accepts (B1–B9, T1–T3). git's own
wildmatch has no budget either (`git ls-files -- '*a'×24+'b'`: 9 ms). There is no ReDoS class: no
exponential blow-up exists to guard against. D1 decides.

### 2. `working-tree-path.ts` — delete both caps

Delete `MAX_PATH_BYTES`, `MAX_COMPONENT_BYTES`, `PATH_ENCODER`, `byteLength`, the
`byteLength(input) > MAX_PATH_BYTES` guard in `rejectInputShape`, and the `asciiOnly` flag with
`componentByteLength` in `rejectTraversalShape`. The loop keeps only the control-byte scan; its
`Stryker disable … EqualityOperator` comment loses the `asciiOnly` clause and keeps the `NaN` argument
for the control checks. The comment explaining the single-pass ASCII split goes too. Doc comments
change accordingly: `validateWorkingTreePath`'s rule list drops "Length caps…", and
`validateWalkedEntryPath`'s list drops "length caps".

```ts
const rejectTraversalShape = (component: string, original: string): void => {
  if (component === '') reject(original);
  if (component === '.' || component === '..') reject(original);
  for (let i = 0; i < component.length; i += 1) {
    const code = component.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) reject(original);
  }
};
```

What decides length afterwards, per caller of each validator:

| Validator | Caller | Length decided by |
|---|---|---|
| `validateWorkingTreePath` | `validatePathspecBody` (add, rm, checkout paths, grep) | nothing at intake; the matcher and the probes (R4, R5) |
| `validateWorkingTreePath` | `mv` (sources, destination) | the OS at `fs.rename` / `fs.mkdir` → `PATH_TOO_LONG` (D4); memory: none |
| `validateWorkingTreePath` | `materializeFile`, `renameInWorkingTree` | the OS at write / rename → `PATH_TOO_LONG`; memory: none |
| `validateWorkingTreePath` | `blame` `seedWorkingTree` | the OS at read → `PATH_TOO_LONG` |
| `validateWorkingTreePathOn` | `removeFile`, `removeDirectory` | the OS at `lstat`. `removeFile` maps any non-`FILE_NOT_FOUND` failure to `CHECKOUT_OVERWRITE_DIRTY` (row X6, out of scope) |
| `validateWalkedEntryPath` | `walkWorkingTree` `stepEntry` | entry names come from `readdir`, so the host already holds them; descent is bounded by `maxDepth` (`TREE_DEPTH_EXCEEDED`) and by the OS refusing `readdir` past `PATH_MAX` (`PATH_TOO_LONG`, row X2) |

Security: the caps were labelled defence in depth, but no rule they enforced is a traversal or
injection rule. `..`, absolute paths, NUL and control bytes, `.git` aliases and the leading `:` stay.
A long string reaching the node adapter is refused by the OS. `wrap-fs-validator.ts` has no length rule
and does not change.

### 3. `add.ts` — fold `PATH_TOO_LONG` on the pathspec probes only

Add one helper beside `lstatOrBeneathFile` and route exactly the three pathspec-body probes through it:

```ts
/** A pathspec body the file system refuses as too long names nothing on disk, as git's `file_exists` reads it. */
const lstatPathspecBody = async (ctx: Context, body: FilePath): Promise<FileStat | undefined> => {
  try {
    return await lstatOrBeneathFile(ctx, body);
  } catch (err) {
    if (errorDataCode(err) === PATH_TOO_LONG) return undefined;
    throw err;
  }
};
```

- Callers that change: `literalStats` (its `boundedMapFor` callback), `namesOnDisk`, `namesDiskPath`.
  A literal that reads as absent in `literalStats` routes the add to the walk. The walk finds nothing,
  so `refuseUnseenWalked` → `namesDiskPath` → absent → `PATHSPEC_NO_MATCH` (verified on the scratch
  copy for C1 and C4).
- Callers that must **not** change: `renormalizeOne`, `presentOnDisk` (on `lstatOrMissing`) and
  `hiddenWalkEntryOf`, `movedGitlinkOf` (on `lstatOrBeneathFile`). Folding in `presentOnDisk` would
  report an unreadable tracked entry as gone, and `add .` would stage a deletion git does not make
  (git prints `<p>: File name too long`, keeps the entry, exit 0). The fold therefore lives in a new
  helper, not in either shared one.
- `PATH_TOO_LONG` becomes a named constant (the file already names `NOT_A_DIRECTORY`). Use
  `errorDataCode` (`src/domain/error-data-code.ts`) or the file's existing `instanceof TsgitError`
  form, whichever the neighbouring helpers use.

### 4. `resolve-pathspec.ts` — the leading-symlink scan of a pathspec target

`assertNoSymlinkedLeadingPath` stats each leading prefix of every target. For `S300/x` the first
prefix, `S300`, raises `PATH_TOO_LONG` (C3, C6). git's `lstat_cache` records a failed `lstat` as "not
a symlink", so `has_symlinked_leading_path` answers false. The fold sits at this call site, so the
other 16 scanner consumers (checkout's writer, stash, merge, sparse checkout, …) are untouched:

```ts
for (const target of targets) {
  if (await beyondSymlink(scanner, target)) throw pathspecBeyondSymlink(target);
}
// beyondSymlink: scanner.hasSymlinkedLeadingPath(target), with PATH_TOO_LONG read as false
```

This is sound because the scan walks prefixes shortest first and returns at the first symlink or file.
A prefix the OS cannot name has nothing beneath it, so no later prefix could be a symlink. The
scanner's memo is local to the call, so a cached rejection is caught the same way for a second target
that shares the prefix. D3 covers the placement.

### 5. `mv.ts`

No validator change beyond §2. The resulting behaviour per row:

- M1, M3, M4, M6, M7 are already as git (scratch-verified).
- M2 (`base → S300`): `renameInWorkingTree` → `moveNode` → `fs.rename` raises `PATH_TOO_LONG`. The node
  adapter maps the errno with the **source** path, absolute (`<tmp>/…/base`), because one errno cannot
  say which operand was too long. git names both. D4 decides whether `mv` re-raises it naming the
  destination.
- M5 (`base → P5000`): `isDirectoryOnDisk(parent)` → `lstatOrUndefined` folds every failure, so the
  `PATH_TOO_LONG` on the 4900-byte parent reads as "missing" and `mv` refuses
  `MV_DESTINATION_DIRECTORY_MISSING { source, destination }`. git reaches its rename and reports the
  rename failure. Both refuse and leave the state unchanged; only the code differs (D4).
- Ordering: `mv` refuses under the index lock before moving anything. A rename failure on the first
  leaf leaves the index unwritten, so R8 holds.

### 6. Error data shapes (ADR-249)

No new code and no field change: `PATHSPEC_NO_MATCH { pattern, patterns }` (ADR-1037),
`MV_SOURCE_NOT_TRACKED` / `MV_BAD_SOURCE { source, destination }`, `PATH_TOO_LONG { path }`, and grep's
`{ paths: [] }`. `INVALID_OPTION` keeps every other `option`. `PATHSPEC_OUTSIDE_REPO` keeps every
shape refusal. Neither union member is removed, so `reports/api.json` does not change. D4 option C is
the only route to a new code.

### 7. Docs

- `docs/use/primitives/walk-working-tree.md`: rewrite the "default depth cap is effectively
  unreachable" bullet. No byte cap remains. On the node adapter the OS refuses a `readdir` past its
  `PATH_MAX` (`PATH_TOO_LONG`) before a one-character-per-level path reaches the default 2048
  `maxDepth`. The memory adapter has no such limit, so `maxDepth` (`TREE_DEPTH_EXCEEDED`) is what
  bounds a walk there. The "raising `core.maxTreeDepth`" sentence keeps its meaning.
- `docs/use/errors.md`: in the `PATH_TOO_LONG` row, add that `add` reads a pathspec the file system
  refuses as too long as matching nothing on disk (`PATHSPEC_NO_MATCH`). The `PATHSPEC_OUTSIDE_REPO`
  row already names no length rule; it stays.
- `docs/use/commands/add.md` (§ Pathspec syntax): one sentence saying a pathspec has no length or
  `**` limit of its own; a body longer than the file system allows matches nothing on disk.
- `docs/use/commands/blame.md`, `rm.md`, `mv.md`, `checkout.md`, `grep.md`: searched; no length or
  budget claim, so no change. `docs/use/serializers/archive.md`'s 256-byte limit is the tar header's,
  unrelated.
- `docs/use/commands/README.md`: unchanged (no barrel export changes).
- `docs/BACKLOG.md`: tick 32.40 and strike it in the release-order table (row 3). The corrected
  statement above is recorded here, not in the tick.

## Decision candidates

| # | Choice | Alternatives (≤3) | Recommendation | Why |
|---|---|---|---|---|
| D1 | The 256-byte budget and the four-`**` budget | **A** delete both. **B** keep a bound that refuses nothing: a short-circuit that answers "no match" without running the matcher when a pattern has more consuming tokens than the longest candidate path has bytes. This is an optimisation with the same outcome, not a refusal, and protects only the 13–49 ms per 4000-byte path case. **C** keep both (today). | **A** | The `**` count bounds nothing (one token per run). The byte budget saves a constant factor only on paths far longer than usual, and costs B1–B9 and T1–T3. B is YAGNI: no measured caller pays it. The new ADR supersedes ADR-1043's "budgets stay" clause (its bundle-cap decision stands) and closes its named follow-up |
| D2 | Scope of the length-cap removal in `working-tree-path.ts` | **A** remove both caps from all three validators. **B** remove them only for pathspec bodies (a length-blind variant behind `validatePathspecBody`). **C** replace them with host-derived caps read through a new port method | **A** | B leaves K1 `add .`, K3, K5 status / blame and the walk refusing a real APFS / NTFS name on a well-formed repository. C duplicates what the OS already decides and adds a port. Afterwards the OS decides length (node: `PATH_TOO_LONG`; memory: none) and `maxDepth` bounds the walk |
| D3 | How an `add` pathspec probe the OS refuses as too long is reported, and where the fold sits | **A** read it as absent (→ `PATHSPEC_NO_MATCH`), with the fold in a new `lstatPathspecBody` used by `literalStats` / `namesOnDisk` / `namesDiskPath` plus a call-site fold in `assertNoSymlinkedLeadingPath`. **B** surface `PATH_TOO_LONG`. **C** read it as absent but fold inside `lstatOrBeneathFile` and the scanner's `lstatPrefix` | **A** | Matches C1, C3, C4, C6. B keeps eight add rows unfaithful. C widens `hiddenWalkEntryOf`, `movedGitlinkOf` and 16 scanner consumers on no pinned row (folding in `lstatOrMissing` is proven wrong: `presentOnDisk`). git's `warning: could not open directory` (P1408) comes from its directory walk, not from the probe, so it belongs to deferred row X2: no structured analogue in this change |
| D4 | `mv` to a destination the OS refuses as too long (M2, M5) | **A** leave as the scratch copy behaves: `PATH_TOO_LONG { path: <absolute source> }` for M2, `MV_DESTINATION_DIRECTORY_MISSING` for M5. **B** `mv` catches `PATH_TOO_LONG` from the move and re-raises `pathTooLong(<destination leaf, repo-relative>)`; M5 unchanged. **C** a new `MV_RENAME_FAILED { source, destination }` for both rows | **B** | Both rows already refuse with unchanged state. A ships a `path` naming the wrong operand (the source is not too long). B corrects the data with one catch and no union change. C matches git's two-name message, but it adds a union member (`feat`) to describe one errno |
| D5 | git's side-channel warnings on now-accepted rows (I1 `warning: failed to stat`) | **A** none: success data only. **B** a new result field listing unreadable paths | **A** | ADR-249 binds data, and the warning changes no state. No consumer asks for it. The same question for the walk warning goes to deferred row X2 |
| D6 | Release marking | **A** `fix:`. **B** `fix!:`. | **A** | Precedent ADR-1048: removing a refusal git does not make ships as `fix`. No union member, type or `api.json` entry changes (contrast ADR-1024). The only code shift for an input class is `PATHSPEC_OUTSIDE_REPO` → `PATHSPEC_NO_MATCH`, between two existing members, for names no file can carry. The breaking doctrine fires when the faithful fix breaks the API, and this one does not. B is right if the user counts a changed refusal code for an input class as breaking (as ADR-1190 counted a new refusal) |

## Test strategy

### Cross-tool interop — `test/integration/pathspec-length-interop.test.ts`

Built like `pathspec-backslash-interop.test.ts`: `GIT_AVAILABLE`, `runGit` / `runGitEnv` from
`interop-helpers.ts`, one `mkdtemp` root resolved with `realpath`, and twin repositories built
identically. git runs in one, tsgit in the other. The suite compares `ls-files -s` and
`status --porcelain --untracked-files=all` after the call. A refusal is compared by rebuilding git's
view from fields: `PATHSPEC_NO_MATCH.pattern` ↔ git's `pathspec '<p>' did not match`, exit 128 / 1 ↔ a
throw, grep `paths` ↔ `grep -c` lines. It never compares tsgit text. Names are generated (`'a'.repeat(200)`),
never literal runs. Exclusions use tsgit's `!p` and git's `:!p`.

- Fixture: `P805` (tracked), `P256` and `P257` (tracked), `S255` (tracked), `base`. Rows: B1–B9,
  T1–T4, C1–C9, I1–I4, M1–M7, each as a `describe('Given …')` > `describe('When …')` > `it('Then …')`
  row via `it.each` per command.
- Host probes (R9), each run once in `beforeAll`:
  - `canHoldWideComponent`: try `mkdir` of a directory named 100 × U+6F22 under the root and record the result. When it fails, the
    K1–K5 existence rows are skipped and add / rm / checkout / grep of CJK100 run their L3 arm
    (did-not-match).
  - `P805` absolute length < `PATH_MAX`: asserted as an `Arrange` precondition with the measured length
    in the failure message.
  - `describe.skipIf(!GIT_AVAILABLE || process.platform === 'win32')`: Windows' legacy 260-character
    path limit makes P805 itself host-conditional, and the unit layer covers the validator there.
- Index-only entries are planted with `git update-index --add --cacheinfo` in both twins, before the
  call.

### Unit tests that change

- `test/unit/application/commands/internal/resolve-pathspec.test.ts`: delete `Given a pattern
  exceeding the per-pattern length cap`, `Given a pattern with more than the **-token cap`,
  `Given a pattern exactly at the byte cap (256 bytes)` and `Given ten consecutive \`*\``. Delete the
  `**/**/**/**` and `a*a*a*a*a*` rows of `Given a pattern at a non-throwing boundary` (keep `x`). Delete
  the `PATTERN_BYTE_LENGTH` helper. Add `it.each` rows proving resolution with a compiled matcher that
  accepts its target: a 300-byte three-component literal, a 300-byte single component, five `**`, ten
  `*`, a 300-byte negated body, and a 300-byte directory-only body. Assert `matcher` data such as
  `entry.negated`, `body` and `isLiteral`, not just `not.toThrow`. Add a `Given a pathspec whose
  target's leading prefix the file system refuses as too long, When assertNoSymlinkedLeadingPath`
  row: a stub `lstat` throws `pathTooLong` for that prefix, and the call resolves. Add a sibling row
  where the stub throws `PERMISSION_DENIED` and the error propagates (isolated guard, specific code).
- `test/unit/domain/working-tree-path.test.ts`: the cap describes under both
  `validateWorkingTreePath` and `validateWalkedEntryPath` flip to acceptance with an exact
  `toBe(input)` return: `Given a path that exceeds 4096 bytes`, `… but with every component legal`,
  `… of exactly 4096 bytes`, `Given a component longer than 255 bytes`, `… exactly 255 bytes`, and the
  two non-ASCII describes. Keep every control-byte boundary test (0x1f, 0x20, 0x7f): they now kill the
  loop's mutants alone.
- `test/unit/application/commands/internal/working-tree.test.ts`: move the 256-byte component and
  4097-byte path rows out of the rejected `it.each` into an accepted one, and merge the `4096-byte`
  and `exactly 255 bytes` describes into it.
- `test/unit/application/commands/add.test.ts`:
  - New `Given a literal pathspec whose lstat the adapter refuses as PATH_TOO_LONG, When add`, then
    `PATHSPEC_NO_MATCH { pattern, patterns }`, using the existing Proxy-over-`lstat` stub, once per
    probe route: a literal alone (`literalStats` → `namesDiskPath`), a glob (`namesDiskPath`), and
    `renormalize: true` (`namesOnDisk`).
  - Extend `Given a tracked file deleted from disk and a stat that fails on it` with a `PATH_TOO_LONG`
    fault row. `add({ all: true })` must rethrow it and stage no removal. This proves the fold did not
    widen into `presentOnDisk`.
  - Add a row for `hiddenWalkEntryOf` with a tracked entry whose stat throws `PATH_TOO_LONG` under a
    glob: it propagates. This is a guard that the fold did not widen; git's behaviour on that row is
    row X3's question and is not pinned here.
- `test/unit/application/commands/mv.test.ts` (if D4 = B): `fs.rename` stub throws `pathTooLong`; the
  error's `path` is the repo-relative destination leaf and the index is unchanged.
- `test/unit/application/commands/internal/pathspec-intake.test.ts`: no cap row exists there (its
  `PATHSPEC_OUTSIDE_REPO` rows are the backslash refusal); no change.
- `test/unit/application/primitives/walk-working-tree.test.ts`: no cap row exists; a memory-adapter
  row walking a component over 255 bytes proves `validateWalkedEntryPath` no longer refuses it.

### Property tests

Lens 3 (a total function over a declared safe subset) fits the validators. Add
`test/unit/domain/working-tree-path.properties.test.ts`: for any array of 1–40 components drawn from
non-control, non-`/`, non-`\` characters, with lengths up to 600 code units, filtered by the
independently tested `isDotGitAlias` and by refusing `.` / `..` and a first component that starts with
`:` or a drive letter, `validateWorkingTreePath(components.join('/'))` returns its input. This covers lengths
well past both former caps (100 runs). The same lens fits `resolvePathspec` over that subset plus
`*` / `?` runs, so a sibling `resolve-pathspec.properties.test.ts` asserts that it never throws and
that a literal body matches itself through `matchesPathspec`. Lens 1 fails: there is no
parse / serialize pair. Lens 2 is already held by `match-pathspec.properties.test.ts` and does not
change. Lens 4 fails: no count invariant is touched.

### Mutation notes

- `lstatPathspecBody`: test the `=== PATH_TOO_LONG` guard in isolation. One test with `PATH_TOO_LONG`
  (absorbed) and one with `PERMISSION_DENIED` (propagated) kill the `true` and `false` conditional
  mutants and the string-literal mutant. The scan fold gets the same two tests.
- Assert `err.data` fully (`{ code, pattern, patterns }`); never `toThrow(TsgitError)` alone.
- The `Stryker disable` marks in `countDoubleStars` disappear with the function. The mark on
  `rejectTraversalShape`'s loop bound keeps its `NaN` argument, rewritten without the `asciiOnly`
  clause. Re-check that it is still provably equivalent and that no new mark is added.
- Stryker scope: `resolve-pathspec.ts`, `working-tree-path.ts`, the `add.ts` hunks and `mv.ts` if
  D4 = B, run on narrowed eponymous suites.

## Out of scope

- **Walk directory open past `PATH_MAX`** (X2: `status`, `add .`, `add DIR805/<e200>`, `add P1408`): git
  warns `could not open directory` and goes on; tsgit raises `PATH_TOO_LONG` from
  `readDirectoryFrame`, on main and after this change. This is the walk's own refusal path, not a
  pathspec or validator one, and it needs a skip-and-report decision for every walk consumer.
- **`add .` with an index-only S300 and `base` modified** (X3): git prints `<s300>: File name too
  long`, stages `base`, exit 0; tsgit raises `PATH_TOO_LONG`. This is the tracked-entry stat
  (`presentOnDisk` / `hiddenWalkEntryOf`) that R5 must not widen; it needs its own pin of git's
  per-entry error handling.
- **`checkout -- .` / `<s254>*` with an index-only S300** (X4): git exits 255 but restores the other
  paths; tsgit stops at the first create failure. This is a checkout write-loop error policy, not a
  length refusal.
- **`grep --cached` with an index-only P5000** (X5): git warns on the `.gitattributes` lookup and
  reports the hit; tsgit raises `PATH_TOO_LONG` from the attributes lookup. This is the attributes
  reader's error policy.
- **`rm S300` (worktree removal) with an index-only S300** (X6): git 128 `File name too long`; tsgit
  `CHECKOUT_OVERWRITE_DIRTY` after this change (`removeFile`'s catch-all), `PATHSPEC_OUTSIDE_REPO`
  before. Both refuse; the code belongs to `removeFile`'s error mapping.
- **`mv -k base → S300`** (X1): git 0, nothing moved; tsgit `PATH_TOO_LONG`. `skipErrors` covers only
  planning refusals, not a failed rename. That is a separate semantics question for `-k`.
- **Already faithful** (X7): a switch to a commit holding S300, and `status` with an index-only S300.
- **`mv.ts` `lstatOrUndefined` folding every failure** (row M5's route): the pinned outcome is a
  refusal with unchanged state on both sides. Narrowing it would turn M3's missing-long-source row into
  `PATH_TOO_LONG` (git: bad source). It is left as it is.
- **Browser (OPFS) adapter name limits**: no row is pinned and the adapter maps whatever its backend
  raises.
