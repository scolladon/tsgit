# Design — Phase 20.2 Standalone Primitives

**Status:** Draft (target: Accepted at `<sha-after-merge>`).

Backlog: **20.2** — _"Standalone primitives — `hashBlob`, `isIgnored`,
`updateIndex` granular CRUD."_

ADRs: 162 (hashBlob shape) · 163 (isIgnored detail) · 164 (updateIndex
three discrete verbs) · 165 (one-PR scope).

## 1. Goal

Land three Tier-2 primitives that bridge composable building blocks the
existing porcelain (`add`, `commit`, `rm`, `status`) currently keeps
private:

1. **`hashBlob`** — compute a blob's OID for arbitrary bytes; optionally
   file the corresponding loose object. Mirrors `git hash-object [-w]`.
2. **`isIgnored`** — answer "is this path ignored, and by which rule?"
   for one or more paths. Mirrors `git check-ignore -v`.
3. **`updateIndex` granular CRUD** — three discrete verbs that operate on
   one index entry at a time:
   - `stageEntry(path, source)` — set/replace a single entry from raw
     bytes or an already-known OID.
   - `unstageEntry(path)` — remove a single entry (no working-tree
     touch — that's `rm`'s job).
   - `setEntryFlags(path, flags)` — flip `assumeValid`, `skipWorktree`,
     `intentToAdd` on an existing entry without rehashing.

All three slot into `repo.primitives.*`. They reuse existing internals
(`writeObject`, `acquireIndexLock`, `readIndex`, `buildIgnoreEvaluator`)
— no parallel building blocks.

### 1.1 Why now

Phase 21 (`pull`, `mv`, `stash`) and Phase 22 (`cherry-pick`, `revert`,
`rebase`) compose on top of these:

- `stash apply` needs `setEntryFlags` to restore `intentToAdd` markers
  on the popped index.
- `mv` rebuilds an index entry at a new path without rehashing — that's
  `setEntryFlags(path, {…})` after `stageEntry` with the known OID.
- Programmatic `add`/`reset` callers (CI tooling, in-memory adapter
  pipelines) want `hashBlob(content, { write: true })` to upload one
  blob without going through pathspec resolution.
- Tooling that walks an external file tree wants `isIgnored` to filter
  *before* it ever hits `add` — the current porcelain only exposes
  ignore semantics implicitly inside the walker.

## 2. Out of scope (does NOT ship in 20.2)

- **Index batch primitive** (single call replays N actions atomically).
  Three discrete verbs cover today's callers. ADR-164 captures the
  decision; if 21.3 (`stash`) proves a batch shape is needed we add it
  as 20.2a, not retrofit here.
- **Tier-1 commands.** No `repo.hashObject` / `repo.checkIgnore` /
  `repo.updateIndex` facades — primitive-only surface mirrors how
  `recordRefUpdate`, `writeSymbolicRef`, and `setConfigEntry` already
  ship.
- **`hashBlob` for trees/commits/tags.** That's `writeObject({ type, … })`.
  We rename it `hashBlob` precisely to keep the surface narrow.
- **`isIgnored` for directories with descend semantics.** Match the
  `git check-ignore` contract: it reports per *exact path* — the caller
  passes the path with the correct `isDirectory` flag, the primitive
  doesn't walk.
- **Write-event-bus emission.** Per ADR-150's Wave-1 note, the bus is
  wired but no write primitive emits yet. `stageEntry`, `unstageEntry`,
  `setEntryFlags` follow the same posture as `commands/add` — they
  durably commit the index under the lock but do not call `bus.emit`.
  Wave 2 of 20.1 will retrofit `emit('index')` across every index
  writer including the three CRUD verbs.
- **Concurrency hardening (multi-process locks).** These primitives
  reuse `acquireIndexLock` — the same lock contract `add`/`commit`/`rm`
  already honour. No new lock semantics.

## 3. References

- ADRs: 162 (hashBlob -w flag), 163 (check-ignore detail), 164 (three
  discrete verbs), 165 (one-PR scope).
