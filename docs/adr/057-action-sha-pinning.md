# ADR-057: GitHub Action version management — reject SHA pinning

## Status

Accepted (at `52809f6`)

## Context

Workflows reference actions by mutable major tag (`uses: actions/checkout@v4`,
`uses: oxsecurity/megalinter@v8`, …). A tag can be re-pointed; if an action's
publisher account is compromised the tag can be moved to a malicious commit
(the `tj-actions/changed-files` compromise, 2025, did exactly this).

The Phase 11 security review flagged this and the backlog (16.1) asked to pin
every action to an immutable 40-char commit SHA, with 16.2 wiring Dependabot to
keep the pins fresh.

Pinning was prototyped: every external `uses:` rewritten to
`uses: owner/repo@<40-hex-sha> # vX.Y.Z`. Reviewing the result, the cost stood
out:

- Every reference became a 40-character opaque hash; the workflow files lost
  readability at a glance.
- Every action patch release now needs a Dependabot SHA bump — a constant
  stream of low-value churn.
- The marginal security gain is small here: this repo's actions are all
  well-known publishers (`actions/*`, `googleapis/*`, `oxsecurity/*`,
  `peaceiris/*`, `benchmark-action/*`), and a grouped Dependabot already keeps
  majors current.

## Decision

**Do not pin GitHub Actions to commit SHAs.** Workflows keep floating
major-version tags (`@v4`, `@v3`, `@v1`, `@v8`). A major tag tracks the latest
release within its major, so the repo runs current, patched action code with a
readable reference.

**Keep actions current via a grouped Dependabot entry (16.2).** The existing
`github-actions` entry in `.github/dependabot.yml` gains a `groups` block
(`patterns: ["*"]`) so all action bumps — including major-version bumps —
arrive as a single weekly PR, plus `open-pull-requests-limit` / `reviewers`
for parity with the `npm` entry.

The backlog text for 16.2 said "group with `update-strategy: lockfile-only`".
`update-strategy` is an npm-ecosystem-only Dependabot option and is invalid for
`github-actions`; the `groups` block is the correct mechanism for the stated
intent (one low-noise refresh PR).

16.1 is therefore **abandoned** — recorded in the backlog's "Abandoned work"
section, linking this ADR.

## Consequences

### Positive

- Workflow files stay short and human-readable; a reviewer sees `@v4`, not a
  hash.
- No per-patch-release SHA churn — Dependabot only surfaces meaningful
  (major / grouped) updates.
- Actions still stay current: floating majors get patches automatically,
  Dependabot proposes major bumps.

### Negative

- The tag-mutation supply-chain vector is not eliminated. Accepted for a repo
  of this size with exclusively well-known action publishers; a future change
  in risk posture (or a move to many third-party actions) can revisit this.

### Neutral

- No workflow files change — they already float to the latest major.
- The SHA-pinning prototype is discarded; the decision, not the diff, is the
  artifact worth keeping.

## Alternatives considered

- **Pin every action to a SHA** (the backlog's 16.1) — rejected: verbose,
  opaque, high-churn, low marginal value here.
- **Pin to exact version tags** (`@v4.3.1`) — rejected: less opaque than a SHA
  but still needs a bump per patch release, and an exact tag is still mutable.
- **`update-strategy: lockfile-only`** (the backlog's 16.2 wording) — rejected:
  not a valid option for the `github-actions` ecosystem.
