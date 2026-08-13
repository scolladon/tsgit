# Plan — git-parity containment

> Source: design doc `docs/design/git-parity-containment.md` · ADRs 625, 626, 627, 628, 629, 630, 631, 632 (supersedes 051), 633, 634
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

## Global context — read once, applies to every part

**Working directory:** `/Users/scolladon/workspace/perso/node/tsgit-git-parity-containment`
(worktree, branch `feat/git-parity-containment`). Serena is ALREADY ACTIVATED here — do
not call `activate_project`; use `find_symbol` / `find_referencing_symbols` /
`replace_symbol_body` as the default for TypeScript navigation and editing.

**Oracles.** Do NOT re-derive git behaviour. The design's §1.1 `verify_path` matrix,
§1.2 read/write symlink matrix (pins B, G, I, L, M) and §1.3 reach-outside pins (C, D,
E, F) are the empirical record, pinned against `git version 2.55.0`. Cite them; never
guess. If a probe is genuinely needed, run it in a `mktemp -d` throwaway with `GIT_*`
scrubbed, isolated `HOME`, `GIT_CONFIG_NOSYSTEM=1`, signing off — **never** in this
worktree (`.git/config` is shared with the main checkout and every sibling worktree).

**Test-strategy buckets.** The design's `## Test strategy` section carries a
per-anchor disposition table (flips / stays / retired / new / unaffected). Each part
below names the anchors it owns. The classification rule, restated: a case **flips**
only if its refusal came from the **post-realpath** stage (input lexically inside a root,
resolution escapes). A case **stays** if the input is *lexically* outside (`../…`, an
absolute foreign path, the prefix-only sibling `<root>-evil`). The one exception is the
symlink-**target** cases, which are write-side but flip by ADR-632 — classify those by
the ADR, not the rule.

**Non-negotiables.** Never commit on a red gate. Never `--no-verify`. No suppression
directives of any flavour (`@ts-ignore`, `biome-ignore`, `v8 ignore`, `stryker-disable`)
— the one narrow exception already in the codebase is `// Stryker disable next-line …:
equivalent` on a *proven* equivalent mutant, and any such proof you touch must be
**re-derived against the new structure**, never carried forward. No phase/ADR/backlog
refs inside source or test code. No swallowed errors — a narrowed `catch` that rethrows
everything it does not handle is not a swallow; a bare `.catch(() => undefined)` is.

**Architecture rule that bites this change — twice.** `.dependency-cruiser.cjs` rule
`primitives-cannot-import-commands` (severity **error**, run by `check:architecture` in
validate): `src/application/primitives/**` must not import
`src/application/commands/**`. Two of the design's stated module locations violate it, and
both are corrected here. These are the plan's only deliberate deviations from the design's
prose; both are mechanical layering fixes, not design changes.

| Design says | Consumers | Plan lands it at |
|---|---|---|
| §10a: `src/application/commands/internal/working-tree-stat-map.ts` | `walk-working-tree.ts`, `compare-working-tree-entry.ts` — both **primitives** | `src/application/primitives/internal/working-tree-stat-map.ts` (Part 8) |
| §4.3 / ADR-626: the leading-symlink scan in `src/application/commands/internal/resolve-pathspec.ts` | `resolve-pathspec.ts` (a command-internal) **plus** `apply-changeset.ts` and `write-working-tree-file.ts` — both **primitives** (ADR-627/628 reuse "the same scan") | the reusable scanner lands at `src/application/primitives/internal/symlinked-leading-path.ts` (Part 5); `resolve-pathspec.ts` imports it and owns the `PATHSPEC_BEYOND_SYMLINK` throw (commands → primitives is the allowed direction) |

**Gate placeholders.** Each part's `### Gate` resolves the manifest's
`gates.part` template. The listed `<touched-tests>` / `<touched-files>` sets are the
starting point derived from this plan — the implementer **adjusts them to the files the
part actually touched**, adding any test file edited and dropping any path that turned out
not to exist. A gate that runs zero test files is a red gate, not a green one.

**Repo gates.** `npm run validate` (23-dep fan-out: biome, tsc, knip dead-code,
ls-lint filesystem, depcruise architecture, cspell, deps, size, exports, tarball,
security, doc-coverage, doc-links, test-pyramid, parity-fixtures, browser-surface,
write-surfaces, `test:coverage` **unit project only, 100% on all four metrics**,
`test:integration`, `test:parity`, `test:perf`). `reports/api.json` staleness is caught
by `check:doc-typedoc` at **prepush only**, not by validate — regenerate with
`npm run docs:json` in the part that changes a public signature. `npm run test:mutation`
is not in validate; the mutation phase runs it scoped later.

**Files kebab-case** (ls-lint). Tests: `describe('Given …') > describe('When …') >
it('Then …')`, AAA body with section comments, SUT variable named `sut` (the function
under test, never the result). Error assertions must assert the error **data**
(`code`, `path`, `reason`), never a bare `toThrow(Class)`.

---

## Part 1 — `verifyPath`: git's `verify_path` matrix as a total domain function

### Context

**New module (internal, not public):** `src/domain/path/verify-path.ts`. The directory
exists and holds exactly one file today (`collapse-posix-segments.ts`, 18 lines, no
`index.ts` barrel). `src/domain/index.ts` does NOT re-export `src/domain/path/`, and
`src/index.ts` (package entry, 24 lines) exports no domain symbols at all. **Decision:
`verifyPath`, `isDotGitAlias` and `VerifyPathRejection` are INTERNAL.** No barrel entry,
no `reports/api.json` regeneration, no `docs/use/` page, no exhaustiveness switch. The
only downstream gate is `knip` (`check:dead-code`, entry points listed in `knip.json`) —
which will flag them as unused exports until Part 2 wires them. `knip` runs in the
**phase** gate, not the part gate, and Part 2 lands before that boundary, so this is
expected and must not be "fixed" by adding a barrel entry.

**Exact target API** (design §3.2, verbatim):

```ts
export type VerifyPathRejection =
  | 'absolute-path' | 'empty-segment' | 'dot-segment' | 'dotdot-segment'
  | 'dotgit-alias' | 'dotgit-ntfs-alias' | 'dotgit-ntfs-stream' | 'dotgit-hfs-alias'
  | 'gitmodules-not-regular';

export const verifyPath = (path: string, mode: FileMode): VerifyPathRejection | undefined;
export const isDotGitAlias = (component: string): boolean;
```

`verifyPath` **returns** a reason, never throws — each boundary shapes its own error
vocabulary in Part 2. It is a *total* function over any string input.

`FileMode` lives at `src/domain/objects/file-mode.ts:12`:
`export type FileMode = (typeof FILE_MODE)[keyof typeof FILE_MODE];` with
`FILE_MODE = { REGULAR: '100644', EXECUTABLE: '100755', SYMLINK: '120000', DIRECTORY:
'40000', GITLINK: '160000' }` (note: `DIRECTORY` is `'40000'`, five chars — `'040000'`
is only an input alias normalised by `normalizeFileMode`). Import the **type** from
`../objects/file-mode.js`; the domain-internal import direction is fine
(`src/domain/path/` → `src/domain/objects/`).

**Alias matcher shape — order matters, each arm proved by a §1.1 row (design §3.2):**

