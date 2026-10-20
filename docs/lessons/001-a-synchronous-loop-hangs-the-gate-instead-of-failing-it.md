---
subjects:
  - src/domain/range-diff/**
  - test/unit/domain/range-diff/**
phases: [implementation, review, validation]
kind: technique
trigger: a test run sits on the same progress line for minutes with one worker near full CPU and no failure printed
evidence:
  - test/unit/domain/range-diff/linear-assignment.characterization.test.ts
  - src/domain/range-diff/linear-assignment.ts
source: { run: lift-delta-chain-read-cap, phase: review, date: 2026-10-20 }
status: active
supersedes: []
last-verified: 2026-10-20
---
# 001 — A synchronous loop hangs the gate instead of failing it

## Context

The review-phase `npm run validate` stalled for 5 h 36 min at 23 of 24 scripts. One vitest
fork was spinning at full CPU inside a fast-check property over the range-diff solver: a
drawn cost matrix sent the augmenting walk to `j = -1`, and the `do … while (i1 !== i)` loop
never returned. vitest's per-test timeout is a timer; a synchronous loop never yields to it,
so the suite could neither fail nor finish. The log's modification time had not moved for
hours, which was the first visible clue.

## Lesson

A hang is not a slow run. Before waiting, check the worker's CPU and the log's mtime: a
silent log and a busy worker mean a spin. The spin is located on the live process, not by
reading code: `kill -USR1 <pid>` opens node's inspector, a WebSocket client sends
`Debugger.enable` and `Debugger.pause`, and the `Debugger.paused` event carries the call
frames and their locals — here the exact 7×7 matrix. Replayed under an external alarm the
matrix reproduced deterministically, and git's own `linear-assignment.c`, compiled against a
stub header, gave the assignment the port must return. The four hanging matrices are now
pinned to git's output, not the port's.

## How to apply

Treat a silent log plus a busy worker as a spin; do not wait it out.
Run suspect suites under an external alarm: `perl -e 'alarm 90; exec @ARGV' -- npx vitest run <file>` (macOS has no `timeout`).
Locate the spin on the live process with the inspector (`kill -USR1`, `Debugger.pause`) and read the frame's locals.
Replay the extracted input under the alarm before theorising; keep the paused process until it is captured.
Pin the input with the oracle's output (git's C here), never with the port's.

## Evidence

`test/unit/domain/range-diff/linear-assignment.characterization.test.ts` — the four
git-oracle rows; before `6a8f8537` the first of them never returned (exit 142 under a 90 s
alarm). `src/domain/range-diff/linear-assignment.ts` — the port now carries git's `j`
across the search.
