# 507 — Mutation-runner phantom survivors: no local config change; equivalence proofs + upstream fix

- **Status:** accepted (user judgment — scope and contribution posture chosen directly);
  decision 1 ("no tsgit config change — none helps") superseded by ADR-508 after the
  bail root cause was pinned
- **Date:** 2026-07-26
- **Design:** docs/spike/stryker-vitest-empty-run-survivors.md · **Refines/Supersedes:**
  none (closes backlog 27.5; complements the mutation-triage procedure in
  `.claude/workflow/mutation.md`)

## Context

Backlog 27.5 recorded that Stryker's vitest-runner "mis-pairs tests and
mutants" and listed config levers to try. The 27.5 investigation root-caused
the real defect instead: the runner scores a mutant run that executed **zero**
of its filtered tests as *survived* — vitest 4 occasionally completes a run
with its tasks collected but never executed (only under real Stryker load;
single-process isolation with every ingredient mimicked is clean), and the
runner's result-less filter misreads that as "all bail-skipped". Every config
lever (pool, `coverageAnalysis`, `related`, `ignoreStatic`) was tested and
refuted; a retry-guard in the runner eliminates the phantom survivors
(verified 5/5 on the published repro). The historic "proven false survivor"
on `correspond.ts:118` was a mutant-identity mixup; the two genuine survivors
there are provably equivalent.

## Decision

1. **No tsgit config change** — none helps; the config stays as-is.
2. **Document the two genuine `correspond.ts` survivors as equivalent** with
   inline proof comments (complete-assignment argument for the `j >= 0`
   operand; exact-match pinning argument for the `exactOldI < 0` operand), per
   the repo's `// Stryker disable next-line <mutators>: equivalent` convention.
3. **The mutation-triage procedure is the local mitigation** until the
   upstream fix lands: hand-verify survivors with the exact replacement, the
   full covering set, and an external watchdog.
4. **The fix is contributed upstream, not vendored**: a stryker-js PR carrying
   the retry-guard (with the repro's before/after evidence) is prepared
   separately; nothing is patched into tsgit's `node_modules`. No external
   communication happens until the write-up is mastered — the user reviews
   issue comments and PR text before anything is posted.

## Consequences

- The CI mutation job's scores remain a lower bound until upstream ships; the
  budget gate stays non-blocking and local triage stays the authority.
- Backlog 27.5 is closed by this resolution; the spike doc is the permanent
  technical record and the seed for the upstream issue/PR text.
- If the upstream PR is rejected, the fallback is vendoring the guard via
  patch-package — a new decision at that point, not pre-approved here.
