# Phase 19.7 — Implementation plan

Derived from `design/phase-19-7-interop-suite.md` + ADRs 137–140.

Three layers:

- **Layer 0 — Audit & wiring.** Land the gap-detector and its
  scaffolding *before* any surface coverage. Subsequent slices
  prove themselves by closing audit gaps.
- **Layer 1 — Surface sweep.** One atomic commit per surface; each
  commit ships the interop test + `@writes` tag together.
- **Layer 2 — CI + docs.** Pin git versions in CI, refresh
  contributor-facing docs, flip BACKLOG.

Each step lists: what test goes red, what code makes it green,
what to verify. Steps marked **‖** are independent of each other
within the layer — a parallel agent team can split them.

## Layer 0 — Audit scaffolding (sequential, single PR commit each)

### 0.1 — `parseWritesTag` (`tooling/audit-write-surfaces/parse-writes-tag.ts`)

- **Red**: `tooling/test/unit/audit-write-surfaces/parse-writes-tag.test.ts`
  with one happy-path case (`@writes` block with all three keys
  parses to a `WritesTag` value) and one error case (missing
  `kind` key reports `missing-key`).
- **Green**: pure-string parser following 19.4's
  `parseProvesHeader` shape — normalise CRLF → LF, skip optional
  shebang, locate first `/** … */`, find line starting `@writes`,
  walk forward parsing `key: value` lines.
- **Verify**: unit suite passes; biome + types green.

### 0.2 — Exhaustive grammar coverage

- **Red**: extend the unit suite with every error path from
  `design §3.2` (bad surface regex, bad kind enum, bad format
  length, two `@writes` blocks in one file, no JSDoc at top).
- **Green**: extend `parseWritesTag` to emit each `ParseError`
  variant; the type is a discriminated union per error reason.
- **Verify**: 100% line/branch/function coverage on
  `parse-writes-tag.ts`.

### 0.3 — `parseInteropSurface` (`tooling/audit-write-surfaces/parse-interop-surface.ts`)

- **Red**: `parse-interop-surface.test.ts` with:
  - Happy path: `interopSurface: tree` parses to `{ surfaces: ['tree'] }`.
  - Comma list: `interopSurface: packfile, packIndex` → `['packfile', 'packIndex']`.
  - Bucket contract: `bucket: cross-tool-interop` without
    `interopSurface:` → `MissingInteropSurface`.
  - Bucket contract: `bucket: real-fs` with `interopSurface:
    foo` → `UnexpectedInteropSurface`.
