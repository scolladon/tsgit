# Plan: Phase 9 — Commands

Implements [design/commands.md](../design/commands.md).
Covers [backlog](../BACKLOG.md) items 9.1–9.16.

### Review Notes

**Round 3 — applied** (third self-review pass, manual due to reviewer rate-limit):

- **`extractDetail` count math reconciled.** Step 1.3 now states 32 arms land in Step 1 + 1 in Step 0 = 33 total, broken down as 29 from design §4.2.1 (excluding `NOT_A_REPOSITORY`) + 2 plan-added + `OPERATION_IN_PROGRESS`.
- **Backlog map clarified.** Row for Step 1 explicitly notes 32 + 1 split.
- **Substep numbering verified.** All 0.x, 1.x, 2.x, 3.x, 4.x sequences are gap-free (1.6 → 1.7 → 1.8 after H1 renumbering held).
- **Variant count cross-check.** 3 `RepositoryError` + 27 `CommandError` + 2 `ApplicationError` + 1 `ProtocolError` = 33 ✓ (consistent with Step 1.2 / Step 1.6 test count of 27 / Backlog map / `extractDetail` total).
- **No remaining TODOs in spec body.** Only review-notes reference TODOs as resolved historical findings.

---

**Round 2 — applied** (second self-review pass):

- **B1 fixed.** Canonical variant count: design §4.2 lists 25 `CommandError` variants. Plan adds 2 (`MAX_REFSPECS_EXCEEDED`, `REMOTE_NOT_CONFIGURED`) → **27** command variants. Plus 3 `RepositoryError` + 2 `ApplicationError` + 1 `ProtocolError` → **33 new variants total**. §1.2 / §1.3 / §1.6 / Backlog map all rewritten to this count.
- **H1 fixed.** Substep heading collision (two `### 1.6`) renumbered: 1.6 Tests → 1.7 Exhaustiveness helper → 1.8 Domain barrels.
- **H2 fixed.** Single name `MAX_OBJECTS_PER_PACK` everywhere (design §4.2 wins). `MAX_PACK_OBJECTS` (push enumeration cap) is a SEPARATE constant per design §10.1; both kept distinct with their own roles documented.
- **H3 fixed.** Step 4.6 ref-spec test uses `MAX_REFSPECS_EXCEEDED` (not `REFSPEC_INVALID`). TODO removed.
- **H4 fixed.** Step 0.6 prose simplified — no "OR" clause; `notARepository` lands together with `getRepoRoot`.
- **M1 fixed.** Plan now states: each Step 5–17 command commit ALSO updates the barrel + `.size-limit.json` + `rollup.config.ts` + `package.json` exports for THAT command. Step 18 then only handles cross-cutting wiring (dep-cruiser rules, knip entries, the sentinel script). `check:wiring` runs in `validate` from Step 18 onward.
- **M2 fixed.** Step 4.11 fixtures note: `memoryRemote` uses `domain/protocol/pkt-line.encodePktStream` for framing (Phase 8 export — no new helper).
- **M3 fixed.** Step 6 explicitly notes the bulk of revParse tests live in Step 4.9 grammar tests; Step 6 only adds the public-API smoke layer.
- **M4 fixed.** Substep commits made explicit for the three large commands: Step 11 (`checkout — switch branch`, `checkout — paths/partial`, `checkout — detach`), Step 14 (`merge — fast-forward`, `merge — three-way`, `merge — conflicts`), Step 15 (`clone — bootstrap`, `clone — fetch+write`, `clone — checkout+rollback`).
- **L1 fixed.** Step 12 status's Dependency Graph row corrected — depends on Step 4 (repo-state, working-tree, config-read, ignore) only, NOT on 7 or 11.
- **L2 fixed.** Step 4.7 test clarifies `withDefaults` freezes ctx.config UPON RETURN (not lazily on first request).
- **L3 fixed.** Status convention check added — design docs use plain `Implemented (<YYYY-MM-DD>)`; ADRs use `Accepted (at <sha>)`. Confirmed in the Step 19.3 wording.
- **L4-L5 fixed.** Step 5 init explicitly notes `InitOptions` / `InitResult` come from design §5.1; the types declaration block lives in `init.ts` itself (no separate `types.ts` for command-local types).

---

**Round 1 — applied** (single self-review pass + tool-assisted external reviewer):

- **B1 fixed.** `CommandError` lives at `src/domain/commands/error.ts` (not `application/commands/error.ts`). All Step 1 substeps use the corrected path; Step 18.5 dep-cruiser rule and §10.1 imports updated.
- **B2 fixed.** Step 0 + Step 1 are explicitly a SINGLE PR. Step 0.6 creates only `notARepository` (the one factory `getRepoRoot` needs); the other 29 variants land in Step 1. The Backlog map, Workflow, and Dependency Graph all reflect the combined commit.
- **H1 fixed.** Step 4 gains a substep dependency table (4.x → 4.y).
- **H2 fixed.** Step 18.7 adds `scripts/check-commands-wiring.ts` with its own red test.
- **H3 fixed.** All three TODOs resolved: pack-enumeration overflow → new `PACK_TOO_LARGE` reuse with `{objectCount, limit}` (Step 17 spec); too-many refspecs → new `MAX_REFSPECS_EXCEEDED` variant (added to Step 1); missing remote → new `REMOTE_NOT_CONFIGURED` variant (added to Step 1); grammar smoke list enumerated.
- **H4 fixed.** Step 1.7 (new) creates `src/domain/repository/index.ts` and updates `src/domain/index.ts` re-exports for all three new domain modules in lockstep.
- **H5 fixed.** Step 4.11 creates `test/unit/application/commands/fixtures.ts` with red tests for the builders.
- **M1 fixed.** "File Conventions" gains an explicit mutation-resistance bullet for command tests.
- **M2 fixed.** Step 1.6 (test exhaustiveness helper) is a separate substep with its own commit.
- **M3 fixed.** Step 4.3 pins the rollback mechanism (snapshot-and-replace under the lock; release without commit reverts).
- **M4 fixed.** Step 9.1 rename recovery line is now a real test that asserts the error code surfaced when HEAD points at a missing branch (`REF_NOT_FOUND` from `resolveRef`).
- **L1 fixed.** Step 0.7 updates `src/application/primitives/index.ts`.
- **L2 fixed.** Critical-path chain now includes Step 6 (revParse) → Step 10 (reset).
- **L3 fixed.** Step 19.3 explicitly checks the current Status line before promoting.

---

## Backlog → Step Mapping

| Backlog | Description | Step |
|---|---|---|
| — | **Combined PR:** Phase 7 amendment + minimal `notARepository` factory (so `getRepoRoot` compiles) | 0 (with Step 1) |
| — | Error scaffold: 33 new variants in `TsgitErrorData` (3 `RepositoryError` + 27 `CommandError` (25 design + 2 plan-added) + 2 `ApplicationError` + 1 `ProtocolError`); 32 `extractDetail` arms here + 1 in Step 0 (`NOT_A_REPOSITORY`) | 1 (with Step 0) |
| — | New domain modules: `domain/repository/error.ts`, `domain/ignore/parse-gitignore.ts`, `domain/ignore/match.ts` | 2 |
| — | `FileSystem` port additions: `rmRecursive`, `openWithNoFollow` + node/memory/browser adapters | 3 |
| — | Shared `commands/internal/*` modules (10 files: `repo-state`, `working-tree`, `index-update`, `bootstrap`, `url-validate`, `ref-spec`, `network-pipeline`, `commit-message`, `rev-parse-grammar`, `config-read`) | 4 |
| **9.1** | `init` | 5 |
| **9.16** | `revParse` | 6 |
| **9.2 / 9.14** | `add`, `rm` | 7 |
| **9.3** | `commit` | 8 |
| **9.7 / 9.8** | `branch`, `tag` | 9 |
| **9.15** | `reset` | 10 |
| **9.9** | `checkout` | 11 |
| **9.4** | `status` | 12 |
| **9.5 / 9.6** | `log`, `diff` | 13 |
| **9.13** | `merge` | 14 |
| **9.10** | `clone` | 15 |
| **9.11** | `fetch` | 16 |
| **9.12** | `push` | 17 |
| — | Wiring: `rollup.config.ts`, `.size-limit.json`, `package.json` exports, dep-cruiser rules, knip entries, barrel | 18 |
| — | Mutation testing + 4× parallel reviews + squash-merge | 19 |

---

## Workflow

Each step follows TDD: write test (red) → implement (green) → refactor.
After every green step, run: `npm run check:types && npm run test:unit && npm run check:architecture`.

**Commit strategy.** One commit per substep (e.g., `5.1`, `5.2`) when the step is large; one commit for the whole step when small. Message format mirrors Phase 8:

- Steps 0 + 1 → SINGLE commit `feat(domain): amend Phase 7 + add Phase 9 error scaffold` (avoids the circular dep where `getRepoRoot` needs `notARepository`).
- Step 2 → `feat(domain): add repository + ignore modules`.
- Step 3 → `feat(ports): add rmRecursive + openWithNoFollow`.
- Steps 4.x → `feat(commands): add internal/<name>` (one commit per internal module).
- Steps 5–17 → `feat(commands): add <command>` (one commit per command — except Step 11 / 14 / 15 which split into 3 substep commits each, see those step bodies). EVERY command commit ALSO updates the barrel re-export, `package.json` exports, `rollup.config.ts` input map, and `.size-limit.json` per-command entry for that command — keeps `check:wiring` green at every commit.
- Step 18 → `chore: wire Phase 9 commands export`.
- Step 19 squash-merge message: `feat(commands): add phase 9 — tier 1 commands`.

**Size gate.** The 28 kB gzipped cap on `dist/esm/commands/index.js` lands at step 18 only. Per-command 1.5 kB caps land alongside.

**Branch strategy.** Implement on `feat/phase-9-commands` (or worktree under `.claude/worktrees/phase-9-commands`). Plan + design land directly on main per Phase 6/7/8 precedent; implementation goes on a branch and squash-merges.

**Parallelism.** Steps 5–17 are dependency-ordered (per design §10.5) but parallelizable AFTER step 4 lands on main: the implementer can split work across branches if desired. Keep the linear order in this plan for review simplicity.

---

## Prerequisites (before Step 0)

1. **Design doc merged.** `docs/design/commands.md` is on main (commit `727691a`). ✓
2. **Phases 1–8 complete.** Phase 9 introduces `src/application/commands/` (currently empty) and amends Phase 7 (`src/application/primitives/`). Both depend on every prior phase.
3. **`.size-limit.json`.** New `Commands (barrel)` entry (28 kB gzip) + 16 per-command entries (1.5 kB each) added at step 18.
4. **`package.json exports`.** New `./commands` + 16 `./commands/<name>` entries added at step 18.
5. **`.dependency-cruiser.cjs` rules.** Four new rules added at step 18 (see §Step 18 below):
   - `commands-cannot-import-each-other`
   - `commands-cannot-import-adapters`
   - `internal-modules-cannot-be-exported`
   - `domain-repository-error-is-leaf`
6. **`knip.json` entries.** Step 18 adds `src/application/commands/index.ts` and per-command source files to `entry`.
7. **`cspell` lexicon.** Spelling updates (`commitlint`-friendly terms used in commit messages) added incrementally per step. Verify with `npm run check:spelling`.
8. **No new ADR required.** Every choice with multiple alternatives is recorded inline in `docs/design/commands.md` Review Notes (Rounds 1–3).

---

## File Conventions

