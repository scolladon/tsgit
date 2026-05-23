# Design — Audience-first documentation restructure (Phase 18.2)

**Status:** Draft.

Backlog: **18.2** — _"Documentation polish for a newcomer audience — restructure README and top-level docs to be easy to read and to showcase the library."_

## 1. Goal

A newcomer **grasps tsgit and runs a working snippet in under a minute**. Maintainers know exactly which file each kind of content lives in. Doc-rot risk is reduced via structural discipline (and bounded further by **18.3** harness, follow-up PR).

Non-goals (this phase):

- New code, new commands, or new primitives.
- Bundle-size measurement scripts (deferred to **26.5**).
- Competitor benchmark numbers in README (deferred to **26.6**).
- Deno / Bun / Workers test matrix (deferred to **19.8**).
- Doc-drift detection in CI (deferred to **18.3**, follow-up PR).

## 2. Current state — what we're moving away from

The pre-v1 layout was **content-type-first**:

```
README.md            (453 lines — value prop + 15 feature walkthroughs)
DESIGN.md            (architecture, perf strategy, security properties)
MIGRATION.md         (isomorphic-git mapping, 12 KB)
CONTRIBUTING.md      (development workflow)
RUNBOOK.md           (operational guide)
SECURITY.md          (vulnerability reporting)
docs/
  prd/               (one PRD)
  design/            (per-phase design docs)
  plan/              (per-phase TDD plans)
  adr/               (one per decision)
  spike/             (research notes)
  BACKLOG.md
```

Symptoms of the failure mode:

- A newcomer asking "how do I clone?" lands on a 453-line README and has to scroll past phase status tables and benchmark methodology before they find a working snippet.
- A maintainer adding a new command has no canonical place to document it — the tendency is to bolt another walkthrough onto README, which only widens the rot.
- `MIGRATION.md` is the only "audience-targeted" file in the layout (audience = iso-git refugees); everything else is "by-content-type".
- `DESIGN.md` collapses three concerns (architecture, performance, security) into one document, making selective updates hard.

## 3. Decision — Audience-first three-funnel layout

```
README.md             (≤ 90 lines — value prop + 60 s quickstart + jump links)
CONTRIBUTING.md       (unchanged — audience = contributors)
RUNBOOK.md            (unchanged — audience = operators)
SECURITY.md           (unchanged — GitHub auto-surfaces)
CHANGELOG.md          (release-please owns)
LICENSE
docs/
  get-started/        ─── learn ─── newcomer onboarding (audience: never used tsgit)
    node.md
    browser.md
    memory.md
    migrate-from-isomorphic-git.md
  use/                ─── do ────── working reference (audience: building with tsgit)
    api-commands.md
    api-primitives.md
    recipes.md
    errors.md
  understand/         ─── why ───── architectural narrative (audience: reasoning about tsgit)
    architecture.md
    design-decisions.md
    performance.md
    security.md
  adr/                (unchanged — historical decisions)
  design/             (unchanged — per-phase design docs)
  plan/               (unchanged — per-phase TDD plans)
  prd/                (unchanged)
  spike/              (unchanged)
  BACKLOG.md          (rewritten in a separate commit — already landed in a03bbb9)
```

Each funnel maps to one Diátaxis quadrant collapsed with a sibling:

| Funnel | Diátaxis correspondence | Audience |
|---|---|---|
| `get-started/` | tutorial + ramp-up how-to | "I've never used tsgit" |
| `use/` | reference + task-oriented how-to | "I'm building with tsgit" |
| `understand/` | explanation | "I want to know why" |

Rationale for collapsing vs strict 4-quadrant Diátaxis: a v1 library doesn't have enough material to justify separate "tutorial" + "how-to" folders. Collapse now; if `get-started/` outgrows itself we split. ADR-092 captures this trade-off.

## 4. Content moves — old file → new home

| From | To | Notes |
|---|---|---|
| `README.md` §Phase status table | `docs/BACKLOG.md` only | Already there; remove from README |
| `README.md` §Features bulleted | `README.md` §Capabilities (rewritten) | Drops command enumeration (redundant with `use/api-commands.md`); keeps Foundations + Surface + Quality |
| `README.md` §Cloning a remote | `docs/use/recipes.md` — "clone + checkout" | |
| `README.md` §Partial clone | `docs/use/recipes.md` — "partial clone with lazy-fetch" | README keeps a 12-line "one composition" snippet only |
| `README.md` §Staging files | `docs/use/api-commands.md` — `add` section + `docs/use/recipes.md` — "stage with globs" | |
| `README.md` §Push | `docs/use/api-commands.md` — `push` section | |
| `README.md` §Git hooks | `docs/use/recipes.md` — "hook integration" | |
| `README.md` §Progress reporting | `docs/use/recipes.md` — "progress + cancellation" | |
| `README.md` §Cancellation | `docs/use/recipes.md` — "progress + cancellation" | Merged with progress |
| `README.md` §Composable primitives | `docs/use/api-primitives.md` | Full reference + composition examples |
| `README.md` §Reflog | `docs/use/recipes.md` — "navigate ref history" | |
| `README.md` §Sparse checkout | `docs/use/recipes.md` — "materialise a subset" | |
| `README.md` §Submodules | `docs/use/recipes.md` — "walk submodules" | |
| `README.md` §`cat-file --batch` | `docs/use/recipes.md` — "streaming object reader" | |
| `README.md` §Benchmarks | `docs/understand/performance.md` (full table + methodology + targets) | README quotes 6 numbers only |
| `README.md` §Architecture | `docs/understand/architecture.md` | |
| `README.md` §Development | dropped — points at `CONTRIBUTING.md` | |
| `DESIGN.md` §Architecture (layers, dep rule, two-tier API, principles) | `docs/understand/architecture.md` | |
| `DESIGN.md` §Security Properties | `docs/understand/security.md` | |
| `DESIGN.md` §Performance Strategy | `docs/understand/performance.md` | |
| `DESIGN.md` §Subsystems | `docs/understand/architecture.md` (appendix) | |
| `MIGRATION.md` (entire file) | `docs/get-started/migrate-from-isomorphic-git.md` | Voice unchanged; references updated |