- **Green**: take a `ProvesHeader` (from 19.4's `parseProvesHeader`)
  + raw JSDoc text → `InteropCoverage | InteropError`.
- **Verify**: unit suite passes.

### 0.4 — `computeGaps` (`tooling/audit-write-surfaces/compute-gaps.ts`)

- **Red**: `compute-gaps.test.ts` with synthetic inputs
  covering: all covered, all gaps, mixed exempt, surface name
  in exempt list with no matching `@writes` (`AllowlistRot`).
- **Green**: set-difference function. Sort outputs by surface name
  (deterministic diff).
- **Verify**: unit suite passes.

### 0.5 — `loadAllowlist` (`tooling/audit-write-surfaces/load-allowlist.ts`)

- **Red**: `load-allowlist.test.ts` with empty allowlist, valid
  entry, missing `reason` field, empty `reason`, entry with
  unknown surface (cross-checked against the `WriteSurface` set).
- **Green**: JSON parse + schema validation; throws `AllowlistError`
  on any malformation.
- **Verify**: unit suite passes.

### 0.6 — CLI entry (`tooling/audit-write-surfaces.ts`)

- **Red**:
  `tooling/test/integration/audit-write-surfaces.test.ts` — build
  a temp tree (three src files: one `@writes` ok, one missing,
  one malformed; two test files: one matching, one orphaned).
  Invoke `main()`; assert exit code, stderr content,
  `reports/write-surface-coverage.json` shape.
- **Green**: implement `parseInteropCoverage` (thin orchestrator
  inside the CLI module — calls 19.4's `parseProvesHeader` then
  19.7's `parseInteropSurface` per file). Wire `parseWritesTags`,
  `parseInteropCoverage`, `loadAllowlist`, `computeGaps`. Honour
  `gating.writeSurfaces` flag from manifest (initially `false` —
  warn-only).
- **Verify**: integration suite passes.

### 0.7 — Empty allowlist + manifest additions

- Create `tooling/audit-write-surfaces.allowlist.json`:
  `{ "surfaces": [] }`.
- Extend `tooling/test-pyramid-budgets-schema.json` with the two
  19.4-side keys (`interopSurfaceRegex`,
  `interopSurfaceRequiredFor`).
- Add `gating.writeSurfaces: false` to manifest.
- **Red**: `parse-manifest.test.ts` extension for the new keys.
- **Green**: `parseManifest` reads + validates them.
- **Verify**: unit suite passes.

### 0.8 — Wireit + validate integration

- Add `check:write-surfaces` to `package.json` (per design §3.9).
- Append it to the `validate` deps array.
- **Verify**: `npm run check:write-surfaces` runs (and reports
  14 gaps since no `@writes` tags exist yet); `npm run validate`
  still succeeds because the audit is warn-only.

Each of 0.1–0.8 lands as its own atomic commit (eight commits in
Layer 0 total). The convention is "one Red→Green cycle per
commit." After 0.8, the audit reports 14 gaps; the next 13 commits
close them one at a time. Slice 1.12 closes two gaps (packfile +
packIndex via a single combined test).

## Layer 1 — Surface sweep (one atomic commit per surface)

Each slice below follows the same TDD pattern:

1. **Red**: write the interop test under `test/integration/<file>`.
   File name follows existing kebab-case convention; pick a
   descriptive name (e.g. `loose-object-interop.test.ts`,
   `packfile-interop.test.ts`). The `bucket: cross-tool-interop`
   header is the audit signal, not the file name — the existing
   `reflog-writers.test.ts` is grandfathered with its descriptive
   name. New files default to the `*-interop.test.ts` suffix for
   pattern visibility, but this is convention, not a parser rule.
   Test invokes tsgit's highest-level relevant API (`commit()`,
   not `writeObject()`), executes the comparison strategy for the
   declared `kind`, asserts.
2. **Green**: add the `@writes` JSDoc block to the module that
   emits the bytes (per `design §2.2 Source` column). The audit
   gap for this surface closes.
3. **Verify**: `npm run check:write-surfaces` reports one fewer
   gap; `npm run test:integration` passes; `npm run validate` is
   green.
4. **Commit**: conventional-commits subject — `feat(interop):
   <surface> round-trips against canonical git` for
   `byte-identical` and `equivalent-under-readback` surfaces;
   `feat(interop): <surface> readback against canonical git` for
   `readback-only`.

### 1.1 ‖ — `looseObject` (byte-identical)

- Test: write a blob via `writeObject`; in peer tmpdir run `git
  hash-object -w <same-content>`; read both `.git/objects/<sha>`
  files; assert byte equality. Repeat for tree + commit + tag
  payloads (parameterised over `[blob, tree, commit, tag]`).
- Tag: `src/application/primitives/write-object.ts`.

### 1.2 ‖ — `tree` (byte-identical)

- Test: build a tree with mixed entry kinds (file, executable,
  symlink, submodule, subdir); write via tsgit; compare with peer
  tmpdir tree built by `git update-index --add` + `git
  write-tree`.
- Tag: `src/domain/objects/tree.ts`.

### 1.3 ‖ — `commit` (byte-identical)

- Test: commit with parents (0, 1, 2), author/committer with
  timezone offsets covering East/West/UTC, multi-line message
  with trailing newlines; compare against peer tmpdir produced by
  `git commit-tree`.
- Tag: `src/domain/objects/commit.ts`.

### 1.4 ‖ — `tag` (byte-identical)

- Test: annotated tag with multi-line message; compare against
  peer tmpdir produced by `git tag -a`.
- Tag: `src/domain/objects/tag.ts`.

### 1.5 ‖ — `looseRef` (byte-identical)

- Test: write `refs/heads/main` via tsgit; in peer tmpdir run
  `git update-ref refs/heads/main <sha>`; assert file bytes
  match (sha + `\n`).
- Tag: `src/domain/refs/loose-ref.ts`.

### 1.6 ‖ — `packedRefs` (byte-identical)

- Test: in peer tmpdir, init + commit + `git tag -a v1 -m "…"` to
  create a peeled annotated tag + `git branch feature` for a
  second branch; run `git pack-refs --all`. Read
  `<peer>/.git/packed-refs`. Build the equivalent ref set with
  tsgit; write `.git/packed-refs`; assert byte equality.
- Tag: `src/domain/refs/packed-refs.ts`.

### 1.7 ‖ — `symbolicRef` (byte-identical)

- Test: write `HEAD` pointing at `refs/heads/main`; compare
  against peer tmpdir `git symbolic-ref HEAD refs/heads/main`.
- Tag: `src/application/primitives/write-symbolic-ref.ts`.

### 1.8 ‖ — `index` (byte-identical, v2 + v3 parameterised)

- Test: parameterise over `version: [2, 3]`. For v3 entries, drive
  canonical `git` to write v3 via `git update-index --add
  --replace --skip-worktree …` after `git config index.version 3`
  (the canonical mechanism — `--index-version` is not a flag on
  `update-index`). Build index with entries covering: regular
  file, executable, symlink, sparse-worktree flag (v3 only),
  intent-to-add (v3 only). Write via tsgit; assert byte equality.
  Pre-compare normalisation: zero out stat-cache mtime/ctime/dev/
  ino fields (per design §4.4) — the contract is content + path +
  mode + flags + sha + trailer SHA.
- Tag: `src/domain/git-index/index-writer.ts`.

### 1.9 ‖ — `sparseCheckoutFile` (byte-identical)

- Test: write `.git/info/sparse-checkout` with mixed cone +
  non-cone patterns; compare against peer tmpdir produced by
  `git sparse-checkout set --cone <…>` and `git sparse-checkout
  set --no-cone <…>`.
- Tag: `src/application/primitives/write-sparse-checkout.ts`.

### 1.10 ‖ — `shallowFile` (byte-identical)

- Setup is heavier than the other byte-identical slices because
  `.git/shallow` is only populated by a shallow fetch/clone, not
  by any local-only command. The test:
  1. Init a bare repo `<bare>` in tmpdir; commit 5 things into a
     working repo and push to `<bare>`.
  2. Shallow-clone `<bare>` with `--depth 2` into peer tmpdir;
     read the resulting `<peer>/.git/shallow`.
  3. With tsgit on the working repo, write the equivalent SHAs
     into `.git/shallow` via the primitive.
  4. Assert byte equality of the two `shallow` files.
- Tag: `src/application/primitives/shallow-file.ts`.

### 1.11 — `reflog` (byte-identical, tag-only + test edit)

- No new test file. Edit
  `test/integration/reflog-writers.test.ts` to add `interopSurface:
  reflog` to the existing `@proves` block.
- Tag: `src/domain/reflog/reflog-format.ts` with a 5-line `@writes`
  block.
- Atomic commit: `feat(interop): claim reflog under write-surface
  audit`.

### 1.12 — `packfile` + `packIndex` (equivalent-under-readback,
combined test)

