# Phase 16.1 / 16.2 — GitHub Action SHA pinning + Dependabot grouping

Design for two Phase 16 supply-chain hardening items:

- **16.1** Pin every third-party GitHub Action `uses:` reference to a 40-char
  commit SHA (Phase 11 security review, MEDIUM).
- **16.2** Make the Dependabot config keep those SHA pins fresh, grouped into a
  single PR.

## 1. Background

A `uses: owner/repo@v4` reference resolves a *mutable* tag at run time. If the
tag is moved to a malicious commit (a documented supply-chain attack — e.g.
`tj-actions/changed-files`, 2025), every workflow run silently executes the
attacker's code with the workflow's token. Pinning to an immutable 40-char
commit SHA removes that vector: the SHA is content-addressed and cannot be
re-pointed.

The repo currently uses moving tags everywhere. `npm run check:deps` and the
CI MegaLinter stage do not catch this; the Phase 11 security review flagged it
and the backlog deferred the fix to Phase 16.

## 2. 16.1 — Pinning policy

**Pin every non-local action to a SHA, including `actions/*`.** GitHub's own
`actions/*` tags are mutable too; a defence-in-depth posture pins them all. The
only exception is the repo-local composite action `./.github/actions/setup`,
which is not a tag reference and carries no supply-chain risk.

Format — SHA plus a trailing `# <version>` comment so the reference stays
human-readable and Dependabot can track the version:

```yaml
- uses: actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5 # v4.3.1
```

### Action → SHA table

Resolved from the current major-tag tip (`gh api repos/<a>/commits/<tag>`):

| Action | Pinned SHA | Version |
|--------|-----------|---------|
| `actions/checkout` | `34e114876b0b11c390a56381ad16ebd13914f8d5` | v4.3.1 |
| `actions/setup-node` | `49933ea5288caeca8642d1e84afbd3f7d6820020` | v4.4.0 |
| `actions/upload-artifact` | `ea165f8d65b6e75b540449e92b4886f43607fa02` | v4.6.2 |
| `actions/upload-pages-artifact` | `56afc609e74202658d3ffba0e8f6dda462b719fa` | v3.0.1 |
| `actions/deploy-pages` | `d6db90164ac5ed86f2b6aed7e0febac5b3c0c03e` | v4.0.5 |
| `actions/cache` | `0057852bfaa89a56745cba8c7296529d2fc39830` | v4.3.0 |
| `googleapis/release-please-action` | `5c625bfb5d1ff62eadeeb3772007f7f66fdcf071` | v4.4.1 |
| `peaceiris/actions-gh-pages` | `4f9cc6602d3f66b9c108549d475ec49e8ef4d45e` | v4.0.0 |
| `benchmark-action/github-action-benchmark` | `52576c92bccf6ac60c8223ec7eb2565637cae9ba` | v1.22.1 |
| `oxsecurity/megalinter` | `e08c2b05e3dbc40af4c23f41172ef1e068a7d651` | v8.8.0 |

Each pin resolves the tag's *current* commit, so the pin is functionally
identical to today's behaviour — no version change, only an immutability
guarantee.

### Files touched (16.1)

Every `uses:` line referencing an external action, across:
`ci.yml`, `bench.yml`, `gh-pages.yml`, `mutation-os.yml`, `npm-service.yml`,
`pkg-pr-new.yml`, `pre-publish.yml`, `release.yml`, `weekly-reports.yml`, and
the composite action `.github/actions/setup/action.yml`. The local
`./.github/actions/setup` references are left untouched.

## 3. 16.2 — Dependabot grouping

`.github/dependabot.yml` already has a `github-actions` ecosystem entry — it
just lacks grouping, so a pinned-SHA refresh would open one PR *per action*.

The backlog text says "group with `update-strategy: lockfile-only`".
`update-strategy` is an **npm-only** option (`lockfile-only` / `widen` /
`increase`) and is not valid for the `github-actions` ecosystem — see ADR-057.
The functional intent ("keep action bumps to one low-noise PR") is achieved by
a `groups:` block instead.

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

`patterns: ["*"]` collapses every action update into a single weekly PR.
`open-pull-requests-limit` + `reviewers` are added for parity with the
existing `npm` entry.

## 4. Testing / verification

- No `src/` code changes — `npm run validate` is unaffected except
  `check:filesystem` (no new files) and `check:spelling` (docs only).
- Workflow YAML is validated by the CI MegaLinter stage; locally, each edit is
  a pure `@tag` → `@sha # tag` substitution that cannot change YAML structure.
- Correctness check: every pinned SHA was resolved from the live tag, so the
  workflows run the exact same action code as before the pin.
- After the change, every external `uses:` must be SHA-pinned:
  `grep -rhE 'uses: [^.]' .github | grep -vE '@[0-9a-f]{40}'` must return
  nothing (local `./...` references start with `.` and are excluded by the
  first grep).

## 5. Decisions → ADR

**ADR-057** — Pin all external actions (incl. `actions/*`) to SHA; use a
Dependabot `groups:` block rather than the backlog's `update-strategy:
lockfile-only` (which the `github-actions` ecosystem does not support).

## 6. Out of scope

- Pinning transitive actions used *inside* third-party actions (not
  controllable from this repo).
- A CI lint rule that *enforces* SHA pins going forward — a reasonable Phase 16
  follow-up, but 16.1/16.2 only establish the pinned state + the Dependabot
  refresh loop.