- Source files under `src/application/commands/` (commands), `src/application/commands/internal/` (shared helpers), `src/domain/repository/` (error family), `src/domain/ignore/` (gitignore parser/matcher), and amendments to `src/application/primitives/`.
- Test files mirror under `test/unit/application/commands/`, `test/unit/application/commands/internal/`, `test/unit/domain/repository/`, `test/unit/domain/ignore/`, `test/unit/application/primitives/`.
- File names: kebab-case (ls-lint enforced). `init.ts`, `with-defaults.ts`, `repo-state.ts`, `rev-parse-grammar.ts`.
- Test files: `<module>.test.ts`. Shared fixtures in `fixtures.ts`. Property tests in `<module>.laws.test.ts`.
- **Test format:** Given/When/Then titles, AAA bodies with `// Arrange` / `// Act` / `// Assert` comments, `sut` variable.
- **Plan style.** Inline test specifications use one of two styles. (a) Full `Given … When … Then …` prose in the plan → copy verbatim as the test title. (b) Shorthand `<scenario>: <outcome>` → rewrite to full `Given … When … Then …` form when authoring the test file.
- **Import extensions:** all imports MUST use the `.js` extension.
- **Type-only imports:** command files use `import type { Context } from '../../ports/context.js'` etc.
- **Error types:** `TsgitError` via named factories from `commands/error.ts`, `domain/repository/error.ts`, `domain/protocol/error.ts`. Never construct `new TsgitError({...})` in command bodies. Internal helpers may throw plain `RangeError` / `TypeError` only when the failure is misconfiguration of the helper itself (not data).
- **Iterator protocol:** commands returning many results use `AsyncIterable<T>` (e.g., `log`, `diff`); single results use `Promise<T>`.
- **Defensive freeze.** `internal/network-pipeline.withDefaults` calls `Object.freeze(ctx.config)` on first invocation — defensive guard until Phase 10's facade freezes at construction. Test pins this.
- **Mutation-resistant assertions (CLAUDE.md).** Error tests use `try/catch + .data.code + payload checks`, NOT `toThrow(SomeClass)` alone. Message-format assertions use `.toBe(<exact string>)`, NOT `.toMatch(/regex/)` (regex passes for too many StringLiteral mutants). Validation guards get one isolated test per condition (no combined "throws on bad input" tests). Boundary triples (just-under / at / just-over) for every cap (`MAX_HAVES`, `MAX_OBJECTS_PER_PACK`, `MAX_REFSPECS_PER_PUSH`, redirect cap, parallelism cap, lock-stale window). This rule applies to ALL command tests, not just error tests.

---

## Design Decisions (applied in this plan)

- **Step 0 (Phase 7 amendment) lands BEFORE every other step.** All command tests will need `mergeBase`, `writeSymbolicRef`, `getRepoRoot` from Phase 7 to compile.
- **Step 1 (error scaffold) lands BEFORE every command step.** The 30 new variants must exist in `TsgitErrorData` so command test files type-check.
- **Steps 2–4 (domain + ports + internals) land BEFORE every command step.** Commands consume them.
- **Steps 5–17 (per-command) follow the dep-order from design §10.5.** Each step depends on at least one prior step's primitive or internal helper.
- **Step 18 (wiring) MUST be last** — it adds `package.json` exports + dep-cruiser rules that reference files that need to exist first.
- **Step 19 (mutation + reviews) is the merge gate.**
- **Every boundary cap gets just-under / at / just-over triple tests** per CLAUDE.md (e.g., `MAX_HAVES`, `MAX_OBJECTS_PER_PACK`, `MAX_REFSPECS_PER_PUSH`, redirect cap, parallelism cap).
- **All validation tests are isolated** (one guard per test). Combined "throws on bad input" tests don't kill `&&`-vs-`||` mutants.
- **Shared `fixtures.ts`** under `test/unit/application/commands/` provides `seedRepo(ctx, builder)`, `memoryRemote(advertisements, packBody)`, `recordedTransport()`, and async helpers. Defined ONCE at the start of step 5; reused across all command tests.
- **Required reading before Step 1:** `docs/design/commands.md` Review Notes (Rounds 1–3) — enumerates non-obvious decisions (HEAD-via-symref, force-with-lease vs --force, EMPTY_TREE_OID for unrelated histories, mergeBase tie-breaker, the 30 error variants and their format strings). Every step below assumes the reader has internalized these.

---

## Step 0: Phase 7 amendment

**Design:** §10.1, §10.5 (Step 0 is the prerequisite that unblocks Phase 9).

**Single PR amends both `docs/design/primitives.md` AND adds the new primitives.** Lands on main BEFORE the `feat/phase-9-commands` branch is opened.

### 0.1 Amend `docs/design/primitives.md`

- §1 size budget: `8 kB` → `9 kB` (with rationale).
- §2 module list: add `merge-base.ts`, `write-symbolic-ref.ts`. Note `path-layout.ts` gains `getRepoRoot`.
- §3.1 dependency table: add the two new primitives.
- Add a "Round 5 amendment" entry to Review Notes recording the addition.

### 0.2 `EMPTY_TREE_OID` constant

**Modify:** `src/domain/objects/object-id.ts`.

Add: `export const EMPTY_TREE_OID: ObjectId = ObjectId.from('4b825dc642cb6eb9a060e54bf8d69288fbee4904');`

**Red.** `test/unit/domain/objects/object-id.test.ts`:

```
Given EMPTY_TREE_OID, When inspected, Then it equals exactly the literal '4b825dc642cb6eb9a060e54bf8d69288fbee4904'.
Given EMPTY_TREE_OID, When ObjectId.from is called with the same string, Then the result is === EMPTY_TREE_OID.
Given EMPTY_TREE_OID, When length is read, Then it equals 40.
```

**Green.** One-line export.

### 0.3 `getRepoRoot` in `path-layout.ts`

**Modify:** `src/application/primitives/path-layout.ts`.

```typescript
const REPO_ROOT_CACHE = new WeakMap<Context, FilePath>();

export const getRepoRoot = async (ctx: Context): Promise<FilePath> => {
  const cached = REPO_ROOT_CACHE.get(ctx);
  if (cached !== undefined) return cached;
  const start = await ctx.fs.realpath(ctx.cwd);
  let dir = start;
  while (true) {
    if (await ctx.fs.exists(`${dir}/.git`)) {
      const root = dir as FilePath;
      REPO_ROOT_CACHE.set(ctx, root);
      return root;
    }
    const parent = dirname(dir);
    if (parent === dir) throw notARepository(start as FilePath);
    dir = parent;
  }
};
```

Note: `notARepository` factory comes from §Step 1 — Step 0.3 is committed AFTER Step 1 in practice, OR `notARepository` lands as part of Step 0 alongside `getRepoRoot`. Choose the latter to keep Step 0 self-contained.

**Red.** `test/unit/application/primitives/path-layout.test.ts`:

```
Given a memory FS with .git at /repo and ctx.cwd = /repo, When getRepoRoot, Then returns '/repo'.
Given .git at /repo and ctx.cwd = /repo/src/lib, When getRepoRoot, Then returns '/repo'.
Given no .git anywhere, When getRepoRoot, Then throws NOT_A_REPOSITORY with .data.path === resolved start.
Given a symlink at /sym -> /repo, .git at /repo, ctx.cwd = /sym, When getRepoRoot, Then returns '/repo' (realpath pinned).
Given two consecutive calls with the same ctx, When getRepoRoot, Then the second call does NOT touch the FS (verify via spy on ctx.fs.exists call count).
```

### 0.4 `mergeBase(ctx, a, b)` primitive

**Create:** `src/application/primitives/merge-base.ts`, `test/unit/application/primitives/merge-base.test.ts`.

```typescript
export const mergeBase = async (
  ctx: Context,
  a: ObjectId,
  b: ObjectId,
): Promise<ObjectId | undefined> => {
  if (a === b) return a;
  // Bidirectional BFS.
  const visitedA = new Set<ObjectId>([a]);
  const visitedB = new Set<ObjectId>([b]);
  const frontierA: ObjectId[] = [a];
  const frontierB: ObjectId[] = [b];
  while (frontierA.length > 0 || frontierB.length > 0) {
    const stepA = await advanceFrontier(ctx, frontierA, visitedA);
    const stepB = await advanceFrontier(ctx, frontierB, visitedB);
    const intersect = collectIntersection(visitedA, visitedB);
    if (intersect.length > 0) {
      // Tie-break: lex-smallest oid (deterministic).
      return intersect.sort()[0];
    }
    if (!stepA && !stepB) break;
  }
  return undefined;
};
```

**Red.**

```
Given linear A←B←C←D, When mergeBase(D, B), Then returns B.
Given linear A←B←C←D, When mergeBase(D, D), Then returns D (self-base shortcut).
Given linear A←B←C, When mergeBase(C, A), Then returns A.
Given diamond A←{B,C}←D, When mergeBase(B, C), Then returns A.
Given criss-cross M1=merge(B,C) and M2=merge(B,C) on same parents B,C, When mergeBase(M1, M2), Then returns lex-smallest of {B, C}.
Given two unrelated histories X and Y, When mergeBase(X, Y), Then returns undefined.
Given missing intermediate object (object store throws OBJECT_NOT_FOUND for a parent), When mergeBase, Then propagates OBJECT_NOT_FOUND.
```

### 0.5 `writeSymbolicRef(ctx, name, target)` primitive

**Create:** `src/application/primitives/write-symbolic-ref.ts`, `test/unit/application/primitives/write-symbolic-ref.test.ts`.

```typescript
export const writeSymbolicRef = async (
  ctx: Context,
  name: RefName,
  target: RefName,
): Promise<void> => {
  validateRefName(name);
  validateRefName(target);
  const path = `${await getRepoRoot(ctx)}/.git/${name}`;
  const content = serializeSymbolicRef(target);  // returns 'ref: <target>\n'
  await atomicWrite(ctx, path, content);
};
```

**Red.**

```
Given name='HEAD' and target='refs/heads/main', When writeSymbolicRef, Then .git/HEAD contains the bytes 'ref: refs/heads/main\n' exactly.
Given an existing direct-oid HEAD, When writeSymbolicRef('HEAD', 'refs/heads/main'), Then HEAD is overwritten as a symbolic ref (atomic).
Given name with leading slash, When writeSymbolicRef, Then throws INVALID_REF.
Given target='refs/heads/feature with space', When writeSymbolicRef, Then throws INVALID_REF.
Given concurrent calls with same ctx, When two writeSymbolicRefs race, Then exactly one wins (locked write); other sees REF_LOCKED.
```

### 0.6 Minimal `notARepository` factory (lands together with Step 0.3)

`getRepoRoot` (Step 0.3) needs `notARepository` to throw. Step 0.6 lands JUST `notARepository` (in the new `src/domain/repository/error.ts` with a single-variant `RepositoryError` union — `NOT_A_REPOSITORY` only) at the same time as Step 0.3. The full `RepositoryError` family (`BARE_REPOSITORY`, `ALREADY_INITIALIZED`) and the rest of the variants land in Step 1 (same combined PR).

```typescript
// src/domain/repository/error.ts (Step 0)
import { TsgitError } from '../error.js';
import type { FilePath } from '../objects/object-id.js';

export type RepositoryError = { readonly code: 'NOT_A_REPOSITORY'; readonly path: FilePath };

export const notARepository = (path: FilePath): TsgitError =>
  new TsgitError({ code: 'NOT_A_REPOSITORY', path });
```

Add `'NOT_A_REPOSITORY'` to `TsgitErrorData` and one `extractDetail` arm. Other arms join in Step 1.

### 0.7 Primitives barrel update

**Modify:** `src/application/primitives/index.ts` — add re-exports:

```typescript
export { mergeBase } from './merge-base.js';
export { writeSymbolicRef } from './write-symbolic-ref.js';
export { getRepoRoot } from './path-layout.js';
```

**Verify Step 0+1 combined.** `npm run validate` — all green; primitives bundle ≤ 9 kB (matches amended budget).

**Commit.** `feat(domain): amend Phase 7 + add Phase 9 error scaffold` (combined Step 0 + Step 1).

---

## Step 1: Error scaffold (continues Step 0's PR)

**Design:** §4.2, §4.2.1, §4.11.

