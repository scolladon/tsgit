---
subjects:
  - vitest.bench.config.ts
  - tooling/typescript-hooks.mjs
  - tooling/register-typescript-hooks.mjs
  - tooling/profile.ts
---
# 913 — Benchmarks load natively, through a TypeScript transpile hook

- **Status:** accepted
- **Date:** 2026-10-01
- **Design:** none (issue #303) · **Supersedes/Refines:** none

## Context

`test:bench`, `bench:ab` and CI's `benchmark-compare` / `benchmark-snapshot` all run
`vitest bench --config vitest.bench.config.ts`, which evaluates `src/` and the bench files
through Vite's module runner: every cross-module binding becomes a getter on a namespace
object. #303 proposes turning the runner off and importing the built output.

Measured on this repo (macOS arm64, Node 22.22.3, Vitest 4.1.11; best-of-2 interleaved rounds,
104 tsgit scenarios; ground truth = the same bench files driven by tinybench in plain Node,
no Vitest):

| loading | vs plain Node |
|---|---|
| module runner (today) | off by **−37 % … +85 %** per scenario, both directions |
| runner off + Node's native type stripping (#303 as written) | **+25 … +40 %** on every hot path |
| runner off + transpile hook (this ADR) | within noise |

- Runner overhead is real: 46 / 104 scenarios drop > 5 % without it — `diff-recursive` −34 %,
  `fsck` −22 %, `closure` −21 %, `blame` −20 %, `pack-read` −16 %. Median −3.8 %.
- It also hides cost: `diff-renames` hostile reads 27 ms under the runner, 31 ms in plain Node
  and in the hook config; native `DecompressionStream` 8 MiB reads 4.8 ms vs 8.9 ms. This is the
  #305 "regression only inside the bench process" — the runner under-reported the base.
- **Node's type stripper poisons the process.** One `module.stripTypeScriptTypes()` call (what
  Node runs to load any `.ts`) makes unrelated, already-loaded JS 25–40 % slower for the rest
  of the process (Node 22.22.3; ~12 % on 24/25). Not GC, not source maps, not module hooks, not
  WebAssembly per se. #303's step 3 relies on exactly this loader, so as written it trades one
  distortion for a uniform slowdown.
- Per-module native ESM matches the shipped rollup bundle within noise (`diffLines` 0.83–0.92 ms
  tsc mirror vs 0.85–0.89 ms `dist/`), so measuring per-module code is faithful to what ships.

## Options considered

1. **Runner off + a `registerHooks` load hook that transpiles `.ts` with `typescript`'s
   `transpileModule`, plus `.js`→`.ts` resolve fallback; workers start with
   `--no-experimental-strip-types`** — *recommended.* No build step, no import edits, raw-report
   keys (`test/bench/x.bench.ts > …`) unchanged. A `.ts` that escapes the hook fails loudly
   (`Unknown file extension ".ts"`) instead of silently re-poisoning the run.
2. Runner off + benches import a tsc mirror (`dist-bench/`) + native stripping for bench files
   (#303 as written) — rejected: the stripping penalty above.
3. Precompile `src/` + `test/bench/` with tsc, run the emitted `.bench.js`, rewrite report keys
   back to `.bench.ts` — honest numbers, but adds a build dependency to every bench entry point
   and a key-rewriting step to keep the gh-pages series addressable.
4. Keep the runner, document the bias — rejected: the bias is not uniform, so base-vs-PR ratios
   lie whenever a change moves code across modules.

## Decision

**Option 1 — user decision.** The hook lives in `tooling/` and is shared: `vitest.bench.config.ts`
registers it as a setup file, and `tooling/profile.ts` starts its `--prof` child with
`--import` of the same registration and `--no-experimental-strip-types` — the child loaded the
tooling `.ts` chain through Node's stripper and sampled a poisoned process.

The gh-pages level shift is **accepted and annotated** (PR body + `docs/perf`), not reset.

## Consequences

- Every bench entry point inherits it through `vitest.bench.config.ts`; `bench:ab`'s base worktree
  keeps its own (runner-on) config until the base ref contains this change.
- Bench files keep their `.js` relative specifiers and must stay `transpileModule`-compatible
  (isolated modules — already enforced by `isolatedModules` / `verbatimModuleSyntax`).
- `raw.json` and the `bench-summarize` / `bench-check` / `bench-to-snapshot` outputs keep their
  schema and keys; their **values** step-change on the first snapshot after merge. The gh-pages
  series carries a level shift at that commit, and the PR's own `benchmark-compare` is runner-on
  base vs runner-off head — not like-for-like.
- `npm run profile` digests are captured from a child that never loads the stripper from this change on.
- `test:perf` (wall-clock budget guards, not benchmarks) is unchanged.