1. Split the component on `/` **and `\`** (so `.git\config` is scanned as two components).
2. Strip trailing `.` and ` ` runs; lowercase.
3. `=== '.git'` → `dotgit-alias`.
4. `=== 'git~1'` → `dotgit-ntfs-alias` (exactly `~1`; `git~2` / `git~10` / `gi~1` /
   `.git~1` all **accept**).
5. `startsWith('.git:')` → `dotgit-ntfs-stream`.
6. Drop the ignorable codepoints {U+200C–U+200F, U+202A–U+202E, U+206A–U+206F, U+FEFF}
   and re-test arm 3 → `dotgit-hfs-alias`. **U+2060 is NOT ignorable** (pinned accept) —
   the set is a closed literal list, never a range guess. Name the set as a module
   constant (`ReadonlySet<number>` or a literal string set), no magic values inline.

**Mode-dependent arm (§1.1):** `.gitmodules` at `100644` accept, `160000` accept,
**`120000` reject** (`gitmodules-not-regular`). `.gitattributes` and `.gitignore` at
`120000` **accept**. A gitlink (`160000`) named `..` is rejected like any other entry —
the traversal arms run irrespective of mode.

**Traversal / shape arms (§1.1):** reject `..`, `.`, empty segment, trailing separator
(`a/`), doubled separator (`a//b`), leading `/` (absolute). Accept a bare `\` as a
character (`a\b` accepts) — the `\` split exists **only** to feed the alias scan; it is
NOT a rejection in itself. Accept Windows reserved device names (`nul`, `con`,
`aux.txt`), trailing dots/spaces on non-alias names (`x `, `x.`, `dir./x`, `dir /x`),
interior spaces in near-aliases (`. git`, `.gi t`), TAB (`a<TAB>b`), `.gitmodules`,
`dotgit`, `.git~1/config`.

**The full §1.1 matrix is the test table. Do not re-derive it — copy it row for row
from the design (§1.1's two tables plus the HFS codepoint table and the mode arm).**

**New tests:**

- `test/unit/domain/path/verify-path.test.ts` — the §1.1 matrix as `it.each`, one row
  per pinned name, asserting the **exact** `VerifyPathRejection` value (or `undefined`),
  never a bare "throws". Sibling for reference conventions:
  `test/unit/domain/path/collapse-posix-segments.test.ts`.
- `test/unit/domain/path/verify-path.properties.test.ts` — lens 3 (*total function over
  an algebraic grammar*): `verifyPath(anyString, anyFileMode)` never throws and always
  returns `VerifyPathRejection | undefined`. Lens 2 (*compositional matcher*) partially
  fits `isDotGitAlias`: appending a non-alias component never flips a verdict to reject;
  suffixing an accepted component with a **non-ignorable** codepoint keeps it accepted.
  Lenses 1 and 4 do not fit (no serialiser, no 1:1 syntactic↔semantic count) — record
  that in the file's header comment so the omission reads as a decision.
- `test/unit/domain/path/arbitraries.ts` — shared generators (`arbPathComponent`,
  `arbIgnorableCodepoint`, `arbSafeAsciiPath`). Convention to copy:
  `test/unit/adapters/arbitraries.ts` (exported `arb*()` factories returning
  `fc.Arbitrary<T>`, module-level `MAX_*` constants) and
  `test/unit/adapters/inflate.properties.test.ts` (module-level `*_NUM_RUNS`
  constants, `fc.assert(fc.property(…), { numRuns })`). Budget: **100** for the
  invariant/total-function properties. Never commit a seed.
  **Checkov trap (recorded):** `CKV_SECRET_6` flags base64-alphabet literals in test
  arbitraries — generate character sets from ranges, not from a pasted alphabet string.

**Coverage:** `src/domain/**` is inside the `test:coverage` include list — 100%
line/branch/function/statement is mandatory on the new file. Every arm of the alias
matcher and every rejection reason needs its own isolated case (a guard-clause family
needs one test per condition, never one test that trips several).

### TDD steps

1. **RED** — write `test/unit/domain/path/verify-path.test.ts` with the full §1.1 matrix
   (`it.each` over `{ name, mode, expected }` rows). Expected failure: `Cannot find
   module '../../../../src/domain/path/verify-path.js'` (module does not exist).
2. **GREEN** — create `src/domain/path/verify-path.ts` with `VerifyPathRejection`,
   `isDotGitAlias` and `verifyPath`, minimal but total. Run the matrix to green.
3. **RED** — add `test/unit/domain/path/verify-path.properties.test.ts` + `arbitraries.ts`
   (lens 3 total-function property, lens 2 composition properties). Expected failure:
   whichever arbitrary input the first draft mishandles (typically an empty component or
   a lone `\`); if it passes first try, tighten the arbitrary's alphabet until it
   exercises the ignorable-codepoint arm.
4. **GREEN** — fix `verifyPath` until both suites are green.
5. **REFACTOR** — extract the ignorable-codepoint set and the alias literals to named
   module constants; keep every function under 20 lines with early returns; no nesting
   beyond 2. Verify each rejection reason has an isolated test.

### Gate

```
npx vitest run test/unit/domain/path/verify-path.test.ts test/unit/domain/path/verify-path.properties.test.ts \
  && npm run check:types \
  && ./node_modules/.bin/biome check src/domain/path/verify-path.ts test/unit/domain/path/verify-path.test.ts test/unit/domain/path/verify-path.properties.test.ts test/unit/domain/path/arbitraries.ts
```

### Commit

`feat(domain): validate entry names against git's verify_path matrix`

---

## Part 2 — Fire `verifyPath` at the index-write boundaries; retire `isForbiddenGitComponent`

### Context

Git's refusal stage is the **index write**, not the tree read (§1.1: `git mktree`
accepts `..`/`.git`/`git~1` at exit 0; `git read-tree` and `git clone` refuse with
`error: invalid path '<name>'` and check **nothing** out). Matching that stage keeps
`cat-file`/`show`/`log` working on a hostile tree exactly as git does. **Do NOT add
validation to `parseTreeContent` or `flatten-raw`** — that is the rejected DC-3(b).

**Boundary 1 — index file parse.**
`src/domain/git-index/path-validator.ts:91`:
```ts
export const validateIndexPath = (path: string, offset: number): void => {
```
Current rejections (all must stay): leading `/` → `'absolute path rejected'`; `\`
anywhere → `'backslash rejected'` (module-private `unsafeReason`, L56); C0/C1 controls
→ `'control character rejected'`; 12 BIDI controls (`BIDI_CONTROLS`, L33–46) →
`'bidi control character rejected'`; `''`/`.`/`..` segments (`UNSAFE_SEGMENTS`, L25;
`reasonFor`, L48). Also exports `NO_PARSER_OFFSET = -1 as const` (L23).
Throws `invalidIndexEntry(offset, reason)` from `./error.js`
(`src/domain/git-index/error.ts:14`, code `INVALID_INDEX_ENTRY`, data `{ offset, reason }`).
**Note the pre-existing over-rejection:** `validateIndexPath` rejects a bare `\` where
git accepts it (`a\b` → accept, §1.1). Keep the existing behaviour — narrowing it is a
separate faithfulness item and is **out of scope**; `verifyPath`'s `\`-split is only for
the alias scan.

`validateIndexPath` has **no mode argument** today. Its two call sites do have the mode:
- `src/domain/git-index/index-parser.ts:99` — `validateIndexPath(path, entryStart);`
  called at L99, immediately after `const path = decode(...)` (L98) and **before** the
  `FilePathFactory.from(path) as FilePath` brand at L120. `mode` is already in scope at
  L88: `const mode = normalizeFileMode(rawMode.toString(8)) as FileMode;`
- `src/application/primitives/synthesize-tree-from-index.ts:86` —
  `validateIndexPath(entry.path, NO_PARSER_OFFSET);` inside `stage0Entries` (L75), with
  `entry.mode` in scope.

Widen the signature to `validateIndexPath(path: string, offset: number, mode: FileMode)`
and delegate the new families to `verifyPath`, mapping each `VerifyPathRejection` to a
distinct `reason` string. Keep the reason strings free of the path itself (the file's
L84–89 comment states that contract explicitly — do not regress it).

**Boundary 2 — tree → index.** `src/application/primitives/build-index-from-tree.ts`.
This primitive projects a target tree onto a fresh stage-0 `IndexEntry` list
(`TargetLeaf { path, id, mode }`, L52; `donorByPath`, L58) and is used by
`reset --mixed`. It currently performs **no** path validation. Add
`validateIndexPath(leaf.path, NO_PARSER_OFFSET, leaf.mode)` at the point each
`TargetLeaf` becomes an `IndexEntry`.

> **Verify, do not assume, that this covers `clone`/`checkout`.** The design names this
> module as *the* tree→index boundary, but `build-index-from-tree.ts`'s own header says it
> is used by `reset --mixed`, and the checkout path builds its index entries in
> `src/application/primitives/apply-changeset.ts` (`buildIndexEntry`, reached at **L216**
> from `applyEntry` L202). The **acceptance criterion is the §1.1 clone pin** — a clone of
> a bare repo whose HEAD tree carries a `..` / `.git` / `git~1` entry must refuse and check
> nothing out (interop scenario 1, Part 9). Trace which primitive actually mints the index
> entries on `clone` and `checkout` and validate **there too** if it is not this one.
> Validating at more than one index-write boundary is defence-in-depth, not duplication —
> `synthesize-tree-from-index.ts:83–86`'s comment already states that policy.

**Boundary 3 — index → tree.** `synthesize-tree-from-index.ts:86` gets the new third
argument for free. Its defence-in-depth test at
`test/unit/application/primitives/synthesize-tree-from-index.test.ts:279` must stay green.

**Boundary 4 — user pathspec.** `src/domain/working-tree-path.ts`:
- `validateWorkingTreePath(input: string): FilePath` (L28) — throws
  `pathspecOutsideRepo(input as FilePath)` via the private `reject` (L60).
  Existing per-component rejections in `rejectComponent` (L64): empty, `.`, `..`,
  >255 B, `isForbiddenGitComponent`, `:` anywhere, C0 + DEL. Plus whole-path: empty,
  >4096 B, leading `/`, `\` anywhere, NUL. Three `Stryker disable next-line …:
  equivalent` proofs live at L29/L32/L35 and one at L74 — **re-verify each against the
  edited code; delete any whose structure changed.**
- `isForbiddenGitComponent(component: string): boolean` (L50) — lowercase, `GIT_FORBIDDEN`
  set membership (`{'.git'}`), then `replace(/[. ]+$/, '') === '.git'`. Carries its own
  `Stryker disable` at L52.

`isDotGitAlias` **subsumes and replaces** `isForbiddenGitComponent` (design §3.2). Both
its consumers want the widened matrix. Delete `isForbiddenGitComponent` and its
`GIT_FORBIDDEN` constant; re-point:
- `src/domain/working-tree-path.ts:68` (inside `rejectComponent`) → `isDotGitAlias`.
- `src/application/primitives/walk-working-tree.ts:72` —
  `if (isForbiddenGitComponent(entry.name)) continue;` → `isDotGitAlias`.
- `src/application/primitives/walk-working-tree.ts:116` — inside `isEmbeddedGitMarker`
  (L110–123) → `isDotGitAlias`.
- Import site: `walk-working-tree.ts:5–8` (multi-line import that also pulls
  `validateWorkingTreePath` at L7). The new import crosses `src/application/primitives/`
  → `src/domain/path/`, which is an allowed direction.

**Behaviour delta this creates, and it must be tested:** the walker now also skips a
component named `git~1`, `.git:x`, or a `.g<ZWNJ>it` HFS form, and `isEmbeddedGitMarker`
now treats a `git~1` directory as an embedded-repo marker. That is the design's stated
intent (widened matrix, §3.2) and the §1.1 pin that `git~1` is a `.git` alias on every
platform.

**Tests to extend (keep every current expectation — these are extends, not replaces):**
- `test/unit/domain/git-index/path-validator.test.ts` (120 lines; `describe('validateIndexPath')`
  L18, `describe('NO_PARSER_OFFSET')` L111) — gains the alias/NTFS/HFS/mode rows and the
  third argument on every existing call.
- `test/unit/domain/working-tree-path.test.ts` (~26 cases) — keeps every current
  expectation; the `describe('isForbiddenGitComponent')` block at **L269** (cases at
  L274, 286, 298, 310, 322, 334) is **renamed/re-pointed to `isDotGitAlias`** and gains
  NTFS/HFS rows. Nothing is deleted without a replacement.
- `test/unit/application/primitives/walk-working-tree.test.ts` — add the widened-skip
  cases (a `git~1` directory is skipped; a `git~1` child makes its parent an
  embedded-repo marker).
- `test/unit/application/primitives/build-index-from-tree.test.ts` — new: a target tree
  carrying a `..` / `.git/config` / `git~1/config` entry throws `INVALID_INDEX_ENTRY`
  and produces no entries; one isolated test per rejection family.
- `test/unit/application/primitives/synthesize-tree-from-index.test.ts:279` — must stay
  green untouched.

**Exhaustiveness / surface gates:** none. `INVALID_INDEX_ENTRY` and
`PATHSPEC_OUTSIDE_REPO` already exist; no new error code, no new export, no api.json
delta.

### TDD steps

1. **RED** — extend `test/unit/domain/git-index/path-validator.test.ts` with the alias /
   NTFS / stream / HFS / mode rows, calling `validateIndexPath(name, 0, mode)`.
   Expected failure: TS arity error (`Expected 2 arguments, but got 3`) at `check:types`,
   and once the signature widens, the alias rows return without throwing.
2. **GREEN** — widen `validateIndexPath` to take `mode: FileMode`, delegate to
   `verifyPath`, map each `VerifyPathRejection` to a reason string. Update both existing
   call sites (`index-parser.ts:99`, `synthesize-tree-from-index.ts:86`).
3. **RED** — add the hostile-tree cases to
   `test/unit/application/primitives/build-index-from-tree.test.ts`. Expected failure: a
   `..`-named tree entry is projected into the index without error.
4. **GREEN** — call `validateIndexPath(path, NO_PARSER_OFFSET, mode)` in
   `build-index-from-tree.ts` at the leaf→entry step.
5. **RED** — re-point `test/unit/domain/working-tree-path.test.ts`'s
   `isForbiddenGitComponent` block to `isDotGitAlias` and add NTFS/HFS rows; add the
   widened-skip cases to `walk-working-tree.test.ts`. Expected failure: `isDotGitAlias`
   is not exported from `working-tree-path.ts` / the walker still admits `git~1`.
6. **GREEN** — delete `isForbiddenGitComponent` + `GIT_FORBIDDEN`; re-point
   `rejectComponent` (L68), `walk-working-tree.ts:72` and `:116` to `isDotGitAlias`.
7. **REFACTOR** — re-verify every `Stryker disable … equivalent` proof in the two edited
   domain files against the new structure; delete any that no longer holds (do not
   carry a proof forward). Confirm 100% coverage on the changed lines.

### Gate

```
npx vitest run test/unit/domain/path test/unit/domain/git-index/path-validator.test.ts test/unit/domain/working-tree-path.test.ts test/unit/application/primitives/walk-working-tree.test.ts test/unit/application/primitives/build-index-from-tree.test.ts test/unit/application/primitives/synthesize-tree-from-index.test.ts \
  && npm run check:types \
  && ./node_modules/.bin/biome check src/domain/git-index/path-validator.ts src/domain/working-tree-path.ts src/domain/git-index/index-parser.ts src/application/primitives/build-index-from-tree.ts src/application/primitives/synthesize-tree-from-index.ts src/application/primitives/walk-working-tree.ts test/unit/domain/git-index/path-validator.test.ts test/unit/domain/working-tree-path.test.ts test/unit/application/primitives/walk-working-tree.test.ts test/unit/application/primitives/build-index-from-tree.test.ts
```

### Commit

`feat(index): refuse hostile entry names at the index-write boundaries`

---

## Part 3 — Node adapter read side: lexical, allocation-free, zero syscalls

### Context

**File:** `src/adapters/node/node-file-system.ts` (1050 lines) and
`src/adapters/node/path-policy.ts` (134 lines). This part changes **only the read
surfaces**. The write guard (`'creation'` mode) and the surfaces that must stay
symlink-aware (`chmod`, `rename` src, `rm`, `rmRecursive`, `openWithNoFollow(_, 'write')`)
are deliberately left on their **current, stricter** guards until Part 4.

> **Why Parts 3 and 4 are separate despite sharing two files** (answering plan-lint's
> cognitive-locality warning): they are separate **security postures**, not two halves of
> one edit. Merging them produces a single commit that simultaneously relaxes every read
> and rewrites every write guard — unbisectable, and unreviewable as a security change.
> Splitting them the other way (all surfaces at once, tests after) would ship an
> intermediate commit where a write surface is lexical-only, which is the DC-8 trap
> ADR-630 exists to name. The split point is chosen so **every intermediate state is at
> least as strict as today's**: Part 3 relaxes only surfaces that cannot mutate state,
> Part 4 then strengthens every surface that can. Each is independently green, and each is
> independently revertible.

**Current machinery (verbatim, line-anchored):**

```ts
// L22
type ContainmentMode = 'read' | 'lstat' | 'creation';
// L29
interface RootPrefix { readonly normalized: string; readonly withSep: string; }
// L45
interface RootSet { readonly canonical: ReadonlyArray<RootPrefix>; readonly all: ReadonlyArray<RootPrefix>; }
// L73
interface ParentRealpathEntry { readonly realParent: string; readonly contained: boolean; }
```

| Line | Member | Role |
|---|---|---|
| L121 | `export function toAbsolute(path, rootDir, policy = nativePolicy): string` | `isAbsolute ? path : join(rootDir, path)` |
| L193 | `function containedByPrefix(normalizedChild, normalizedParent, parentWithSep): boolean` | `=== \|\| startsWith` — the hot predicate |
| L202 | `export function mapErrno(err, path): TsgitError` | ENOENT/EEXIST/ENOTDIR/ENOTEMPTY/EACCES·EPERM·ELOOP·EISDIR→`permissionDenied`/default |
| L239 | `export async function runFs<T>(op, path): Promise<T>` | errno translation wrapper |
| L415 | `private readonly parentRealpathCache = createLruCache<ParentRealpathEntry>(128 * 1024, 512)` | cleared at L696 (`rename`) and L752 (`rmRecursive`); **not** by `rm` (comment L683–686) |
| L422 / L431 | `private rootSetPromise` / `private resolvedRootSet` | the lazy memo |
| L510 | `private async loadRootSet(): Promise<RootSet>` | memoise; on reject clears BOTH fields and rethrows (fail-closed, keep) |
| L538 | `private async resolveRootSet(): Promise<RootSet>` | returns `resolvedRootSet` when populated, else awaits `loadRootSet()` — **still `async`, so every call pays a microtask** |
| L906 | `private async resolveForMode(path, resolved, mode, roots)` | the three-mode dispatch |
| L968 | `private isContainedInAnyRoot(abs, roots): boolean` | (the design calls this `isContainedInEitherRoot`; the real name is `isContainedInAnyRoot`) |
| L979 | `private containmentVerdict(abs, roots): { contained: boolean; isExactRoot: boolean }` | |
| L989 | `private async checkContainment(path, mode): Promise<string>` | the gate |

**Port methods to convert in this part** (all currently `checkContainment(path, <mode>)`):

| Line | Signature | Today | After this part |
|---|---|---|---|
| L547 | `read = async (path: string): Promise<Uint8Array>` | `'read'` | `resolveRead` |
| L552 | `readSlice = async (path, offset, length)` | `'read'` (after the negative-arg guard at L553 — **keep it**) | `resolveRead` |
| L573 | `readUtf8 = async (path)` | `'read'` | `resolveRead` |
| L648 | `stat = async (path): Promise<FileStat>` | `'read'` | `resolveRead` (still follows symlinks by contract, as git does) |
| L653 | `lstat = async (path): Promise<FileStat>` | `'lstat'` | `resolveRead` |
| L658 | `readdir = async (path): Promise<ReadonlyArray<DirEntry>>` | `'read'` | `resolveRead` (one gate per directory) |
| L699 | `readlink = async (path): Promise<string>` | `'lstat'` | `resolveRead` |
| L618 | `exists = async (path): Promise<boolean>` | inline realpath ×1–2 + double root consultation + ENOENT re-check | `resolveRead` + **one** existence probe — see the follow-semantics caveat below |
| L755 | `openWithNoFollow = async (path, mode: 'read' \| 'write')` | `'lstat'` for both | **branch**: `'read'` → `resolveRead`; `'write'` → `checkContainment(path, 'lstat')` unchanged (Part 4 takes it) |

**`exists` follow-semantics caveat — do not change the contract by accident.** The design
writes "lexical + 1 `lstat`", but `src/ports/file-system.ts:92` documents `exists` as
**following symlinks**, and switching to `lstat` would silently make a *dangling* symlink
report `true` — a port-contract change with cross-adapter reach
(`src/application/primitives/apply-changeset.ts:90`'s `isWorkingTreeDirty` probe is a live
consumer). The design's word is shorthand for "one existence probe instead of a full
`realpath`". **Check `test/unit/ports/file-system.contract.ts` for a row pinning
`exists`-follows-symlink and preserve whatever it pins**; if nothing pins it, use `stat`
(which follows) and keep the documented contract. Either way the win is intact: what goes
is the `realpath` that resolves every component, the ENOENT re-check against the raw set,
and the double root consultation — not the follow semantics. `exists` is the largest
read-side frame by profile share (self: 0.27 name-rev, 0.23 describe, 0.16 log, 0.11 merge).

**Pillar 3 falls out here, and one shipped consumer must stay green.**
`src/application/primitives/internal/pack-registry.ts:372` holds a persistent per-pack
`FileHandle` via `openWithNoFollow(packPath, 'read')`. Its containment becomes lexical in
this part; `O_NOFOLLOW` on the pack file stays. Loose object paths are built from a branded
`ObjectId` whose hex is already validated, so traversal is unrepresentable by construction —
the object-store exemption needs **no special case**, it is the absence of one. Alternates
and a symlinked `objects` dir become readable (§1.3 pins C/D); tsgit does not yet read
`objects/info/alternates`, so this removes the blocker rather than implementing the feature.
ADR-509's loose-first precedence and its readdir-backed fanout membership set are untouched.

`chmod` (L732, `'read'`), `rename` src (L690, `'read'`), `rm` (L676, `'lstat'`),
`rmRecursive` (L737, `'lstat'`), and every `'creation'` surface keep their current guard
in this part. `ContainmentMode` therefore keeps all three members here and loses `'read'`
and `'lstat'` in Part 4.

**`resolveRead(path: string): string` — synchronous, total, throws `permissionDenied(path)`.**
Order (design §4.1):

1. `toAbsolute(path, this.rootDir, this.pathPolicy)` — one `charCodeAt` on POSIX; the
   join arm is dead for internal callers (all pass absolute paths).
2. **Non-allocating `..` prefilter:** `path.indexOf('..') === -1` in the common case.
   Only when `..` appears do we pay `policy.resolve` (today's unconditional cost). The
   facade already rejects `..` segments; this arm exists to keep a raw adapter
   fail-closed. Skipping `resolve` also stops collapsing `.` segments and duplicate
   separators — both are OS-normalised at the syscall, neither can escape, and a
   trailing separator still satisfies the `startsWith(root + sep)` arm, so no spurious
   refusal appears.
3. `policy.normalizeForCompare` — identity, zero allocation on POSIX.
4. `containedByPrefix` against each `RootPrefix` of the **settled** `RootSet.all`
   (N = 1 for a normal repo).

**Sync root-set access (P2).** `resolveRead` must read the settled `resolvedRootSet`
**field** directly, never `await resolveRootSet()` — an `async` accessor reintroduces a
microtask per call even when it returns a settled value, which is exactly today's cost
at ~17 call sites. Shape every converted port method as "sync fast arm; async slow arm
on first use only": if `this.resolvedRootSet === undefined`, `await this.loadRootSet()`
once, then take the sync arm. ADR-042's laziness and its **reset-on-rejection** rule
(L510's reject branch clearing both fields) are preserved verbatim.

**Windows caveat — load-bearing (design §4.1).** Dropping `resolve` also drops the
foreign-separator normalisation the adapter contractually depends on:
`src/application/primitives/internal/join-working-tree-path.ts:7` (`joinPath`) emits `/`
unconditionally, so a Windows caller legitimately hands in `C:\repo/sub/file`, which
would fail a `\`-separated prefix compare. Fix inside the case-folding step already paid
there: **the Windows arm of `normalizeForCompare` additionally maps `/` → `\`** (after
the existing `\\?\` strip and lowercase). Roots are normalised through the same function,
so both sides compare like-for-like. POSIX untouched and still allocation-free. The path
handed to the syscall keeps its mixed separators, which Win32 accepts.
`path-policy.ts:107–118` `makePolicy`:
```ts
  normalizeForCompare: (path: string) =>
    caseInsensitive ? stripWinExtendedPrefix(path).toLowerCase() : path,
```
`stripWinExtendedPrefix` is at L97 (module-private; UNC arm must stay first,
constants L80–82).

**What is removed from the read side:** the `realpath` syscall, `dirname` + `basename` +
`join` (3 strings + 1 rest array), `resolve` (1 string + 1 rest array), the per-parent
LRU probe, the microtask, and the whole `isExactRoot` special case (the exact-root leaf
needed a bespoke arm only because the lstat mode trusted a *per-parent* verdict; a direct
lexical test on the path itself has no such blind spot — the raw and canonical prefixes
are both in `RootSet.all`, so `containedByPrefix`'s `===` arm admits either spelling of
the root).

**`exists` (L618) also carries a `Stryker disable next-line ConditionalExpression:
equivalent` at L630** guarding the `TsgitError` rethrow at L631. `exists` is rewritten
here — **re-derive or delete that proof; never carry it forward** (R10).

**Shared contract — parameterised symlink read-escape rows (ADR-629).**
`test/unit/ports/file-system.contract.ts` (847 lines):
```ts
// L5
export interface FileSystemContractEnv {
  readonly fs: FileSystem;
  readonly rootDir: string;
  readonly getRootDirSibling: () => Promise<string>;
  readonly getExistingInRoot: () => Promise<string>;
  readonly cleanup?: () => Promise<void>;
}
```
Entry point L82 `export function fileSystemContractTests(createSut: () => Promise<FileSystemContractEnv>): void`.
The `pathCalls` table is L13–60 (20 entries). The **security matrix** is L824–845 — a
`for…of` over `pathCalls`, two cases each (`'../outside-root'` and
`await env.getRootDirSibling()`), i.e. 40 matrix cases per adapter; with the two
negative-argument cases (L435, L524) that is the design's **84** across both adapters.
**Every one of those stays green untouched** — both inputs are lexical. Do not modify
the matrix.

Add a **new** parameterised block: an in-root symlink whose target escapes every root,
read through. Extend the env with an optional declaration supplied per adapter, e.g.
`readonly symlinkReadEscape?: { readonly create: () => Promise<string>; readonly expected: 'allowed' | 'refused' }`
— Node declares `'allowed'` (git parity), Memory declares `'refused'` (its 40-hop
follower; its root confinement is its addressing model). Adapter invocations to edit:
- Node: `test/unit/adapters/node/node-file-system.test.ts:23` (`fileSystemContractTests(async () => {…})`,
  `siblingDir = \`${rootDir}-evil\`` L27, `new NodeFileSystem(rootDir)` L34,
  `getRootDirSibling` L39).
- Memory: `test/unit/adapters/memory/memory-file-system.test.ts:7`
  (env verbatim L8–15, `rootDir: '/repo'`, `getRootDirSibling: async () => '/repo-evil/x'` L13).
The block must `describe.skipIf`/skip cleanly when an adapter declares nothing (the
Browser adapter's `symlink` throws `UNSUPPORTED_OPERATION`).

**Test dispositions this part owns** (design `## Test strategy` → Adapter behaviour):

*Flips (post-realpath read refusal → allowed).* Rewrite each to the **new** observable
(content returned / `FILE_NOT_FOUND`), and keep each file's lexical sibling case as the
proof the gate still exists:
- `test/unit/adapters/node/node-file-system.test.ts` **L71** (`Given symlink in root
  pointing outside root` / `When reading through it` / `Then throws PERMISSION_DENIED`),
  **L123** (`Given in-root directory symlink pointing outside root` / `When lstat of
  child path`), **L1326** (multi-root: symlink inside root A targeting outside every root).
- `test/unit/adapters/node/node-file-system-injected.test.ts` **L1248** (`exists` of an
  in-root path whose realpath resolves outside), **L2015** (`describe.each` ×2 policies —
  exact-root leaf whose realpath escapes), **L1894** (`describe.each` ×2 — read whose
  leaf realpath escapes), **L1001** (8.3 short-name: read on a path that resolves outside).

*Stays — keep verbatim, they are the regression wall for the lexical gate.*
`node-file-system.test.ts` **L349** (rename via absolute path — still on `'read'` mode
this part), **L1280** (outside every root, under the common ancestor), **L1303**
(multi-root write), **L1372** (`exists` outside every root), **L274/L288** (exact-root
`exists`/`stat` admit). `injected` **L100/L126/L152** (`..` escapes — these now exercise
the `..` prefilter arm), **L1068** (prefix-sibling `tsgit-evil`), **L1166** (POSIX
case-sensitivity), **L1309** (pre-check fires before any I/O), **L3130/L3156**
(prefix-only sibling `/root-evil`, `C:\Root-evil`), **L3084–3125** (the 4-row
containment `it.each`), **L3180/L3208/L3225**.

*Retired in this part* (delete with the code they pin, or re-point):
`injected` **L1361 / L1388** (exact-root recognition via the `isExactRoot` arm — the arm
disappears; **keep one admit-the-root regression case per policy**, re-pointed at the
lexical path, so **L2069**'s "no false-deny regression on the exact-root leaf" survives
in substance), **L3007 / L3048** (read-side prefix precompute — the
`normalizeForCompare` call-count oracle changes shape; re-point at the surviving
per-check normalise or delete).

*Unaffected, must stay green untouched:* `mapErrno` (all arms incl. `ELOOP`/`EISDIR` →
`PERMISSION_DENIED`), `runFs`, `mapStat`, `mapConcurrent`, `isErrnoException`,
`isWindowsSymlinkRefusal`, `realpathNearestExisting` (5 cases), `pathContains` /
`pathContainsNormalized` + `test/unit/adapters/node/node-file-system.properties.test.ts`
(4 fast-check properties), `node-fs-locked-directory.test.ts`,
`fsck-pack-accessibility-interop.test.ts`'s six EACCES assertions, the whole
`test/unit/repository/wrap-fs-validator.test.ts` (~45 `PATHSPEC_OUTSIDE_REPO` cases —
the facade layer is **out of scope**), `repository.test.ts` L662/L1111/L1221,
`file-system-layout-probe.test.ts:46`, and the entire Memory adapter suite
(`memory-file-system.test.ts`, 51 cases incl. the 40-hop cap).

*New in this part:* `path-policy.test.ts`'s Windows `normalizeForCompare` `it.each`
(table at **L222–L244**, rows verbatim in the design's exploration) gains a `/`→`\` row;
the POSIX identity cases at L151–L180 must stay identity. New adapter coverage:
`read`/`stat`/`readdir`/`lstat`/`readlink` through a symlink resolving outside every root
now **succeed**; `exists` of an in-root path resolving outside returns `true`; a lexical
escape still refuses on every one of those methods (one isolated test per method — a
guard-clause family needs one test per condition, never one that trips several).

**Fail-closed properties retained (§7.5):** empty root set still throws
`UNSUPPORTED_OPERATION` at construction (L443–445); a root-set resolution failure still
clears the memo and rethrows; `unsafeRawAdapters: true` still bypasses only the facade,
never the adapter's lexical gate.

**Coverage:** `src/adapters/node/**` is in the `test:coverage` include list — 100% on all
four metrics for the rewritten code.

### TDD steps

1. **RED** — rewrite the *flips* above to their new observable
   (`node-file-system.test.ts` L71/L123/L1326; `injected` L1248/L2015/L1894/L1001).
   Expected failure: each still throws `PERMISSION_DENIED` from the post-realpath stage.
2. **GREEN** — add `private resolveRead(path: string): string` and the sync-arm/async-arm
   root-set access; convert `read`, `readSlice`, `readUtf8`, `stat`, `lstat`, `readdir`,
   `readlink`; branch `openWithNoFollow` on `mode`. Leave `chmod`, `rename` src, `rm`,
   `rmRecursive` and every `'creation'` surface on their current guard.
3. **RED** — add the `/`→`\` row to `path-policy.test.ts`'s Windows
   `normalizeForCompare` table. Expected failure: `'C:\\repo/sub'` normalises with a
   surviving `/`.
4. **GREEN** — extend the Windows arm of `normalizeForCompare` in `path-policy.ts`.
5. **RED** — rewrite `exists`'s tests: an in-root path whose realpath escapes now returns
   `true`; a lexically outside path still refuses; the ENOENT arm returns `false` without
   a second root consultation. Expected failure: the current inline realpath path.
6. **GREEN** — collapse `exists` to `resolveRead` + one `lstat`; drop its `realpath`, its
   ENOENT re-check against the raw set and its double root consultation. Re-derive or
   delete the L630 `Stryker disable` proof.
7. **RED** — add the parameterised symlink read-escape block to
   `test/unit/ports/file-system.contract.ts` and declare it in both adapter envs
   (Node `'allowed'`, Memory `'refused'`). Expected failure: the env field does not exist
   (type error), then Node refuses where the row expects `allowed`.
8. **GREEN** — extend `FileSystemContractEnv`; wire both adapter envs. The 84 existing
   lexical cases must remain byte-identical.
9. **REFACTOR** — retire `injected` L1361/L1388/L3007/L3048 as described (keep one
   admit-the-root case per policy). Confirm `resolveRead` is under 20 lines with early
   returns and allocates nothing on the POSIX path. Confirm coverage 100% on the file.

### Gate

```
npx vitest run test/unit/adapters/node test/unit/adapters/memory/memory-file-system.test.ts test/unit/ports \
  && npm run check:types \
  && ./node_modules/.bin/biome check src/adapters/node/node-file-system.ts src/adapters/node/path-policy.ts test/unit/adapters/node/node-file-system.test.ts test/unit/adapters/node/node-file-system-injected.test.ts test/unit/adapters/node/path-policy.test.ts test/unit/adapters/memory/memory-file-system.test.ts test/unit/ports/file-system.contract.ts
```

### Commit

`perf(node-fs): make read-path containment lexical and syscall-free`

---

## Part 4 — Node adapter write side: leading-path containment, leaf no-follow, verbatim symlink targets

### Context

**Files:** `src/adapters/node/node-file-system.ts`, `src/adapters/node/path-policy.ts`,
`src/adapters/node/fs-operations.ts` (only if the DI seam needs the flag argument),
plus `docs/understand/security.md` and `docs/use/errors.md` (behaviour-coupled prose —
this is the part where the containment posture is complete, so the docs land here).

> Shares two files with Part 3 by design — see Part 3's "Why Parts 3 and 4 are separate"
> note. This part is the **strengthening** half: every surface it touches ends up at least
> as strict as it was before Part 3, and the one relaxation it carries (symlink targets)
> is the user-ratified ADR-632.

**Target: one write guard, two separable parts (design §4.2).**

- **(W1) Leading-path containment — EVERY write surface.** Keep today's
  `realpathForCreation` mechanism (L869): `cachedParentRealpath(dirname)` (L852,
  LRU-amortised per directory — git's `lstat_cache` equivalent) → `join(realParent,
  basename)`; ENOENT on the parent falls back to `realpathNearestExisting` (L248).
  Cache invalidation unchanged: cleared at `rename` (L696) and `rmRecursive` (L752),
  **not** by `rm`. Because W1 never realpaths the **leaf**, it preserves the property
  today's `lstat` mode was chosen for at `rm`: a **dangling** symlink, whose leaf
  realpath would ENOENT, is still removable.
- **(W2) Leaf no-follow — every surface that dereferences the leaf.** `write`,
  `writeStream`, `writeUtf8`, `appendUtf8`, `openWithNoFollow(_, 'write')` get it from
  `O_NOFOLLOW`. **`chmod` needs it too and cannot use `O_NOFOLLOW`** — POSIX `chmod`
  follows the leaf and no portable no-follow chmod exists (the variant is macOS-only) —
  so `chmod` keeps an explicit leaf `lstat` and refuses a symlink leaf. Faithfulness cost
  nil: git only ever chmods regular files (a `120000` entry carries no exec bit).

**Per-surface target (design §4.2 checklist), with today's line and guard:**

| Line | Method | Today | After |
|---|---|---|---|
| L578 | `write = async (path, data)` | `'creation'` | W1 + W2 (`O_WRONLY\|O_CREAT\|O_TRUNC\|O_NOFOLLOW`) |
| L586 | `writeStream = async (path, source)` | `'creation'`; `fs.createWriteStream(real)` with **no options** (Node default `flags:'w'`) and via the **static `node:fs` import, bypassing `FsOperations`** | W1 + W2 — `createWriteStream(real, { flags })` with numeric flags. Not fakeable through `fsOps`; its proof is the posix-only real-FS tier |
| L594 | `writeExclusive = async (path, data)` | `'creation'` | W1 + W2 (`O_EXCL` already refuses any existing leaf; add `O_NOFOLLOW` anyway) |
| L602 | `writeUtf8` | `'creation'` | W1 + W2 |
| L610 | `appendUtf8` | `'creation'` | W1 + W2 (`O_APPEND\|O_NOFOLLOW`) — stricter than git for a symlinked reflog; **pre-existing and deliberately kept** (Out of scope) |
| L671 | `mkdir` | `'creation'` | **W1 only** — mkdir over a symlinked directory succeeds like git's; a later write *into* it is itself a W1-guarded access whose parent realpath is the link target |
| L676 | `rm` | `'lstat'` | **W1 only** — unlink acts on the link itself; W1's no-leaf-realpath keeps dangling links removable |
| L737 | `rmRecursive` | `'lstat'` + `removeTree` walk (L806) | **W1** on the root; `removeTree` unchanged (already `lstat`-per-node, never follows) |
| L689/L690 | `rename` **src** | **`'read'` — realpaths the leaf** | **W1** — see the live bug below |
| L689/L691 | `rename` **dst** | `'creation'` | **W1** — rename replaces the destination *name*; it does not follow it |
| L732 | `chmod = async (path, mode: number)` | **`'read'` — realpaths the leaf** | **W1 + W2 (explicit leaf `lstat`)** |
| L704 | `symlink` (linkPath arg) | `'creation'` | W1 + W2 (`symlink(2)` fails `EEXIST` on any existing leaf) |
| L704–724 | `symlink` (**target** arg) | `realpathNearestExisting` + root set | **gate removed entirely** |
| L755 | `openWithNoFollow(_, 'write')` | `'lstat'` (branched in Part 3) | **W1 + W2** |

**`rename` src is a live bug (ADR-631).** It resolves `realSrc = realpath(src)` and
renames *that*. Verified against Node: `renameSync('link','moved')` moves the **symlink**
(POSIX semantics), while `renameSync(realpathSync('moved'),'moved2')` moves the
**target** and leaves the link dangling. So `mv <symlink> <dst>` today relocates the
target file. W1 fixes it as a side effect. It needs its own dedicated adapter test.

**Remove the ADR-051 gate (ADR-632).** `symlink` body is L704–730; the block to delete is
**L705–L724** — the comment block plus the whole `if (this.pathPolicy.isAbsolute(target)) { … }`
that calls `policy.resolve(target)`, `realpathNearestExisting`, `resolveRootSet()` and
`isContainedInAnyRoot`. Lines L725–730 stay:
```ts
    const real = await this.checkContainment(path, 'creation');   // → the new write guard
    await runFs(async () => {
      await this.fsOps.mkdir(this.pathPolicy.dirname(real), { recursive: true });
      await this.fsOps.symlink(target, real);
    }, path);
```
After removal, `realpathNearestExisting` keeps only its W1 caller (L891) and
`canonicalizeRoots` (L488). A symlink's target — absolute or relative — is opaque bytes,
written verbatim, never validated against the root set (§1.2 pin M). This is the single
write relaxation the change carries, and **R5 (Part 6) is what stands behind it.**

**W2's mechanism.** `O_NOFOLLOW` at the `open` rather than `lstat`-then-write closes the
TOCTOU window between `interpretCreationLstat`'s `lstat` and the write **and** removes
one syscall per write (`ELOOP` → `PERMISSION_DENIED` via `mapErrno`'s existing arm,
L202). Windows ignores `O_NOFOLLOW` (already documented at `openWithNoFollow` L757);
there the pre-write `lstat` is retained, discriminated by `policy.caseInsensitive`
exactly as `isSymlinkLeaf` (L785) is today. `interpretCreationLstat` (L289) survives
**only** as the Windows arm and as `chmod`'s explicit check — its non-errno-rethrow and
ENOENT contracts and their four tests are unchanged.
Check `src/adapters/node/fs-operations.ts` (41 lines; members `appendFile, chmod, lstat,
mkdir, open, readdir, readFile, readlink, realpath, rename, rm, rmdir, stat, symlink,
writeFile`): if `writeFile`'s injected signature does not already carry an options/flag
argument, thread it — the injected tests assert **the flag passed to `open`/`writeFile`**,
not an absent `lstat`. `fs.constants` comes from the static `node:fs` import (L1).

**P7 micro (write path only).** `path-policy.ts` `rootOf: (path) => impl.parse(path).root`
(L116 inside `makePolicy`) allocates a whole `ParsedPath` to read one field. Only
`realpathNearestExisting` uses it. Replace with a direct computation (POSIX: `'/'` when
absolute else `''`; Windows: drive/UNC prefix). `path-policy.test.ts`'s `posixPolicy.rootOf`
(L182) and `windowsPolicy.rootOf` drive (L254) / UNC (L269) blocks must stay green.

**Delete the legacy modes.** `ContainmentMode` (L22), `resolveForMode` (L906) and the
`isExactRoot` field on `containmentVerdict` (L979–987) all go; `checkContainment`
becomes a single write guard (`resolveWrite`). Its two `Stryker disable next-line`
proofs at **L1024** and **L1026** (guarding the `TsgitError` rethrow at L1025 and the
ENOENT short-circuit at L1027) are **structure-specific** — re-derive them against the
new shape or delete them with their arms (R10). Never carry them forward.
`ParentRealpathEntry.contained` (L73) becomes dead once the lstat mode goes — the write
guard's post-check runs unconditionally; drop the field rather than leaving it unread
(`check:dead-code`).

**Test dispositions this part owns:**

*Flips — symlink targets (classify by ADR-632, not the post-realpath rule).* Rewrite to:
the link **is** created, `fsOps.symlink` **is** invoked with the target string
**unchanged**; on the real-FS case, `readlink` returns the absolute target byte-for-byte
and the target file is untouched. Their "absolute-symlink-info-oracle" rationale comments
go **with** the gate — leaving them would document a defence that no longer exists.
- `node-file-system.test.ts` **L1429** (`Given an absolute symlink target outside every
  root` / `When creating the link` / `Then it throws PERMISSION_DENIED and creates no link`).
- `injected` **L2214** (`/etc/passwd` → refused, `fsOps.symlink` not invoked) and
  **L2246** (absolute target with embedded `..` resolving outside → refused).
- `injected` **L2276** (`Given a relative symlink target (even one containing ..)` /
  `Then fsOps.symlink is invoked unchanged`) — keeps its assertion **verbatim** but loses
  its framing: passing a relative target through is no longer an *exemption*, it is the
  rule for every target. Strike its comment about a later read re-checking containment —
  no such re-check exists after Part 3.
- `realpathNearestExisting`'s own 5 cases **stay** (W1 still uses it).

*Stays — write side; keep the expectation, re-point at W1/W2.*
`node-file-system.test.ts` **L97** (write onto a symlink leaf → `PERMISSION_DENIED`),
**L349** (rename escape via absolute path), **L1303** (multi-root write outside every
root creates nothing). `injected` **L1958** (`describe.each` ×2, creation post-check),
**L666** / **L2916** (Windows symlink refusal + the `UNSUPPORTED_OPERATION` rewrap — a
platform capability check, nothing to do with targets), `interpretCreationLstat`'s four
cases. `test/integration/posix-only/node-fs-real-symlinks.test.ts` case 1 (**L48/L49**,
broken in-root symlink leaf + write → `PERMISSION_DENIED`) and case 3 (**L87/L88**,
`openWithNoFollow(read)` on a symlink leaf). `test/integration/win-only/node-fs-windows-real.test.ts`
case 2 (**L68/L69**).

*Retired* (delete with the code they pin, or re-point at the write path):
`injected` **L1659 / L1711 / L1838** (per-parent **verdict** cases — the verdict cache
narrows to a per-parent *realpath* memo with no `contained` field), **L1430–L1535**
(lstat-mode parent-realpath LRU cases — re-point at `rm`/`write`, which still amortise
per directory), **L1765 / L1802** (verdict recomputed after `rename` / `rmRecursive` —
re-point at the write path's cache invalidation, which is unchanged and still needs a pin).

*New adapter coverage — one isolated test per surface* (a guard-clause family needs one
test per condition, never one test that trips several): `chmod`, `rename` src, `rm`,
`rmRecursive` and `openWithNoFollow(_, 'write')` each refuse a write escape through a
symlinked parent; `chmod` refuses a **symlink leaf** even when the parent is contained;
`rename` of a symlink moves the **link** and leaves the target in place; `symlink`
accepts **any** target string — absolute outside every root, relative with escaping `..`,
and a dangling one — writing it verbatim and never touching whatever it points at.
The real-FS proofs (`readlink` byte-identity, target file untouched, `rename` moves the
link, `writeStream`'s flags) go in `test/integration/posix-only/node-fs-real-symlinks.test.ts`,
which already carries the `@proves surface: nodeFs.symlinks / bucket: platform-only`
header at L1–12 and a `makeFs` helper at L22–35 with `beforeEach` L39 / `afterEach` L43.

**Docs owned by this part (design §11 disposition table):**
- `docs/understand/security.md` — **L7–L15** ("Every `FileSystem` adapter enforces that
  every input path resolves to a location **inside one of the adapter's containment
  roots**", the three escape bullets, "…all throw `PERMISSION_DENIED` before any data is
  read or written") and **L17–L29** (`### Node — symlink-escape defense`, the three-mode
  realpath table L21–25, the "only symlink-aware containment layer" sentence L27) are
  **superseded** for the Node read side and for symlink targets on the write side.
  Rewrite to the read/write asymmetry and to "a link's target is never validated".
  **Keep L31–L33 (`### Browser — OPFS sandbox`) and L35–L37 (`### Memory — symlink loop
  cap`) exactly as they are.** L3's intro sentence also carries the invariant and needs
  narrowing. Do not touch any other section.
- `docs/use/errors.md` — **L46**:
  `| `PERMISSION_DENIED` | `path` | Filesystem permission error, including symlink-escape rejections and 8.3 path mismatches on Windows. |`
  Narrow "symlink-escape rejections" to **write** escapes and lexical escapes; a
  post-realpath **read** escape no longer raises it. Table format is
  `| Code | Payload | Raised when |`, groups alphabetical within each `###` section
  (rule stated at L34).
- `docs/understand/performance.md` is **NOT** this part's — see Part 9. It is currently
  **modified in the working tree** and must be layered onto, never clobbered.

`npm run check:spelling` is the review-batch gate and the md commit hook is narrower than
validate — run it over the edited markdown before committing (the cspell dict lags on some
British `-ising/-ised` forms, so a green commit hook is not proof).

**Working-tree hygiene.** `README.md`, `RUNBOOK.md`,
`docs/adr/482-competitor-comparison-publication-surfaces.md`,
`docs/understand/performance.md` and the untracked
`docs/adr/624-readme-links-performance-analysis-no-comparison-table.md` are pre-existing
uncommitted changes carried into this worktree from the main checkout. **Commit only the
files this part touched** — never `git add -A`, never revert or stage someone else's
in-flight work.

### TDD steps

1. **RED** — rewrite the ADR-632 symlink-target cases (`node-file-system.test.ts` L1429;
   `injected` L2214, L2246) to assert the link is created and `fsOps.symlink` receives
   the target unchanged. Expected failure: `PERMISSION_DENIED` from the gate at L711–724.
2. **GREEN** — delete `node-file-system.ts` L705–L724. Re-frame `injected` L2276's comment.
3. **RED** — add the isolated write-escape tests for `chmod` (parent escape **and**
   symlink leaf, two separate tests), `rename` src, `rm`, `rmRecursive`,
   `openWithNoFollow(_, 'write')`; plus a `rename`-moves-the-link test. Expected failure:
   `chmod`/`rename` src take the read guard (leaf realpath), `rm`/`rmRecursive` take the
   lstat mode, `rename` moves the target.
4. **GREEN** — collapse `checkContainment` to a single write guard (`resolveWrite` = W1 +
   post-check); delete `ContainmentMode`, `resolveForMode` and the `isExactRoot` field;
   route `chmod` (W1 + explicit leaf `lstat`), `rename` both arms (W1), `rm`,
   `rmRecursive`, `mkdir`, `symlink` linkPath and `openWithNoFollow(_, 'write')`.
5. **RED** — add the injected flag assertions: `write`/`writeUtf8`/`writeExclusive`/
   `appendUtf8`/`openWithNoFollow(_, 'write')` pass `O_NOFOLLOW` (composed with the
   right access/creation flags) and issue **no** pre-write `lstat` on a POSIX policy;
   the Windows policy still issues it. Expected failure: the current pre-write `lstat`
   path.
6. **GREEN** — thread `O_NOFOLLOW` through the write opens (extending `FsOperations` if
   the seam lacks the flag argument); keep `interpretCreationLstat` as the Windows arm
   and `chmod`'s check. Add the real-FS proofs to
   `test/integration/posix-only/node-fs-real-symlinks.test.ts` (incl. `writeStream`'s
   numeric flags, which the DI seam cannot reach).
7. **REFACTOR** — retire `injected` L1659/L1711/L1838/L1430–L1535/L1765/L1802 per the
   table; drop `ParentRealpathEntry.contained`; replace `rootOf`'s `ParsedPath`
   allocation; **re-derive or delete** the two `Stryker disable` proofs at L1024/L1026.
   Confirm the 84-case shared security matrix is still green untouched.
8. **DOCS** — rewrite `docs/understand/security.md` L3, L7–L15, L17–L29 (keeping L31–L37
   verbatim) and narrow `docs/use/errors.md` L46. Run `npx cspell` on both.

### Gate

```
npx vitest run test/unit/adapters/node test/unit/ports test/unit/adapters/memory/memory-file-system.test.ts \
  && npm run test:posix-integration \
  && npm run check:types \
  && ./node_modules/.bin/biome check src/adapters/node/node-file-system.ts src/adapters/node/path-policy.ts src/adapters/node/fs-operations.ts test/unit/adapters/node/node-file-system.test.ts test/unit/adapters/node/node-file-system-injected.test.ts test/unit/adapters/node/path-policy.test.ts test/integration/posix-only/node-fs-real-symlinks.test.ts
```

### Commit

`feat(node-fs): guard writes with leading-path containment and leaf no-follow`

---

## Part 5 — `PATHSPEC_BEYOND_SYMLINK`: an explicit refusal for `add` beyond a symbolic link

### Context

**The pinned behaviour (§1.2), and the trap.** `git add dir/file` where `dir` is a
symlink → `fatal: pathspec 'dir/file' is beyond a symbolic link`, exit 128. It is
**shape-based, not containment-based**: it fires identically when the link points
*inside* the repo, and for a file that is not tracked at all. It is the **only** command
in the pinned matrix that refuses — `git checkout -- <p>`, `git restore -- <p>`,
`git rm`, `git mv`, `git stash push -- <p>` all decline for ordinary "pathspec did not
match" reasons, never for the symlink. **Therefore: wire the scan into `add` only.**
ADR-626's consequence line ("`mv` and `blame` … gain the same explicit refusal *where
git raises it*") is satisfied by the qualifier — the matrix says git does not raise it
there, and wiring it would be a new divergence. If a later pin shows otherwise, that is
its own change.

**Why the current refusal is accidental.** The adapter's lstat-mode containment throws
`PERMISSION_DENIED`, which `add.ts` swallows in `.catch(() => undefined)`, degrading the
observable to `PATHSPEC_NO_MATCH` (pinned today at
`test/integration/node-shim.test.ts:282`). Part 3 removed that accidental path entirely
(reads are lexical), so without this part `add` silently succeeds where git refuses.

**The two swallows — and the exact shape of their replacement.**
`src/application/commands/add.ts`:
```ts
143 const allLiteralsAreFiles = async (ctx: Context, literals: ReadonlyArray<FilePath>): Promise<boolean> => {
147   if (literals.length === 0) return false;
148   for (const path of literals) {
149     const stat = await ctx.fs.lstat(joinPath(ctx.layout.workDir, path)).catch(() => undefined);
150     if (stat === undefined) return false;
151     if (stat.isDirectory && !stat.isSymbolicLink) return false;
```
```ts
334 const stageOne = async (ctx: Context, path: FilePath, provider: AttributeProvider | undefined): Promise<IndexEntry | 'missing'> => {
339   const stat = await ctx.fs.lstat(joinPath(ctx.layout.workDir, path)).catch(() => undefined);
340   if (stat === undefined) return 'missing';
341   return stageFromStat(ctx, path, stat, provider);
```
`stageOne`'s `'missing'` becomes `throw pathspecNoMatch(path)` at `add.ts:130`.

**Do NOT delete these catches outright.** `git add missing-file` must still report
`fatal: pathspec 'missing-file' did not match any files` — a bare removal would surface
`FILE_NOT_FOUND` instead. Replace each with a **narrowed** catch: `FILE_NOT_FOUND` →
`undefined` / `'missing'`; **rethrow everything else**. That satisfies the
no-swallowed-errors guardrail and preserves the git-faithful missing-path observable.
Error shape check: `err instanceof TsgitError && err.data.code === 'FILE_NOT_FOUND'` —
be aware `instanceof` can fail across module graphs; prefer a code check on a duck-typed
`data` when the value may cross a boundary (this one does not, but the pattern in
`apply-changeset.ts:66` is the local precedent).

**Where the scan lives — two modules, because of the layering rule.** ADR-627 and ADR-628
(Part 6) reuse "the same scan" from **primitives** (`apply-changeset.ts`,
`write-working-tree-file.ts`), and `primitives-cannot-import-commands` is an error rule.
So the reusable mechanism is a **primitive** and only the error vocabulary is a command
concern:

1. **New primitive:** `src/application/primitives/internal/symlinked-leading-path.ts`
   ```ts
   export interface LeadingPathScanner {
     /** True when any leading component of `path` (its directories, never the leaf) is a symlink. */
     readonly hasSymlinkedLeadingPath: (path: FilePath) => Promise<boolean>;
   }
   export const createLeadingPathScanner = (ctx: Context): LeadingPathScanner;
   ```
   Semantics = git's `has_symlinked_leading_path` + `lstat_cache`: split on `/`, walk the
   prefixes **excluding the leaf**, `lstat` each (`joinPath(ctx.layout.workDir, prefix)`),
   return `true` on the first `isSymbolicLink`. **Memoise per directory for the scanner's
   lifetime** — a `Map<string, boolean>` captured in the closure, so a repeated prefix
   across a pathspec set costs one `lstat`. A **missing** prefix (`FILE_NOT_FOUND`) is not
   a symlink: stop walking and return `false`. **Never swallow a non-`FILE_NOT_FOUND`
   error** — rethrow it. Lifetime is one command invocation, like the stat map in Part 8;
   no module-level state, no `Context` field, no adapter cache.
   Test: `test/unit/application/primitives/internal/symlinked-leading-path.test.ts`.
2. **Command wrapper:** `src/application/commands/internal/resolve-pathspec.ts` (98 lines)
   gains one new export that owns the `PATHSPEC_BEYOND_SYMLINK` vocabulary:
   ```ts
   export const assertNoSymlinkedLeadingPath = async (
     ctx: Context,
     literals: ReadonlyArray<FilePath>,
   ): Promise<void>;
   ```
   It builds one scanner and throws `pathspecBeyondSymlink(literal)` on the first hit.

The module is **pure and synchronous today**: it imports zero ports, takes no `Context`,
and neither export is `async`.
```ts
L21 export interface ResolvedPathspec { readonly matcher: Pathspec; readonly literalMustMatch: ReadonlyArray<FilePath>; readonly hasGlob: boolean; }
L38 export const resolvePathspec = (patterns: ReadonlyArray<string>): ResolvedPathspec => { … }
L82 export const enforceLiteralMustMatch = (literals: ReadonlyArray<FilePath>, matched: ReadonlyArray<FilePath>): void => { … }
```
Its four call sites are `add.ts:110`, `checkout.ts:179`, `rm.ts:72`, `grep.ts:182`.
**Do not make `resolvePathspec` async or ctx-taking** — that ripples to all four and
changes three commands that must not gain the refusal.

**Scope the scan to `literalMustMatch`, not to every pattern.** The pinned refusal is for
a *literal* pathspec naming a file beyond the link (`git add dir/file`). `git add -A` does
**not** refuse — it stages the symlink as `120000` and reports the child as deleted
(§1.2). `ResolvedPathspec.literalMustMatch` (L45) is exactly the positive-literal set, so
passing it is both the correct scope and the cheapest one.

**New public error code — pre-pay every surface gate in this part** (the repo's
error-union gate set, verified against current code):

1. `src/domain/commands/error.ts` — add the union member next to **L14–L15**
   (`PATHSPEC_NO_MATCH` / `PATHSPEC_OUTSIDE_REPO`):
   `| { readonly code: 'PATHSPEC_BEYOND_SYMLINK'; readonly path: FilePath }`
   and the factory next to **L299–L303**:
   ```ts
   export const pathspecBeyondSymlink = (path: FilePath): TsgitError =>
     new TsgitError({ code: 'PATHSPEC_BEYOND_SYMLINK', path });
   ```
2. `src/domain/commands/index.ts` — re-export the factory in the `./error.js` block
   (**L4–L55**, alphabetical; `pathspecNoMatch` and `pathspecOutsideRepo` sit adjacent).
3. `src/domain/error.ts` — **compiler-enforced**: `extractDetail`'s `switch (data.code)`
   opens at **L178**; the `default:` block at **L548–L551** carries
   `const _exhaustive: never = data;` at L549. Add the `case` before L548 **with a
   message template** (mirror L309–310's `pathspec resolves outside repository:
   ${basename(data.path)}` shape). Missing arm = TS2322 at `check:types`.
4. `test/unit/domain/exhaustiveness.ts` — **compiler-enforced**: `switch` at L14, case
   list L15–L204, `default:` L206–209 with `const _exhaustive: never = data;` at L207.
   Add the case adjacent to `PATHSPEC_OUTSIDE_REPO` at **L87**. (Eight test files import
   `assertExhaustiveSwitch`; none needs editing.)
5. `test/unit/domain/commands/error.test.ts` — the hand-maintained message table
   `const cases: ReadonlyArray<Case>` at **L1175** (`PATHSPEC_NO_MATCH` row L1185–1186,
   `PATHSPEC_OUTSIDE_REPO` row L1189–1190), consumed by `it.each` at L1472. **Not
   exhaustiveness-checked — a missing row passes silently.** Add the row.
6. `docs/use/errors.md` — insert the row in `### Index, working tree, sparse, ignore`
   (table L97–L114), alphabetically **before** L106's `PATHSPEC_NO_MATCH`, in the
   `| Code | Payload | Raised when |` shape.
