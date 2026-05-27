# Plan — Phase 20.2 Standalone Primitives

Derived from `docs/design/phase-20-2-standalone-primitives.md` and
ADRs 162–165. Slices are ordered so each one rests on a green tree.

## Slice 1 — Domain extensions (no surface change)

**Why first:** the three new primitives all depend on these
additive domain tweaks. Landing them in their own commit keeps the
diff tiny, the failure surface narrow, and the property tests
focused.

1. **RED** — extend `parse-gitignore.properties.test.ts` with a
   property: every parsed rule's `lineNumber` falls within
   `[1, sourceLineCount]`; concrete unit tests assert exact
   1-based numbers for hand-rolled multi-line samples.
2. **GREEN** — add `lineNumber: number` to `IgnoreRule` in
   `src/domain/ignore/parse-gitignore.ts`; the parser already
   iterates `text.split('\n')` — track the index.
3. **RED** — unit tests for `matchesVerbose` (per-level) and
   `matchInStackVerbose` (stack-wide). Cover:
   - `unset` verdict → no `level`, no `ruleIndex`.
   - `ignored` verdict → carries the matching level + rule index.
   - `unignored` verdict (negation) → carries the matching level +
     rule index.
   - Last-match-wins across multiple rules in one level.
   - Last-level-wins across multiple matching levels.
4. **GREEN** — add `matchesVerbose` to
   `src/domain/ignore/match.ts`; refactor `matches` to delegate
   (drop the `ruleIndex`). Add `matchInStackVerbose` to
   `src/domain/ignore/matcher-stack.ts`; refactor `matchInStack`
   to delegate (drop the verbose fields).
5. **RED/GREEN** — extend `IgnoreLevel` with `kind?: 'global' |
   'info' | 'gitignore'`. Update
   `commands/internal/build-ignore-evaluator.ts` to tag each base
   level. One unit test asserts the three base levels carry the
   right `kind`; existing tests continue to pass.
6. **Validate** — `npm run validate` clean. Atomic commit:
   `feat(ignore): expose verbose matcher + per-rule line numbers`.

## Slice 2 — `hashBlob` + `serializeAndHash` helper

1. **RED** — `test/unit/application/primitives/hash-blob.test.ts`
   covers:
   - `write: undefined` → returns OID, no `fs` writes (assert via
     spy / in-memory adapter snapshot).
   - `write: false` → identical to undefined.
   - `write: true` → returns OID and writes the loose object;
     reading the object back round-trips the content.
   - OID matches `writeObject({ type: 'blob', id: '' as ObjectId,
     content })` byte-for-byte.
   - Aborted signal pre-serialise throws `OPERATION_ABORTED`.
   - Aborted signal post-serialise (with `write: true`) throws
     `OPERATION_ABORTED`.
   - Empty content (`new Uint8Array(0)`) hashes to the well-known
     empty-blob SHA.
2. **GREEN** — create
   `src/application/primitives/internal/serialize-and-hash.ts`
   exporting `serializeAndHash(ctx, object)`. Refactor
   `write-object.ts` to use it (no behaviour change; existing
   unit + integration tests remain green).
3. **GREEN** — create `src/application/primitives/hash-blob.ts`
   exporting `hashBlob(ctx, content, opts?)`. The
   `opts.write === true` branch delegates to `writeObject` so the
   `FILE_EXISTS` / `OBJECT_HASH_MISMATCH` paths are inherited
   verbatim.
4. **RED/GREEN integration** —
   `test/integration/application/primitives/hash-blob.integration.test.ts`
   with `@proves: 'application/primitives/hash-blob'`. Exercises
   both `write: true` and `write: false` against the Node fs
   adapter on a tmp repo.
5. **Wire-up** — add `hashBlob` to `primitives/index.ts` exports
   and to `repository.ts` (`Repository['primitives']['hashBlob']`
   binding + `Object.freeze({ … hashBlob: … })` slot).
6. **Validate** — `npm run validate` clean. Atomic commit:
   `feat(primitives): hashBlob with optional write flag (ADR-162)`.

## Slice 3 — `isIgnored`

