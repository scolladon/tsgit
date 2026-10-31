---
subjects:
  - src/adapters/node/node-file-system.ts
  - src/application/primitives/ref-store.ts
  - test/integration/fsck-broken-ref-chain-interop.test.ts
phases: [design, implementation]
kind: gotcha
trigger: a git behaviour that stops, truncates or reports "the first" entry of a directory walk
evidence:
  - src/adapters/node/node-file-system.ts:1415
  - test/integration/fsck-broken-ref-chain-interop.test.ts:1400
source: { run: fsck-broken-ref-chain-unreadable, phase: planning, date: 2026-10-31 }
status: active
supersedes: []
last-verified: 2026-10-31
---
# 026 — Node's readdir is sorted; git reads the OS order

## Context

git's `refs verify` stops at an unresolvable symlinked ref and its root-ref check stops at the first
error, so which findings git prints depends on the order `readdir(3)` returns. The design assumed
Node's `fs.readdir` returns that order. A planning probe refuted it on APFS: `readdirSync` gave
`a b m y z`, `opendir` and `ls -f` gave `z a m b y`. Eight interop rows had to wait for a new
optional `FileSystem.readdirInOsOrder` (Node: `opendir`) before they could match git.

## Lesson

Node's `fs.readdir` sorts its result; `fs.opendir` iterates in the operating system's order, which is
git's. Any git behaviour that depends on walk position is reproducible only through the second.

## How to apply

When git stops, truncates or picks "the first" entry of a directory walk, read that directory with
`readdirInOsOrder` (or `opendir`), never `readdir`.
Derive the interop expectation from git's own output on the same throwaway; never hard-code an order.
Run such rows several times on fresh fixtures (lesson 022, lesson 023).

## Evidence

- `src/adapters/node/node-file-system.ts:1415` — the OS-order read.
- `test/integration/fsck-broken-ref-chain-interop.test.ts:1400` — the OS-order family, compared in
  git's sequence, three runs each.

<!-- cspell:ignore opendir -->