- Internals reused:
  - `src/application/primitives/write-object.ts`
  - `src/application/commands/internal/build-ignore-evaluator.ts`
  - `src/application/commands/internal/index-update.ts`
  - `src/application/primitives/read-index.ts`
  - `src/domain/ignore/matcher-stack.ts`
- Test conventions: `CLAUDE.md` §"Test Conventions" + §"Mutation-Resistant
  Test Patterns" + §"Property-Based Testing".

## 4. Surface

### 4.1 `hashBlob`

```ts
// src/application/primitives/hash-blob.ts
export interface HashBlobOptions {
  /** Persist the loose object under `.git/objects/<2>/<38>`. Default `false`. */
  readonly write?: boolean;
}

export const hashBlob = (
  ctx: Context,
  content: Uint8Array,
  opts?: HashBlobOptions,
): Promise<ObjectId>;
```

Behaviour:

- Always returns the canonical blob OID (sha-1 or sha-256 depending on
  `ctx.hashConfig`). Byte-identical to `writeObject({ type: 'blob', id:
  '' as ObjectId, content })` for the OID; that primitive already
  serialises `blob <size>\0<payload>` and hashes the result.
- `opts.write === true` delegates to `writeObject` so we share the
  exact same loose-object encoding, mkdir behaviour, and
  `FILE_EXISTS` idempotency contract.
- `opts.write` falsy (the default) skips all I/O on `ctx.fs` and only
  touches `ctx.hash`. Hot path for callers that want the OID but write
  via a different store (a packfile builder, a remote uploader).
- Cancellation: checks `ctx.signal?.aborted` once before serialising
  and once after — same shape as `writeObject`.
- Domain composition: a small helper `hashBlobContent(content,
  hashConfig, hash)` is extracted from `writeObject` so both call sites
  share the serialise+hash path. `writeObject` becomes "compute OID,
  then mkdir+deflate+rename." `hashBlob` is "compute OID, then maybe
  delegate to `writeObject`."

### 4.2 `isIgnored`

```ts
// src/application/primitives/is-ignored.ts
export interface IsIgnoredQuery {
  readonly path: FilePath;
  /** Match directory rules (`build/`) — defaults to `false`. */
  readonly isDirectory?: boolean;
}

export interface IsIgnoredMatch {
  readonly path: FilePath;
  readonly ignored: boolean;
  /** Set only when `ignored === true`. */
  readonly source?: {
    readonly kind: 'global' | 'info' | 'gitignore';
    /** POSIX-relative dir whose `.gitignore` carried the rule. Empty for global / info / root `.gitignore`. */
    readonly basedir: FilePath | '';
    /** 1-based line number of the matching rule inside its file. */
    readonly line: number;
    /** Raw pattern text (e.g. `*.log`, `!keep.log`, `build/`). */
    readonly pattern: string;
  };
}

export const isIgnored = (
  ctx: Context,
  queries: ReadonlyArray<IsIgnoredQuery>,
): Promise<ReadonlyArray<IsIgnoredMatch>>;
```

Behaviour:

- One result per input, in **input order** — keeps caller bookkeeping
  trivial.
- Reuses `buildIgnoreEvaluator(ctx)` so the global excludes file,
  `info/exclude`, and the root `.gitignore` are loaded *once* per call
  and cached for the duration. Per-directory `.gitignore` files are
  loaded lazily — the same evaluator already memoises.
- The three base levels (global / info / repo-root gitignore) all
  carry `basedir === ''` today, so `basedir` alone cannot tell them
  apart. We extend `IgnoreLevel` with an optional `kind?: 'global' |
  'info' | 'gitignore'` (default `'gitignore'`) — additive; every
  existing consumer keeps its boolean lookup. `buildIgnoreEvaluator`
  tags each base push with the right `kind`; `buildRepoIgnorePredicate`
  is unchanged.
- Matching delegates to `matchInStack`. Today `matchInStack` returns
  `MatchResult = 'ignored' | 'unignored' | 'unset'` and discards
  *which* rule produced the verdict. To surface the metadata we add
  sibling functions `matchesVerbose` (per-level) and `matchInStackVerbose`
  (stack-wide), each returning `{ verdict, ruleIndex?, level? }` — see
  §6.2. The existing predicate path is untouched;
  `buildRepoIgnorePredicate` keeps its boolean return.
