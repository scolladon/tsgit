---
subjects:
  - package.json
  - .claude/workflow.md
phases: [implementation, propose]
kind: gotcha
trigger: a dev-dependency bump installs cleanly but its CLI dies with MODULE_NOT_FOUND for a platform package
evidence:
  - package.json
  - .claude/workflow.md
source: { run: gc-size-lying-loose-blob, phase: implementation, date: 2026-10-21 }
status: active
supersedes: []
last-verified: 2026-10-29
---
# 007 — A dependency bump can ship without its platform binary

## Context

`npm outdated` named `@biomejs/biome` 2.6.0. The bump installed without a word, then every
`biome` call died with `Cannot find module '@biomejs/cli-darwin-arm64/biome'`: the release
declares its platform packages at 2.6.0 while the registry carries `cli-darwin-arm64` only up to
2.5.15, and npm skips an unresolvable optional dependency silently. A Linux runner would have
passed. The same shape had already forced the `jscpd` hold recorded in the manifest.

## Lesson

A package that ships per-platform optional dependencies is only installable when the platform
package exists at the declared version. `npm install` does not say when it does not. The check
is two `npm view` calls before the bump, and the remedy is a documented hold in the
`check:deps` exceptions, not a bump that works on CI alone.

## How to apply

Before bumping a package with platform optional dependencies, run `npm view <pkg>@<version> optionalDependencies` and `npm view <platform-pkg> versions`.
If the host's platform package is missing at that version, hold the current version with a documented `check:deps` exception.
Re-check the hold on the next PR and remove it once the platform package is published.

## Evidence

`package.json` — the `check:deps` exception list.
`.claude/workflow.md` — the `@biomejs/biome` hold and its reproduction note.