1. **RED** — `test/unit/application/primitives/is-ignored.test.ts`
   covers:
   - One ignored path with a root `.gitignore` rule.
   - One ignored path with a nested `.gitignore` rule.
   - One unmatched path → `ignored: false`, no `source`.
   - One negated path (`!keep.log` after `*.log`) →
     `ignored: false`, no `source` (per ADR-163).
   - Directory-only rule (`build/`) matched against an
     `isDirectory: true` query.
   - Directory-only rule NOT matched against an
     `isDirectory: false` query for the same path.
   - `source.kind` distinguishes `'global'` (via
     `core.excludesFile`), `'info'` (via `.git/info/exclude`),
     and `'gitignore'` for the same matched path.
   - `source.line` is the 1-based line number from the file.
   - Aborted signal between paths throws `OPERATION_ABORTED`.
   - Empty queries array returns empty result (idempotent edge).
2. **GREEN** — create
   `src/application/primitives/is-ignored.ts`. Internally builds
   the same evaluator as `buildRepoIgnorePredicate` but loads
   per-directory rules eagerly along each queried path's ancestor
   chain (no walk — direct ancestor resolution).
3. **RED/GREEN integration** —
   `test/integration/application/primitives/is-ignored.integration.test.ts`
   with `@proves: 'application/primitives/is-ignored'`. Seeds
   `.gitignore` + `.git/info/exclude` on a real Node-fs repo,
   asserts the source `kind` differentiation.
4. **Wire-up** — add `isIgnored` to `primitives/index.ts` exports
   and `repository.ts`.
5. **Validate** — `npm run validate` clean. Atomic commit:
   `feat(primitives): isIgnored with rule provenance (ADR-163)`.

## Slice 4 — `stageEntry` + `unstageEntry`

These two ship together (they share the index-lock idiom and the
path-validator path; tests are easier to assert as before/after
pairs).

1. **RED** — `test/unit/application/primitives/stage-entry.test.ts`:
   - `source.content` path stages a stage-0 entry; OID matches
     `hashBlob(content)`.
   - `source.id` path stages without writing a blob (object store
     untouched) — asserted via fs adapter snapshot.
   - `mode` defaults to `'100644'` for content path.
   - Symlink case: `source.content` + `mode: '120000'` round-trips
     a symlink-mode entry.
   - `flags.intentToAdd: true` overlay produces a v3 index on
     disk (round-trip via `readIndex`).
   - Invalid path (`/abs`, `..`, embedded NUL) throws
     `INVALID_INDEX_ENTRY` with the expected reason.
   - Bare repo throws `BARE_REPOSITORY`.
   - Concurrent call observes `RESOURCE_LOCKED` (one smoke test).
   - Aborted signal pre-lock throws `OPERATION_ABORTED`.
2. **RED** — `test/unit/application/primitives/unstage-entry.test.ts`:
   - Entry present → returns `{ removed: true }`; the entry is
     absent on readback.
   - Entry absent → returns `{ removed: false }`; index unchanged.
   - Conflict path (stage-1/2/3) → all three removed in one call.
   - Bare repo throws `BARE_REPOSITORY`.
   - Invalid path throws `INVALID_INDEX_ENTRY`.
   - Aborted signal pre-lock throws `OPERATION_ABORTED`.
   - Working-tree file untouched (verified via fs adapter snapshot).
3. **GREEN** — create `src/application/primitives/stage-entry.ts`
   and `src/application/primitives/unstage-entry.ts`. Both reuse
   `acquireIndexLock`, `readIndex`, and (stage path) `hashBlob`
   with `write: true`. Defaults for synthetic stat fields per
   design §4.3.
4. **RED/GREEN integration** —
   `test/integration/application/primitives/stage-entry.integration.test.ts`
   and `unstage-entry.integration.test.ts`. Each declares the
   matching `@proves` surface.
5. **Wire-up** — exports + repository bindings.
6. **Validate** — `npm run validate` clean. Atomic commit:
   `feat(primitives): stageEntry + unstageEntry granular CRUD (ADR-164)`.

## Slice 5 — `setEntryFlags`

1. **RED** — `test/unit/application/primitives/set-entry-flags.test.ts`:
   - Flip each flag (`assumeValid`, `skipWorktree`, `intentToAdd`)
     true and back to false in isolated tests.
   - Multi-stage entry: all stages updated when the path matches
     multiple stages.
   - Absent path throws `PATHSPEC_NO_MATCH` (`data.pattern` carries
     the requested path).
   - Invalid path throws `INVALID_INDEX_ENTRY`.
   - Bare repo throws `BARE_REPOSITORY`.
   - On-disk index promotes to v3 when an extended flag flips true
     (round-trip via `readIndex`).
   - Aborted signal pre-lock throws `OPERATION_ABORTED`.
   - Return value: stage-0 entry when present, lowest stage
     otherwise.
