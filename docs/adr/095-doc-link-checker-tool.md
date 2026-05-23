# ADR-095: Markdown link checker — lychee over markdown-link-check

## Status

Accepted (at `5cb6a6b`)

## Context

Phase 18.3 needs an automated markdown link checker in CI to prevent the audience-first doc structure from rotting. Two candidates dominate the OSS landscape:

- [`lychee`](https://github.com/lycheeverse/lychee) — Rust, single binary, official GitHub Action (`lycheeverse/lychee-action`)
- [`markdown-link-check`](https://github.com/tcort/markdown-link-check) — Node, npm-installable, also an established GitHub Action

The deliverable in `docs/BACKLOG.md` Phase 18.3 lists both as candidates ("lychee or markdown-link-check").

## Decision

Use **lychee**.

Drivers:

- **Speed.** Lychee parallelises link extraction and HTTP checks by default; on this repo's doc tree (~70 markdown files, ~200 outbound links once we include `docs/adr/`) it completes in well under 30 seconds. `markdown-link-check` runs sequentially per file and is closer to 3–5 minutes on a similar corpus.
- **Lower false-positive rate on rate-limited hosts.** Lychee retries with exponential backoff and accepts a configurable status-code allowlist (e.g. `200..=299, 429`). `markdown-link-check`'s retry story is per-file via `aliveStatusCodes` and less ergonomic.
- **Config file co-located with the repo.** `.lychee.toml` lives in the repo root; excludes, accept lists, timeout, and concurrency all sit in one TOML file under version control. `markdown-link-check` uses a JSON file per directory or a single global file — same outcome, less idiomatic in our toolchain (we already have `cspell.json`, `.dependency-cruiser.cjs`, `.ls-lint.yml` in root).
- **CI footprint.** `lycheeverse/lychee-action` is a single composite action with no Node install step. `markdown-link-check` requires `actions/setup-node` plus an `npm install -g`. One less moving piece.
- **Active maintenance.** Lychee's release cadence (monthly) outpaces `markdown-link-check` (gaps of ~6 months between releases as of 2026).

## Consequences

### Positive

- CI job completes in under 30s on the full doc tree — well inside the < 90s budget for the four doc-maintenance jobs combined.
- Excludes (historical artifacts: `docs/plan/`, `docs/spike/`, `docs/design/phase-13-4b-*.md`) live in `.lychee.toml` as `exclude_path` entries — explicit, grep-able, reviewable.
- External-URL flakiness handled in-config without per-URL ignores in source files.

### Negative

- Local invocation requires installing the lychee binary (no npm wrapper). Contributors run `brew install lychee` / `cargo install lychee` once; `CONTRIBUTING.md` adds the install hint. A contributor without lychee installed cannot reproduce the check locally — they must rely on the CI run.
- Rust toolchain dependency for contributors who choose `cargo install lychee`. (`brew` and pre-built tarballs avoid this.)

### Neutral

- We will revisit if lychee's maintenance slows below `markdown-link-check`'s. Migration cost: a single workflow file rewrite + `.lychee.toml` → `.markdown-link-check.json` translation. Low.