**Modify:** `src/domain/repository/error.ts` (created in Step 0; widen now), create `src/domain/commands/error.ts`. Modify `src/domain/error.ts`, `src/domain/index.ts`, `src/domain/protocol/error.ts`.

### 1.1 Widen `src/domain/repository/error.ts` (already created in Step 0)

```typescript
import { TsgitError } from '../error.js';
import type { FilePath } from '../objects/object-id.js';

export type RepositoryError =
  | { readonly code: 'NOT_A_REPOSITORY'; readonly path: FilePath }
  | { readonly code: 'BARE_REPOSITORY'; readonly operation: string }
  | { readonly code: 'ALREADY_INITIALIZED'; readonly path: FilePath };

export const notARepository = (path: FilePath): TsgitError =>
  new TsgitError({ code: 'NOT_A_REPOSITORY', path });

export const bareRepository = (operation: string): TsgitError =>
  new TsgitError({ code: 'BARE_REPOSITORY', operation });

export const alreadyInitialized = (path: FilePath): TsgitError =>
  new TsgitError({ code: 'ALREADY_INITIALIZED', path });
```

### 1.2 `src/domain/commands/error.ts`

`CommandError` lives in **domain** (not application) so the `TsgitErrorData` union stays purely domain-tier and primitives can reference command-tier codes if needed. Application command files import via `'../../../domain/commands/error.js'`.

**27 variants total** = 25 from design §4.2 + 2 plan-added (`MAX_REFSPECS_EXCEEDED` + `REMOTE_NOT_CONFIGURED`, resolving Round-1 H3 TODOs in Steps 16/17). The 25 design variants are listed in design §4.2 — copy verbatim (do NOT re-list here to avoid drift). Add at the end:

```typescript
| { readonly code: 'MAX_REFSPECS_EXCEEDED'; readonly count: number; readonly limit: number }
| { readonly code: 'REMOTE_NOT_CONFIGURED'; readonly remote: string };
```

27 factories (one per variant). Tree:

```
src/domain/
├── commands/
│   └── error.ts        # CommandError union + 27 factories
├── repository/
│   └── error.ts        # RepositoryError + 3 factories
```

### 1.3 Extend `domain/error.ts`

- Add `import type { RepositoryError } from './repository/error.js';`
- Add `import type { CommandError } from './commands/error.js';` (PURE DOMAIN — no application import).
- Add `| RepositoryError | CommandError` to `TsgitErrorData`.
- Add `| { readonly code: 'RESOURCE_LOCKED'; readonly resource: 'index' | 'ref'; readonly path: FilePath; readonly mtimeMs?: number }` to `ApplicationError`.
- Add `| { readonly code: 'PACK_TOO_LARGE'; readonly objectCount: number; readonly limit: number }` to `ApplicationError`.
- Add the remaining 32 cases to `extractDetail` (33 total — 1 added in Step 0 for `NOT_A_REPOSITORY`; 32 land here). Breakdown of the 32: 29 from design §4.2.1 (excluding `NOT_A_REPOSITORY`) + 2 plan-added + 1 (`OPERATION_IN_PROGRESS` from §4.11). Plan-added templates:
  - `MAX_REFSPECS_EXCEEDED` → `${count} refspecs exceeds limit ${limit}`
  - `REMOTE_NOT_CONFIGURED` → `remote not configured: ${sanitize(remote)}`

### 1.4 Extend `domain/protocol/error.ts`

Add `REFSPEC_INVALID` variant + factory. Update `extractDetail` arm.

### 1.5 Extend `domain/commands/error.ts` exports

`src/domain/commands/index.ts` re-exports the error module + factories.

### 1.6 Tests

`test/unit/domain/repository/error.test.ts`:

- 3 factory-data tests (mirrors Phase 8 §1.4 pattern).
- 3 extractDetail message-format tests with EXACT `toBe(...)` per §4.2.1.

`test/unit/domain/commands/error.test.ts`:

- 27 factory-data tests (one per variant).
- 27 extractDetail message-format tests.

`test/unit/domain/error.test.ts` (extend existing):

- 2 factory-data tests for `RESOURCE_LOCKED` and `PACK_TOO_LARGE`.
- 2 extractDetail tests for the same.

`test/unit/domain/protocol/error.test.ts` (extend existing):

- 1 factory + 1 extractDetail test for `REFSPEC_INVALID`.

### 1.7 Shared exhaustiveness helper

**Create:** `test/unit/domain/exhaustiveness.ts` — exports a single `assertExhaustiveSwitch(data: TsgitErrorData)` function that does the `case 'X': case 'Y': ... default: { const _: never = data; }` for ALL variants in one place. The 6 existing tests (`test/unit/domain/{diff,git-index,merge,objects,refs,storage}/error.test.ts`) are refactored to call this helper instead of inlining the switch — single update point for future widening.

**Tests for the helper itself:**

```
Given a known variant from each family (DomainObjectError, StorageError, RefsError, IndexError, AdapterError, DiffError, MergeError, ApplicationError, ProtocolError, RepositoryError, CommandError), When assertExhaustiveSwitch is called, Then it returns void without throwing.
Given a hand-crafted bogus code, When called, Then it throws (the never check fires).
```

**Substep commit.** `test(domain): consolidate error exhaustiveness check into shared helper`.

### 1.8 New domain barrels + top-level re-export

**Create:**
- `src/domain/repository/index.ts` re-exporting `RepositoryError` + factories.
- `src/domain/commands/index.ts` re-exporting `CommandError` + factories.

**Modify:** `src/domain/index.ts` — add `export * from './repository/index.js';` and `export * from './commands/index.js';` (alongside the existing re-exports of `objects`, `protocol`, `refs`, `storage`).

**Verify.** `npm run check:types && npm run test:unit -- test/unit/domain/`.

**Substep commit.** `feat(domain): add repository + commands sub-barrels`.

---

## Step 2: Domain modules

**Design:** §5.2.1 (`domain/ignore/`).

### 2.1 `domain/ignore/parse-gitignore.ts`

```typescript
export interface IgnoreRule {
  readonly pattern: string;
  readonly negated: boolean;
  readonly directoryOnly: boolean;
  readonly anchored: boolean;
  readonly compiled: RegExp;
}

export type IgnoreRuleset = ReadonlyArray<IgnoreRule>;

export const parseGitignore = (text: string): IgnoreRuleset => {
  // Split on \n, trim trailing space (unless escaped), skip blank + #-prefixed lines.
  // Compile each pattern: convert `*`, `**`, `?` to regex tokens; honor `!` for negation;
  // honor trailing `/` for directory-only; honor `/` anywhere for anchoring.
};
```

**Red tests** (in `test/unit/domain/ignore/parse-gitignore.test.ts`):

```
Given empty input, When parsed, Then yields 0 rules.
Given "# comment\n", When parsed, Then yields 0 rules.
Given "build/", When parsed, Then yields 1 rule with directoryOnly=true.
Given "*.log", When parsed, Then yields 1 rule whose compiled regex matches 'foo.log' but not 'foo/log'.
Given "!**/*.keep", When parsed, Then yields 1 rule with negated=true.
Given "/dist", When parsed, Then yields 1 rule with anchored=true.
Given "trailing space   \n", When parsed, Then trailing space is stripped (rule pattern equals 'trailing space').
Given "\\#literal", When parsed, Then yields 1 rule with pattern '#literal' (escape preserves '#').
Given a 1000-line .gitignore, When parsed, Then completes in <50ms (perf sanity, not asserted in unit but documented).
```

### 2.2 `domain/ignore/match.ts`

```typescript
export type MatchResult = 'ignored' | 'unignored' | 'unset';

export const matches = (
  rules: IgnoreRuleset,
  path: FilePath,
  isDir: boolean,
): MatchResult => {
  let result: MatchResult = 'unset';
  for (const rule of rules) {
    if (rule.directoryOnly && !isDir) continue;
    if (rule.compiled.test(path)) {
      result = rule.negated ? 'unignored' : 'ignored';
    }
  }
  return result;
};
```

**Red tests:**

```
Given ruleset=[*.log], When matches('foo.log', false), Then 'ignored'.
Given ruleset=[*.log, !important.log], When matches('important.log', false), Then 'unignored' (last-match wins).
Given ruleset=[build/], When matches('build', true), Then 'ignored'.
Given ruleset=[build/], When matches('build', false), Then 'unset' (directory-only doesn't match files).
Given ruleset=[], When matches(any), Then 'unset'.
Given ruleset=[/dist], When matches('dist', true), Then 'ignored'.
Given ruleset=[/dist], When matches('src/dist', true), Then 'unset' (anchored doesn't match nested).
Given ruleset=[**/node_modules], When matches('a/b/node_modules', true), Then 'ignored'.
```

### 2.3 Barrel + index

`src/domain/ignore/index.ts` exports both. `src/domain/index.ts` re-exports.

**Verify.** `npm run test:unit -- test/unit/domain/ignore/ && npm run check:architecture`.

**Commit.** `feat(domain): add gitignore parser and matcher`.

---

## Step 3: `FileSystem` port additions

**Design:** §10.1 port table.

### 3.1 Modify `src/ports/file-system.ts`

Add to the `FileSystem` interface:

```typescript
/**
 * Recursively remove a file or directory tree.
 * Idempotent: a missing path returns void with no error.
 * Does NOT follow ANY symlink during traversal — when a directory entry's
 * lstat shows it is a symlink, removes the symlink itself (not its target)
 * and stops descent at that point.
 */
readonly rmRecursive: (path: string) => Promise<void>;

/**
 * Open a file with O_NOFOLLOW on POSIX (Node node:fs).
 * On platforms without the flag (browser OPFS), throws UNSUPPORTED_OPERATION
 * so callers can fall back to a realpath check.
 */
readonly openWithNoFollow: (
  path: string,
  mode: 'read' | 'write',
) => Promise<FileHandle>;
```

