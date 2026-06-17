# Design — retire-redundant-config-pins

> Brief: now that 24.9o ([ADR-337](../adr/337-interop-helper-home-isolation-non-existent-path.md)–[ADR-339](../adr/339-interop-sweep-drop-redundant-isolation-duplication.md)) hardened `test/integration/interop-helpers.ts` (isolated non-existent `HOME` + `GIT_CONFIG_NOSYSTEM=1` + redirected `XDG_CONFIG_HOME`, on top of the existing `GIT_*` scrub), retire the per-test config workarounds those guarantees made redundant — the corpus-wide `commit.gpgsign=false` pins and the four `-c merge.conflictStyle=merge` pins — but only after a **single centralized guard** pins the helper's full env-isolation contract so the protection moves from scattered safety nets into one intentional tripwire. Retain `config-interop`'s `--local`/`--file` distinction (it is real read-scoping, not belt-and-suspenders).
> Status: draft → self-reviewed ×3 → ready for ADR conversation

## Context

### The mechanism that made the pins redundant

`test/integration/interop-helpers.ts` is the shared spawn surface for every write-surface interop test. 24.9o promoted the faithfulness-pinning isolation discipline from a per-probe ritual into an always-on property of the helper. `buildSafeEnv()` (computed once into `SAFE_ENV`, copied per-call by `runGitEnv()`) now sets:

- the **`GIT_*` scrub** — every inherited `GIT_*` key is dropped from `process.env` (closes the husky-hook `GIT_DIR` leak; project memory "Isolate git subprocess env");
- `GIT_CEILING_DIRECTORIES = os.tmpdir()` — defence-in-depth against discovery-time walk-up;
- `HOME = <os.tmpdir()>/tsgit-interop-nonexistent-home` — a deterministic path that is never created, so `$HOME/.gitconfig` lookups miss and fail soft ([ADR-337](../adr/337-interop-helper-home-isolation-non-existent-path.md));
- `GIT_CONFIG_NOSYSTEM = '1'` — closes `/etc/gitconfig` ([ADR-337](../adr/337-interop-helper-home-isolation-non-existent-path.md));
- `XDG_CONFIG_HOME = <HOME>/.config` — points the independent XDG config root into the same non-existent tree ([ADR-338](../adr/338-interop-helper-xdg-config-home-inside-home.md)).

`runGit` / `tryRunGit` default to `SAFE_ENV`; `runGitEnv()` returns `{ ...SAFE_ENV }` so the 30+ callers that spread it (`{ ...runGitEnv(), GIT_AUTHOR_DATE, … }`) inherit all five guarantees and never clobber them (the added keys are author/committer vars, disjoint from the isolation keys).

The consequence ([ADR-339](../adr/339-interop-sweep-drop-redundant-isolation-duplication.md) Context): ~25 suites that pin `commit.gpgsign=false` and four that pin `-c merge.conflictStyle=merge` are now pinning values that the helper already neutralizes to git's built-in defaults. [ADR-339](../adr/339-interop-sweep-drop-redundant-isolation-duplication.md) explicitly **deferred** the corpus-wide retirement (its rejected Option 3) to a separate backlog entry, retaining the pins meanwhile as "self-documenting safety nets against a future weakening of the helper." **This is that entry (24.9t).**

### What 24.9o already shipped (the "guard" half is mostly present)