7. **`reports/api.json`** — regenerate with `npm run docs:json` and commit it (the large
   typedoc-id diff is normal). `check:doc-typedoc` is a **prepush** gate, not a validate
   gate; a green local validate can still be followed by a rejected push.

There is **no** exhaustive barrel-surface test over error codes, and `src/index.ts` does
not re-export domain errors — no other surface gate applies. `check:doc-coverage` only
verifies command/primitive doc pages against `src/repository.ts`; it does not check error
codes.

**Existing tests to re-point:** `test/integration/node-shim.test.ts:282` currently pins
the accidental `PATHSPEC_NO_MATCH`; rewrite it to `PATHSPEC_BEYOND_SYMLINK` carrying the
pathspec. **`node-shim.test.ts:305` stays verbatim** — the outside secret file there is a
*sibling directory*, lexically outside, still `PERMISSION_DENIED`.

**New tests** (`test/unit/application/commands/add.test.ts`,
`test/unit/application/commands/internal/` for the scan): the refusal fires for an
**outside-pointing** link and for an **intra-repo** link (two isolated tests — the
shape-based property is exactly what a containment-shaped implementation would get
wrong); it fires for an untracked file under the link; it does **not** fire when the leaf
itself is a symlink (git stages that as `120000`); a missing literal still yields
`PATHSPEC_NO_MATCH`; a genuine `PERMISSION_DENIED` from the adapter now propagates
instead of degrading; the per-directory memo issues one `lstat` per distinct prefix
across a multi-literal pathspec set (call-count oracle against an injected filesystem).
Assert the error **data** (`code` + `path`), never a bare `toThrow`.