2. **GREEN** — create
   `src/application/primitives/set-entry-flags.ts`. Reuses
   `acquireIndexLock`, `readIndex`, merges flags, commits.
3. **RED/GREEN integration** —
   `test/integration/application/primitives/set-entry-flags.integration.test.ts`
   with `@proves: 'application/primitives/set-entry-flags'`.
4. **Wire-up** — exports + repository bindings.
5. **Validate** — `npm run validate` clean. Atomic commit:
   `feat(primitives): setEntryFlags granular CRUD (ADR-164)`.

## Slice 6 — Parity scenarios

1. **RED** — three new scenarios under `test/parity/scenarios/`:
   - `hash-blob.scenario.ts`
   - `is-ignored.scenario.ts`
   - `stage-unstage-flags.scenario.ts`

   Each registered in `test/parity/scenarios/index.ts` with a
   golden output object (OIDs are deterministic for fixed content;
   ignored-rule line numbers are deterministic from seeded files).
2. **GREEN** — scenarios run against Node + Memory + Browser
   drivers via the existing parity harness (no driver changes).
3. **Audit** — re-run `tooling/audit-browser-surface.ts` to
   confirm the five new primitives are covered (no allowlist
   bumps).
4. **Validate** — `npm run validate` clean, parity job green.
   Atomic commit: `test(parity): cover phase 20.2 primitives`.

## Slice 7 — Three review passes + mutation

1. Parallel review agents:
   `typescript-reviewer` × `test-review` × `security-reviewer` ×
   perf review (run on all files touched in slices 1–6).
2. Fix every finding; re-run validate after each round.
3. Pass 2 of reviews, then pass 3 (same parallel agents, fresh
   diff context each round).
4. **Stryker** — `npx stryker run` scoped to the new files +
   touched domain files. Kill every killable mutant. Annotate
   provable equivalents inline with `// equivalent-mutant: <why>`.

## Slice 8 — Docs + BACKLOG + PR

1. **README** — no change (the new primitives are tier-2; the
   landing README already explains tier-1 commands).
2. **docs/get-started/node.md** — add a recipe: "compute a blob
   OID without writing" (`hashBlob` example).
3. **docs/use/api-primitives.md** — add five sub-sections, one
   per new primitive, each with a runnable snippet and a link to
   the ADR.
4. **docs/understand/architecture.md** — no change (tier
   organisation unchanged).
5. **docs/understand/design-decisions.md** — add ADRs 162–165 to
   the curated index.
6. **CONTRIBUTING.md** — add the five new files to the design
   checklist (`hash-blob.ts`, `is-ignored.ts`, `stage-entry.ts`,
   `unstage-entry.ts`, `set-entry-flags.ts`).
7. **RUNBOOK.md** — note the new primitive surface under
   "Public API."
8. **BACKLOG flip** — `[~] 20.2` → `[x] 20.2` in
   `docs/BACKLOG.md`. Same PR's own commits, per
   `feedback_apply_the_workflow.md`.
9. Push the branch, open the PR with a thorough body (summary +
   test plan checklist). Wait for CI green and user merge — do
   NOT auto-merge.

## Dependencies between slices

```
Slice 1 (domain) ───┬─► Slice 2 (hashBlob)      ───┐
                    ├─► Slice 3 (isIgnored)         ├─► Slice 6 (parity)
                    └─► Slice 4 (stage/unstage) ───┤    ─► Slice 7 (review)
                          └─► Slice 5 (setFlags)  ──┘       ─► Slice 8 (docs/PR)
```

Slices 2 and 3 are parallelizable (no shared internals); slices 4
and 5 are sequential (5 reuses the lock pattern from 4 and its
unit-test fixtures). Slices 6 → 7 → 8 are strictly ordered.

## Convergence note

This plan was self-reviewed once after the first draft; review
caught the missing reference to `serializeAndHash` in slice 2 and
clarified that slice 4 ships two primitives together. No further
revisions needed — converged at pass 2.
