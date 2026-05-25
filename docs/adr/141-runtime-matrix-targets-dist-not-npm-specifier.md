# ADR-141: Runtime matrix targets `dist/`, not `npm:@scolladon/tsgit`

## Status

Accepted (at `4911c0d`)

## Context

The Phase 19.8 backlog proposes a runtime-parity matrix where Deno
imports tsgit "via npm specifier (`npm:@scolladon/tsgit`)". Deno honours
that specifier directly (it resolves the latest published version from
npm); Bun supports the same pattern via `bun install`.

The question for CI is what *version* of tsgit each runtime should load.
Two options:

1. **`npm:` specifier (or equivalent install-from-registry).** Deno's
   `npm:@scolladon/tsgit` pins to whatever is on npm. Bun's
   `bun install @scolladon/tsgit` does the same.
2. **Local `dist/`.** Each runtime driver imports from a relative path
   into `dist/esm/index.{node,default}.js` produced by the existing
   `build` job on this branch.

Option 1 tests last week's published artifact, not this PR's code. A
regression introduced in the PR would not surface until *after* the
release lands. Option 2 tests the artifact this branch produces — which
is what a future `@scolladon/tsgit@next` will actually contain.

## Decision

PR CI tests the `dist/` artifact produced by the `build` job on the
current branch. Drivers import:

- `dist/esm/index.node.js` for Node-adapter scenarios (Deno + Bun).
- `dist/esm/index.default.js` for Memory-adapter scenarios (Deno + Bun +
  Workers).

The runtime matrix jobs `actions/download-artifact@v4` the `dist`
artifact uploaded by the existing `build` job.

A `npm:` smoke step belongs in release/post-publish CI (`pre-publish.yml`
already exists). 19.8 does not duplicate that signal in PR CI.

## Consequences

### Positive

- Matrix gates the actual code on the PR, not the previous release.
- Zero registry latency in feedback loop.
- Re-uses the `dist` artifact already produced by `build` — no
  duplicated build step.
- The on-disk dist IS what users `npm install`, so the path under test
  matches the path under consumption.

### Negative

- Does not exercise the actual registry tarball metadata
  (`package.json`, `files` array, etc.). Mitigated by `pre-publish.yml`
  which runs `attw` + manifest checks on the packaged tarball.
- A user-facing import via `npm:@scolladon/tsgit` could in principle
  resolve differently than a direct file-path import (e.g. a missing
  conditional export). Mitigated by the existing `check:exports` step
  and `attw`.

### Neutral

- Future post-publish smoke testing remains an open option but is out
  of scope for 19.8.