24.9o (#176) did **not** only harden the helper — it also landed a centralized tripwire, `test/integration/interop-env-hardening.test.ts`, and removed `missing-value-refusal-interop`'s duplicated local isolation ([ADR-339](../adr/339-interop-sweep-drop-redundant-isolation-duplication.md)). The existing tripwire asserts (read in full; enumerated, not from memory):

| guard | what it asserts | helper key it protects |
|---|---|---|
| global-config probe | `tryRunGit(['config','--get','merge.conflictStyle'])` → `ok === false`, empty stdout | `HOME` (non-existent) + behaviour |
| system-config probe | inject `GIT_CONFIG_SYSTEM=<tmp>/config` with a `credential.helper` sentinel → `--get credential.helper` → `ok === false`, empty | `GIT_CONFIG_NOSYSTEM` |
| HOME-shape probe | `runGitEnv().HOME` is defined, starts with `os.tmpdir()`, **does not exist** | `HOME` (non-existent) |
| XDG-shape probe | `runGitEnv().XDG_CONFIG_HOME === path.join(HOME, '.config')` | `XDG_CONFIG_HOME` |

The tripwire asserts **absence** (never a specific leaked value, which would only pass on one author's machine) and uses an injected sentinel for the system vector so it proves the closure on any machine. It does **not** currently assert the **`GIT_*` scrub** nor `GIT_CEILING_DIRECTORIES` — the original `GIT_DIR`-leak half of the contract (`man githooks` → husky → wireit → vitest workers). That is the one load-bearing gap this backlog's guard step should close, because the sweep removes pins whose only remaining job was insulating against config leaks, leaving the helper's env-isolation contract the sole protection — and that contract has two halves, only one of which is currently tripwire-pinned.

### Faithfulness pinning procedure

The empirical-pinning contract: `.claude/workflow/faithfulness.md`; prime directive [ADR-226](../adr/226-git-faithfulness-prime-directive.md). **This change introduces no new git behaviour and no new interop matrix** — it is pure test-infrastructure tidy. Faithfulness here means the regression guard must assert exactly what the hardened helper actually guarantees (verified by reading the helper, above) and the sweep must only remove a pin where the helper provably subsumes it. The one empirical pin below (conflict-marker style under the helper env) is the linchpin that licenses the `conflictStyle` removals; it was produced against the real `git` binary in a `mktemp -d` throwaway, never the worktree.

## Requirements

Verifiable statements (each maps to a test or to the pinned probe):

1. **The env-isolation contract is pinned by one intentional guard.** A centralized regression test fails loudly if any helper isolation key is dropped or weakened — the config-discovery half (`HOME`, `GIT_CONFIG_NOSYSTEM`, `XDG_CONFIG_HOME`; already covered by `interop-env-hardening.test.ts`) **and** the `GIT_*`-scrub half (`buildSafeEnv` strips every `GIT_*` key and sets `GIT_CEILING_DIRECTORIES`; the gap to close).
2. **The `gpgsign` pins are retired.** Every `commit.gpgsign=false` workaround (both forms — per-invocation `-c` and per-repo `git config` write) is removed; spawned commits still produce the goldens' SHAs because the helper env resolves `commit.gpgsign` → unset → git default-off (Matrix below).
3. **The `conflictStyle` pins are retired.** Every `-c merge.conflictStyle=merge` workaround is removed; conflict-marker bytes still match the goldens because the helper env resolves `merge.conflictStyle` → unset → git's built-in 2-way `merge` style — **even on a dev whose global is `diff3`** (the empirically-pinned linchpin below).
4. **`config-interop`'s `--local`/`--file` distinction is retained** — it is genuine read-scoping and stack-parse-masking avoidance, not redundant isolation (see Design § Retain).
5. **No behaviour change, full gate green.** `npm run validate` stays green after the sweep (all interop suites + unit + types + lint + coverage + the existing mutation budget). No golden SHA, ref, reflog, or on-disk-state byte changes; the only diff is removed pins + one extended guard.
6. **No new interop matrix.** The only new/changed test is the centralized helper-env guard. No `*-interop.test.ts` gains a new git-behaviour assertion.

## Design

### Empirical pin (git 2.54.0, darwin) — the linchpin that licenses the `conflictStyle` removals

The dev's ambient global config on this machine is `merge.conflictStyle=diff3` and `commit.gpgsign=true` (read-only `git config --get` in the worktree confirmed both). The probe reproduced the helper's `SAFE_ENV` in a `mktemp -d` throwaway: `GIT_*` scrubbed (`env -i`), `HOME=<tmp>/nonexistent-home` (never created), `GIT_CONFIG_NOSYSTEM=1`, `XDG_CONFIG_HOME=<HOME>/.config`, `GIT_CEILING_DIRECTORIES=<tmp-parent>`, identity supplied per-invocation via `-c user.*`. Then a real conflicting three-commit merge with **no `-c merge.conflictStyle` pin**:

| probe (helper-equivalent env, no `-c` pin) | result | exit |
|---|---|---|
| `git config --get merge.conflictStyle` | *(none)* | 1 |
| `git config --get commit.gpgsign` | *(none)* | 1 |
| `git merge other` (both sides edit the same line) | `CONFLICT (content)`; `f.txt` carries `<<<<<<< HEAD` / `=======` / `>>>>>>> other` with **no `\|\|\|\|\|\|\|` base section** | — |

**Conclusion:** under the helper env, ambient `merge.conflictStyle=diff3` does **not** leak — git falls to its built-in **2-way `merge`** style, which is exactly what the four `conflictStyle`-pinning goldens assert. Ambient `commit.gpgsign=true` does not leak either — git resolves the key unset (default-off), so commits stay unsigned and SHAs match. Both pins are therefore confirmed redundant: removing them changes no observable byte under the hardened helper. (This mirrors the `interop-helper-env-hardening.md` Matrix B/E pins, re-confirmed fresh on this base per the prime directive's "never trust cross-base" rule.)

### The sweep — what is removed, in two mechanical forms

A grep of `test/` confirms the survey: **25 files** carry a `commit.gpgsign=false` pin, **5 files** carry `-c merge.conflictStyle=merge` — and all 5 conflict suites (`add-add-content`, `conflict-marker-size-and-labels`, `distinct-types-with-base`, `merge-conflict`, `merge-tracked-dirty-conflict-refusal`) carry both pins, so each loses two overrides. The pins appear in two distinct forms, each removed differently:

**Form A — per-invocation `-c` argument** inside a `runGit`/`git`/`tryRunGit` call: drop the two array elements `'-c', 'commit.gpgsign=false'` (or `'-c', 'merge.conflictStyle=merge'`) and re-flow the array literal. `gpgsign` Form-A files (10): `commit-message`, `conflict-marker-size-and-labels`, `hooks-coverage` (×2), `merge-conflict`, `merge-driver` (×4), `merge` (×2), `merge-tracked-dirty-conflict-refusal`, `rm` (×2), `reset`, `network/submodule-add-update-http-backend` (×3). All `conflictStyle` pins are Form A.

**Form B — per-repo `git config` write** in a setup helper, e.g. `git(dir, 'config', 'commit.gpgsign', 'false')`: delete the whole statement (and prune any now-orphaned setup wrapper / its comment). `gpgsign` Form-B files: `add-add-content`, `blame`, `checkout-replace-symlink-with-file`, `cherry-pick`, `describe`, `distinct-types-with-base`, `merge-abort`, `name-rev`, `rebase`, `revert`, `shortlog`, `show`, `stash`, `status` (×2), `whatchanged`.

Each removal carries its now-stale "global signing/diff3 would diverge" comment with it (no-dead-code: the comment documented a hazard the helper now owns centrally and the new guard pins). The linkage that makes every removal safe: **the helper guarantees the ambient value never reaches spawned git** (Matrix above for both keys), so the per-test pin is provably inert. After this change a future weakening of the helper trips the centralized guard (Requirement 1) rather than silently re-exposing 30 suites.

### The guard step (TDD, lands first) — close the `GIT_*`-scrub gap

"Guard, then sweep": before removing any pin, ensure the helper's env-isolation contract is pinned in one place so the scattered safety net becomes one intentional tripwire. The config-discovery half is already pinned by `interop-env-hardening.test.ts` (Context table). The remaining gap is the **`GIT_*`-scrub half** — assert that `runGitEnv()` (the snapshot every consumer derives from) carries **no `GIT_*` key** and sets `GIT_CEILING_DIRECTORIES`. The most faithful assertion is on the **env object the helper constructs** (`runGitEnv()`), because that is the exact surface the sweep relies on and a behavioural probe cannot distinguish "scrubbed" from "the runner happened to have no `GIT_*` set":

```ts
// env-object assertion (the recommended shape — decision candidate (b))
const env = runGitEnv();
// no GIT_ key survives except the two the helper deliberately re-adds
const gitKeys = Object.keys(env).filter((k) => k.startsWith('GIT_'));
expect(gitKeys.sort()).toEqual(['GIT_CEILING_DIRECTORIES', 'GIT_CONFIG_NOSYSTEM']);
expect(env.GIT_CEILING_DIRECTORIES).toBe(os.tmpdir());
```

This **must fail** if a future edit stops scrubbing (e.g. lets `GIT_DIR` through) or drops the ceiling guard. It is a sibling concern to the four existing probes, so the natural home is the existing `interop-env-hardening.test.ts` under a new `describe('When inspecting the spawn env GIT_* keys')` — keeping the whole isolation contract pinned in one file. Whether to extend that file vs. start a new `interop-helpers.test.ts`, and env-object vs. behavioural style, is decision candidate (b) — the designer does not decide. (TDD note for the plan: write the guard so it is RED against a deliberately un-scrubbed env, GREEN against the real helper, before any pin is touched.)

### Retain — `config-interop`'s `--local` and `--file` (NOT redundant)

`config-interop.test.ts` uses `--local` and `--file` for **read-scoping and parse-masking avoidance**, a different mechanism from the `gpgsign`/`conflictStyle` value pins. Confirmed in-file:

- **`--local` scopes the readback to `.git/config`** (L118–120): `git config --local --list -z` so "the user's global config bleeds into the result on developer machines" is excluded from the *listing*. Even with the hardened helper neutralizing the global, `--local` documents and enforces the intended read scope (the test compares a local-only key set); it is part of the assertion's meaning, not a leak guard.
- **`--file` (not `--local`) on write-refusal parity** (L493–495, 599, 608, 727): a deliberate distinction — `git config --local` reads *all* config layers and surfaces "bad config line N" (a stack-parse error) **before** the write/rename machinery runs, masking the refusal the test is pinning; `git config --file <standalone>` hits git's per-file path and exercises the intended refusal. This is load-bearing test design that the helper's env isolation does not subsume (it is about *which config layers git parses for a given command*, not *what the ambient layers contain*).

Both are **retained**, matching the user's instruction and [ADR-339](../adr/339-interop-sweep-drop-redundant-isolation-duplication.md). The doc found no `--local`/`--file` use in `config-interop` that is pure belt-and-suspenders — every occurrence is read-scoping or parse-masking avoidance. (If the implementer finds one that is genuinely inert and safe to drop, surface it as a decision rather than dropping it — recorded as candidate (d).)

### Why this is faithfulness-neutral

No `src/` code changes; this is purely `test/integration/` infrastructure. No golden, SHA, ref, reflog, or on-disk-state byte changes — the helper already produces the same spawned-git environment the pins targeted (Matrix), so removing the pins removes only inert overrides. The new guard asserts the helper's existing contract; it adds no behaviour. tsgit's own config discovery (`readConfig`/`getConfigValue`) is local-only and untouched.

## Decision candidates

| # | Choice | Alternatives (≤3) | Recommendation | Why |
|---|---|---|---|---|
| **(a)** | New ADR vs. reference [ADR-339](../adr/339-interop-sweep-drop-redundant-isolation-duplication.md) only — the "guard" wrinkle (closing the `GIT_*`-scrub tripwire gap) adds a sub-decision [ADR-339](../adr/339-interop-sweep-drop-redundant-isolation-duplication.md) did not foresee. | **1.** No new ADR — this entry merely executes [ADR-339](../adr/339-interop-sweep-drop-redundant-isolation-duplication.md)'s deferred Option 3; reference it and note the guard in the commit/design. **2.** New ADR (next free is **356**) recording the "guard-then-sweep" sequencing decision and the `GIT_*`-scrub guard gap closure — i.e. *why* the corpus-wide retirement is now safe where [ADR-339](../adr/339-interop-sweep-drop-redundant-isolation-duplication.md) judged it premature. **3.** Amend/supersede [ADR-339](../adr/339-interop-sweep-drop-redundant-isolation-duplication.md) in place. | **2 — new ADR-356** | [ADR-339](../adr/339-interop-sweep-drop-redundant-isolation-duplication.md) *retained* the pins as safety nets and explicitly deferred their removal; reversing that with a new safeguard (the centralized guard) is a genuine decision worth its own record, not a silent execution of the old one. (1) understates that the precondition changed; (3) rewrites accepted history — append, don't mutate. The designer does not decide. |
| **(b)** | Where the `GIT_*`-scrub guard lives and how it asserts. | **1.** Extend `interop-env-hardening.test.ts` with a new `describe` block; assert on the **env object** (`runGitEnv()` carries no `GIT_*` except the two deliberate keys + `GIT_CEILING_DIRECTORIES === os.tmpdir()`). **2.** New `test/integration/interop-helpers.test.ts` dedicated to the helper's contract; env-object assertion. **3.** **Behavioural** assertion — spawn `git` with an ambient `GIT_DIR=/bogus` pre-set and prove the spawned git ignores it (lands in the tmp repo, not the bogus dir). | **1 (extend the existing file) + env-object style** | The four existing probes already pin the config half in that file; co-locating the `GIT_*` half keeps the whole contract in one tripwire and one place to read. Env-object assertion is the most faithful: it pins the *exact surface the sweep depends on* (`runGitEnv()`), is deterministic on any machine, and a behavioural probe (3) cannot distinguish "scrubbed" from "no `GIT_*` was set in this process" (a false-green on a clean CI runner). A behavioural pin could be added as a complementary case but should not be the sole guard. The designer does not decide. |
| **(c)** | Conventional-commit type for the eventual squash. | **1.** `test:` — the change is entirely under `test/`. **2.** `chore:` — a maintenance tidy with no behaviour change. **3.** `refactor(test):` — behaviour-preserving restructure of test code. | **1 — `test:`** | The diff is wholly test-infrastructure (removed pins + an extended guard test); `test:` is the precise type and matches the 24.9o commit (`test(integration): harden interop helper env …`). `chore:` is for non-code housekeeping; `refactor` implies production restructure. The designer does not decide. |
| **(d)** | Any pin the conflictStyle probe (or the sweep) surfaces as *non*-redundant, or any `config-interop` `--local`/`--file` use found to be pure belt-and-suspenders. | **1.** None surfaced — the probe confirmed both `gpgsign` and `conflictStyle` are fully neutralized by the helper, and every `config-interop` `--local`/`--file` is load-bearing (read-scoping / parse-masking). **2.** (placeholder) If the implementer finds a pin whose removal flips a golden, or a `--local` that is genuinely inert, retain it and record here. | **1 — none surfaced; retain `config-interop` whole** | The empirical pin closed the highest-risk case (`conflictStyle` under a `diff3` global → still `merge` style). No residual risk identified at design time. Left as a live candidate so the implementer escalates rather than silently drops/keeps if the sweep contradicts the design. The designer does not decide. |

## Test strategy

This is a **test-infrastructure** change; the load-bearing proof is that the corpus stays faithful and green with the pins gone and the guard extended.

1. **Guard (new, TDD, lands first):** the centralized `GIT_*`-scrub assertion (candidate (b)). Given/When/Then split, AAA body, `sut` is `runGitEnv` (the env factory). RED first against a deliberately un-scrubbed env, then GREEN against the real helper. It joins the four existing absence/shape probes so the full contract — `GIT_*` scrub + `GIT_CEILING_DIRECTORIES` + non-existent `HOME` + `GIT_CONFIG_NOSYSTEM` + redirected `XDG_CONFIG_HOME` — fails loudly if any single key is dropped. Asserts the env object, not a leaked value (which would pass only on one machine).
2. **Sweep regression gate (load-bearing):** full `npm run validate` (every interop suite that lost a pin + unit + types + lint + coverage) stays green. Because the helper neutralizes the ambient values (Matrix), a green run with the pins gone proves each pin was inert. Particular attention to the five `conflictStyle` suites and the SHA-bearing `gpgsign` suites (`show`, `blame`, `describe`, `name-rev`, `shortlog`, …) whose goldens depend on unsigned commit SHAs.
3. **Mutation budget — unaffected.** Stryker's `mutate` glob is `src/**/*.ts` only and its runner executes `test/unit` only (`stryker.config.json`), so neither `interop-helpers.ts`'s `buildSafeEnv` nor the new guard is ever mutated, and the removed pins live in untouched `test/integration/` code. The guard's value is therefore a regression **tripwire** (it fails the `validate` gate if the helper weakens), not a mutation-score contribution. The corpus mutation score is unchanged by this PR.
4. **No property tests:** the helper env is I/O orchestration with no algebraic grammar (CLAUDE.md "When property tests are NOT appropriate"). Skip.
5. **No source/test provenance refs:** the guard test and edited suites carry no backlog/ADR/phase markers; provenance lives in this doc, the ADR, and the commit.

## Out of scope

- **Production (`src/`) code** — none touched. tsgit's own config discovery is local-only by design and unaffected.
- **`config-interop`'s `--local`/`--file`** — retained as genuine read-scoping / parse-masking-avoidance, not redundant isolation ([ADR-339](../adr/339-interop-sweep-drop-redundant-isolation-duplication.md); Design § Retain).
- **`missing-value-refusal-interop`'s local isolation** — already removed in 24.9o ([ADR-339](../adr/339-interop-sweep-drop-redundant-isolation-duplication.md)); nothing left to retire there (confirmed: no `isolatedHome`/`makeCleanEnv`/local-`HOME` remains).
- **New interop matrices / any git-behaviour change** — none; the sweep removes inert overrides and the conflict-marker style is unchanged (Matrix).
- **`initBothRepos`'s `user.name=Ada` / `user.email=ada@example.com` per-repo writes** — these are deliberate identity *setup* (committing suites need an author), not ambient-config insulation; the helper's `HOME` isolation removes only what would otherwise *leak*, it does not supply identity. Untouched.
- **Windows path semantics for the isolated `HOME`** — the interop suite runs the POSIX CI lanes ([ADR-337](../adr/337-interop-helper-home-isolation-non-existent-path.md) follow-up); not reopened here.
- **The other 24.9x / config-parity backlog entries** — unrelated.
