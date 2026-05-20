# Phase 16.1 / 16.2 — GitHub Action version management

Design for two Phase 16 supply-chain items:

- **16.1** "Pin every third-party GitHub Action to a 40-char commit SHA" —
  **abandoned.** See ADR-057.
- **16.2** Keep action versions current and low-noise via Dependabot.

## 1. 16.1 — abandoned

The backlog asked for SHA pinning. On review the decision is **not** to pin
(ADR-057): a SHA reference (`uses: actions/checkout@34e1148…f8d5 # v4.3.1`) is
verbose, opaque, and needs a Dependabot bump for every patch release — high
maintenance for marginal value on a small repo whose actions are all
well-known publishers (`actions/*`, `googleapis/*`, `oxsecurity/*`,
`peaceiris/*`, `benchmark-action/*`).

The workflows stay on **floating major-version tags** (`@v4`, `@v3`, `@v1`,
`@v8`). A major tag already tracks the latest release within its major, so the
repo always runs current, patched action code with a readable reference. The
residual tag-mutation risk is accepted for a project of this size.

No workflow files change.

## 2. 16.2 — Dependabot keeps actions current

`.github/dependabot.yml` already has a `github-actions` ecosystem entry — it
updates `uses:` major tags weekly. Two gaps:

- Without grouping, a week with several action updates opens several PRs.
- It lacks the `open-pull-requests-limit` and `reviewers` keys the sibling
  `npm` entry sets.

Change to the `github-actions` entry:

```yaml
  - package-ecosystem: github-actions
    directory: /
    schedule:
      interval: weekly
    open-pull-requests-limit: 10
    reviewers:
      - scolladon
    labels:
      - ci
    groups:
      github-actions:
        patterns:
          - "*"
```

`groups` with `patterns: ["*"]` collapses every action update into one weekly
PR. (The backlog text said "group with `update-strategy: lockfile-only`";
`update-strategy` is an npm-only option and is not valid for the
`github-actions` ecosystem — the `groups` block is the correct mechanism. See
ADR-057.)

The `npm` entry is untouched.

## 3. Testing / verification

- No `src/` code and no workflow files change — `npm run validate` is
  affected only by `check:spelling` (docs) and `check:filesystem` (the two
  renamed docs).
- `.github/dependabot.yml` still parses as YAML after the edit.
- The Dependabot config is exercised for real only by GitHub's Dependabot
  service; correctness is a structural review of the YAML against the schema.

## 4. Decisions → ADR

**ADR-057** — Reject SHA pinning for GitHub Actions; keep floating major tags;
keep actions current with a grouped Dependabot `github-actions` entry.

## 5. Out of scope

- Any change to workflow `uses:` references — they already float to the latest
  major.
- Pinning / enforcement tooling — explicitly rejected, not deferred.