### TDD steps

1. **RED** — add `test/unit/domain/commands/error.test.ts`'s message row and an
   `assertExhaustiveSwitch` case for `PATHSPEC_BEYOND_SYMLINK`. Expected failure:
   TS2322 / TS2678 — the code is not a member of the union.
2. **GREEN** — add the union member + factory in `src/domain/commands/error.ts`, the
   re-export in `src/domain/commands/index.ts`, the `extractDetail` case in
   `src/domain/error.ts`, the `exhaustiveness.ts` case.
3. **RED** — write `test/unit/application/primitives/internal/symlinked-leading-path.test.ts`
   (outside-pointing link, intra-repo link, leaf-is-a-symlink → `false`, missing prefix →
   `false`, non-`FILE_NOT_FOUND` error rethrown, per-directory memo call-count across a
   multi-literal set) and the wrapper's tests in
   `test/unit/application/commands/internal/`. Expected failure: neither
   `createLeadingPathScanner` nor `assertNoSymlinkedLeadingPath` exists.
4. **GREEN** — implement `src/application/primitives/internal/symlinked-leading-path.ts`
   with the per-directory memo, then `assertNoSymlinkedLeadingPath` in
   `resolve-pathspec.ts` on top of it; keep `resolvePathspec` sync and its four call sites
   untouched.
