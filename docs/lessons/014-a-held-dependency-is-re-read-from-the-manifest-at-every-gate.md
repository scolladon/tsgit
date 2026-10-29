---
subjects:
  - .claude/workflow.md
  - package.json
phases: [propose, integrate]
kind: gotcha
trigger: npm outdated lists a row and the session is about to bump it
evidence:
  - .claude/workflow.md
  - package.json
source: { run: status-gitlink-parity, phase: integrate, date: 2026-10-25 }
status: active
supersedes: []
last-verified: 2026-10-29
---
# 014 — A held dependency is re-read from the manifest at every gate

## Context

The pre-PR gate is `npm outdated` with its exceptions written in the manifest body. After a
context compaction the session carried a one-line verdict — "only the Playwright runner is a
genuine bump" — and acted on it: `@playwright/test` went 1.62.1 → 1.64.1. The manifest held
that row at 1.62.1 with the proof: WebKit 26.6 fails `navigator.storage.getDirectory()` on the
Ubuntu runner, so the `e2e (webkit)` job goes red. CI reproduced it twice on the PR; the
revert, a second validate and a second CI round were the price.

## Lesson

A compaction summary's verdict on dependencies is not evidence. The exception block in the
manifest body is the contract the pre-PR gate names, and it is read at the gate, not recalled.

## How to apply

At the `npm outdated` gate, print the manifest's exception block beside the `npm outdated`
table and strike every row the block names before choosing what to bump.
Treat a bump of a held row as a defect, not a judgment call; the block states why it is held.
When a later version of a held row fails again, add the version and the PR to the block so the
next reader sees the history, and keep the "unpin once a later release passes" instruction.

## Evidence

`.claude/workflow.md` — the `pre-pr-gate: npm outdated` exception block, `@playwright/test` entry.
`package.json` — the exact-pinned `@playwright/test` row.