Root files **deleted** (no redirect stubs, ADR-093):

- `DESIGN.md` — all references are internal (workflow rules, historical plan docs); no external link discovery
- `MIGRATION.md` — same

Workflow file edits (one-liner per file):

- `CLAUDE.md` step 8 — replace `DESIGN.md` reference with `docs/understand/*`
- `CONTRIBUTING.md` "Update docs" — same

## 5. README — content and honesty boundaries (ADR-094)

The new README is **≤ 90 lines** and contains nine sections, in order:

1. Title + badges (CI, npm, license)
2. One-line value prop + roadmap pointer
3. Install (one bash block)
4. 60 s quickstart (4-line snippet + runtime table + jump link)
5. One composition (~12-line snippet showcasing partial-clone + lazy-fetch + AsyncIterable)
6. Capabilities — three buckets: Foundations · Surface · Quality. No command enumeration.
7. Why tsgit — self-contained: design goals + 6 measured performance rows. **No competitor mentions, no tree-shaken numbers.**
8. Documentation — three jump links to the three funnels
9. Contribute + License (one line each)

Honesty boundaries enforced in 18.2:

- **Runtime claims** — README states only Node + Browser + in-memory (tested today). Deno + Bun + Cloudflare Workers are deferred until **19.8** lands a green parity matrix.
- **Bundle size** — README cites the size-limit-enforced bound (Node entry < 60 KB gz). No tree-shaken number until **26.5** ships measurement scripts.
- **Performance** — README quotes 6 medians from `reports/benchmarks/summary.md` as-measured. No competitor row. No "X× faster" headline. Honest about where tsgit is slower today (`log:walk`, `readBlob:cold-cache`). Deeper comparison deferred to `docs/understand/performance.md` and **26.6**.
- **Quality claims** — only assertions whose proof lives in CI today (100% coverage, mutation tested, cross-platform CI).

## 6. Voice & structure conventions for the new folders

Every page under `docs/get-started/` MUST:

- Open with a 1-paragraph value statement: who this page is for, what they'll have at the end
- Lead with a runnable snippet inside the first screenful
- End with a "Next steps" section that links 3–5 onward routes (no dead ends)

Every page under `docs/use/` MUST:

- Open with a 1-line surface summary
- Group entries alphabetically OR by category (whichever fits the file's nature); declare the chosen order in a header line
- Each entry: signature → one-line summary → 1–2 examples → cross-links to related entries and underlying primitives

Every page under `docs/understand/` MUST:

- Open with a 1-paragraph "what this document explains"
- Lead with the bottom line (decision, claim, measurement) before the justification
- Link out to ADRs / design docs for the full receipts

These rules are advisory at land time; **18.3** harness will enforce structural pieces (link integrity, API drift).

## 7. Failure modes considered

| Failure | Mitigation |
|---|---|
| External inbound links to `/blob/main/DESIGN.md` break | Internal-only references confirmed by grep audit (Section 3, ADR-093). Risk is bookmarks; npm `homepage` and README never linked to `DESIGN.md`. |
| Doc-rot under the new structure (more files = more places to forget) | **18.3** harness as immediate follow-up PR. Until then, `CLAUDE.md` workflow step 8 enforces by-hand. |
| Voice drift across 12 new files | Section 6 conventions; checkpoint-mode review with user catches voice drift early. |
| Newcomer hits `docs/use/api-commands.md` and finds it stale vs source | **18.3** API drift check (`scripts/check-doc-coverage.ts`) catches this in CI from then on. Pre-18.3 we rely on workflow discipline. |
| `MIGRATION.md` deletion causes pain for in-flight iso-git migrators reading our README via npm | Content moved verbatim to `docs/get-started/migrate-from-isomorphic-git.md`; README's quickstart section links to it directly. |

## 8. Out of scope — explicit non-goals

- Translations / localised docs (no demand signal)
- TypeDoc HTML hosting changes (`reports/api/` continues to generate; placement TBD in **18.3**)
- Versioned doc snapshots per release (release-please cuts CHANGELOG; doc evolves on `main`)
- A separate "API" subdomain / docs site (`docs.tsgit.dev`) — we ship Markdown in-repo; users read on GitHub. Hosting decision parked.
- Image / diagram assets (the existing architecture text-art block is sufficient for v1; visual diagrams are a Phase 23+ concern)

## 9. Plan

See `docs/plan/18-2-audience-first-doc-restructure.md` (next).

## 10. ADRs landed with this design

- ADR-092 — Audience-first documentation structure (3-funnel choice over Diátaxis-strict or surface-first)
- ADR-093 — Drop `DESIGN.md` and `MIGRATION.md` without redirect stubs
- ADR-094 — README honesty boundaries (no untested runtime claims; no competitor rows; size-limit-enforced bundle bound)