- Test: build a small repo via tsgit (5 commits, 3 file changes);
  invoke `buildPack` to produce `.git/objects/pack/<…>.pack` +
  `.idx`. Run `git fsck --strict` (must exit 0). Enumerate objects
  via `git cat-file --batch-all-objects --batch-check`; compare
  to peer tmpdir produced by `git repack -a -d`. Object set must
  match; per-object `git cat-file -p` content must match.
- Tag: `src/domain/storage/pack-writer.ts` *and*
  `src/domain/storage/pack-index.ts`. Test header lists
  `interopSurface: packfile, packIndex` (comma form per design
  §3.3 grammar).
- Single commit covers both surfaces.

### 1.13 — `config` (readback-only)

- Test: write a config covering `[user] name`, `[user] email`,
  `[core] repositoryformatversion`, a multi-value key
  (`[remote "origin"] fetch` with two entries); read via `git
  config --list -z` (NUL-delimited, robust to embedded `=` in
  values); parse into a `Map<string, ReadonlyArray<string>>`;
  assert the map matches expected. Multi-value keys produce
  multiple parsed entries — the test asserts the array, not a
  single value. No file diff.
- Tag: `src/application/primitives/update-config.ts`.

After 1.13 lands, `npm run check:write-surfaces` reports 0 gaps.

## Layer 2 — CI + docs

### 2.1 — CI matrix entry (single commit)

