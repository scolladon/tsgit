# Plan — Phase 16.1 / 16.2 action version management

Derived from `docs/design/phase-16-1-16-2-action-updates.md` and ADR-057.
One branch (`ci/action-sha-pinning`), one implementation slice.

16.1 (SHA pinning) is **abandoned** per ADR-057 — no workflow files change.
The only code change is the Dependabot grouping for 16.2.

## Slice — Group the Dependabot `github-actions` entry (16.2)

**File:** `.github/dependabot.yml`.

Edit the existing `github-actions` ecosystem entry (the `npm` entry is left
untouched):

- add `open-pull-requests-limit: 10` and `reviewers: [scolladon]` — parity
  with the `npm` entry;
- add a `groups:` block with one group `github-actions` matching `["*"]` so
  every action bump lands as a single weekly PR.

**Verify:** `.github/dependabot.yml` still parses as YAML; the `npm` entry is
byte-identical; the `github-actions` entry has the new keys.

_Commit:_ `ci: group dependabot action updates into one pr`.

## Verification (workflow steps 6-8)

- `npm run validate` — green (docs + one config file; no `src/` change).
- YAML parse check on `.github/dependabot.yml`.
- Three review passes on the diff.
- Mutation: no `src/` change — surface unchanged, nothing to run.
- Docs: `RUNBOOK.md` — note that actions float on major tags and Dependabot
  keeps them current; `docs/BACKLOG.md` — move **16.1** to "Abandoned work"
  (`[x]`, linking ADR-057) and flip **16.2** to `[x]`.
- Push, open PR, squash-merge on green.
