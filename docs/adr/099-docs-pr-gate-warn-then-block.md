# ADR-099: Path-based docs PR gate — warn-then-block ramp

## Status

Accepted (at `5cb6a6b`)

## Context

Phase 18.3 introduces a path-based docs PR gate: when a PR touches `src/application/commands/<name>.ts` or `src/application/primitives/<name>.ts`, it should also touch the corresponding `docs/use/{commands,primitives}/<kebab>.md` page or its funnel `README.md` index.

A gate like this can land in two postures:

- **Block immediately** — every PR that doesn't satisfy the rule fails CI. Strong signal, immediate enforcement.
- **Warn first, block later** — first iteration writes a PR comment + step-summary annotation; never `exit 1`. Promote to blocking after one cycle of real-PR observation.

The risk profile of blocking immediately:

- The rule has not been tested against the full distribution of PR shapes. Legitimate code-only PRs (type tightening, internal refactor, dead-code removal) may trip the gate even though no docs change is warranted.
- A new check that immediately blocks teaches contributors to look for escape hatches (PR labels, `--no-verify`-style bypasses). A warn-first ramp keeps the muscle memory aligned with the rule's *spirit*.
- 18.2 changed naming conventions in `docs/use/`. PRs already in flight at 18.3's land time may not match the new shape; one cycle of observation surfaces those.

## Decision

Land the gate **warn-only**. The CI job:

- Computes the changed-file set via `git diff --name-only <base>...<head>`.
- For each touched `src/application/{commands,primitives}/<name>.ts`, checks whether the same diff touches the matching `docs/use/{commands,primitives}/<kebab>.md` *or* the funnel `README.md`.
- On mismatch, posts (or updates) a PR comment with the informational template and writes the same summary to `$GITHUB_STEP_SUMMARY`.
- **Never exits non-zero.** `continue-on-error: true` is set on the job for the first iteration as a belt-and-braces guard.

Promotion to a blocking gate is a one-line change (remove `continue-on-error` and flip the script's `exit 0` to `exit 1` on mismatch). The promotion decision is owned by the next phase (18.4 or whenever drift signal warrants action) and lands in its own commit + ADR amendment.

The PR comment template includes an explicit "if your change is intentionally code-only, this is a no-op" note so contributors don't read the comment as a CI failure.

## Consequences

### Positive

- Zero risk of blocking legitimate PRs at land time.
- The signal accumulates: maintainers see in PR comments how often the rule trips and on what kind of changes. That data informs the promotion threshold.
- The escape-hatch mechanism (PR label `[skip-docs-gate]` or equivalent) can be designed during the warn phase, not retrofitted under pressure after the gate starts failing PRs.

### Negative

- A warn-only check is easy to ignore. Contributors who skim PR comments may miss the signal entirely. Mitigated by surfacing the same warning in `$GITHUB_STEP_SUMMARY` (visible on the PR's checks tab).
- The promotion step is "soon" but unscheduled. Risk of indefinitely warn-only: the rule degrades into a comment nobody reads. Mitigation: the promotion is tracked in `docs/BACKLOG.md` as the explicit follow-up after 18.3 lands.

### Neutral

- The script logic between warn-only and blocking modes is identical except for the exit code and `continue-on-error`. Flipping it is cheap.
- If during the warn phase we discover the rule is too strict (e.g. trivial type-only PRs reliably trip it), we adjust the rule rather than the gate posture. The warn phase is observation, not just delay.
