# ADR-092: Audience-first documentation structure

## Status

Proposed.

## Context

The pre-v1 documentation layout was **content-type-first**: `README.md` at the root, `DESIGN.md` / `MIGRATION.md` / `CONTRIBUTING.md` / `RUNBOOK.md` as siblings, and `docs/{prd,design,plan,adr,spike}/` underneath. This shape served the implementation phase well — each concern owned one file — but failed two audiences as the surface grew:

- A newcomer asking "how do I clone?" landed on a 453-line README and scrolled past a phase status table and a benchmark methodology block before finding a runnable snippet.
- A maintainer adding a new command had no canonical place to document its surface; the path of least resistance was bolting another walkthrough onto the README, which only widened the rot.

Three alternative structures were considered for the 18.2 restructure:

1. **Diátaxis (strict 4 quadrants):** `tutorials/`, `how-to/`, `reference/`, `explanation/`. The de-facto OSS standard. Maintenance discipline strong.
2. **Audience-first (3 funnels):** `get-started/` (learn), `use/` (do), `understand/` (why). Simpler than Diátaxis; collapses "tutorial" and "task how-to" together.
3. **Surface-first (API as spine):** `api/` as the primary navigation, with `guides/` and `concepts/` hanging off. Fastest path for git-fluent users.

## Decision

**Adopt audience-first.**

```
docs/
  get-started/   ── learn ──── newcomer onboarding
  use/           ── do ─────── working reference
  understand/    ── why ────── architectural narrative
  adr/           (unchanged)
  design/        (unchanged)
  plan/          (unchanged)
  prd/           (unchanged)
  spike/         (unchanged)
  BACKLOG.md
```

Diátaxis-strict was rejected on volume: a v1 library doesn't have enough material to populate four folders evenly — the "tutorial" folder would hold 1–2 files and "how-to" would balloon. The audience-first split collapses tutorial + ramp-up how-to into `get-started/` and reference + task-oriented how-to into `use/`, leaving room to split later if either folder outgrows itself.

Surface-first was rejected on first-impression: a user landing on `docs/api/` first has to know what they're looking for. The audience layout puts onboarding before reference, which is the right default for a library that wants new users.

## Consequences

### Positive

- Newcomers see exactly one funnel (`get-started/`) and never need to know about the others.
- Each new command lands its docs in a deterministic location (`use/api-commands.md`); no debate per PR.
- Folder names communicate audience without external knowledge of Diátaxis vocabulary.
- The 3-funnel split is small enough that `18.3` harness can enforce structural rules (link integrity, API drift, PR gate) without growing a Diátaxis-grade taxonomy in code.

### Negative

- Loses some of Diátaxis's rigour: a "task how-to" and a "tutorial" both live under `get-started/` or `use/`, and the choice between them is editorial. Mitigation: voice & structure conventions in §6 of the 18.2 design doc.
- Departs from a recognised industry pattern. Users who expect Diátaxis quadrants will not find them. Mitigation: the funnels are self-explanatory; no jargon is exposed.
- If `get-started/` outgrows itself, we'll need to split it later — at which point an ADR-supersede captures the migration. The split point is cheap.

### Neutral

- `adr/`, `design/`, `plan/`, `prd/`, `spike/` stay where they are. They serve maintainers, not users; folding them into the audience funnels would mix audiences.
- The root files (`CONTRIBUTING.md`, `RUNBOOK.md`, `SECURITY.md`, `CHANGELOG.md`, `LICENSE`) stay at the root. Each serves a non-user audience (contributors, operators, security reporters, release tooling, legal) that's better served by GitHub's root-level discoverability than by another funnel.

## Alternatives considered

- **Diátaxis-strict** — rejected for v1 volume; reconsider on a future restructure if `get-started/` or `use/` exceeds ~10 pages.
- **Surface-first** — rejected for newcomer hostility; the API reference is the most-visited page over time, but the first-time visitor needs onboarding, not signatures.
- **Status quo (content-type-first)** — rejected because the README balloon is the failure mode that triggered 18.2 in the first place.
- **No restructure; just rewrite README** — rejected because a leaner README pushes content onto sibling files (`MIGRATION.md` etc.), and those siblings have no shared shape. The funnel structure is what makes the README-trim sustainable.
