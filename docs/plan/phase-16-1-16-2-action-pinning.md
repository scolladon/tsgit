# Plan — Phase 16.1 / 16.2 action SHA pinning

Derived from `docs/design/phase-16-1-16-2-action-pinning.md` and ADR-057. Two
slices, two commits, one branch (`ci/action-sha-pinning`). No `src/` code.

## Slice 1 — Pin every external action (16.1)

Replace each external `uses: <action>@<tag>` with
`uses: <action>@<40-hex-sha> # <version>`, per the ADR-057 table. Each
substitution is verbatim and uniform — within a file, every occurrence of a
given `<action>@<tag>` is replaced (`replace_all`). Local `./.github/...`
references are never touched.

**Files and the external actions each references:**

| File | Actions to pin |
|------|----------------|
| `.github/actions/setup/action.yml` | `setup-node` |
| `.github/workflows/ci.yml` | `checkout`, `upload-artifact`, `cache`, `github-action-benchmark`, `megalinter` |
| `.github/workflows/bench.yml` | `checkout`, `cache`, `upload-artifact` |
| `.github/workflows/gh-pages.yml` | `checkout`, `upload-pages-artifact`, `deploy-pages` |
| `.github/workflows/mutation-os.yml` | `checkout`, `upload-artifact` |
| `.github/workflows/npm-service.yml` | `checkout`, `setup-node` |
| `.github/workflows/pkg-pr-new.yml` | `checkout` |
| `.github/workflows/pre-publish.yml` | `checkout` |
| `.github/workflows/release.yml` | `release-please-action` |
| `.github/workflows/weekly-reports.yml` | `checkout`, `upload-artifact`, `actions-gh-pages`, `github-action-benchmark` |

SHA table (from ADR-057): checkout `34e114876b0b11c390a56381ad16ebd13914f8d5`
(v4.3.1) · setup-node `49933ea5288caeca8642d1e84afbd3f7d6820020` (v4.4.0) ·
upload-artifact `ea165f8d65b6e75b540449e92b4886f43607fa02` (v4.6.2) ·
upload-pages-artifact `56afc609e74202658d3ffba0e8f6dda462b719fa` (v3.0.1) ·
deploy-pages `d6db90164ac5ed86f2b6aed7e0febac5b3c0c03e` (v4.0.5) ·
cache `0057852bfaa89a56745cba8c7296529d2fc39830` (v4.3.0) ·
release-please-action `5c625bfb5d1ff62eadeeb3772007f7f66fdcf071` (v4.4.1) ·
actions-gh-pages `4f9cc6602d3f66b9c108549d475ec49e8ef4d45e` (v4.0.0) ·
github-action-benchmark `52576c92bccf6ac60c8223ec7eb2565637cae9ba` (v1.22.1) ·
megalinter `e08c2b05e3dbc40af4c23f41172ef1e068a7d651` (v8.8.0).

**Verify:** `grep -rhE 'uses: [^.]' .github | grep -vE '@[0-9a-f]{40}'`
returns nothing.

_Commit:_ `ci: pin github actions to commit shas`.

## Slice 2 — Group Dependabot action updates (16.2)

Edit the existing `github-actions` entry in `.github/dependabot.yml`:
- add `open-pull-requests-limit: 10` and `reviewers: [scolladon]` (parity with
  the `npm` entry);
- add a `groups:` block with one group `github-actions` matching `["*"]` so
  every action bump arrives as a single weekly PR.

The `npm` entry is left untouched.

_Commit:_ `ci: group dependabot action updates into one pr`.

## Verification (workflow steps 6-8)

- `npm run validate` — green (docs + config only; no `src/` change).
- The grep check above shows zero un-pinned external `uses:`.
- Every touched `.github/**/*.yml` still parses as YAML (a `@tag` →
  `@sha # tag` substitution only adds an inline comment, but parse anyway).
- Three review passes on the diff.
- Mutation: no `src/` change — surface unchanged, nothing to run.
- Docs: `RUNBOOK.md` CI section gains a one-line note that actions are
  SHA-pinned + Dependabot-refreshed; flip `docs/BACKLOG.md` 16.1 + 16.2 to
  `[x]`.
- Push, open PR, squash-merge on green.

## Dependencies

The two slices touch disjoint files (workflows vs `dependabot.yml`) and could
land in either order. Slice 1 is committed first so the history reads as
"pin, then automate the refresh".