5. **RED** — rewrite `test/integration/node-shim.test.ts:282` to expect
   `PATHSPEC_BEYOND_SYMLINK`; add the add-level tests (missing literal still
   `PATHSPEC_NO_MATCH`; adapter `PERMISSION_DENIED` propagates). Expected failure:
   `add` still degrades to `PATHSPEC_NO_MATCH` / swallows.
6. **GREEN** — call `assertNoSymlinkedLeadingPath(ctx, literalMustMatch)` from `add`'s
   pathspec resolution at `add.ts:110`, before `dispatchPathspec` branches (so it covers
   both the literal-only route via `allLiteralsAreFiles`/`addLiteralOnly` and the walk
   route); narrow the two `.catch(() => undefined)` at `add.ts:149` and `add.ts:339` to
   `FILE_NOT_FOUND`-only with a rethrow.
7. **DOCS + SURFACE** — add the `docs/use/errors.md` row; run `npm run docs:json` and
   commit `reports/api.json`. Run `npm run check:spelling`.
8. **REFACTOR** — confirm one isolated test per guard condition; confirm no bare
   `.catch(() => undefined)` remains on a path that can now carry a real error.

### Gate

```
npx vitest run test/unit/domain/commands/error.test.ts test/unit/domain/error.test.ts test/unit/application/primitives/internal/symlinked-leading-path.test.ts test/unit/application/commands/add.test.ts test/unit/application/commands/internal test/integration/node-shim.test.ts \
  && npm run check:types \
  && ./node_modules/.bin/biome check src/domain/commands/error.ts src/domain/commands/index.ts src/domain/error.ts src/application/primitives/internal/symlinked-leading-path.ts src/application/commands/internal/resolve-pathspec.ts src/application/commands/add.ts test/unit/domain/exhaustiveness.ts test/unit/domain/commands/error.test.ts test/unit/application/primitives/internal/symlinked-leading-path.test.ts test/unit/application/commands/add.test.ts test/integration/node-shim.test.ts
```

