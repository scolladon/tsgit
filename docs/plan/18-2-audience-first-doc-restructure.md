# Plan — Audience-first documentation restructure (Phase 18.2)

Derived from `docs/design/18-2-audience-first-doc-restructure.md` and ADRs 092–094. No code changes; pure documentation move + rewrite. `npm run validate` before every commit (catches `cspell` regressions, markdown lint, link checker once 18.3 lands).

## Slice graph

```
A (BACKLOG restructure) ──── already landed (a03bbb9)
B (design + ADRs 092/093/094)       ─► already landed (b2d574a, 6872c7d, and this checkpoint)
C (get-started funnel)              ─► node sample landed (dfe83db)
D (use funnel)                      ─► api-commands voice sample lands with this plan
E (understand funnel)
F (README rewrite)
G (delete DESIGN.md + MIGRATION.md + workflow edits)
H (BACKLOG tick 18.2 → [x])
```

C, D, E run in parallel after the voice samples are approved. F depends on C–E being substantially complete (jump-links must resolve). G runs after F. H is the final commit.

Convergence cap: this is a documentation move, not a code change. Self-review × max 3 still applies to each new file but in practice a single pass suffices because the source content already exists.

## Step C — `docs/get-started/` (4 files)

**Files added:**

- `docs/get-started/node.md` ✅ (voice sample — landed in `dfe83db`)
- `docs/get-started/browser.md`
- `docs/get-started/memory.md`
- `docs/get-started/migrate-from-isomorphic-git.md`

**Method:**

- `browser.md` mirrors the `node.md` shape: prerequisites → install → open repo (with `rootHandle`) → first operations → cleanup → next steps. OPFS-specific notes inline (no `process.cwd()`; sandboxed origin; Playwright as the test surface).
- `memory.md` same shape, audience-shifted to test authors: prerequisites (vitest / jest / anything) → install → seed files → open + exercise → assertions → next steps.
- `migrate-from-isomorphic-git.md` ports `MIGRATION.md` verbatim with two edits: (1) the file is reachable from `docs/get-started/` so internal links update to `../use/` / `../understand/`; (2) the deleted "Compatibility shim?" section's pointer at ADR-091 stays.

**Commits (atomic, one per file):**

- `docs(get-started): browser quickstart`
- `docs(get-started): memory adapter quickstart`
- `docs(get-started): migration from isomorphic-git`

## Step D — `docs/use/` (4 files)

**Files added:**

- `docs/use/api-commands.md` (Tier-1 reference)
- `docs/use/api-primitives.md` (Tier-2 reference)
- `docs/use/recipes.md` (composed flows)
- `docs/use/errors.md` (`TsgitError` codes + reason payload shape)

**Method:**

- `api-commands.md` — one section per Tier-1 command, alphabetical order (declared in the file header). Each section: signature → 1-line summary → options table → 1–2 examples → cross-links to primitives it composes + related commands. Voice sample: `clone` and `add`, lands with this plan.
- `api-primitives.md` — same shape, one section per Tier-2 primitive. Highlights the `AsyncIterable` composition pattern at the top so users grasp the operator toolkit's relevance.
- `recipes.md` — task-oriented; titles are "Do X" sentences. One recipe per former README walkthrough: clone+checkout, partial clone with lazy-fetch, stage with globs, hook integration, progress + cancellation, navigate ref history, materialise a subset (sparse), walk submodules, streaming object reader.
- `errors.md` — table of every `TsgitError.code`, the `reason` shape when present, and which commands/primitives can throw it. Generated initially by grep over `src/domain/errors/`; refined for prose.

**Commits:**

- `docs(use): api-commands reference`
- `docs(use): api-primitives reference`
- `docs(use): recipes`
- `docs(use): error reference`

## Step E — `docs/understand/` (4 files)

**Files added:**

- `docs/understand/architecture.md` (absorbs `DESIGN.md` §Architecture + §Subsystems)
- `docs/understand/design-decisions.md` (curated ADR index — not a reverse chronological dump; grouped by subsystem)
- `docs/understand/performance.md` (absorbs `DESIGN.md` §Performance Strategy; carries `reports/benchmarks/summary.md` table inline; methodology section; deferred competitor comparison placeholder for **26.6**)
- `docs/understand/security.md` (absorbs `DESIGN.md` §Security Properties)

**Method:**

