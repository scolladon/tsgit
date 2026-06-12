Design session — promote and generalize the tsgit development workflow. No feature work
this session. Read these first:
- .claude/commands/apply-workflow.md (the current operational workflow, tsgit-specific)
- ~/.claude/CLAUDE.md § "Default feature workflow" (the user-global variant + its precedence rule)
- CLAUDE.md § "Development Workflow" (the in-repo summary + non-negotiables)

## Goal

One abstract, reusable workflow that any project can adopt, with tsgit as the first concrete
instantiation — without losing what makes the current one work.

Shape in mind (challenge it if you see better):
1. **Abstract skeleton with hooks + default handlers** — the phase sequence
   (branch → design → ADR → plan → implement-by-slices → review×4 → architecture refactor →
   mutation → docs → PR → merge/cleanup) is the invariant part. Each phase is a hook with a
   default handler; a project *declines* (overrides/specializes/no-ops) hooks via its own
   config — e.g. tsgit overrides the mutation hook with Stryker scoping + false-survivor
   triage and the faithfulness-pinning rule in design; a project without mutation tooling
   no-ops that hook. Decide the declination mechanism: per-project file
   (e.g. .claude/workflow.config.md) vs CLAUDE.md section vs skill arguments.
2. **Factor into dedicated agents/skills where it brings value** — today the per-phase
   prompts are assembled inline. Evaluate: custom agent definitions for the stable roles
   (designer, planner, slice implementer, 4 reviewers, triager, docs) vs inline assembly;
   a skill for the orchestration entry point; where the delegation map (fable
   design/plan/review, sonnet slices/refactor-exec/triage, haiku docs) should live.
3. **Where it ships**: ~/.claude (global skill + agents) vs a plugin vs a repo template.
   Recommend one with reasons.

## Hard requirement — enforcement over memory

Session memory is NOT an acceptable harness layer: it is unenforced, machine-local, and
silently lossy. Every workflow-load-bearing rule must live in an enforced, versioned
mechanism (slash command, CLAUDE.md, hook script, settings, or declination config) and the
design must define the layering rule: abstract skeleton vs project declination vs user
preference — with session memory demoted to scratch. The following rules currently live
ONLY in session memory and must be migrated into the appropriate layer:
- Closing steps: after PR up → monitor CI → fix to green (ignore non-blocking mutation /
  benchmark-compare jobs) → `gh pr merge --squash --delete-branch --admin` (main ruleset
  blocks normal merges) → `git sync` from the main worktree → prune the worktree's tooling
  registrations.
- Worktree lifecycle: fresh worktrees install their own deps (never symlink main's
  node_modules); worktree-rooted tooling activation/cleanup is a matched pair
  (create→activate, remove→prune — Serena today; the pattern generalizes). Serena
  stale-worktree recovery: activation failing with FileNotFoundError on a deleted sibling
  → mkdir -p the missing path, activate the new worktree, rmdir the placeholder.
- Mutation triage: local Stryker under vitest 4 reports false survivors; hand-apply the
  mutant and run the named UNIT test file (Stryker's scope) — a failing run = false
  survivor, no kill test. Post-refactor runs scope whole files; triage filters survivors
  to feature-changed logic, moved-verbatim machinery is declared out of scope in the PR body.
- Scope-fold recovery: an ADR-phase decision that widens scope after design → fresh
  design-revision agent fed the ADRs + existing doc; never patch in-session, never try to
  continue the original agent (committed artifacts, not agent context, are the handoff).
- Review → triage handoff: reviewer-predicted equivalent mutants (with proof sketch) are
  deferred and passed verbatim into the triage agent's prompt.
- Prompt-template environment gotchas: every diff-reading agent prompt carries
  `git diff --no-ext-diff` + run-from-worktree-cwd; concurrent background Stryker is safe
  only after the sandbox copy completes and with no npm install during the run.

## Lessons from the 24.9k run (2026-06-12) to bake into the design

- The plan-as-knowledge-handoff contract (pre-chewed per-slice context blocks) eliminated
  slice rediscovery — zero blockers across 4 slices. Keep it a hard contract.
- Subagents can die mid-flight (API errors) and there is no SendMessage to continue them —
  fresh respawn is the recovery; design phases so their committed artifact, not the agent's
  context, is the handoff.
- The haiku docs agent produced factual errors the session had to correct against the
  design doc; either contract a session-side fact-check of docs output, or drop haiku for
  behavior-bearing pages.
- Review rounds: 4 dimensions in parallel, fix-all in-session, MEDIUM+ relaunch scoped to
  the fix delta only — converged in 2 rounds; keep per-dimension convergence + severity rules.
- Mutation gates the PR; the triage procedure above is part of the hook's default contract.

## Deliverables

A short design doc for the abstract workflow (phase/hook table: name, default handler,
what tsgit overrides, what a bare project gets), the chosen packaging + declination
mechanism honoring the enforcement-over-memory requirement, and the migration plan for
tsgit (apply-workflow.md becomes the tsgit declination). Implementation only after we
agree on the design — start by interviewing me on the open choices, ≤3 options each,
like an ADR conversation.
