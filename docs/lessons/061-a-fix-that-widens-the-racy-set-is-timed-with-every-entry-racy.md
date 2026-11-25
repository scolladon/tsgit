---
subjects:
  - src/application/primitives/internal/is-entry-stat-clean.ts
  - src/application/primitives/internal/smudge-racily-clean.ts
  - test/bench/status-racy-window.bench.ts
phases: [design, review]
kind: trap
trigger: a fix widens the set of entries a slow path handles, such as the racily clean set
evidence:
  - test/bench/status-racy-window.bench.ts
  - src/application/primitives/internal/smudge-racily-clean.ts:63
  - src/application/commands/add.ts:785
  - docs/design/whole-second-stat-match.md
source: { run: whole-second-stat-match, phase: review, date: 2026-11-25 }
status: active
supersedes: []
last-verified: 2026-11-25
---
# 061 — A fix that widens the racy set is timed with every entry racy

## Context

Under a nanosecond racy test almost no entry was racy. Under git's whole-second test every file
written in the index's second is: a fresh clone, a checkout, a test fixture. The design benched
`status` on such a tree and gated it. The perf review then ran three cycles, and each one found
another command paying for the wider set. `add .` hashed every racy file twice (3.77 against a
read-and-hash twin). The index write built its candidate keys over the whole index. The smudge
pass started one `lstat` and one read per racy entry at once: `add` of one path on a
100 000-file tree whose every entry is racy took over 240 s and 2.2 GB where git takes 4 to
12 s. That last cost was already on `main`; the fix made ordinary input reach it.

## Lesson

Widening the population of a slow path moves old costs from a corner to the common case. A
bench on one command says nothing about the other commands that walk the same population.

## How to apply

At design, build the extreme fixture: every tracked file staged in the index's second, at 100 000 files.
Time each command that reads or writes the index on it (`status`, `add .`, `add` of one path, `mv`, `checkout`) with git on the same fixture.
Look for work done twice per entry and for fan-out outside the I/O bound; weigh the peak heap as well as the time.
Gate what a ratio can separate (lesson 056) and record the rest, with its measurement, in the design.

## Evidence

`test/bench/status-racy-window.bench.ts` — the `status` and `add` pairs against their floor twins.
`src/application/primitives/internal/smudge-racily-clean.ts:63` — `carriedOver` keys only the
racy entries; `filterConcurrently` runs the pass through the I/O bound (14 to 17 s and under
310 MiB on the same tree).
`src/application/commands/add.ts:785` — `restagedIn`: the paths `add` staged are not read again
by the index write.
`docs/design/whole-second-stat-match.md` — "Performance" and "What review changed": the
measurements of each round.