- `architecture.md` opens with the hexagonal-architecture overview, the dependency rule, the two-tier API. Sections in order: Layers → Tiered API → Design Principles → Subsystems table → Cross-cutting invariants. No re-derivation; this is the home for the "what we built and why" narrative.
- `design-decisions.md` is the navigation aid for `docs/adr/`. Sections by subsystem (Domain, Storage, Refs, Transport, Application, Repository facade). Each entry: short title → ADR link → 1-line decision summary. The reader who lands here is asking "why was X chosen?" and wants the ADR fast.
- `performance.md` carries the same six rows as the README plus a methodology paragraph (platform, Node version, sample count, RME bound), the full `reports/benchmarks/summary.md` link, and a "Targets" section that names the **26** perf-pass roadmap items.
- `security.md` carries the security properties table from `DESIGN.md` plus a "How to report" pointer at root `SECURITY.md`.

**Commits:**

- `docs(understand): architecture`
- `docs(understand): design decisions index`
- `docs(understand): performance methodology`
- `docs(understand): security model`

## Step F — README rewrite

**Files touched:**

- `README.md`

**Method:**

- Rewrite in place to the ≤ 90-line shape locked in design §5 and ADR-094: title + badges + one-line value prop + roadmap pointer · install · 60 s quickstart + runtime table · one composition · capabilities (3 buckets) · why tsgit (goals + 6 measured rows) · documentation (3 jump links) · contribute · license.
- Honesty-boundary edits: no Deno/Bun/Workers in the opener; no competitor table; no tree-shaken size; no aspirational "X× faster".

**Commit:**

- `docs(readme): rewrite around audience-first layout`

## Step G — delete root docs + workflow edits

**Files touched:**

- `git rm DESIGN.md`
- `git rm MIGRATION.md`
- `CLAUDE.md` — step 8 swap (`DESIGN.md` → `docs/understand/*`)
- `CONTRIBUTING.md` — same swap in "Update docs"

**Commit:**

- `chore(docs): drop DESIGN.md and MIGRATION.md; update workflow refs`

## Step H — flip BACKLOG

**Files touched:**

- `docs/BACKLOG.md` (line: `**18.2** Audience-first doc restructure` → `[x]`)

**Commit:**

- `docs(backlog): tick 18.2`

## Review passes

After step H, run **three review passes** in parallel against the branch diff (per CLAUDE.md "Review the implementation three times"):

- **Pass 1 — doc-coverage agent.** Verify every Tier-1 command and every Tier-2 primitive appears in `docs/use/api-{commands,primitives}.md`. Verify every former root-doc section has a destination. Verify all internal jump links resolve.
- **Pass 2 — voice consistency.** Scan all new files for tone drift; flag pages that violate the §6 conventions (no opening value statement, no runnable snippet on first screenful, no "Next steps", etc.).
- **Pass 3 — honesty audit.** Re-read README against ADR-094 boundaries; verify no untested runtime claim, no competitor row, no tree-shaken number, no aspirational performance headline.

Findings from each pass → small follow-up commits before push.

## Validation gate

`npm run validate` must pass before push:

- cspell on every new file
- markdown lint
- ls-lint (kebab-case filenames)
- knip (no dead exports) — N/A for docs PR
- existing test suite — must still be green (no source code changed)

## Push + PR

Branch: `docs/18-2-audience-first-restructure`. PR body: link the design doc, ADRs 092–094, plan; list every file added / removed; cite this plan's slice graph as the table of contents. Squash-merge on green.

## What lands in this PR — file-count summary

- Added: `docs/design/18-2-audience-first-doc-restructure.md` (1)
- Added: `docs/adr/092-…md`, `093-…md`, `094-…md` (3)
- Added: `docs/plan/18-2-audience-first-doc-restructure.md` (1)
- Added: `docs/get-started/*.md` (4)
- Added: `docs/use/*.md` (4)
- Added: `docs/understand/*.md` (4)
- Removed: `DESIGN.md`, `MIGRATION.md` (2)
- Modified: `README.md`, `CLAUDE.md`, `CONTRIBUTING.md`, `docs/BACKLOG.md` (4)

Total: 17 added, 2 removed, 4 modified.

## Out of scope — explicit non-goals

- TypeDoc HTML output structure changes (`reports/api/` stays as-is)
- `.github/` template / `PULL_REQUEST_TEMPLATE.md` edits (separate concern)
- Doc-drift CI checks — those are **18.3** (follow-up PR)
- Per-doc-folder README sentinel files (overkill for v1; each folder's flat listing on GitHub suffices)
