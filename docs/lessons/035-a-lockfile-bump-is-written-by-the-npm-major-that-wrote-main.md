---
subjects:
  - package-lock.json
  - .claude/workflow.md
phases: [implementation, review]
kind: gotcha
trigger: bumping a dependency to clear check:deps with an npm major other than the one that wrote main's lockfile
evidence:
  - package-lock.json
  - .claude/workflow.md
source: { run: rev-list-objects-zero-count-boundary, phase: review, date: 2026-11-11 }
status: active
supersedes: []
last-verified: 2026-11-11
---
# 035 — A lockfile bump is written by the npm major that wrote main

## Context

Two patch releases landed mid-run, and `check:deps` went red. They were bumped with `npx npm@10`,
the version the worktree setup falls back to when the user's npm refuses project installs.
npm 10 writes no `libc` field: the bump removed all 37 `"libc": [...]` entries main's
lockfile carries, so 2 changed versions grew into a 135-line diff. Without those fields npm
cannot skip the musl or glibc native binaries on Linux CI. Rewriting the same bump with
`npx npm@11` from main's lockfile left a 12-line diff with all 37 fields kept.

## Lesson

The lockfile format belongs to the npm major that wrote it. A bump from a different major
rewrites fields the other major owns, and the next bump with the right major flips them back.

## How to apply

Before a bump, count `"libc"` in main's `package-lock.json`. When it is non-zero, bump with `npx -y npm@11`.
Start from main's lockfile: `git show <base>:package-lock.json > package-lock.json`, then install the new versions.
Check the diff covers only the bumped packages' version, resolved and integrity lines.
Re-run `npm run check:deps` before committing.

## Evidence

`package-lock.json` — the `"libc"` entries on the optional native-binary packages (37 at this
commit). `.claude/workflow.md` — the `pre-pr-gate: npm outdated` remediation that calls for the
`chore(deps)` bump.