- An ignored path's `source.basedir` is the directory whose
  `.gitignore` contained the rule (`''` for global / info / root).
  `source.kind` distinguishes the three indistinguishable-by-basedir
  cases. `source.line` is the 1-based line number — preserved by
  extending `parseGitignore` with a per-rule `lineNumber` field. The
  parser currently discards it; adding it is additive (every existing
  consumer ignores extra fields on `IgnoreRule`).
- `MatchResult === 'unset'` (no rule matched) maps to `ignored:
  false`, `source === undefined`. `MatchResult === 'unignored'` (a
  negation was the last match) maps to the same shape per ADR-163 —
  the user-facing shape collapses the two `false` cases. (If a real
  caller needs to distinguish them later we widen the type, additively.)
- `git check-ignore -v` parity: it only prints a rule when the verdict
  is "ignored". Our shape matches — `ignored === true ⇔ source !==
  undefined`. The discriminant is unambiguous at the type level.
- No path is staged or read from working tree — the primitive is
  purely declarative. Caller supplies `isDirectory` because the *only*
  way the predicate can know (without an extra syscall) is to ask.
- Cancellation: `ctx.signal` checked at the top and between paths.

### 4.3 `stageEntry`

```ts
// src/application/primitives/stage-entry.ts
export type StageEntrySource =
  | { readonly content: Uint8Array; readonly mode?: FileMode }
  | { readonly id: ObjectId; readonly mode: FileMode };

export interface StageEntryOptions {
  readonly breakStaleLockMs?: number;
  /** Flags overlay on top of `STAGE0_FLAGS`. Use to seed `intentToAdd` etc. */
  readonly flags?: Partial<IndexEntryFlags>;
}

export const stageEntry = (
  ctx: Context,
  path: FilePath,
  source: StageEntrySource,
  opts?: StageEntryOptions,
): Promise<IndexEntry>;
```

Behaviour:

- Acquires `${gitDir}/index.lock`, reads the existing index, replaces
  (or inserts) the entry at `path`, commits.
- `source.content` path: writes the blob via `writeObject` (or, more
  precisely, calls `hashBlob(content, { write: true })` — same effect,
  but routed through the new shared primitive). Re-stat semantics
  follow `commands/add` minus the lstat compare (no working-tree
  inode to compare against; the caller is supplying bytes
  out-of-band). The synthesised stat fields default to:
  - `mtimeSeconds = ctimeSeconds = floor(Date.now() / 1000)`
  - `mtimeNanoseconds = ctimeNanoseconds = 0`
  - `dev = ino = uid = gid = 0`
  - `fileSize = content.byteLength`
  - `mode` defaults to `'100644'` unless supplied.
- `source.id` path: trusts the OID — does NOT verify the object exists
  (mirrors `git update-index --cacheinfo`). The caller has just
  written the object, or is constructing an index against a known
  baseline. `mode` is required because we can't infer it from raw
  content.
- Flags default to `STAGE0_FLAGS`; `opts.flags` overlays via
  `{ ...STAGE0_FLAGS, ...opts.flags }`. Supplying a non-zero `stage`
  pathway is permitted (callers building conflict markers post-merge).
- Returns the persisted `IndexEntry` so callers can chain.
- Bare-repo check: throws `INVALID_OPERATION` (the index lives under
  `.git/index` — a bare repo has no useful index for staging).
- A `path` that contains `..` / starts with `/` / is invalid in any of
  the existing index-parser path-validator senses throws `INVALID_PATH`
  before the lock is taken.

### 4.4 `unstageEntry`

```ts
// src/application/primitives/unstage-entry.ts
export interface UnstageEntryOptions {
  readonly breakStaleLockMs?: number;
}

export const unstageEntry = (
  ctx: Context,
  path: FilePath,
  opts?: UnstageEntryOptions,
): Promise<{ readonly removed: boolean }>;
```

Behaviour:

- Acquires the lock, reads the index, drops any entry at `path` (all
  stages — if both stage-2 and stage-3 entries exist for a conflict,
  both go). Commits.
- `removed === false` when no entry matched; the lock-and-commit still
  ran (releasing the lock cleanly). Idempotent.
- Working-tree file is **not** touched. This is the *index-only*
  unstage — the equivalent of `git rm --cached` plus `git restore
  --staged` minus working-tree side-effects.
- Bare-repo: same `INVALID_OPERATION` rejection.

### 4.5 `setEntryFlags`

```ts
// src/application/primitives/set-entry-flags.ts
export interface SetEntryFlagsOptions {
  readonly breakStaleLockMs?: number;
}

export const setEntryFlags = (
  ctx: Context,
  path: FilePath,
  flags: Partial<IndexEntryFlags>,
  opts?: SetEntryFlagsOptions,
): Promise<IndexEntry>;
```

Behaviour:

- Acquires the lock, reads the index, finds the (single) entry at
  `path`. If no entry — throws `PATHSPEC_NO_MATCH` (consistent with
  how `rm` reports "this path isn't tracked").
- Merges `flags` over the entry's existing flags (`{ ...entry.flags,
  ...flags }`). Returns the new entry.
- The on-disk index version is auto-promoted to v3 when `skipWorktree`
  or `intentToAdd` flip to `true` — `serializeIndex` already picks
  the minimum version that fits the per-entry flags (see
  `src/domain/git-index/index-writer.ts:62`). Nothing to add at the
  primitive layer.
- Multi-stage entries (`stage > 0`): the flag overlay applies to
  *every* matching stage entry. Conflict-stage entries don't have
  `skipWorktree` / `intentToAdd` semantics but the operator may need
  to set `assumeValid` post-resolution; allow it.
- Returns the updated entry (stage-0 if there is one, otherwise the
  lowest stage). When multiple entries were updated, callers can call
  `readIndex` for the full picture; the return value is "the
  user-facing one."

## 5. Module layout

```
src/application/primitives/
├── hash-blob.ts              [NEW]
├── is-ignored.ts             [NEW]
├── stage-entry.ts            [NEW]
├── unstage-entry.ts          [NEW]
├── set-entry-flags.ts        [NEW]
├── index.ts                  [touched — exports + types]
└── write-object.ts           [touched — extract shared serialise+hash helper]

src/domain/ignore/
├── matcher-stack.ts          [touched — add matchInStackVerbose]
└── parse-gitignore.ts        [touched — per-rule lineNumber]

src/application/commands/internal/
└── index-update.ts           [untouched]

src/repository.ts             [touched — 5 new primitives bindings]
```

Five new files, four touched. No file exceeds 200 lines.

## 6. Internal touchpoints

### 6.1 `writeObject` factoring

`writeObject` accepts any `GitObject`. The cleanest factoring is to
extract a `serializeAndHash` helper from its body and have both
`writeObject` and `hashBlob` call it:

```ts
// src/application/primitives/internal/serialize-and-hash.ts (new internal helper)
export const serializeAndHash = async (
  ctx: Context,
  object: GitObject,
): Promise<{ readonly bytes: Uint8Array; readonly id: ObjectId }> => {
  const bytes = serializeObject(object, ctx.hashConfig);
  const id = (await ctx.hash.hashHex(bytes)) as ObjectId;
  return { bytes, id };
};
```

`writeObject` becomes:

1. Cancellation guard.
2. `const { bytes, id } = await serializeAndHash(ctx, object);`
3. Declared-id check, then mkdir + deflate + writeExclusive.

`hashBlob` becomes:

1. Cancellation guard.
2. `const { id } = await serializeAndHash(ctx, { type: 'blob', id: '' as ObjectId, content });`
3. If `opts.write === true`, delegate to `writeObject` for the file
   write — sharing the FILE_EXISTS / mkdir / deflate code path
   verbatim instead of duplicating it.

The helper is `internal/` (not re-exported from
`primitives/index.ts`) — purely a refactor seam.

### 6.2 `matchInStackVerbose`

`matchInStack` currently returns the `MatchResult` of the last rule
that matched. We add a sibling that returns the same verdict plus
which level (`IgnoreLevel`) and which rule index produced it:

```ts
// src/domain/ignore/match.ts (new sibling)
export interface VerboseLevelMatch {
  readonly verdict: 'ignored' | 'unignored' | 'unset';
  /** Index of the matching rule inside `rules`. Present iff verdict !== 'unset'. */
  readonly ruleIndex?: number;
}