### Commit

`feat(add): refuse a pathspec that lies beyond a symbolic link`

---

## Part 6 — Checkout parity through a symlinked leading directory, and the caller-side no-dereference audit

### Context

This part lands three coupled command-layer behaviours. **R5 is the whole line behind
ADR-632** — Part 4 removed the creation-time target gate and Part 3 removed the read-time
one, so nothing sits behind these call sites. Treat the audit as load-bearing, not
housekeeping.

**(a) Delete through a symlinked leading directory skips silently (ADR-627, §1.2 pin L).**
Pinned: `git checkout -f <branch that deletes dir/file>` where `dir` is a symlink exits 0,
**skips the removal**, leaves the symlink, never touches the link target. tsgit today
refuses via the lstat-mode parent realpath. After Part 4 the write guard still refuses —
so the skip must be decided **above** the adapter.
Delete site: `src/application/primitives/apply-changeset.ts:202–217`, the `'delete'` arm
at **L210–213**:
```ts
210   if (entry.kind === 'delete') {
211     await rmIfExists(ctx, absPath);
212     return undefined;
213   }
```
`rmIfExists` is `src/application/primitives/internal/write-working-tree-file.ts:23`:
```ts
23 export const rmIfExists = async (ctx: Context, fullPath: string): Promise<void> => {
24   const exists = await ctx.fs.lstat(fullPath).then(() => true)
28     .catch(() => false);        // carries a `Stryker disable next-line ArrowFunction: equivalent` at L27
29   if (exists) await ctx.fs.rm(fullPath);
30 };
```
Today the skip happens **by accident** of `.catch(() => false)` conflating "missing" with
"refused". Make it deliberate: detect the symlinked leading component with
`createLeadingPathScanner` from
`src/application/primitives/internal/symlinked-leading-path.ts` (Part 5 — a primitive
precisely so this part can reuse it without violating
`primitives-cannot-import-commands`), skip the removal exit-successfully, and narrow the
`lstat` catch to `FILE_NOT_FOUND` so a real failure is no longer swallowed. **No
`PATHSPEC_BEYOND_SYMLINK` is thrown here** — git skips silently, it does not refuse; the
error code belongs to `add` alone. Build **one** scanner per changeset application and
thread it, so a deep tree costs one `lstat` per distinct directory, not one per entry.
The adapter's write guard stays the backstop for an actual escaping deletion.

**(b) Checkout writes unlink a symlinked leading component (ADR-628, §1.2 pins G/I).**
Pinned: checking out `dir/file` where `dir` is a symlink — outside-pointing **or
intra-repo** — unlinks the symlink, creates a real directory, and writes inside the repo.
tsgit today diverges in **both** sub-cases: it refuses when the link resolves outside a
root and writes *through* it when it resolves inside.
The shared writer is `src/application/primitives/internal/write-working-tree-file.ts`
(142 lines). Exports: `rmIfExists` L23, `writeRegularFile` L38, `writeWorkingTreeFile`
L54, `writeWorkingTreeEntry` L70, `writeRegularFileStream` L95,
`writeWorkingTreeFileStream` L115, `writeWorkingTreeEntryStream` L130,
`removeWorkingTreeFile` L139.
`writeWorkingTreeEntry` (L70–87) is the mode dispatcher:
```ts
76   const fullPath = joinPath(ctx.layout.workDir, path);
77   if (mode === FILE_MODE.SYMLINK) { await rmIfExists(ctx, fullPath); await ctx.fs.symlink(decoder.decode(content), fullPath); return; }
82   if (mode === FILE_MODE.GITLINK) { await ctx.fs.mkdir(fullPath); return; }
86   await writeRegularFile(ctx, fullPath, content, mode);
```
**The complete set of hook points is the four `joinPath(ctx.layout.workDir, path)` sites
— L59, L76, L120, L136** (`writeWorkingTreeFile`, `writeWorkingTreeEntry`,
`writeWorkingTreeFileStream`, `writeWorkingTreeEntryStream`). `writeRegularFile` (L38)
receives only an opaque absolute `fullPath` and cannot decompose it, so the unlink must
happen at those four sites (extract one shared helper and call it from each). Note the
streaming pair is a live bypass: `apply-changeset.ts:199` calls
`writeWorkingTreeEntryStream` directly. Also note there is **no explicit parent `mkdir`
in the regular-write path** — parent creation is delegated to the adapter
(`src/ports/file-system.ts:61` "creating parent directories as needed").
Working-tree policy stays in the command layer; the adapter stays policy-free.

**(c) R5 — the six-site audit.** Each site must reach `ctx.fs.read` only on a path it has
already established is not a symlink. Findings (verified against current code):

| # | Site | State |
|---|---|---|
| 1 | `src/application/primitives/apply-changeset.ts:62` (`blobMatches`, L59–78) | **GAP — blind `ctx.fs.read(absPath)`, no `lstat` at all.** The only pre-check is `ctx.fs.exists` at L90 (`isWorkingTreeDirty`), which **follows** symlinks. A `120000` entry's dirty check therefore hashes the **target's contents** instead of the target **path** — a correctness bug as well as an R5 violation. Fix: `lstat` first; symlink → hash the `readlink` bytes (the same `TextEncoder` shape the other five use); non-symlink → today's `ctx.fs.read`. Preserve the existing catch semantics at L63–71 (`FILE_NOT_FOUND` → `true`/non-dirty; everything else rethrows) |
| 2 | `src/application/primitives/compare-working-tree-entry.ts:116–118` | guarded (ternary on `stat.isSymbolicLink`) — assert, do not change |
| 3 | `src/application/primitives/snapshot/workdir-entry.ts:80` | guarded (ternary on the cached `row.kind === 'symlink'`; the live `lstat` is `liveStat` L61–70, consumed by `verify()` L92) — assert, do not change |
| 4 | `src/application/commands/blame.ts:182–184` | guarded (ternary on `stat.isSymbolicLink`, live `lstat` L180) — assert, do not change |
| 5 | `src/application/commands/grep.ts:79–82` | guarded **by exclusion**: L79 `continue`s on `stat.isDirectory \|\| stat.isSymbolicLink`, so the deferred `load: () => ctx.fs.read(absPath)` at L82 is unreachable for a symlink. Assert the exclusion explicitly |
| 6 | `src/application/commands/stash.ts:122–124` | guarded (ternary on the caller-supplied `stat.isSymbolicLink`) — assert, do not change |