Add a new `FileHandle` interface (small subset matching Node's):

```typescript
export interface FileHandle {
  readonly read: (buffer: Uint8Array, offset: number, length: number, position?: number) => Promise<number>;
  readonly write: (buffer: Uint8Array) => Promise<void>;
  readonly stat: () => Promise<FileStat>;
  readonly close: () => Promise<void>;
}
```

### 3.2 Adapter implementations

**Node** (`src/adapters/node/file-system.ts`):

- `rmRecursive`: implement with a manual `lstat` + `readdir` walk (NOT `fs.rm({recursive:true, force:true})` — that follows symlinks per the Node spec; we need explicit lstat checks).
- `openWithNoFollow`: `fs.open(path, fs.constants.O_NOFOLLOW | (mode === 'write' ? O_WRONLY : O_RDONLY))`.

**Memory** (`src/adapters/memory/file-system.ts`):

- `rmRecursive`: walk the in-memory tree, removing nodes; symlinks are entries with a `linkTarget` field — never followed.
- `openWithNoFollow`: returns a memory `FileHandle`; if the target is a symlink entry, throws `ELOOP`-equivalent (`PERMISSION_DENIED`).

**Browser** (`src/adapters/browser/file-system.ts`):

- `rmRecursive`: walk via OPFS `removeEntry({recursive:true})` if available, else manual; OPFS doesn't support symlinks so the no-follow rule is automatic.
- `openWithNoFollow`: throws `UNSUPPORTED_OPERATION` with `{ operation: 'openWithNoFollow', reason: 'browser FS does not support O_NOFOLLOW' }`.

### 3.3 Tests

`test/unit/ports/file-system.contract.ts` — extend the contract suite with new methods. Run against all 3 adapters.

```
rmRecursive:
  Given an empty directory at /a, When rmRecursive('/a'), Then it is removed.
  Given a missing path, When rmRecursive('/missing'), Then it returns void (no error — idempotent).
  Given /a/b/c/d.txt, When rmRecursive('/a'), Then everything under /a is removed.
  Given /a/symlink → /b (where /b is outside the tree), When rmRecursive('/a'), Then /a/symlink is removed but /b is untouched.
  Given /a/sub/symlink → /external, When rmRecursive('/a'), Then /a/sub/symlink is removed; /external is untouched (NO traversal through symlinks).

openWithNoFollow:
  Given a regular file /a/file, When openWithNoFollow('/a/file', 'read'), Then returns a FileHandle.
  Given a symlink /a/link, When openWithNoFollow('/a/link', 'read'), Then throws (POSIX ELOOP / memory PERMISSION_DENIED).
  Given the browser adapter on any path, When openWithNoFollow, Then throws UNSUPPORTED_OPERATION.
  Given an opened FileHandle, When read() / write() / stat() / close() are called, Then they behave per the contract.
```

**Verify.** `npm run test:unit -- test/unit/ports/`.

**Commit.** `feat(ports): add FileSystem.rmRecursive + openWithNoFollow`.

---

## Step 4: Shared `commands/internal/*` modules

11 substeps (10 helpers + 1 fixtures file). Each in its own substep + commit.

### Substep dependency table

| Substep | Helper | Depends on (other 4.x) |
|---|---|---|
| 4.1 | `repo-state` | (4.10 for `core.bare` lookup) |
| 4.2 | `working-tree` | none |
| 4.3 | `index-update` | none |
| 4.4 | `bootstrap` | (3 — port additions) |
| 4.5 | `url-validate` | none |
| 4.6 | `ref-spec` | none |
| 4.7 | `network-pipeline` | 4.5 (for redirect re-validation) |
| 4.8 | `commit-message` | none |
| 4.9 | `rev-parse-grammar` | 4.10 (reads `.git/index` for `:N:path` form) |
| 4.10 | `config-read` | none |
| 4.11 | `fixtures.ts` (test) | 4.1, 4.4, 4.5, 4.7 |

**Implementation order (linear):** 4.10 → 4.1 → 4.5 → 4.7 → 4.2 → 4.3 → 4.4 → 4.6 → 4.8 → 4.9 → 4.11. Other orderings work as long as each helper lands after its deps.

### 4.1 `internal/repo-state.ts`

**Design:** §4.3, §4.4, §4.11.

```typescript
export const assertRepository = (ctx: Context): Promise<FilePath>;
export const assertNotBare = (ctx: Context, operation: string): Promise<void>;
export const isBare = (ctx: Context): Promise<boolean>;
export const readHeadRaw = (ctx: Context): Promise<HeadState>;
export const assertNoPendingOperation = (ctx: Context): Promise<void>;
```

**Red tests:**

```
assertRepository:
  Given a repo at ctx.cwd, When called, Then returns the repo root.
  Given no repo, When called, Then throws NOT_A_REPOSITORY.

assertNotBare:
  Given a non-bare repo, When assertNotBare(ctx, 'add'), Then resolves.
  Given a bare repo (core.bare=true in config), When called, Then throws BARE_REPOSITORY with .data.operation === 'add'.

isBare:
  Given core.bare=true, Then true.
  Given core.bare=false, Then false.
  Given missing .git/config, Then false (default).
  Given missing [core] section, Then false (default).
  Given two consecutive calls, Then second hits cache (spy on fs.readFile).

readHeadRaw:
  Given HEAD = 'ref: refs/heads/main\n', Then returns { kind: 'symbolic', target: 'refs/heads/main' }.
  Given HEAD = '<40 hex>\n', Then returns { kind: 'direct', id: <oid> }.
  Given HEAD missing, Then throws REF_NOT_FOUND.

assertNoPendingOperation:
  Given no marker files, Then resolves.
  Given .git/MERGE_HEAD exists, Then throws OPERATION_IN_PROGRESS with .data.operation === 'merge'.
  Given .git/CHERRY_PICK_HEAD exists, Then throws with operation 'cherry-pick'.
  Given .git/REVERT_HEAD exists, Then throws with operation 'revert'.
  Given .git/REBASE_HEAD exists, Then throws with operation 'rebase'.
```

**Commit.** `feat(commands): add internal/repo-state`.

### 4.2 `internal/working-tree.ts`

**Design:** §4.6.

```typescript
export const validatePath = (input: string): FilePath;  // throws PATHSPEC_OUTSIDE_REPO
export const materializeFile = (ctx: Context, path: FilePath, blob: Blob, mode: FileMode): Promise<void>;
export const removeFile = (ctx: Context, path: FilePath): Promise<void>;
export const readFile = (ctx: Context, path: FilePath): Promise<Uint8Array>;
```

**Red tests** (one isolated test per validation rule):

```
validatePath:
  Given 'src/foo.ts', When validatePath, Then returns 'src/foo.ts' as FilePath.
  Given '/abs/path', Then throws PATHSPEC_OUTSIDE_REPO.
  Given '../escape', Then throws PATHSPEC_OUTSIDE_REPO.
  Given 'a/../b', Then throws PATHSPEC_OUTSIDE_REPO.
  Given 'a\0b', Then throws PATHSPEC_OUTSIDE_REPO.
  Given 'foo/.git/config' (lowercase .git), Then throws.
  Given 'foo/.GIT/config' (uppercase .GIT — Windows/macOS), Then throws (when running on those FS).
  Given 'foo/.git ' (trailing space — NTFS), Then throws (when running on NTFS).
  Given 'foo/.git.' (trailing dot — NTFS), Then throws.
  Given a 4097-byte path, Then throws.
  Given a 256-byte component, Then throws.
  Given control character in component, Then throws.

materializeFile:
  Given mode 100644 + content "abc", When materializeFile, Then file written with chmod 0644 + content.
  Given mode 100755, Then chmod 0755.
  Given mode 120000 on POSIX, Then a symlink is created with target = blob content.
  Given mode 120000 on Windows / OPFS, Then a regular file is written with content = link target string (NO trailing newline, NO BOM).
  Given mode 160000, Then throws UNSUPPORTED_OPERATION.
  Given a path containing '.git', Then throws PATHSPEC_OUTSIDE_REPO before any I/O.
  Given a write that races with a concurrent symlink replacement of the parent dir, When O_NOFOLLOW is supported, Then throws (O_NOFOLLOW catches it).

removeFile:
  Given a file we wrote, Then removes it.
  Given a directory at the path (changed since we wrote), Then throws CHECKOUT_OVERWRITE_DIRTY.
  Given a symlink that doesn't match, Then throws CHECKOUT_OVERWRITE_DIRTY.
```

**Commit.** `feat(commands): add internal/working-tree with O_NOFOLLOW + .git reject`.

### 4.3 `internal/index-update.ts`

**Design:** §4.5.

```typescript
export const acquireIndexLock = (ctx: Context, opts?: { breakStaleLockMs?: number }): Promise<IndexLock>;
export interface IndexLock {
  readonly release: () => Promise<void>;
  readonly commit: (entries: ReadonlyArray<IndexEntry>) => Promise<void>;
}
```

**Atomicity / rollback contract.** The lock holds for the entire read-modify-write cycle. A successful `commit(entries)` writes the new index to a temp file, fsyncs, and renames into place under the lock. `release()` without a prior `commit()` simply removes the lock file — the index on disk is unchanged. Callers with multi-path operations (e.g., `add(['a','b','c'])`) compute all entry mutations in memory FIRST, then call `commit(allEntries)` once: any per-path failure throws BEFORE `commit` is reached, so `release()` in the `finally` block leaves the index untouched. This is the rollback mechanism — there is no partial-success state.

**Red tests:**

```
Given no existing lock, When acquireIndexLock, Then returns a lock.
Given an existing lock file, When acquireIndexLock without breakStaleLockMs, Then throws RESOURCE_LOCKED.
Given an existing lock with mtime older than breakStaleLockMs, When acquireIndexLock, Then breaks the stale lock + retries + succeeds.
Given an existing lock with mtime in the future (NTP backward step), When acquireIndexLock with breakStaleLockMs, Then does NOT break the lock (treated as unknown age) — throws RESOURCE_LOCKED.
Given a lock + commit + release sequence, When commit is called, Then index is atomically updated (temp + fsync + rename); when release is called after commit, Then no-op.
Given a lock + release without commit, Then the lock file is removed; index unchanged.
Given two concurrent acquireIndexLock calls, Then exactly one wins.
```

**Commit.** `feat(commands): add internal/index-update`.

### 4.4 `internal/bootstrap.ts`

**Design:** §10.1 `bootstrapRepository`.

```typescript
export interface BootstrapOptions {
  readonly initialBranch: string;
  readonly bare: boolean;
  readonly hash?: 'sha1';
}

export interface BootstrapResult {
  readonly gitDir: FilePath;
  readonly initialBranch: RefName;
  readonly bare: boolean;
}

export const bootstrapRepository = (
  ctx: Context,
  opts: BootstrapOptions,
): Promise<BootstrapResult>;
```

**Red tests:**

```
Given a fresh empty directory + opts={initialBranch:'main', bare:false}, When bootstrapRepository, Then creates .git/{HEAD,config,objects/info,objects/pack,refs/heads,refs/tags,info/exclude,description} with the documented content.
Given bare=true, Then the repo is created at ctx.cwd directly (no .git subdirectory) with bare=true in config.
Given an invalid initialBranch (with space), Then throws INVALID_REF before any I/O.
Given a partial-creation failure (mkdir of refs/heads fails), Then rmRecursive cleans up; throws.
Given the resulting BootstrapResult, Then matches the documented shape exactly.
```

**Commit.** `feat(commands): add internal/bootstrap`.

### 4.5 `internal/url-validate.ts`

**Design:** §4.8.

```typescript
export interface ValidatedUrl {
  readonly url: string;
  readonly pinnedAddress: string;
}

export const validateUrl = (
  ctx: Context,
  raw: string,
): Promise<ValidatedUrl>;
```

**Red tests** — extensive (security boundary):

```
Scheme allowlist:
  Given 'https://example.com/x', When validateUrl, Then returns ValidatedUrl.
  Given 'http://example.com/x' with allowInsecure=false, Then throws UNSUPPORTED_SCHEME.
  Given 'http://example.com/x' with allowInsecure=true, Then returns ValidatedUrl.
  Given 'ftp://...', 'file://...', 'data:...', 'javascript:...', Then each throws UNSUPPORTED_SCHEME.

URL parse:
  Given 'not-a-url', Then throws INVALID_URL.
  Given 'https://example.com#frag', Then throws INVALID_URL with reason mentioning fragment.

IP block ranges (resolve via ctx.dnsResolver):
  Given DNS resolves to 127.0.0.1, Then throws BLOCKED_HOST.
  Given DNS resolves to 10.0.0.5, Then throws BLOCKED_HOST.
  Given DNS resolves to 172.16.0.1, Then throws BLOCKED_HOST.
  Given DNS resolves to 192.168.1.1, Then throws BLOCKED_HOST.
  Given DNS resolves to 169.254.169.254 (AWS metadata), Then throws BLOCKED_HOST.
  Given DNS resolves to 100.64.0.1 (CGNAT), Then throws BLOCKED_HOST.
  Given DNS resolves to 0.0.0.0, Then throws BLOCKED_HOST.
  Given DNS resolves to 224.0.0.1 (multicast), Then throws BLOCKED_HOST.

IPv6:
  Given DNS resolves to ::1, Then throws BLOCKED_HOST.
  Given DNS resolves to fc00::1 (ULA), Then throws BLOCKED_HOST.
  Given DNS resolves to fe80::1 (link-local), Then throws BLOCKED_HOST.
  Given DNS resolves to ff00::1 (multicast), Then throws BLOCKED_HOST.
  Given DNS resolves to ::ffff:127.0.0.1 (IPv4-mapped loopback), Then throws BLOCKED_HOST.
  Given DNS resolves to ::ffff:169.254.169.254 (IPv4-mapped metadata), Then throws BLOCKED_HOST.

Allow override:
  Given allowPrivateNetworks=true, When DNS resolves to 192.168.1.1, Then returns ValidatedUrl.

DNS pinning:
  Given DNS resolves to a public IP, Then ValidatedUrl.pinnedAddress equals that IP.

Public passthrough:
  Given DNS resolves to 8.8.8.8, Then returns ValidatedUrl with pinnedAddress='8.8.8.8'.

Sanitization:
  Given a host containing CRLF, Then throws INVALID_URL with sanitized reason (no raw CRLF in error message).
```

**Commit.** `feat(commands): add internal/url-validate with SSRF guards`.

### 4.6 `internal/ref-spec.ts`

**Design:** §5.11 refspec parsing.

```typescript
export const MAX_REFSPECS_PER_FETCH = 1024;
export const MAX_REFSPECS_PER_PUSH = 1024;

export interface ParsedRefspec {
  readonly force: boolean;
  readonly src: string;
  readonly dst: string;
  readonly hasWildcard: boolean;
}

export const parseRefspec = (raw: string): ParsedRefspec;
export const applyRefspec = (spec: ParsedRefspec, ref: RefName): RefName | undefined;
```

**Red tests:**

```
Given 'refs/heads/main:refs/remotes/origin/main', When parseRefspec, Then { force:false, src:'refs/heads/main', dst:'refs/remotes/origin/main', hasWildcard:false }.
Given '+refs/heads/main:refs/remotes/origin/main', Then force:true.
Given 'refs/heads/*:refs/remotes/origin/*', Then hasWildcard:true.
Given 'refs/heads/*:refs/heads/*', Then valid.
Given a refspec with src='refs/heads/*' and dst='refs/remotes/origin/main' (wildcard mismatch), Then throws REFSPEC_INVALID.
Given a refspec with no colon ('refs/heads/main'), Then throws REFSPEC_INVALID.
Given a refspec with NUL byte, Then throws REFSPEC_INVALID.
Given more than MAX_REFSPECS_PER_PUSH refspecs to a single API, Then throws MAX_REFSPECS_EXCEEDED with .data.count and .data.limit.

applyRefspec:
  Given spec='refs/heads/*:refs/remotes/origin/*' and ref='refs/heads/main', Then returns 'refs/remotes/origin/main'.
  Given spec='refs/heads/*:refs/remotes/origin/*' and ref='refs/tags/v1', Then returns undefined (no match).
```

**Commit.** `feat(commands): add internal/ref-spec`.

### 4.7 `internal/network-pipeline.ts`

**Design:** §4.7, §4.8.

```typescript
export interface NetworkOpts {
  readonly auth?: AuthConfig;
  readonly retry?: RetryConfig;
}

export const withDefaults = (ctx: Context, opts?: NetworkOpts): HttpTransport;
export const wrapLoggerSanitizer = (logger: Logger): Logger;
```

**Red tests:**

```
Given ctx with logger, When withDefaults is called (no request made yet), Then Object.isFrozen(ctx.config) returns true (freeze happens upon return, not lazily).
Given ctx with no logger, When sent, Then no logging events.
Given a request with an attacker-controlled response header containing CRLF, When logged, Then the logged event has \xNN escapes for those bytes.
Given a 4xx redirect to a different host, When followed, Then Authorization, Cookie, Proxy-Authorization headers are dropped.
Given a 4xx redirect to the same host, Then headers are preserved.
Given a redirect to a host that fails url-validate (private IP), Then throws BLOCKED_HOST.
Given a chain of 5 redirects, Then succeeds.
Given a chain of 6 redirects, Then throws TOO_MANY_REDIRECTS.
Given a response body exceeding ctx.config.maxResponseBytes, Then throws PACK_TOO_LARGE (or generic if not pack).
Given a withRetry attempt logging via the wrapped logger, When the response contains attacker bytes, Then those reach the wrapped logger sanitized.
```

**Commit.** `feat(commands): add internal/network-pipeline with sanitized logging`.

### 4.8 `internal/commit-message.ts`

**Design:** §5.3, §5.13.

```typescript
export const resolveAuthor = (ctx: Context, explicit?: AuthorIdentity): AuthorIdentity;  // throws AUTHOR_UNCONFIGURED
export const resolveCommitter = (ctx: Context, explicit?: AuthorIdentity, author?: AuthorIdentity): AuthorIdentity;
export const sanitizeMessage = (raw: string, opts: { allowEmpty: boolean }): string;  // throws EMPTY_COMMIT_MESSAGE
export const sanitizeMarkerLabel = (raw: string): string;  // for merge conflict markers
```

**Red tests:**

```
resolveAuthor:
  Given explicit author, Then returns it.
  Given no explicit + ctx.config.user set, Then returns the config user.
  Given neither, Then throws AUTHOR_UNCONFIGURED.

resolveCommitter:
  Given explicit committer, Then returns it.
  Given no explicit + author given, Then returns author.
  Given no explicit + no author + ctx.config.user, Then returns config user.

sanitizeMessage:
  Given '   leading + trailing whitespace   \n\n', When sanitizeMessage(_, {allowEmpty:false}), Then returns 'leading + trailing whitespace' (trimmed).
  Given '', When sanitizeMessage(_, {allowEmpty:false}), Then throws EMPTY_COMMIT_MESSAGE.
  Given '', When sanitizeMessage(_, {allowEmpty:true}), Then returns ''.

sanitizeMarkerLabel:
  Given 'main', Then returns 'main'.
  Given 'main\nfoo', Then returns 'main\\x0Afoo' (CR + LF + control chars escaped).
  Given a 250-character label, Then truncated to 200 bytes.
  Given a label with NUL, Then NUL escaped.
```

**Commit.** `feat(commands): add internal/commit-message`.

### 4.9 `internal/rev-parse-grammar.ts`

**Design:** §5.16.

```typescript
export const parse = (ctx: Context, expression: string): Promise<ObjectId>;
```

**Red tests:**

```
Given 'HEAD', When parse, Then returns HEAD's resolved oid.
Given 'main', Then returns 'refs/heads/main' resolved.
Given 'refs/heads/main', Then resolves directly.
Given 'origin/main', Then resolves to 'refs/remotes/origin/main'.
Given 'abc1234' with at least 7 hex and exactly one matching object, Then resolves to that oid.
Given 'abc1' with multiple matching objects, Then throws REVPARSE_AMBIGUOUS with .data.candidates listing all matches.
Given 'abc' (less than 7 hex), Then throws REVPARSE_UNRESOLVED.
Given 'HEAD~3', Then walks up 3 first-parents.
Given 'HEAD^', Then equivalent to HEAD~1.
Given 'HEAD^2', Then second parent of HEAD (merge commit's other parent).
Given 'HEAD^^^', Then equivalent to HEAD~3.
Given 'HEAD^{tree}', Then peels HEAD's commit object to its tree.
Given 'HEAD^{commit}', Then no-op (HEAD is already a commit).
Given 'tag-name^{commit}', Then peels through tag → commit.
Given ':0:src/foo.ts' (stage 0 = staged), Then returns the blob oid for that path in the index.
Given ':1:'/':2:'/':3:' for an unmerged file, Then returns the respective stage's oid.
Given ':0:nonexistent', Then throws OBJECT_NOT_FOUND.
Given a missing parent during traversal (HEAD~3 with only 2 parents), Then throws OBJECT_NOT_FOUND (NOT REVPARSE_UNRESOLVED).
Given malformed expression like 'HEAD~~' (no number after ~), Then throws REVPARSE_UNRESOLVED.
Given 'HEAD@{1}' (reflog navigation), Then throws REVPARSE_UNRESOLVED (v1 doesn't support reflog).
Given an empty expression, Then throws REVPARSE_UNRESOLVED.
```

**Commit.** `feat(commands): add internal/rev-parse-grammar`.

### 4.10 `internal/config-read.ts`

**Design:** §4.4 + §5.7 (`branch.<name>.merge`).

```typescript
export interface ParsedConfig {
  readonly core?: { readonly bare?: boolean };
  readonly user?: AuthorIdentity;
  readonly remote?: ReadonlyMap<string, { readonly url?: string; readonly fetch?: ReadonlyArray<string> }>;
  readonly branch?: ReadonlyMap<string, { readonly remote?: string; readonly merge?: RefName }>;
}

export const readConfig = (ctx: Context): Promise<ParsedConfig>;
```

**Red tests:**

```
Given missing .git/config, Then returns {} (empty parsed config).
Given a config with [core] bare=true, Then parsed.core.bare === true.
Given a config with [core] bare=invalid, Then defaults to false (unparseable boolean).
Given a config with [user] name and email, Then parsed.user is the AuthorIdentity.
Given a config with [remote "origin"] url=..., Then parsed.remote.get('origin')?.url is set.
Given a config with quoted section names, Then handled.
Given a config with comments (# and ;), Then comments are skipped.
Given a config with continuation lines (key = a \n b), Then concatenated.
Given a malformed line, Then ignored (lenient parser — git does the same).
Given two consecutive calls, Then second hits cache.
```

**Commit.** `feat(commands): add internal/config-read`.

### 4.11 `test/unit/application/commands/fixtures.ts`

**Design:** §7.2.

Shared fixture builders used by every command test from Step 5 onward. NOT shipped — test-only.

```typescript
export interface RepoSeed {
  readonly commits?: ReadonlyArray<{ readonly id: string; readonly tree: string; readonly parents?: ReadonlyArray<string>; readonly message?: string }>;
  readonly refs?: Readonly<Record<string, string>>;          // refName → oid
  readonly head?: string;                                     // ref name or oid
  readonly workingTree?: Readonly<Record<string, string>>;   // path → content
  readonly indexEntries?: ReadonlyArray<{ path: string; oid: string; mode: number }>;
  readonly bare?: boolean;
}

export const seedRepo = (ctx: Context, seed: RepoSeed): Promise<void>;

export const memoryRemote = (
  advertisement: { readonly refs: ReadonlyArray<{ name: string; id: string }>; readonly head?: string },
  packBody: Uint8Array,
): HttpTransport;

export const recordedTransport = (): {
  readonly transport: HttpTransport;
  readonly requests: ReadonlyArray<HttpRequest>;
};
```

**Red tests:**

```
seedRepo:
  Given seed with one commit + working tree, When seedRepo(ctx, seed), Then ctx.fs has the .git layout matching the seed; readObject(commit.id) returns the commit; readIndex matches index entries.
  Given seed with bare:true, Then no working tree path; .git layout at ctx.cwd directly.

memoryRemote (uses domain/protocol/pkt-line.encodePktStream for framing — Phase 8 export, no new helper):
  Given advertisement + packBody, When transport.request({url:'.../info/refs?service=git-upload-pack'}), Then returns the discovery body framed in pkt-line.
  When transport.request({url:'.../git-upload-pack', method:'POST'}), Then returns NAK + sideband-1 packed packBody.

recordedTransport:
  Given a wrapped transport, When two requests are made, Then requests array has 2 entries in order with full method/url/headers/body.
```

**Substep commit.** `test(commands): add shared fixture builders`.

---

## Step 5: `init`

**Design:** §5.1.

**Create:** `src/application/commands/init.ts`, `test/unit/application/commands/init.test.ts`.

### 5.1 Implementation sketch

`InitOptions` and `InitResult` come from design §5.1; declare them at the top of `init.ts` (no separate `types.ts` for command-local types).

```typescript
export const init = async (ctx: Context, opts?: InitOptions): Promise<InitResult> => {
  const initialBranch = opts?.initialBranch ?? 'main';
  const bare = opts?.bare ?? false;
  const root = await ctx.fs.realpath(ctx.cwd);
  const gitDir = bare ? root : `${root}/.git`;
  if (await ctx.fs.exists(gitDir)) {
    throw alreadyInitialized(gitDir as FilePath);
  }
  const result = await bootstrapRepository(ctx, { initialBranch, bare });
  return {
    path: result.gitDir,
    initialBranch: result.initialBranch,
    bare: result.bare,
  };
};
```

### 5.2 Tests

```
Given a fresh directory, When init(), Then creates .git, returns InitResult{path, initialBranch:'main', bare:false}.
Given a fresh directory + opts.initialBranch='trunk', Then HEAD is symref to refs/heads/trunk; result.initialBranch === 'trunk'.
Given a fresh directory + opts.bare=true, Then no .git subdir; root acts as gitDir; result.bare === true.
Given an existing .git, Then throws ALREADY_INITIALIZED with .data.path === resolved gitDir.
Given an invalid initialBranch ('with space'), Then throws INVALID_REF before any I/O.
Given ctx.cwd missing, Then throws FILE_NOT_FOUND.
Given two concurrent init() calls on the same dir, Then exactly one wins; the other sees ALREADY_INITIALIZED.
```

**Verify.** `npm run test:unit -- test/unit/application/commands/init.test.ts && npm run check:architecture`.

**Commit.** `feat(commands): add init`.

---

## Step 6: `revParse`

**Design:** §5.16.

**Create:** `src/application/commands/rev-parse.ts`, `test/unit/application/commands/rev-parse.test.ts`.

### 6.1 Implementation

Thin wrapper over `internal/rev-parse-grammar.parse`. Calls `assertRepository` first.

```typescript
export const revParse = async (ctx: Context, expression: string): Promise<ObjectId> => {
  await assertRepository(ctx);
  return parse(ctx, expression);
};
```

### 6.2 Tests

The bulk of the grammar tests live in `internal/rev-parse-grammar.test.ts` (Step 4.9 — 18 tests covering every grammar form). Step 6 only covers the public-API smoke layer (3 tests). The grammar coverage at Step 4.9 is what mutation testing scores against.

```
Given a non-repo ctx, When revParse('HEAD'), Then throws NOT_A_REPOSITORY.
Given a repo with HEAD pointing at a commit, When revParse('HEAD'), Then returns the commit oid.
Given a smoke test for each grammar form (HEAD, name, sha, ~N, ^, ^N, ^{tree}, :0:path), When called via the public API, Then returns the expected oid (integration smoke).
```

**Commit.** `feat(commands): add revParse`.

---

## Step 7: `add` and `rm`

**Design:** §5.2, §5.14.

### 7.1 `add`

**Create:** `src/application/commands/add.ts`, `test/unit/application/commands/add.test.ts`.

**Red tests:**

```
Empty input:
  Given paths=[], When add, Then throws EMPTY_PATHSPEC.

Single literal path:
  Given working tree {src/foo.ts: "x"}, When add(['src/foo.ts']), Then index has src/foo.ts with the new blob oid; result.added === ['src/foo.ts'].

Modified file:
  Given index has src/foo.ts and the working file changed, When add(['src/foo.ts']), Then result.modified === ['src/foo.ts']; index updated.

Removed file (with all=true):
  Given index has src/gone.ts and the file is missing, When add(['.'], {all:true}), Then result.removed includes src/gone.ts.

Mode change:
  Given index has src/foo.ts at 100644 and the working file is now executable, When add(['src/foo.ts']), Then the entry mode changes to 100755 (oid stays).

Symlink:
  Given working tree has a symlink src/link → src/foo.ts, When add(['src/link']), Then index has 120000 mode; blob content equals 'src/foo.ts'.

Glob:
  Given working tree {a.ts, b.ts, c.md}, When add(['*.ts']), Then index has a.ts and b.ts.

Glob expansion validation:
  Given a glob that expands to a symlink escaping the repo, When add(['*']), Then throws PATHSPEC_OUTSIDE_REPO for that path.

Pathspec no-match:
  Given a glob matching nothing, When add(['*.zzz']), Then throws PATHSPEC_NO_MATCH.

Outside-repo path:
  Given paths=['../escape'], When add, Then throws PATHSPEC_OUTSIDE_REPO before any I/O.

Bare repo:
  Given a bare repo, When add(['x']), Then throws BARE_REPOSITORY.

Concurrent index lock:
  Given .git/index.lock exists, When add, Then throws RESOURCE_LOCKED.

.gitignore:
  Given .gitignore = '*.log' and add(['debug.log']) without force, Then result.added is empty (silently skipped); add returns the actual non-empty result.
  Given the same with force=true, Then debug.log IS added.

OPERATION_IN_PROGRESS:
  Given .git/MERGE_HEAD exists, When add, Then throws OPERATION_IN_PROGRESS with .data.operation === 'merge'.

Atomicity:
  Given add(['a','b','nonexistent']), When the third path fails, Then index is NOT updated for any of the three (rollback).

Submodule:
  Given a path that maps to mode 160000, When add, Then throws UNSUPPORTED_OPERATION.
```

**Commit.** `feat(commands): add add`.

### 7.2 `rm`

**Create:** `src/application/commands/rm.ts`, `test/unit/application/commands/rm.test.ts`.

**Red tests:**

```
Empty input:
  Given paths=[], When rm, Then throws EMPTY_PATHSPEC.

Cached only:
  Given index has src/foo.ts and working file matches, When rm(['src/foo.ts'], {cached:true}), Then index entry removed; working file remains.

Default (cached=false):
  Given the same, When rm(['src/foo.ts']), Then index entry removed AND working file deleted.

No match:
  Given paths=['nonexistent.ts'], When rm, Then throws PATHSPEC_NO_MATCH.

Working tree dirty (when !cached):
  Given index has src/foo.ts but working file modified, When rm(['src/foo.ts']), Then throws WORKING_TREE_DIRTY (no partial removal).

Recursive:
  Given index has src/a.ts and src/b.ts, When rm(['src/'], {recursive:true}), Then both removed.
  Given the same without recursive=true, Then throws PATHSPEC_NO_MATCH (or a "is a directory" error — pin to UNSUPPORTED_OPERATION with a specific reason).

Lock contention:
  Given index.lock exists, Then throws RESOURCE_LOCKED.

Bare repo:
  Given a bare repo, Then throws BARE_REPOSITORY.

OPERATION_IN_PROGRESS guard.
```

**Commit.** `feat(commands): add rm`.

---

## Step 8: `commit`

**Design:** §5.3.

**Create:** `src/application/commands/commit.ts`, `test/unit/application/commands/commit.test.ts`.

**Red tests:**

```
Initial commit:
  Given a fresh repo + index has src/foo.ts, When commit({message:'init', author}), Then commit object created; HEAD's underlying branch refs/heads/main is created with the new oid; result.parents === [].

Subsequent commit:
  Given a repo with HEAD at oid1 + index has changes, When commit({message:'next'}), Then result.parents === [oid1]; HEAD's branch advanced atomically.

Detached HEAD:
  Given HEAD is direct (detached at oid1), When commit({message:'detached'}), Then HEAD is updated to the new oid (NOT a branch); result.parents === [oid1].

Nothing to commit:
  Given index matches HEAD's tree, When commit, Then throws NOTHING_TO_COMMIT.
  Given the same with allowEmpty=true, Then commit succeeds.

Empty message:
  Given empty message, When commit, Then throws EMPTY_COMMIT_MESSAGE.
  Given the same with allowEmptyMessage=true, Then commit succeeds.

Author resolution:
  Given no opts.author + no ctx.config.user, Then throws AUTHOR_UNCONFIGURED.
  Given opts.author, Then commit uses it.
  Given ctx.config.user, Then commit uses it (no opts.author).

Unmerged index:
  Given index has unmerged entries, When commit, Then throws MERGE_HAS_CONFLICTS.

OPERATION_IN_PROGRESS:
  Given .git/MERGE_HEAD + clean index, When commit, Then succeeds (this IS the resolution path).

Concurrent HEAD update:
  Given HEAD changes between read and write, When commit, Then throws REF_UPDATE_CONFLICT.

Parents override:
  Given opts.parents = [oid1, oid2], When commit, Then result.parents === [oid1, oid2] (octopus).
  Given opts.parents with duplicates, Then throws INVALID_COMMIT.
```

**Commit.** `feat(commands): add commit`.

---

## Step 9: `branch` and `tag`

### 9.1 `branch`

**Design:** §5.7.

**Create:** `src/application/commands/branch.ts`, `test/unit/application/commands/branch.test.ts`.

**Red tests** (organized by action.kind):

```
list:
  Given refs/heads/{main, dev}, When branch({kind:'list'}), Then returns 2 BranchInfo entries; current=true on the one HEAD points at.
  Given remote=true, Then scans refs/remotes/.

create:
  Given startPoint='HEAD' (default), When branch({kind:'create', name:'feature'}), Then refs/heads/feature created at HEAD's oid.
  Given startPoint='abc1234' (sha prefix), Then resolves via revParse-grammar; creates the branch.
  Given an existing branch + force=false, Then throws BRANCH_EXISTS.
  Given an existing branch + force=true, Then overwrites.
  Given invalid name (with space), Then throws INVALID_REF.

delete:
  Given a branch not currently checked out, When branch({kind:'delete', name:'feature'}), Then refs/heads/feature removed.
  Given a branch that IS HEAD's symref target, Then throws CANNOT_DELETE_CHECKED_OUT_BRANCH.
  Given non-existent branch, Then throws BRANCH_NOT_FOUND.

rename:
  Given branches main + feature, HEAD on feature, When branch({kind:'rename', from:'feature', to:'feature-2'}), Then refs/heads/feature-2 has feature's oid; refs/heads/feature removed; HEAD writeSymbolicRef → refs/heads/feature-2.
  Given the same renaming a non-current branch, Then HEAD is NOT touched.
  Given the destination already exists + force=false, Then throws BRANCH_EXISTS.
  Given step 3 (delete old) fails after step 2 succeeded, Then both branches exist; user can recover.
  Given step 4 (HEAD update) fails after delete, Then HEAD points at non-existent branch; subsequent `resolveRef('HEAD')` throws REF_NOT_FOUND with the unborn branch name. Caller can recover via `branch create <to> <oid>` (test asserts this round-trip works).

OPERATION_IN_PROGRESS guard for create/delete/rename.
```

**Commit.** `feat(commands): add branch`.

### 9.2 `tag`

**Design:** §5.8.

**Red tests:**

```
list:
  Given refs/tags/{v1, v2 (annotated)}, When tag({kind:'list'}), Then 2 TagInfo entries; v2.annotated === true with target peeled to commit.

create lightweight:
  Given target='HEAD', When tag({kind:'create', name:'v1'}), Then refs/tags/v1 → HEAD's oid; result.annotated === false.
  Given existing tag + force=false, Then throws TAG_EXISTS.

create annotated:
  Given message + ctx.config.user set, When tag({kind:'create', name:'v1', message:'release'}), Then a tag object is written; refs/tags/v1 → tag oid; result.annotated === true.
  Given message + no user + no opts.tagger, Then throws AUTHOR_UNCONFIGURED.

delete:
  Given a tag, When tag({kind:'delete', name:'v1'}), Then refs/tags/v1 removed.
  Given non-existent, Then throws TAG_NOT_FOUND.

OPERATION_IN_PROGRESS guard.
```

**Commit.** `feat(commands): add tag`.

---

## Step 10: `reset`

**Design:** §5.15.

**Create:** `src/application/commands/reset.ts`, `test/unit/application/commands/reset.test.ts`.

**Red tests:**

```
mode='soft':
  Given HEAD at oid2 + working tree dirty, When reset(target='oid1', {mode:'soft'}), Then HEAD moves to oid1; index unchanged; working tree unchanged.

mode='mixed' (default):
  Given the same, When reset(target='oid1'), Then HEAD moves; index reset to oid1's tree; working tree unchanged.

mode='hard':
  Given the same, When reset(target='oid1', {mode:'hard'}), Then HEAD moves; index reset; working tree overwritten; uncommitted changes lost (no --force needed).

target via revParse-grammar:
  Given HEAD~3, Then reset to HEAD's third grandparent.

Symbolic HEAD:
  Given HEAD = 'ref: refs/heads/main', When reset, Then refs/heads/main is updated; HEAD untouched (still symref).

Detached HEAD:
  Given HEAD direct, When reset, Then HEAD writes the new oid directly.

Concurrent HEAD change:
  Given HEAD changes between read and write, Then throws REF_UPDATE_CONFLICT.

Bare repo:
  Given a bare repo + mode='mixed' or 'hard', Then throws BARE_REPOSITORY.

Lock contention for mixed/hard, OPERATION_IN_PROGRESS guard.
```

**Commit.** `feat(commands): add reset`.

---

## Step 11: `checkout`

**Design:** §5.9.

**Create:** `src/application/commands/checkout.ts`, `test/unit/application/commands/checkout.test.ts`.

**Red tests:**

```
Switch branch:
  Given HEAD on main + working tree clean, When checkout('feature'), Then HEAD writeSymbolicRef → refs/heads/feature; working tree updated to feature's tree.

Detached:
  Given checkout('abc1234' or a tag, with detach=true), Then HEAD = direct oid.

Path-restricted (partial checkout):
  Given paths=['src/'], Then only src/* is updated; other paths untouched.

Dirty file refusal:
  Given working tree has uncommitted change to a file that differs in target tree, When checkout without force, Then throws CHECKOUT_OVERWRITE_DIRTY with .data.paths listing the dirty file.

Force overwrites:
  Given the same with force=true, Then file is overwritten (uncommitted change lost).

.git path injection:
  Given target tree contains an entry named '.git/config' (malicious), When checkout, Then throws PATHSPEC_OUTSIDE_REPO via materializeFile's path-component reject.

Mode 100755 + 120000 + 100644 fixtures:
  Given each mode in target tree, When checkout, Then file is materialized with the correct mode (or symlink fallback on Windows).

Bare repo:
  Given a bare repo, Then throws BARE_REPOSITORY.

Cancellation:
  Given ctx.signal aborts mid-materialize, Then OPERATION_ABORTED propagates; locks released.

OPERATION_IN_PROGRESS guard.
```

**Substep commits** (3 commits for reviewability):
- `feat(commands): add checkout — switch branch + detach`
- `feat(commands): add checkout — paths/partial`
- `feat(commands): add checkout — overwrite-dirty refusal + force`

---

## Step 12: `status`

**Design:** §5.4.

**Create:** `src/application/commands/status.ts`, `test/unit/application/commands/status.test.ts`.

**Red tests:**

```
Empty repo:
  Given init'd repo, no commits, no working tree files, When status, Then branch='main', head=undefined, all arrays empty.

Untracked file:
  Given a working tree file not in index, When status, Then result.untracked includes it.

Modified working file:
  Given index has src/a.ts (oid X) and working file differs, When status, Then result.unstagedChanges has {path:'src/a.ts', kind:'modified'}.

Staged change:
  Given index has src/a.ts (modified vs HEAD), When status, Then result.stagedChanges includes it.

Detached HEAD:
  Given HEAD is direct, Then result.branch === undefined; head = the oid.

ahead/behind:
  Given ctx.config.upstreamRef + local has 2 commits ahead, Then result.ahead === 2, behind === 0.
  Given local is 3 commits behind, Then ahead === 0, behind === 3.
  Given diverged (1 ahead, 2 behind), Then ahead === 1, behind === 2.
  Given upstream not configured, Then ahead/behind both undefined.

Conflicts:
  Given index has unmerged entries, Then result.conflicts lists them.

.gitignore:
  Given an ignored file, When status without includeIgnored, Then result.untracked does NOT include it; result.ignored is empty (not requested).
  Given includeIgnored=true, Then result.ignored lists it.

Bare repo:
  Given a bare repo, Then throws BARE_REPOSITORY.

paths filter:
  Given the option paths=['src/'], Then only src/* is reported.

Cancellation:
  Given ctx.signal aborts mid-walk, Then OPERATION_ABORTED.
```

**Commit.** `feat(commands): add status`.

---

## Step 13: `log` and `diff`

### 13.1 `log`

**Design:** §5.5.

**Red tests:**

```
Default (HEAD):
  Given a 5-commit history, When for await (entry of log(ctx)), Then yields all 5 in topo order.

Limit:
  Given the same with limit=2, Then yields exactly 2.

excluding (stop set):
  Given excluding=[oldCommit], Then yields only commits newer than oldCommit (exclusive).

paths filter:
  Given commits where only commit C touches src/foo.ts, When log({paths:['src/foo.ts']}), Then yields only C.

author filter:
  Given filter author='alice', Then only commits by alice.

before/since (date range):
  Given filter since=Date(2025-01-01), Then commits with committer.date >= 2025-01-01.

grep (regex):
  Given grep=/fix:/, Then commits whose message matches.

Predicate ordering:
  Given a heavy paths filter + cheap author filter, Then author is checked first (no path-diff for non-matching authors). Verify via spy on diffTrees call count.

Cancellation:
  Given ctx.signal aborts mid-iteration, Then OPERATION_ABORTED at next yield.

Empty repo:
  Given no commits, Then yields nothing.
```

**Commit.** `feat(commands): add log`.

### 13.2 `diff`

**Design:** §5.6.

**Red tests:**

```
workdir-vs-index (default):
  Given index has src/a.ts (oid X) and working file changed, When for await (entry of diff(ctx)), Then yields one 'modified' DiffEntry with hunks.

index-vs-tree:
  Given mode={kind:'index-vs-tree', tree:'HEAD'}, Then diffs HEAD's tree against the index.

tree-vs-tree:
  Given two commit oids, When diff({mode:{kind:'commit-vs-commit',a:oid1,b:oid2}}), Then yields all changes between their trees.

Binary file:
  Given a file with NUL in first 8000 bytes, When diff, Then yields a 'binary' DiffEntry without hunks.

Mode-only change:
  Given a file whose mode changed but content didn't, When diff, Then yields a 'modified' entry with empty hunks.

paths filter:
  Given paths=['src/'], Then only entries under src/ are yielded.

contextLines:
  Given the option contextLines=0, Then hunks contain only changed lines (no context).

detectRenames:
  Given a 99%-similar rename, When diff({detectRenames:true}), Then yields a 'renamed' DiffEntry with score>=99.

Bare repo + workdir-vs-index:
  Given a bare repo + workdir-vs-index, Then throws BARE_REPOSITORY.

Missing oid:
  Given an oid not in storage, Then throws OBJECT_NOT_FOUND.

Cancellation.
```

**Commit.** `feat(commands): add diff`.

---

## Step 14: `merge`

**Design:** §5.13.

**Red tests:**

```
Up-to-date:
  Given source === HEAD, When merge, Then result.kind === 'up-to-date'.
  Given source is HEAD's ancestor, Then 'up-to-date'.

Fast-forward:
  Given HEAD is source's ancestor, When merge without noFastForward, Then result.kind === 'fast-forward'; HEAD advanced; working tree updated; no commit.

No-fast-forward:
  Given the same with noFastForward=true, Then result.kind === 'commit' (a real merge commit is created).

Three-way merge no conflicts:
  Given two diverged branches, When merge, Then mergeBase computed; mergeTrees yields a clean tree; new commit with parents=[HEAD,source].

Three-way merge with conflicts:
  Given a divergence with overlapping changes, Then result.kind === 'conflicts'; index has unmerged entries; working tree files have conflict markers.

Conflict marker label sanitization:
  Given source label = 'main\n<<<<<<< HEAD', When merge produces a conflict marker, Then the label embedded in '<<<<<<<' is sanitized via \xNN escapes.

Working tree dirty:
  Given a non-FF merge with uncommitted changes that conflict with the merge tree, Then throws WORKING_TREE_DIRTY.

Unrelated histories:
  Given source on disjoint history, When merge, Then mergeBase returns undefined; merge proceeds with EMPTY_TREE_OID as base; result is the union tree.

noCommit:
  Given a successful 3-way merge with noCommit=true, Then index has the merged tree but no commit is created; HEAD untouched.

mergeBase determinism:
  Given a criss-cross history, Then mergeBase returns the lex-smallest of the multiple bases (deterministic test).

OPERATION_IN_PROGRESS:
  Given .git/MERGE_HEAD exists, When merge is invoked, Then throws OPERATION_IN_PROGRESS (only commit can resume).
```

**Substep commits** (3 commits for reviewability):
- `feat(commands): add merge — fast-forward + up-to-date paths`
- `feat(commands): add merge — three-way merge (clean tree)`
- `feat(commands): add merge — conflicts + EMPTY_TREE_OID unrelated histories`

---

## Step 15: `clone`

**Design:** §5.10.

**Red tests** (heavy use of `memoryRemote` fixture):

```
Successful clone:
  Given memoryRemote with 1 advertised ref + a valid pack, When clone, Then .git/ created; objects written; refs/remotes/origin/main + refs/heads/main set; HEAD symref to refs/heads/main; working tree materialized.

bare:
  Given bare=true, Then no working tree; refs at refs/<name> (NOT refs/heads/); HEAD symref to advertised default.

Missing target dir created:
  Given target doesn't exist, Then directory created; clone proceeds.

Non-empty target rejected:
  Given target exists with files, Then throws TARGET_DIRECTORY_NOT_EMPTY.

URL validation:
  Given an invalid URL, Then throws INVALID_URL.
  Given http:// without allowInsecure, Then throws UNSUPPORTED_SCHEME.
  Given a private IP, Then throws BLOCKED_HOST.

Pack header oversize:
  Given a fixture pack header with object count > MAX_OBJECTS_PER_PACK, Then throws PACK_TOO_LARGE before any inflation.

Empty advertisement:
  Given a remote that advertises 0 refs, Then throws REMOTE_ADVERTISES_NO_REFS.

Rollback on failure:
  Given pack write fails mid-clone (didCreateGitDir=true), Then rmRecursive removes .git/; if didCreateTarget=true, also removes target.

Rollback boundaries:
  Given a pre-existing target dir (didCreateTarget=false), When failure occurs, Then only .git is removed; pre-existing files preserved.

Object integrity:
  Given a pack with mismatched sha, When writeObject detects it, Then OBJECT_HASH_MISMATCH; rollback fires.

Cancellation:
  Given ctx.signal aborts during pack drain, Then OPERATION_ABORTED; rollback fires.

Auth via opts.auth:
  Given opts.auth = bearer, Then the request includes Authorization: Bearer <token>.
```

**Substep commits** (3 commits for reviewability):
- `feat(commands): add clone — bootstrap + URL validation + target prep`
- `feat(commands): add clone — discovery + fetch pack + write objects`
- `feat(commands): add clone — refs + checkout + rollback`

---

## Step 16: `fetch`

**Design:** §5.11.

**Red tests:**

```
Single-round fetch:
  Given remote with new commits, When fetch, Then haves capped at 256; pack received; refs/remotes/origin/* updated.

prune:
  Given a local refs/remotes/origin/old that no longer exists in advertisement, When fetch({prune:true}), Then refs/remotes/origin/old is removed.

Refspec parsing:
  Given opts.refspecs=['+refs/heads/main:refs/remotes/origin/main'], Then force-update applied.

Default refspec:
  Given no refspecs configured, Then default 'refs/heads/*:refs/remotes/origin/*' applied.

REFSPEC_INVALID:
  Given a malformed refspec, Then throws.

Remote URL resolution:
  Given .git/config [remote "origin"] url=..., When fetch({remote:'origin'}), Then that URL is used.
  Given missing remote (no `[remote "<name>"]` in `.git/config`), Then throws `REMOTE_NOT_CONFIGURED` with `.data.remote === <name>` (variant added in Step 1.2).

URL validation, redirects, SSRF — same as clone.

Auth via opts.auth.

Cancellation.
```

**Commit.** `feat(commands): add fetch`.

---

## Step 17: `push`

**Design:** §5.12.

**Red tests:**

```
Successful push:
  Given a non-FF-but-FF-able update, When push, Then pack built; ReceivePackRequest sent; report-status indicates success; refs/remotes/origin/* updated.

Non-FF without force:
  Given local diverged from remote, When push, Then throws NON_FAST_FORWARD.

force:
  Given the same with force=true, Then push succeeds (server accepts via force).

force-with-lease 'auto':
  Given local refs/remotes/origin/main matches remote advertisement, When push({forceWithLease:'auto'}), Then accepted.
  Given local refs/remotes/origin/main DIFFERS from remote, When push({forceWithLease:'auto'}), Then throws NON_FAST_FORWARD (lease wins, even if force=true).

force-with-lease explicit:
  Given forceWithLease=<oid>, Then matched against remote's advertised oldId.

Empty refspecs:
  Given push({refspecs:[]}), Then defaults to 'current branch only' (refs/heads/<currentBranch>:refs/heads/<currentBranch>).

PUSH_REJECTED:
  Given the server reports 'ng <ref> reason', Then throws PUSH_REJECTED with reportStatus payload.

Pack enumeration cap:
  Given the walked object set exceeds MAX_PACK_OBJECTS, Then throws PACK_TOO_LARGE with `.data.objectCount === walkedSize` and `.data.limit === MAX_PACK_OBJECTS` (reuses the existing `PACK_TOO_LARGE` variant from §4.2 — symmetric with the clone-side check).

Refspec count cap:
  Given more than MAX_REFSPECS_PER_PUSH refspecs, Then throws MAX_REFSPECS_EXCEEDED with `.data.count` and `.data.limit`.

Local refs updated to mirror accepted state.

URL validation, redirects, SSRF, auth, cancellation.
```

**Commit.** `feat(commands): add push`.

---

## Step 18: Wiring

**Modify:** `package.json`, `rollup.config.ts`, `.size-limit.json`, `knip.json`, `.dependency-cruiser.cjs`, `src/application/commands/index.ts`.

### 18.1 `package.json` exports

Add 17 entries (1 barrel + 16 per-command):

```json
"./commands": { "import": {...}, "require": {...} },
"./commands/init": { ... },
"./commands/add": { ... },
... (14 more)
```

### 18.2 `rollup.config.ts`

Add 16 entries to the `input` map.

### 18.3 `.size-limit.json`

Add `{ "name":"Commands (barrel)", "path":"dist/esm/commands/index.js", "limit":"28 kB", "gzip":true }` plus 16 per-command entries (`{ "name":"Command: init", "path":"dist/esm/commands/init.js", "limit":"1.5 kB", "gzip":true }` ×16).

### 18.4 `knip.json`

Add 16 `src/application/commands/<name>.ts` entries to `entry`.

### 18.5 `.dependency-cruiser.cjs`

Add 4 rules:

```javascript
{
  name: 'commands-cannot-import-each-other',
  severity: 'error',
  from: { path: '^src/application/commands/([^/]+)\\.ts$' },
  to:   { path: '^src/application/commands/(?!internal/)([^/]+)\\.ts$', pathNot: '$1' },
},
{
  name: 'commands-cannot-import-adapters',
  severity: 'error',
  from: { path: '^src/application/commands' },
  to:   { path: '^src/adapters' },
},
{
  name: 'internal-modules-cannot-be-exported',
  severity: 'error',
  from: { pathNot: '^src/application/commands' },
  to:   { path: '^src/application/commands/internal/' },
},
{
  name: 'domain-repository-error-is-leaf',
  severity: 'error',
  from: { path: '^src/domain/repository/error\\.ts$' },
  to:   { path: '^src/domain/(?!objects/object-id|error)' },
},
```

### 18.6 `src/application/commands/index.ts`

Barrel re-exporting the 16 commands + types per design §6.

### 18.7 Wiring sentinel script

**Create:** `scripts/check-commands-wiring.ts` — fails CI if any of (`src/application/commands/<name>.ts`, the barrel re-export, `package.json` exports map, `rollup.config.ts` input map, `.size-limit.json` per-command entry) falls out of sync.

```typescript
// Reads each source file, asserts:
// 1. Every src/application/commands/<name>.ts (excluding error/types/internal/index)
//    has a corresponding line in the barrel.
// 2. Every barrel entry has a corresponding rollup input.
// 3. Every rollup input has a package.json export.
// 4. Every package.json command export has a .size-limit.json entry.
// 5. The counts are all equal.
```

Add to `package.json` scripts: `"check:wiring": "tsx scripts/check-commands-wiring.ts"`. Wire into `validate`'s wireit dependencies.

**Red tests:**

```
Given all wiring is consistent, When the script runs, Then exits 0.
Given a command source file with no barrel entry, Then exits 1 with a clear message naming the missing pair.
Given a barrel entry with no rollup input, Then exits 1.
Given mismatched per-command size-limit entry name, Then exits 1.
```

### 18.8 Verify

```bash
npm run build
npm run check:size       # all caps respected
npm run check:exports    # arethetypeswrong passes for ./commands/* entries
npm run check:architecture
npm run check:dead-code
npm run check:wiring     # new — sentinel script
node --input-type=module -e "import('./dist/esm/commands/index.js').then(m => console.log(Object.keys(m).sort()))"
# Expect: 16 command names + the type re-exports
```

**Commit.** `chore: wire Phase 9 commands export and size-limit entries`.

---

## Step 19: Mutation testing + 4× parallel reviews + merge

### 19.1 Mutation testing

Run `npx stryker run` with focused mutate globs (per Phase 8 precedent):

```
mutate: [
  "src/application/commands/**/*.ts",
  "src/domain/repository/**/*.ts",
  "src/domain/ignore/**/*.ts",
  "src/domain/commands/**/*.ts",
]
```

Targets per design §7.3 — copied here for the runner:

| Module | Target |
|---|---|
| `internal/url-validate.ts` | 100% |
| `internal/ref-spec.ts` | 100% |
| `internal/rev-parse-grammar.ts` | 100% |
| `internal/config-read.ts` | ≥ 95% |
| `internal/repo-state.ts` | ≥ 95% |
| `internal/working-tree.ts` | ≥ 95% |
| `internal/network-pipeline.ts` | ≥ 95% |
| `internal/bootstrap.ts` | ≥ 90% |
| `init.ts`, `branch.ts`, `tag.ts`, `revParse.ts` | ≥ 95% |
| `commit.ts`, `merge.ts`, `reset.ts` | ≥ 95% |
| `add.ts`, `rm.ts`, `status.ts`, `checkout.ts`, `diff.ts`, `log.ts` | ≥ 90% |
| `clone.ts`, `fetch.ts`, `push.ts` | ≥ 90% |

For every survivor: (a) provably equivalent → document with one-line comment per CLAUDE.md "Accept provably equivalent mutants"; (b) otherwise add an isolated test that kills it.

### 19.2 Parallel reviews

Run four agents in parallel:

1. **`code-reviewer`** — quality, idiomatic TypeScript, project conventions.
2. **`security-reviewer`** — credential handling, redaction, SSRF stance, parser hardening, working-tree path safety.
3. **`profiling-driven-optimization`** — hot-path allocations, per-request middleware composition cost, large-tree walk performance.
4. **`test-review`** — coverage holes, mutation-resistant assertions, test isolation, fixture reuse across 16 command suites.

Address all CRITICAL + HIGH findings before merge. MEDIUM findings either fixed or recorded in `docs/design/commands.md` Round 4 review notes.

### 19.3 Documentation updates

- `README.md` — add a "Commands" section showing `import { init, add, commit, status } from 'tsgit/commands';`.
- `docs/design/commands.md` — first verify the current `Status:` line value (currently `Draft`); promote to `Implemented (<YYYY-MM-DD>)`. Add a Round 4 review-notes section per Phase 6 / 7 / 8 precedent (mutation score, bundle size, surprises).
- `docs/design/primitives.md` — confirm Round 5 amendment (mergeBase + writeSymbolicRef + getRepoRoot) is on main.

### 19.4 Merge

- Squash-merge the implementation branch into main.
- Squash commit message: `feat(commands): add phase 9 — tier 1 commands`.
- Delete the implementation branch.
- Update `docs/BACKLOG.md`: items 9.1–9.16 from `[ ]` → `[x]`. Bump the Progress line: `Phases 0–9 complete. Phase 10 (Repository Facade) is next.`

**Verify.**

```bash
npm run validate                   # full quality gate
git log --oneline -5               # confirm squash landed cleanly
node --input-type=module -e "import { init, add, commit, status } from './dist/esm/commands/index.js'; console.log(typeof init, typeof add, typeof commit, typeof status)"
# Expect: function function function function
```

**Final commit (on main, post-merge).** Squash message above.

---

## Dependency Graph

Each row lists a step and its hard prerequisites. The implementation goes linearly per the design's §10.5 ordering; parallelism is documented for future multi-branch workflows.

| Step | Prerequisites | Could parallel with |
|---|---|---|
| 0 Phase 7 amendment              | none — Phase 7 already on main | — |
| 1 Error scaffold                 | 0                              | 2, 3 |
| 2 Domain modules                 | 1                              | 1, 3 |
| 3 FileSystem port additions      | 0                              | 1, 2 |
| 4.x Internal helpers (10 substeps)| 1, 2, 3                       | 4.x can run in parallel after 1+2+3 land |
| 5 init                           | 4 (`bootstrap`, `repo-state`)  | 6 |
| 6 revParse                       | 4 (`rev-parse-grammar`, `repo-state`) | 5 |
| 7 add, rm                        | 5, 4 (`working-tree`, `index-update`, `config-read`, ignore module) | 8 |
| 8 commit                         | 7, 4 (`commit-message`)        | 9 |
| 9 branch, tag                    | 8                              | 10 |
| 10 reset                         | 6, 7, 8                        | 11 |
| 11 checkout                      | 7, 8                           | 12 |
| 12 status                        | 4 (`repo-state`, `working-tree`, `config-read`, ignore) | 13 |
| 13 log, diff                     | 8                              | 14 |
| 14 merge                         | 0 (mergeBase), 8, 11           | 15 |
| 15 clone                         | 4 (network-pipeline, url-validate, bootstrap), 11 | 16 |
| 16 fetch                         | 15                             | 17 |
| 17 push                          | 15, 0 (mergeBase), 4 (ref-spec)| 18 |
| 18 Wiring                        | 5–17                           | — |
| 19 Mutation + reviews + merge    | 18                             | — |

**Critical path** (longest chain): `0+1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 11 → 14 → 15 → 16 → 17 → 18 → 19` (15 hops, counting 0+1 as one combined PR).

**Sequential implementation order** (single branch — what the implementer actually executes): `0 → 1 → 2 → 3 → 4.1 → 4.2 → 4.3 → 4.4 → 4.5 → 4.6 → 4.7 → 4.8 → 4.9 → 4.10 → 5 → 6 → 7.1 → 7.2 → 8 → 9.1 → 9.2 → 10 → 11 → 12 → 13.1 → 13.2 → 14 → 15 → 16 → 17 → 18 → 19`.

**Maximum parallelism** (future optimization — multi-branch workflow): After steps 1, 2, 3 land, the 10 internal helpers (4.x) can land in parallel branches. After step 4 lands, multiple commands can land in parallel. Step 18 (wiring) serializes the final merge.

---

## Post-Plan — next phase

Merge of `feat/phase-9-commands` to main starts the Phase 10 (Repository Facade) work:

- Phase 10 design doc (`docs/design/repository-facade.md`) is the next deliverable.
- Phase 10 wires `openRepository(opts)` with frozen `ctx`, real auth resolution, per-command export entries finalised, adapter auto-detection (Node vs browser).
- Phase 10 is the first phase callers see as `import { openRepository } from 'tsgit'`.

The Phase 10 design lands on main BEFORE the implementation branch is opened (Phase 6/7/8/9 precedent).