export const matchesVerbose = (
  rules: IgnoreRuleset,
  path: FilePath,
  isDir: boolean,
): VerboseLevelMatch;

// src/domain/ignore/matcher-stack.ts
export interface VerboseMatch {
  readonly verdict: 'ignored' | 'unignored' | 'unset';
  readonly level?: IgnoreLevel;   // present iff verdict !== 'unset'
  readonly ruleIndex?: number;    // index into `level.rules`
}

export const matchInStackVerbose = (
  stack: ReadonlyArray<IgnoreLevel>,
  path: FilePath,
  isDir: boolean,
): VerboseMatch;
```

`matches` and `matchInStack` keep their current shape — we don't churn
the existing callers. The new `matchesVerbose` shares the loop body
with `matches` by extracting the per-rule decision; the existing
`matches` becomes a thin wrapper that drops the `ruleIndex`. Same
relationship between `matchInStackVerbose` and `matchInStack`.

`MatchResult` values are spelled `'ignored' | 'unignored' | 'unset'`
in the existing codebase — `'unset'` (no rule matched) maps to
`isIgnored`'s `ignored: false` with `source === undefined`.
`'unignored'` (last match was a negation) maps to the same shape per
ADR-163 — the caller can't distinguish "no rule matched" from
"negation rule matched" in the user-facing return. (If a real caller
later needs that split we widen the type, additively.)

### 6.3 `parseGitignore` lineNumber

`IgnoreRule` grows a `readonly lineNumber: number` field. The parser
already iterates lines in order — we just stop discarding the
1-based index. Every existing consumer reads `pattern` / `negated` /
`directoryOnly`; the new field is additive.

Property tests (already shipped in 19.6 for `parseGitignore`) gain a
property: "every parsed rule's `lineNumber` falls within
`[1, sourceLineCount]`."

## 7. Composition contract

| New primitive    | Reads        | Writes         | Locks acquired   | Emits (Wave 2) |
| ---------------- | ------------ | -------------- | ---------------- | --------------- |
| `hashBlob`       | none         | objects (opt.) | none             | none            |
| `isIgnored`      | gitignore    | none           | none             | none            |
| `stageEntry`     | index, blob  | index, objects | `${gitDir}/index.lock` | `index` (W2) |
| `unstageEntry`   | index        | index          | `${gitDir}/index.lock` | `index` (W2) |
| `setEntryFlags`  | index        | index          | `${gitDir}/index.lock` | `index` (W2) |

"Wave 2" = the 20.1 follow-up that retrofits `bus.emit` to every
index-mutating primitive (current `commands/add`, `commands/commit`,
`commands/rm`, plus the three new ones).

## 8. Error model

All errors flow through `TsgitError` with the existing discriminated
`data.code`:

| Code                  | Trigger                                                                                     |
| --------------------- | ------------------------------------------------------------------------------------------- |
| `OPERATION_ABORTED`   | `ctx.signal.aborted` checked at the documented points.                                      |
| `INVALID_INDEX_ENTRY` | `stageEntry` / `unstageEntry` / `setEntryFlags` reject paths via the existing `validateIndexPath(path, NO_PARSER_OFFSET)` (`offset === -1` marks "no underlying file offset"). |
| `PATHSPEC_NO_MATCH`   | `setEntryFlags` called against an absent path. `data.pattern` carries the requested `path`. |
| `BARE_REPOSITORY`     | Any of the three CRUD verbs invoked on a bare repo; `data.operation` distinguishes which.   |
| `RESOURCE_LOCKED`     | Existing `acquireIndexLock` semantics.                                                      |
| `FILE_NOT_FOUND` / `INVALID_INDEX_HEADER` | Propagated from `readIndex`; the lock IS still released.                                    |
| `OBJECT_HASH_MISMATCH`| Inherited from `writeObject` when `stageEntry` writes a blob.                               |

No new error codes — every shape already exists in
`src/domain/commands/error.ts`, `src/domain/repository/error.ts`,
and `src/domain/git-index/error.ts`. `PATHSPEC_NO_MATCH` is reused
even though the input isn't a pathspec; reusing it keeps the
porcelain's surface (`rm` already throws the same code for the same
condition) consistent with the new primitive. `validateIndexPath`
already designs in the `NO_PARSER_OFFSET = -1` sentinel for exactly
this kind of caller-supplied path scenario.

## 9. Test strategy

### 9.1 Tier composition

Per Phase 19.2's pyramid (80/15/5):

- **Unit (≈80%)** — one `*.test.ts` per primitive + one per touched
  domain helper. GWT describe/it split per Phase 19.3c, AAA bodies,
  `sut` variable, no generic `toThrow(ErrorClass)`.
- **Integration (≈15%)** — one file per primitive that proves
  end-to-end behaviour against the **real Node fs adapter** and a
  freshly initialised repo. The integration files declare a
  `@proves` JSDoc per Phase 19.4. Surfaces:
  - `hashBlob.proves: 'application/primitives/hash-blob'`
  - `isIgnored.proves: 'application/primitives/is-ignored'`
  - `stageEntry.proves: 'application/primitives/stage-entry'`
  - `unstageEntry.proves: 'application/primitives/unstage-entry'`
  - `setEntryFlags.proves: 'application/primitives/set-entry-flags'`
- **Property (additive, per Phase 19.6)** — one
  `parse-gitignore.properties.test.ts` extension covering the new
  `lineNumber` invariant; no other primitive grows a property file
  this phase (they're not parsers/decoders).
- **Parity / E2E (per Phase 19.5a)** — every new primitive is added
  to a parity scenario so the Node + Memory + Playwright drivers all
  iterate it. New `test/parity/scenarios/*.scenario.ts` files
  (matching the existing flat layout):
  - `hash-blob.scenario.ts` — exercises both `write: true` and
    `write: false` in one scenario; asserts the OID is stable and
    that `write: true` makes a subsequent `readObject` succeed.
  - `is-ignored.scenario.ts` — seeds a `.gitignore`, queries 3
    paths (ignored / unignored-by-negation / unmatched), asserts the
    shape of the result.
  - `stage-unstage-flags.scenario.ts` — `stageEntry` (content), then
    `setEntryFlags({ skipWorktree: true })`, then `unstageEntry`;
    each step asserts the index state.

  Three scenarios is the right granularity — one per primitive
  family — and keeps the Playwright run time bounded. Each scenario
  is registered in `test/parity/scenarios/index.ts`.
- **Interop (per Phase 19.7)** — `hashBlob` with `{ write: true }`
  shares the `looseObject` surface that `writeObject` already covers.
  No new interop surface; the existing byte-identical comparison
  protects us.

### 9.2 Mutation-resistance checklist

Per CLAUDE.md "Mutation-Resistant Test Patterns":

- Every `INVALID_PATH` / `PATHSPEC_NO_MATCH` / `INVALID_OPERATION`
  guard gets an isolated test that triggers *only* that condition.
- Error data is asserted via `try / catch + .data` (not
  `toThrow(ErrorClass)` alone).
- `hashBlob` covers each branch (`write: undefined`, `write: false`,
  `write: true`) independently. The OID-only path is asserted by
  reading `objects/` *before and after* and confirming nothing was
  written.
- `isIgnored` covers each rule source (`global`, `info`,
  `gitignore` root, `gitignore` nested) independently — and a
  negated-rule test that asserts `source === undefined`.
- `stageEntry` covers `source.content` vs. `source.id` paths
  independently; the `mode` defaulting branch and `flags` overlay
  branch are isolated.
- `setEntryFlags` covers each flag (`assumeValid`,
  `skipWorktree`, `intentToAdd`) flipping `true` and back to `false`
  in isolated tests so the bitfield serialisation mutants are killed.

Provably equivalent mutants get the inline `// equivalent-mutant:
<why>` annotation only; no central catalogue (per project memory
`project_no_equivalent_mutant_catalogue.md`).

### 9.3 Concurrency tests

- Two concurrent `stageEntry` calls on different paths against the
  same repo: second one observes `RESOURCE_LOCKED`. Existing
  `acquireIndexLock` behaviour — reused, not re-tested in depth.
  One smoke test per CRUD verb.
- `stageEntry` then `unstageEntry` on the same path round-trips
  cleanly; the final index matches the initial.

## 10. Performance posture

- `hashBlob({ write: false })` is one hash call. Constant memory
  (`serializeObject` allocates header + payload once). Suitable for
  bulk loops the caller controls.
- `isIgnored` amortises evaluator construction across the batch.
  First call loads global + info + root gitignore (3 files in the
  worst case); subsequent paths reuse the cache. Order-of-N over the
  query count, O(rules × stack depth) per path — same complexity as
  the existing `walkWorkingTree` predicate.
- CRUD verbs each cost one index read + one index write under the
  lock. The same hot path `commands/add` already pays per call.
  Bulk-update users go through `commands/add` (which buffers paths
  inside one lock) — we will not optimise the CRUD verbs into a
  batch shape (ADR-164 is explicit).

No new bench scenario this phase; Phase 26 will measure if any of
these emerge as hot paths.

## 11. Security posture

- `stageEntry` paths flow through the existing index path-validator
  (`src/domain/git-index/path-validator.ts`) — same rejection set as
  the loaded index. No new traversal surface.
- `hashBlob` accepts arbitrary bytes; the caller is responsible for
  size. `writeObject` already enforces the `MAX_OBJECT_SIZE` check at
  serialise time via `serializeObject`. The OID-only path has no
  size cap because no file is written — symmetrical to a pure hash
  function.
- `isIgnored` reads only files under `ctx.layout.gitDir` /
  `ctx.layout.workDir`; the FS validator wrapper from
  `repository/wrap-fs-validator.ts` already gates that.
- No new auth, no new transport, no new env reads.

## 12. Migration impact

- **Public surface:** five new exports from
  `src/application/primitives/index.ts` and five bindings on
  `repo.primitives`. Strictly additive.
- **Existing primitives:** `writeObject` keeps its signature; an
  internal helper is extracted. `matchInStack`, `parseGitignore`
  results gain a field (additive).
- **Docs:** `docs/use/api-primitives.md` gains a section per new
  primitive; `docs/get-started/node.md` gets a recipe; `RUNBOOK.md`
  notes the new surface; `CONTRIBUTING.md` lists the new files under
  the design checklist.

No breaking change. No deprecation needed. Phase 20.2 is `2.x` minor.

## 13. Open questions

1. Should `stageEntry` accept a `content: Uint8Array` AND a `mode:
   '120000'` (symlink) combination? `git update-index` allows
   `--cacheinfo 120000,<oid>,<path>` with the symlink target stored as
   blob content. Yes — covered by §4.3's `mode` field on the content
   variant. Test parity adds a symlink-mode case.
2. Does `unstageEntry` need to report *which* stages it removed (a
   conflict file with stage-1/2/3 entries) instead of a single
   `removed: boolean`? Provisional: no — the boolean is sufficient
   for the porcelain that needs this (`stash pop`, `merge --abort`).
   If a real caller proves otherwise we widen to `{ removed: number }`
   in a follow-up (additive).

## 14. Acceptance gates

- [ ] All five primitives have unit + integration + parity coverage.
- [ ] `npm run validate` clean (lint, types, deps, architecture, coverage 100%).
- [ ] Stryker on the five new files + two touched domain files: every
      killable mutant killed; equivalents annotated inline.
- [ ] No new ignore-directives, no new biome-ignore comments.
- [ ] `docs/use/api-primitives.md` documents every new primitive with a
      runnable snippet.
- [ ] BACKLOG `[~] 20.2` flips to `[x]` in the PR's own commits.