Two adjacent sites, audited and already correct — record them in the tests so a future
reader does not re-audit: `src/application/commands/add.ts:407–419` (`readContent`,
if/else form) and `src/application/commands/internal/working-tree.ts:75–78` (`readFile`,
a bare `ctx.fs.read`, reachable only from `add.ts:419`, i.e. behind add's own guard).

**Each of the six carries its own isolated test** (design R5), and the discipline is
already pinned cross-adapter by the contract rows Part 3 added.

**Tests:**
- `test/unit/application/primitives/apply-changeset.test.ts` — the symlink dirty-check
  fix (a `120000` entry whose link target differs from the blob is dirty; whose link
  target matches is clean; the outside target is never read); the delete-skip
  (a delete whose leading component is a symlink is skipped, exit-successful, link
  intact, target untouched).
- `test/unit/application/primitives/internal/write-working-tree-file.test.ts` — the
  unlink-then-create behaviour for all four `joinPath` sites, for **both** an
  outside-pointing and an intra-repo link (two isolated tests — the intra-repo case is
  the one today silently writes *through*).
- One isolated R5 test per site for sites 2–6 asserting the no-dereference discipline
  against an injected filesystem that fails the test if `read` is called on a symlink
  path (the same shape for all five keeps the audit legible).

No new exports, no new error codes, no api.json delta.

### TDD steps

1. **RED** — `apply-changeset.test.ts`: a `120000` entry whose working-tree link target
   differs from the stored blob must read as dirty, and the link's **target file** must
   never be read. Expected failure: `blobMatches` dereferences the link and hashes the
   target's bytes.
2. **GREEN** — add the `lstat` + `isSymbolicLink` branch to `blobMatches`, preserving the
   L63–71 catch semantics.
3. **RED** — add the five remaining R5 isolated tests (sites 2–6) against an injected
   filesystem that throws if `read` is called on a symlink path. Expected: they pass
   immediately for sites 2, 3, 4, 6; site 5's assertion must be written as an explicit
   exclusion pin. If any fails, the guard has regressed — fix the site.
4. **RED** — `apply-changeset.test.ts`: a delete whose leading component is a symlink is
   skipped (exit 0, link intact, target untouched); a delete of a genuinely missing path
   is still a no-op; a delete that fails for any other reason **propagates**. Expected
   failure: the current `.catch(() => false)` conflation and the adapter refusal.
5. **GREEN** — wire the memoised leading-symlink scan into the delete arm; narrow
   `rmIfExists`'s `lstat` catch to `FILE_NOT_FOUND`; re-derive or delete the L27
   `Stryker disable` proof.
6. **RED** — `write-working-tree-file.test.ts`: writing `dir/file` where `dir` is a
   symlink (outside-pointing case, then intra-repo case) unlinks the symlink, creates a
   real directory and writes inside the repo. Expected failure: refusal in the first
   case, write-through in the second.
7. **GREEN** — extract one shared "unlink a symlinked leading component" helper and call
   it from all four `joinPath` sites (L59, L76, L120, L136).
8. **REFACTOR** — confirm each guard condition has its own test; confirm no swallowed
   error remains on any path this part touched; confirm the adapter refusal still fires
   as the backstop for a write that would genuinely land outside every root.

### Gate

```
npx vitest run test/unit/application/primitives/apply-changeset.test.ts test/unit/application/primitives/internal/write-working-tree-file.test.ts test/unit/application/primitives/compare-working-tree-entry.test.ts test/unit/application/commands/blame.test.ts test/unit/application/commands/grep.test.ts test/unit/application/commands/stash.test.ts test/unit/application/commands/checkout.test.ts \
  && npm run check:types \
  && ./node_modules/.bin/biome check src/application/primitives/apply-changeset.ts src/application/primitives/internal/write-working-tree-file.ts test/unit/application/primitives/apply-changeset.test.ts test/unit/application/primitives/internal/write-working-tree-file.test.ts
```

> Add the `workdir-entry` suite path to `<touched-tests>` once located — the source is
> `src/application/primitives/snapshot/workdir-entry.ts`; its test lives under
> `test/unit/application/primitives/` (exact filename to be confirmed, do not glob a
> directory that may not exist).

### Commit

`fix(checkout): match git through a symlinked leading directory and never dereference a link leaf`

---

## Part 7 — `walkWorkingTree` derives entry kinds from readdir and fetches stats lazily

### Context

**File:** `src/application/primitives/walk-working-tree.ts` (123 lines) and the yielded
type in `src/application/primitives/types.ts`.

**Current shape (verbatim, line-anchored):**
```ts
// types.ts L183
export interface WalkWorkingTreeEntry {
  readonly path: FilePath;
  readonly stat: FileStat;
}
// types.ts L192
export interface WalkWorkingTreeOptions {
  readonly maxDepth?: number;
  readonly maxEntries?: number;
  readonly ignore?: WalkIgnorePredicate;
}
```
```ts
// walk-working-tree.ts L16
interface WalkConfig { readonly ctx: Context; readonly maxDepth: number; readonly maxEntries: number; readonly ignore: WalkIgnorePredicate | undefined; }
// L23 — the shape precedent for threaded mutable state
interface Counter { value: number; }        // instantiated L51, mutated L99, read L100–102
// L41 (the only export)
export async function* walkWorkingTree(ctx: Context, options?: WalkWorkingTreeOptions): AsyncIterable<WalkWorkingTreeEntry>
// L55
async function* walkInternal(config, counter, prefix, depth, isRoot): AsyncIterable<WalkWorkingTreeEntry>
// L77
async function* visitEntry(config, counter, prefix, depth, entry: { name; isFile; isDirectory; isSymbolicLink }): AsyncIterable<WalkWorkingTreeEntry>
// L107
const directoryPath = (config, prefix) => prefix === '' ? config.ctx.layout.workDir : joinPath(config.ctx.layout.workDir, prefix);
```
`visitEntry`'s body: `joinPathSegment(prefix, entry.name)` **L89** → `validateWorkingTreePath(path)`
**L91** (defence-in-depth) → symlinked-directory non-traversal at **L92**
(`if (entry.isDirectory && !entry.isSymbolicLink)`) → leaf filter L97 → ignore L98 →
counter L99–102 → **`const stat = await config.ctx.fs.lstat(joinPath(config.ctx.layout.workDir, path));` L103**
→ `yield { path, stat }` **L104**.

**The waste, precisely.** `readdir` already returns every kind bit the walker's control
flow needs — `src/ports/file-system.ts:21`:
```ts
export interface DirEntry { readonly name: string; readonly isFile: boolean; readonly isDirectory: boolean; readonly isSymbolicLink: boolean; }
```
Nothing in `walkInternal`/`visitEntry`'s control flow consumes the `lstat`; only the
yielded value does. `status`'s untracked pass binds **only `{ path }`**
(`src/application/commands/status.ts:206`) and pays a full `lstat` + a second `joinPath`
per entry for nothing.

**Consumer audit — who needs the stat:**

| Consumer | Site | Needs stat? |
|---|---|---|
| `status.ts:206` | `for await (const { path } of walkWorkingTree(ctx, { ignore }))` | **NO** — path only |
| `stash.ts:178` | `for await (const { path, stat } of …)` → `hashFileAt(ctx, path, stat)` L180 | yes |
| `add.ts:181` and `add.ts:220` → `processWalkEntry` | destructures at `add.ts:297`, size cap L306, `stageFromStat` L309 | yes |
| `src/adapters/snapshot-resolvers/fs-workdir-enumerator.ts:73` | `toRow(path, stat)` L80 → `toWorkdirStat` L17–23 reads `isSymbolicLink`, `mode & 0o111`, `size`, `mtimeMs`, `mtimeNs`, `ino`; `isSymbolicLink` again L31 | yes, heavily |
| `src/repository.ts:746–749` (type at `:297`) | public pass-through | shape must stay usable |

**Target shape — decided, not left open:**
```ts
export interface WalkWorkingTreeEntry {
  readonly path: FilePath;
  readonly isFile: boolean;
  readonly isDirectory: boolean;
  readonly isSymbolicLink: boolean;
  /** Lazily fetched, memoised per entry. Consumers that only need the path never pay it. */
  readonly stat: () => Promise<FileStat>;
}
```
The three kind bits come straight off the `DirEntry` the parent `readdir` already
returned; `stat` becomes a callable. Turning a value field into a function is deliberate:
every stale consumer (`entry.stat.size`) becomes a **compile error** rather than a silent
type change, which is the loud failure you want on a public shape change. Constraints:

- The accessor **must memoise its own fetch per entry**, so two calls from one consumer
  issue one `lstat` even with no stat map present (design §10a states this explicitly —
  ADR-633 and ADR-634 must not each assume the other does it).
- The `lstat` currently has **no `.catch()`** — a file deleted between `readdir` and
  `lstat` throws out of the walker. Preserve that: laziness moves *when* it throws, and
  a consumer that never asks now never throws. Document the delta.
- Behaviour that must not change: yielded path set, skip rules
  (`isDotGitAlias` per Part 2, ignore predicate, embedded-repo gate at L69), the
  symlinked-directory non-traversal at L92, `validateWorkingTreePath` at L91, the
  entry-count limit and `treeEntryLimitExceeded`, the abort check at L71, `maxDepth`.
- `WalkWorkingTreeEntry.stat` is currently a **required** readonly `FileStat` field
  (`types.ts:185`), re-exported through `src/application/primitives/index.ts:101`,
  `src/repository.ts:297` and `reports/api.json`. The change above is a **public-shape
  change**; the four stat-reading consumers are updated in this same part and
  `reports/api.json` is regenerated. It is sanctioned by ADR-633 option (b), which the
  user ratified.

**Public-surface decision: `WalkWorkingTreeEntry` stays PUBLIC.** Downstream gates to
pre-pay in this part:
- `src/application/primitives/index.ts` **L101** (`export { walkWorkingTree } …`) — no
  new name, but verify the type re-export still resolves.
- `src/repository.ts:297` (`readonly walkWorkingTree: BindCtx<typeof primitives.walkWorkingTree>;`)
  and the binding at L746–749 — type-only; must compile.
- **`npm run docs:json`** → commit `reports/api.json` (prepush gate).
- `check:doc-coverage` does not apply (no new command). `audit-browser-surface` does not
  apply (no new `Repository` method).

**Tests:**
- `test/unit/application/primitives/walk-working-tree.test.ts` — the call-count oracle
  against an injected filesystem: a walk whose consumer reads only `path` issues **zero**
  `lstat` calls; a consumer that reads the stat issues exactly one per entry; reading the
  same entry's stat twice still issues one. One isolated test per condition. All existing
  skip/limit/depth/abort/ignore cases stay green untouched.
- `test/unit/application/commands/stash.test.ts`, `.../commands/add.test.ts`,
  `test/unit/adapters/snapshot-resolvers/…` (the `fs-workdir-enumerator` suite),
  `test/unit/repository/repository.test.ts` — updated for the new accessor; behaviour
  assertions unchanged.
- `test/unit/application/commands/status.test.ts` — `status`'s untracked pass now issues
  no `lstat` per untracked entry. This is the measurable half of the perf pair.

Property lenses: none fit (orchestration, no grammar, no round-trip). Record it.

### TDD steps

1. **RED** — `walk-working-tree.test.ts`: a walk consumed as `{ path }` only issues zero
   `ctx.fs.lstat` calls; a walk that reads the stat issues exactly one per entry; reading
   twice still issues one. Expected failure: `lstat` fires unconditionally at L103.
2. **GREEN** — change `WalkWorkingTreeEntry` to the decided shape (three kind bits +
   `stat: () => Promise<FileStat>` with a per-entry memo); drop the eager `lstat` and the
   second `joinPath` from `visitEntry`; keep every control-flow decision on the `DirEntry`
   bits.
3. **RED** — update the four stat-reading consumers' tests to the new accessor. Expected
   failure: TS type errors at `stash.ts:178`, `add.ts:297`,
   `fs-workdir-enumerator.ts:73–80`, `repository.ts:297`.
4. **GREEN** — update the four consumers. Behaviour assertions must not move.
5. **RED** — `status.test.ts`: the untracked pass issues no per-entry `lstat`. Expected
   failure if the walker still fetches eagerly for any reason.
6. **GREEN** — confirm; no `status.ts` change should be needed (it already binds `{ path }`).
7. **SURFACE** — `npm run docs:json`; commit `reports/api.json`.
8. **REFACTOR** — confirm the lazy accessor is the walker's **single** `lstat` site
   (Part 8 injects there); confirm the no-`.catch()` throw semantics are preserved and
   documented; 100% coverage on the changed lines.

### Gate

```
npx vitest run test/unit/application/primitives/walk-working-tree.test.ts test/unit/application/commands/status.test.ts test/unit/application/commands/add.test.ts test/unit/application/commands/stash.test.ts test/unit/adapters/snapshot-resolvers test/unit/repository/repository.test.ts test/unit/api-surface \
  && npm run check:types \
  && ./node_modules/.bin/biome check src/application/primitives/walk-working-tree.ts src/application/primitives/types.ts src/application/commands/add.ts src/application/commands/stash.ts src/adapters/snapshot-resolvers/fs-workdir-enumerator.ts test/unit/application/primitives/walk-working-tree.test.ts
```

### Commit

`perf(walk): derive entry kinds from readdir and fetch working-tree stats lazily`

---

## Part 8 — `status` shares one stat map across its two passes

### Context

**Module path — deviates from the design, deliberately.** Design §10a names
`src/application/commands/internal/working-tree-stat-map.ts`. Both consumers
(`walk-working-tree.ts`, `compare-working-tree-entry.ts`) are **primitives**, and
`.dependency-cruiser.cjs`'s `primitives-cannot-import-commands` is an **error** rule
(`check:architecture` runs in validate). The module therefore lands at
**`src/application/primitives/internal/working-tree-stat-map.ts`**, tested at
`test/unit/application/primitives/internal/working-tree-stat-map.test.ts` (that
directory exists and holds ~20 sibling suites).

**The collection (design §10a, verbatim intent):**
```ts
export interface WorkingTreeStatMap {
  readonly sampled: (path: FilePath) => FileStat | undefined;   // query
  readonly record: (path: FilePath, stat: FileStat) => void;    // command
}
export const createWorkingTreeStatMap = (): WorkingTreeStatMap;
```
CQS-split on purpose: `sampled` never populates, `record` never returns. It is mutable
state; the containment on that is **lifetime**, not immutability — created inside one
`status` call, passed explicitly down two call paths, unreachable once `status` returns.
Same shape as the walker's `Counter` (`walk-working-tree.ts:23`) and `status`'s own
`workingMap`. **No module-level state, no `Context` field, no adapter cache** (ADR-634
rejected option (c) for exactly that reason). **No eviction policy** — adding one
reintroduces the rejected cache. Memory is bounded by the paths one `status` already
materialises in `workingMap` and `untracked`.

**Public-surface decision: `WorkingTreeStatMap` is INTERNAL** (under `primitives/internal/`,
not in `src/application/primitives/index.ts`). But it appears in the **type** of a new
optional parameter on two symbols that ARE public and ARE in `reports/api.json`
(`compareWorkingTreeDelta`, `walkWorkingTree`/`WalkWorkingTreeOptions`) — so typedoc will
surface the type and **`reports/api.json` must be regenerated and committed in this part**
(`npm run docs:json`; prepush gate).

**Where it is threaded (design §10a):**

| Site | Today | With the map |
|---|---|---|
| `src/application/commands/status.ts` | `const provider = await maybeBuildAttributeProvider(ctx);` **L147**; `scanWorkingTree(…)` **L148–154**; `scanUntracked(ctx, trackedPaths)` **L155** | `const stats = createWorkingTreeStatMap()` beside L147; the **same instance** passed to both passes |
| `src/application/primitives/compare-working-tree-entry.ts` **L90** | `const stat = await ctx.fs.lstat(absPath).catch(() => undefined);` | `stats?.sampled(entry.path) ?? await lstat(…)`, then `stats?.record(entry.path, stat)` on a **successful** sample |
| the walker's lazy accessor (Part 7) | issues its own `lstat` | consults `stats?.sampled(path)` before issuing, and records what it does fetch |

**Signature changes — additive and optional, deliberately not a refactor.** A **5th**
optional argument on `compareWorkingTreeDelta`:
```ts
// current, compare-working-tree-entry.ts L83
export const compareWorkingTreeDelta = async (
  ctx: Context, entry: IndexEntry, provider?: AttributeProvider, indexMtime?: IndexMtime,
): Promise<WorkingTreeDelta> => { … }
```
and a new optional `stats?` field on `WalkWorkingTreeOptions` (`types.ts:192`). Both
functions are public exports in `reports/api.json`; collapsing
`provider`/`indexMtime`/`stats` into one options object would read better but is a
**breaking** public-signature change on a 3.x library for internal convenience. Additive
keeps this wiring non-breaking and the api.json regen a gate rather than a bump.

**Correctness rules, stated so they are not re-litigated:**
- **Absent files record nothing.** `compareWorkingTreeDelta` treats a failed `lstat` as
  `absent` (L90–91). Store **successful samples only — no tombstones**. The one
  observable consequence: a file created between the two passes gets a fresh stat from
  the walk instead of a stale negative. More accurate, not less.
- **Keying and case.** Keys are repo-relative `FilePath` values compared **byte-exact** —
  the same key both passes already carry (`entry.path` and the walker's
  `joinPathSegment` result). **No case folding**: on a case-insensitive filesystem two
  spellings of one file miss each other and cost one extra `lstat` — a missed
  optimisation, never a wrong sample. Folding would diverge from the byte-exact path
  identity the index itself uses. The two `lstat` sites resolve the same absolute path by
  construction: both build it as `joinPath(ctx.layout.workDir, path)`
  (`compare-working-tree-entry.ts:89` and the walker's accessor).
- **Order independence.** `status` awaits `scanWorkingTree` (L148) fully before
  `scanUntracked` (L155), so today the tracked pass always records and the walk always
  consumes. Write the map **order-agnostically** anyway — one lookup on a guaranteed miss,
  correctness if the pass order ever changes. Within pass 1 the entries are concurrent
  (`Promise.all` at `status.ts:185–191`) but stage-0 paths are **unique**, so no two
  in-flight calls contend for one key: the map needs **no** single-flight promise memo.
- **`buildUnmergedEntries` stays outside the map** (`status.ts:320`, its per-path `lstat`
  in `readWorktreeMode` at **L340**). An unmerged path has **no stage-0 entry**, so the
  key sets are disjoint and a shared entry could never hit. Do not wire it — and say so
  in a comment, because it looks like an omission.
- **The stat-cache fast path is unchanged.** `isEntryStatClean` /
  `ie_match_stat` (`src/application/primitives/internal/is-entry-stat-clean.ts:66`,
  armed only when `status` supplies `indexMtime`) still compares the same fields of the
  same sample against the same racy-guard reference point, and fires before any of this
  on a clean entry. `test/unit/application/primitives/internal/is-entry-stat-clean.test.ts`
  keeps every current expectation — the map changes *where the sample comes from*, never
  what `ie_match_stat` does with it. `matchesContentStat` reads `mtime`, `ctime`, `uid`,
  `gid`, `ino`, `size` (and the ns fields) — the shared sample must carry them faithfully;
  store the `FileStat` object, never a projection.
- **Staleness — the full statement.** Today the two passes take two independent samples
  of the same path at two different times; both already race the working tree. Consuming
  one sample twice **removes the second sample**; it does not add a new race class, and it
  narrows rather than widens the disagreement window. That is what git's own `status`
  does via `lstat_cache`. No `status` verdict depends on the delta: `changes` derive
  entirely from pass 1's sample, `untracked` entirely from pass 2's path set.
- **Absent the map**, every other `compareWorkingTreeDelta` consumer (`rm.ts:138`,
  `stash.ts:150`, `clean-work-tree.ts:64`, `find-would-overwrite.ts:118` — all via
  `compareWorkingTreeEntry`, `compare-working-tree-entry.ts:142`) and every other walker
  consumer (`add`, `stash`, `fs-workdir-enumerator`) issue byte-for-byte the calls they
  issue today.

**Tests (R12 is a call-count oracle — a wall-clock bench cannot prove a deduplication):**
- `test/unit/application/primitives/internal/working-tree-stat-map.test.ts` — the
  collection itself: `sampled` on an unrecorded path returns `undefined`; a recorded
  sample is returned; two instances share nothing.
- `status` call-count pins against an injected filesystem that counts `lstat` **per path**:
  - a repo with N tracked unmodified files plus M untracked ones ⇒ exactly N + M `lstat`
    calls, and **no path appears twice**;
  - the map is populated by the tracked pass and consumed by the walk: arrange a walk
    consumer that *does* read the lazy stat, assert the tracked path costs one `lstat`
    total while an untracked-only path costs one of its own (this is precisely the case
    Part 7 alone does not cover);
  - a tracked path **absent** from disk records nothing — the `lstat` rejects, `status`
    reports `absent`, and a later walk over a path recreated in between takes a fresh
    sample rather than a stale negative. **Two isolated tests, one per condition**, never
    one that trips both.
- `compareWorkingTreeDelta` and `walkWorkingTree` called **without** a map issue exactly
  the calls they issue today — one test each, guarding the optional arm's absent branch
  (mutation testing will otherwise flip that arm silently).

Property lenses: **none fit** — per-invocation orchestration, no grammar, no round-trip,
no algebraic composition. CLAUDE.md's "no virtue points" case; record the decision in the
test file header so the omission reads as deliberate.

### TDD steps

1. **RED** — `working-tree-stat-map.test.ts`: `sampled` on an unrecorded path is
   `undefined`; a recorded sample round-trips; two instances share nothing. Expected
   failure: module does not exist.
2. **GREEN** — create `src/application/primitives/internal/working-tree-stat-map.ts` with
   the CQS-split interface and factory.
3. **RED** — `compare-working-tree-entry.test.ts`: with a map supplied and a sample
   pre-recorded, no `lstat` is issued; with a map supplied and nothing recorded, one
   `lstat` is issued **and recorded**; a failed `lstat` records **nothing**; with **no**
   map the call count is unchanged. Four isolated tests. Expected failure: the 5th
   parameter does not exist (TS arity).
4. **GREEN** — add the optional 5th parameter and the sampled/record wiring at
   `compare-working-tree-entry.ts:90`.
5. **RED** — `walk-working-tree.test.ts`: with a map supplied, the lazy accessor consults
   it before issuing an `lstat` and records what it fetches. Expected failure: `stats` is
   not a member of `WalkWorkingTreeOptions`.
6. **GREEN** — add `stats?` to `WalkWorkingTreeOptions` and consult/populate it in the
   lazy accessor from Part 7.
7. **RED** — the three `status` call-count pins above. Expected failure: `status` creates
   no map and each path is stated by both passes.
8. **GREEN** — create the map beside `status.ts:147` and hand the **same instance** to
   `scanWorkingTree` (through to `compareWorkingTreeDelta`) and to `scanUntracked`
   (through `walkWorkingTree`'s options).
9. **SURFACE** — `npm run docs:json`; commit `reports/api.json`.
10. **REFACTOR** — confirm `is-entry-stat-clean.test.ts` is green untouched; confirm
    `buildUnmergedEntries` is deliberately outside the map with a comment saying why;
    confirm no eviction policy, no module-level state, no `Context` field; 100% coverage
    including the optional arms' absent branches.

### Gate

```
npx vitest run test/unit/application/primitives/internal/working-tree-stat-map.test.ts test/unit/application/primitives/compare-working-tree-entry.test.ts test/unit/application/primitives/walk-working-tree.test.ts test/unit/application/primitives/internal/is-entry-stat-clean.test.ts test/unit/application/commands/status.test.ts test/unit/application/commands/rm.test.ts test/unit/application/commands/stash.test.ts test/unit/api-surface \
  && npm run check:types \
  && ./node_modules/.bin/biome check src/application/primitives/internal/working-tree-stat-map.ts src/application/primitives/compare-working-tree-entry.ts src/application/primitives/walk-working-tree.ts src/application/primitives/types.ts src/application/commands/status.ts test/unit/application/primitives/internal/working-tree-stat-map.test.ts test/unit/application/commands/status.test.ts
```

### Commit

`perf(status): share one working-tree stat sample across both scan passes`

---

## Part 9 — Cross-tool faithfulness suite and the superseded performance narrative

### Context

Test-infra + docs only; no `src/` delta. This is the tier that **proves** faithfulness —
parity tests are cross-adapter only and do not.

**New file:** `test/integration/git-parity-containment-interop.test.ts`.

**Harness.** `test/integration/interop-helpers.ts` (259 lines). Exports to use:
```ts
L76  export const runGit = (args, options: { input?; env? } = {}): string
L90  export const runGitEnv = (): NodeJS.ProcessEnv
L103 export const runGitAsync = async (args, options = {}): Promise<string>
L117 export const runGitBytes = (args, options = {}): Uint8Array
L125 export const hasGit = (): boolean
L134 export const GIT_AVAILABLE = hasGit();
L161 export const git = (dir, ...args) => runGit(['-C', dir, ...args]);
L165 export const gitAsync = (dir, ...args) => runGitAsync(['-C', dir, ...args]);
L218 export const tryRunGitWithExit = (args, options = {}): { stdout; stderr; exitCode }
L242 export const tryRunGit = (args, options = {}): GitRunResult
```
Isolation is already built in (`buildSafeEnv`, L52–66): every `GIT_*` key is dropped,
`HOME` points at a deterministic **non-existent** path under `os.tmpdir()`,
`GIT_CONFIG_NOSYSTEM=1`, `XDG_CONFIG_HOME` under that fake home,
`GIT_CEILING_DIRECTORIES=os.tmpdir()`. **Never** spawn `git` any other way from this file.
For the hostile-tree scenarios use `tryRunGitWithExit` — you need the exit code and
stderr, and git exits 128.

**Timeouts.** There is no `hookTimeout` anywhere in the repo and no separate integration
config; everything inherits `vitest.config.ts:10` `testTimeout: 120_000`. Follow the
established pattern: `describe.skipIf(!GIT_AVAILABLE)(name, { timeout: 60_000 }, …)`
(as in `test/integration/add-add-content-interop.test.ts:50–52`) **or**
`beforeAll(fn, SETUP_TIMEOUT)` with `const SETUP_TIMEOUT = 60_000` (as in
`test/integration/linked-worktree-discovery-interop.test.ts:27, 132`). Use **one shared
`beforeAll` repo per scenario group** — the known interop load→validate flake is a
per-test repo build.

**Required header** — `check:write-surfaces` and `check:test-pyramid` parse it
(`tooling/test-pyramid/parse-proves-header.ts`). Copy the shape from
`test/integration/checkout-replace-symlink-with-file-interop.test.ts:9–13`:
```
 * @proves
 *   surface:        <repo surface>
 *   bucket:         cross-tool-interop
 *   unique:         <one-line reason this file exists>
 *   interopSurface: <surface name>
```
`test-pyramid-budgets.json` sets the integration tier target 15 % (warn 10–25 %) — one
new file will not move it, but check the report if `check:test-pyramid` complains.

**The eight scenarios (design `## Test strategy` → Interop). Compare on-disk state and
exit conditions, never message bytes — faithfulness binds the data and on-disk state,
not rendered stdout.**

1. **Hostile tree names.** For each of `..`, `.git`, `git~1`, `.gi<ZWNJ>t`: build the raw
   tree with `git hash-object -t tree --literally` (`git mktree` accepts these at exit 0
   — it is the plumbing escape hatch), then assert **git** refuses at `read-tree`/clone
   with `invalid path` and checks nothing out (`exit=128`, clone dir contains only
   `.git/`), and **tsgit** refuses at the same stage with `INVALID_INDEX_ENTRY` and
   writes nothing. Compare the on-disk state (empty worktree, `.git` only).
2. **`.gitmodules` mode arm.** At `120000` both refuse; at `100644` and `160000` both
   accept.
3. **Symlinked leading directory.** `status` reports the symlink as untracked and the
   tracked child as deleted in **both**; `add <child>` refuses in both; `add -A` stages
   the symlink as `120000` in both and leaves the outside file untouched.
4. **Leaf symlink.** `add` stores the **target path** as blob content in both
   (`git cat-file -p :link` → the target path, §1.2 pin B); checkout of a regular file
   over it replaces the link and leaves the outside target byte-identical in both.
5. **Write / delete through a symlinked leading directory.** Assert the outside file is
   byte-identical after each operation in both tools, and record tsgit's shape against
   git's: **write** → unlink-and-create (Part 6); **delete** → skipped, symlink intact,
   exit 0 (Part 6).
6. **Object store outside the repo.** `.git/objects` moved out and symlinked back: both
   read the object (§1.3 pin C). `.git` itself moved out and symlinked back: both report
   the same `status` (pin F). Alternates stay a read-not-refused assertion until tsgit
   implements `objects/info/alternates` (out of scope).
7. **Root reached through a symlink.** tsgit's resolved `workDir` matches
   `git rev-parse --show-toplevel` (the **realpath**, §1.3 pin E) — this pins the
   retention of the one-per-lifetime root realpath.
8. **Symlink targets written verbatim.** A source repo carrying three `120000` entries:
   `abs -> <tmp>/outside/secret` (absolute, escaping, and **hermetic** — the byte/mtime
   assertions run against a file the test owns), `rel -> ../../../etc/passwd` (relative,
   escaping), `sys -> /etc/passwd` (the literal pin-M shape, asserted for **link bytes
   only** — never read, never written). Clone with **git** and with **tsgit** into two
   destinations, then assert: every entry is a symlink in both; `readlink` returns the
   same bytes in both and equals the blob content; the owned outside file's bytes **and
   mtime** are unchanged after both clones. **The negative half matters as much as the
   positive: tsgit must NOT raise `PERMISSION_DENIED` on any of the three** — that is the
   assertion which would have failed before this change. Repeat both halves for a
   checkout of the same commit into an existing worktree.

Trap to avoid: never write to a real system path. Scenario 8's `/etc/passwd` arms assert
**link bytes only**; the byte/mtime oracle uses the test-owned file under the scenario's
own `mktemp` root.

**Docs owned by this part.**
`docs/understand/performance.md` — **the file is currently MODIFIED in the working tree**
(uncommitted benchmark-table refresh to the 2026-08-13 nightly, plus L3 and the Phase-26.7
roadmap bullet, carried in from the main checkout). **Layer onto it; do not clobber it.**
The superseded claims are all in the single bullet at **L63**, under the heading
`## Why status:clean / readBlob:cold / delta-chain:cold are currently slower` (L61):
- *"an extra `lstat` / path-policy step per path"* — first sentence.
- *"The tax itself is inherent — iso-git skips the security check entirely"* — last
  sentence.
Rewrite the section (and narrow L3 and L7, which repeat the framing) to the pinned truth:
**git skips it too** — the check was stricter than the tool being replicated, which under
the prime directive is itself a divergence. Do not invent numbers. **The acceptance
signal (R8) is the CI nightly `bench.yml` artefact on the four losing scenarios at ±20 %
advisory variance — never a local run.** Record the gate asymmetry explicitly:
`hot-paths.json` covers `status` and `pack-read`, so `loose-read` (0.33×) and
`delta-chain-read` (0.35×) are **ungated** by `benchmark-compare` and must be read off the
nightly by hand. State the honest per-scenario expectation from the design: `status:clean`
carries three independent contributions (containment collapse + the walker's per-entry
`lstat`/`joinPath` removal + the one-sample-per-path invariant), of which only the first
two are bench-measurable — the stat map is proved by call count, so a `status:clean`
result must not be read as evidence for or against it; `readBlob:cold` and
`delta-chain:cold` are dominated by repository-open fixed cost, where `exists`'s collapse
is the largest single contributor.

Also cross-reference `docs/design/checkcontainment-hot-path.md`'s Lever 5c foreclosure
(**L612–619**, **L1352–1355**, **L1537–1546**) as **re-entry condition met** — the
committed profile now shows containment itself dominating (0.46 of `status` self-time).

Run `npx cspell` over every edited markdown file before committing (`check:spelling` is
the review-batch gate and the md commit hook is narrower than validate).

### TDD steps

1. **RED** — create `test/integration/git-parity-containment-interop.test.ts` with the
   `@proves` header, `describe.skipIf(!GIT_AVAILABLE)`, `SETUP_TIMEOUT = 60_000`, and
   scenarios 1 and 2 (hostile tree names, `.gitmodules` mode arm), one shared `beforeAll`
   repo per group. Expect them to pass against the landed Parts 1–2 — if any fails, the
   validator's stage or reason is wrong and the *implementation* is fixed, not the test.
2. **RED** — add scenarios 3, 4, 5 (symlinked leading directory; leaf symlink; write and
   delete through a symlinked leading directory). These are the faithfulness pins over
   Parts 3–6. A failure here is a real divergence — fix the source.
3. **RED** — add scenarios 6 and 7 (object store outside the repo; root reached through a
   symlink). These pin the pillar-3 exemption and ADR-042's retention.
4. **RED** — add scenario 8 (symlink targets written verbatim), including the negative
   half (no `PERMISSION_DENIED` on any of the three) and the checkout-into-an-existing-
   worktree repeat.
5. **GREEN** — resolve any divergence the suite surfaces in the source, never by relaxing
   an assertion. If a divergence is genuinely a design gap, escalate as
   `{ scenario, reason, ≤3 options }` — do not quietly weaken the pin.
6. **DOCS** — rewrite `docs/understand/performance.md` L3, L7 and the L61–L64 section on
   top of the existing uncommitted diff; add the Lever 5c re-entry cross-reference.
   Run `npm run check:spelling`.
7. **REFACTOR** — confirm one shared `beforeAll` repo per scenario group (not per test),
   every `git` call routed through the helpers, and no write to any path outside the
   scenario's own `mktemp` root.

### Gate

```
npx vitest run test/integration/git-parity-containment-interop.test.ts \
  && npm run check:types \
  && ./node_modules/.bin/biome check test/integration/git-parity-containment-interop.test.ts \
  && npm run check:spelling
```

### Commit

`test(interop): pin git-parity containment behaviour against canonical git`

---

## Phase-boundary gate

After Part 9, run the phase gate once:

```
npm run validate
```

Then, before pushing, confirm `reports/api.json` is current (`npm run docs:json` produces
no diff) — `check:doc-typedoc` runs at **prepush only** and a green cached validate can
still precede a red pre-push hook.
