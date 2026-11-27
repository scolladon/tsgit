---
subjects:
  - src/application/**
  - test/unit/**
phases: [implementation, review, validation]
kind: gotcha
trigger: one options constant is passed by name to several finders or helpers, and a test pins its effect through one of them
evidence:
  - src/application/commands/internal/remote-branch-guess.ts
  - test/unit/application/commands/internal/remote-branch-guess.test.ts
source: { run: checkout-remote-branch-dwim, phase: review, date: 2026-11-27 }
status: active
supersedes: []
last-verified: 2026-11-27
---
# 067 — A shared option constant is pinned at every call site that passes it

## Context

The remote reader passes one constant, `SUBSECTIONED = { requireSubsection: true }`, to five
config finders. Two review cycles found the same gap twice. First no row pinned the constant at
all; a row was added for the three valueless-key finders, and flipping the constant then failed
it. A cycle later, the boolean finder added since still passed the constant with no row: deleting
the argument at that call site left every test green. Stryker cannot catch that. It mutates the
constant's object literal, and those mutants were already killed through the other call sites. It
does not drop an identifier argument.

## Lesson

A constant shared by name gets its mutation coverage from whichever call site the tests
reach first. Each call site that passes it can still lose the argument, or receive a different
constant, without a mutant to show it.

## How to apply

For each call site that passes a shared options constant, write one row whose outcome changes when that site's argument is dropped.
Prove the row by deleting the argument at that site in a throwaway copy and watching it fail.
When a later change adds a call site, add its row in the same commit.

## Evidence

`src/application/commands/internal/remote-branch-guess.ts` — `assertRemoteConfigReadable`: five
finders, each given `SUBSECTIONED`.
`test/unit/application/commands/internal/remote-branch-guess.test.ts` — "Given a valueless
$label outside any subsection": one row per finder, the boolean row added last.