- Add an `interop-git-pinned` job to `.github/workflows/ci.yml`
  that installs git 2.39 (via marketplace setup-git action or
  local composite step — pick whichever ships first per design
  §3.8) and runs the full integration suite (`npm run
  test:integration`). The interop tests live mixed at the
  integration root with `bucket: cross-tool-interop`; no path
  filter needed.
- The existing `validate` workflow already runs the integration
  suite against `ubuntu-latest`'s preinstalled git (the `latest`
  slot of the matrix); no edit there.
- Upload each matrix entry's test report as a separate artefact.

### 2.2 — Docs refresh (single commit, ideally combined with 2.3)

- `CONTRIBUTING.md` — add a paragraph under the existing testing
  section: "When you add a module under `src/` that writes Git-
  on-disk bytes, declare its surface with a `@writes` JSDoc tag
  and ship a matching interop test. See `docs/design/phase-19-7-
  interop-suite.md`."
- `docs/understand/architecture.md` — note the canonical-git
  oracle for write paths under the "Testing" sub-section if one
  exists; otherwise add a one-paragraph subsection.
- `docs/understand/design-decisions.md` — add ADRs 137–140 to
  the curated index.

### 2.3 — BACKLOG flip + audit gating bump prep

- `docs/BACKLOG.md`:
  - `[ ] 19.7` → `[x] 19.7` with the same shape as 19.5a/19.6
    rows (ADR + design link suffix).
  - Add an entry under "Cross-cutting invariants" or a follow-up
    bullet pointing at a planned ADR for flipping
    `gating.writeSurfaces: true` after one cycle. (The flip
    itself is a separate, tiny PR — out of scope for this one
    per ADR-139.)

## Sequencing notes

- Layer 0 is **strictly sequential** (each step builds on the
  previous's exports). One contributor or one agent.
- Layer 1 steps 1.1–1.10 + 1.13 are **independent** (each touches
  a different src file + creates a different test file). A
  parallel agent team works well; each agent owns one slice in
  its own sub-worktree, atomic commits land sequentially against
  the main worktree once validation passes.
- Layer 1 step 1.11 (reflog) is the smallest slice — a 5-line
  `@writes` block in src + one new `interopSurface:` line in the
  existing test. Can land any time after Layer 0.
- Layer 1 step 1.12 (packfile + packIndex) is single-contributor
  due to the shared trailer SHA logic — the test needs both
  writers' state.
- Layer 2 lands last (CI matrix runs the layer 1 tests; docs +
  BACKLOG flip describe the finished state).

## Verification gates (run before every commit)

```
npm run check                  # biome
npm run check:types            # tsc
npm run check:test-pyramid     # 19.2/19.4 still green after the new tests
npm run check:write-surfaces   # closes one gap per layer-1 commit
npm run test:unit              # unit suite
npm run test:integration       # full integration suite incl. new interop tests
npm run validate               # full chain (slow — run before PR push)
```

Mutation testing (`npm run test:mutation`) runs in Layer 3 (post-
implementation review pass per the project workflow §6) — not
required per commit but required before PR push.

## Convergence pass log

- **Pass 1** — initial draft.
- **Pass 2** — fixed Layer 0 commit granularity (eight atomic
  commits, not one); rewrote 1.10 setup to account for `.git/shallow`
  needing a bare-repo + shallow-clone peer (it has no local-only
  population path); clarified test file naming convention (default
  `*-interop.test.ts` suffix, reflog precedent grandfathered);
  switched commit prefix from `test(interop):` to `feat(interop):`
  (we ship a new write-surface declaration + coverage together).
- **Pass 3** — folded `parseInteropCoverage` definition into 0.6
  (it had no slice); reworked 1.6 setup so peer tmpdir produces the
  annotated tag before `pack-refs --all`; fixed 1.8 to use `git
  config index.version 3` instead of the non-existent `--index-
  version` flag on `update-index`; harmonised 1.11 commit prefix to
  `feat(interop):`; replaced `git config --list` with `--list -z` in
  1.13 so multi-value keys parse without ambiguity; replaced the
  invalid `npm run test:integration -- path` snippet in 2.1 with a
  plain `npm run test:integration`; deleted redundant §2.4;
  corrected sequencing-notes "one-line edit" claim for 1.11.

Converged at pass 3.
