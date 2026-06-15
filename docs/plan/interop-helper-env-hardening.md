# Plan — interop-helper-env-hardening

> Source: design doc `docs/design/interop-helper-env-hardening.md` · ADRs `337, 338, 339`
> The plan is the implementation script AND the knowledge handoff. Slice agents start
> with zero context: whatever a slice block omits is paid later as agent rediscovery.
> `plan-lint.sh` enforces the schema below — the plan phase cannot close without it.

## Surface decision (read first — applies to the whole plan)

This is a **test-infrastructure** change confined to `test/integration/`. It introduces
**NO new public symbol**, no new Tier-1 command, no new error code, no barrel/facade
entry, no exhaustiveness switch arm, no generated-API-report row. **No surface gates
apply** — the implementer must NOT hunt for barrels / `index.*` / `repository.ts` keys /
`reports/api.json` / doc-coverage pages / README counts. The only new file (Slice 1's
tripwire test) is a `*.test.ts` under `test/integration/`, which is never an exported
surface. Slice 1 mutates one existing internal factory (`buildSafeEnv`) whose public
consumers (`runGit`, `runGitEnv`, `tryRunGit`) keep their exact signatures, so no call
site changes for the hardening itself.

Faithfulness note (project prime directive): this change makes the interop corpus
*more* faithful — it makes spawned `git` read no developer global/system/XDG config, the
same isolation the faithfulness-pinning procedure mandates for probes. No git observable
behaviour is being diverged; no ADR-divergence applies to production bytes.

## Sizing rules

- Every slice costs a full agent lifecycle (spin-up, zero-context rebuild, gate) — it
  must earn it. No standalone test-only slices: coverage/interop/property tests fold
  into the implementation slice whose code they exercise.
- A slice that would be a pure test pass over already-landed code merges into its
  neighbour.

Two slices, sequential, sharing one working tree. Slice 1 hardens the helper and folds
in the isolation tripwire test (the test exercises Slice 1's helper change — not a
standalone test-only slice). Slice 2 depends on Slice 1 having landed: it removes the
now-redundant local isolation in one consumer suite. They are split because they are two
distinct behaviour-preserving concerns with two distinct conventional-commit subjects,
and because the Slice 2 cleanup is only *correct* once Slice 1's helper guarantees the
isolation Slice 2 deletes.

## Slice 1 — Harden buildSafeEnv against ambient git config + isolation tripwire test

### Context

**File to edit:** `test/integration/interop-helpers.ts` (the shared spawn surface for all
write-surface interop tests; the env is computed once at module load and reused).

**Symbol to change:** `buildSafeEnv` (arrow const, currently lines 32–40). Current body
verbatim:

```ts
const buildSafeEnv = (): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith('GIT_')) continue;
    if (value !== undefined) env[key] = value;
  }
  env.GIT_CEILING_DIRECTORIES = os.tmpdir();
  return env;
};
```

`const SAFE_ENV: NodeJS.ProcessEnv = buildSafeEnv();` follows at line 42. `os` and `path`
are ALREADY imported (`import * as os from 'node:os'` L29, `import * as path from
'node:path'` L30) — do NOT add imports for them.

**The three additions** (decided in the ADR phase — do NOT re-derive; all pinned against
real git 2.54.0 in the design's Matrix B/C/D). Insert them AFTER the existing
`env.GIT_CEILING_DIRECTORIES = os.tmpdir();` line and BEFORE `return env;`:

1. **Isolated HOME — a deterministic NON-existent path under `os.tmpdir()`** (ADR-337,
   decision (a) alternative 3). NOT `mkdtemp`, NOT any directory creation — a fixed
   subdir name joined onto `os.tmpdir()`. Use a stable descriptive constant name, e.g.
   `path.join(os.tmpdir(), 'tsgit-interop-nonexistent-home')`. git's `$HOME/.gitconfig`
   lookup misses and resolves no value; git writes nothing under `$HOME` during
   read/init/add/commit with signing off (Matrix D), so there is nothing to create and
   nothing to clean up.
2. **`env.GIT_CONFIG_NOSYSTEM = '1'`** (ADR-337). Closes the system-config vector — the
   Matrix B canary is `credential.helper=osxkeychain` from `/etc/gitconfig` /
   `$(brew --prefix)/etc/gitconfig`.
3. **`env.XDG_CONFIG_HOME = path.join(env.HOME, '.config')`** (ADR-338, decision (b)
   alternative 2). Points the *independent* XDG config-discovery root into the same
   non-existent tree as HOME. Assign HOME first so `env.HOME` is defined when computing
   this. git reads `$XDG_CONFIG_HOME/git/config` independently of HOME (Matrix C), so
   this must be set even though the dev's `XDG_CONFIG_HOME` is currently unset.

**Retain unchanged:** the `GIT_*` scrub loop and `env.GIT_CEILING_DIRECTORIES =
os.tmpdir();` (requirement 7 — no GIT_* regression).

**Extend the module doc-comment block (lines 1–26)** so it documents *why* the
HOME / `GIT_CONFIG_NOSYSTEM` / `XDG_CONFIG_HOME` additions exist (the project rule is
"comment why, not what"). The existing block (the "Isolation discipline" paragraph,
lines 9–25) explains only the `GIT_*` scrub + `GIT_CEILING_DIRECTORIES` rationale (husky
pre-push `GIT_DIR` leakage). Add a short paragraph: spawned git also inherits the
developer's `HOME`, so without isolation it reads `~/.gitconfig` (global) and, without
`GIT_CONFIG_NOSYSTEM`, `/etc/gitconfig` (system) and `$XDG_CONFIG_HOME/git/config` (XDG) —
silently changing git's observable bytes (same trap class as the `merge.conflictStyle`
diff3 flake). Pointing HOME (and XDG) at a non-existent tmp path + `GIT_CONFIG_NOSYSTEM=1`
makes git fail-soft to "no config" without creating or cleaning up any directory. **No
backlog / ADR / phase number anywhere in the comment** (project rule: provenance lives in
the commit, never in source/test code).

**Consumers (unchanged — verify, do not edit):**
- `runGit(args, { input?, env? })` L52–60 — default `env: SAFE_ENV` (the `?? SAFE_ENV`).
- `runGitEnv()` L63 — returns `{ ...SAFE_ENV }`, so the three new keys are part of the
  spread. The 30+ suites that spread it and add `GIT_AUTHOR_*` / `GIT_COMMITTER_*` /
  `GIT_*_DATE` append *different* keys — no collision with `HOME` / `GIT_CONFIG_NOSYSTEM`
  / `XDG_CONFIG_HOME` (requirement 4 holds by construction).
- `tryRunGit(args, { env? })` L138–155 — reuses `runGit`, same scrubbing.

**The tripwire test (folds into this slice — it exercises this slice's helper change).**
Create a NEW file `test/integration/interop-env-hardening.test.ts`. It is the regression
tripwire from the design's Test strategy §3: it asserts the helper env reads NO ambient
config. Shape:

- Imports: `import { describe, expect, it } from 'vitest';` and
  `import { GIT_AVAILABLE, tryRunGit } from './interop-helpers.js';`
  (note the `.js` extension — the corpus uses NodeNext ESM specifiers; see
  `missing-value-refusal-interop.test.ts` L22).
- Guard: `describe.skipIf(!GIT_AVAILABLE)('...')` wrapper (every git-spawning interop
  suite uses this; see `missing-value-refusal-interop.test.ts` L61).
- Conventions: Given/When/Then split across describe/it + AAA body (Arrange/Act/Assert
  section comments) + the system under test named `sut`. Here `sut` is the spawn helper
  (`tryRunGit`) running under the hardened `SAFE_ENV`. `Given` reads e.g.
  "Given the hardened interop spawn env".
- **Assert ABSENCE, never a specific leaked value** (a specific value only passes on the
  author's machine). For each probe use `tryRunGit([...])` and assert
  `result.ok === false` and `result.stdout` is empty (trimmed) — `git config --get
  <key>` exits 1 with no stdout when the key resolves nowhere (Matrix B).
- Probes (each its own isolated `it`, per the guard-clause-isolation test rule):
  - **Global-config canary:** `tryRunGit(['config', '--get', 'merge.conflictStyle'])` →
    `ok === false`, empty stdout. On the dev's machine (global
    `merge.conflictStyle=diff3`) this is a REAL red before the helper change and green
    after; on clean-config CI it is a standing tripwire.
  - **System-config canary:** `tryRunGit(['config', '--get', 'credential.helper'])` →
    `ok === false`, empty stdout. Proves `GIT_CONFIG_NOSYSTEM=1` closed `/etc/gitconfig`.
  Do NOT spawn `git` directly with `execFileSync`; route everything through the helper so
  the test exercises the hardened `SAFE_ENV` path. Do NOT pass a custom `env` — the whole
  point is to exercise the default `SAFE_ENV`.

### TDD steps

- **RED 1 (tripwire, new file):** write `interop-env-hardening.test.ts` with the two
  probes above. Run it BEFORE editing `interop-helpers.ts`. On the dev's machine the
  `merge.conflictStyle` probe FAILS — current `SAFE_ENV` inherits `HOME`, so
  `git config --get merge.conflictStyle` returns `diff3` exit 0 (`result.ok === true`,
  non-empty stdout) — asserting `ok === false` / empty stdout fails. Expected failure
  reason: ambient global config leaks through the un-hardened env. (On a clean-config CI
  the probe would pass even before the fix — that's fine; it is a standing tripwire, and
  the load-bearing red is the author-machine run.)
- **GREEN:** add the three additions to `buildSafeEnv` (isolated non-existent HOME,
  `GIT_CONFIG_NOSYSTEM = '1'`, `XDG_CONFIG_HOME = <HOME>/.config`) as specified in
  Context. Re-run the tripwire — both probes now `ok === false` with empty stdout (git
  fail-soft to "no config", Matrix B). After the source edit, call
  `get_diagnostics_for_file` on `interop-helpers.ts` (advisory) and confirm
  `npm run check:types` green (ground truth).
- **REFACTOR:** extend the module doc-comment block to explain *why* the HOME/NOSYSTEM/XDG
  additions exist (per Context); name the non-existent-HOME path with a single descriptive
  inline `path.join(os.tmpdir(), 'tsgit-interop-nonexistent-home')` (no magic literal
  scattered). Keep `buildSafeEnv` under 20 lines and free of nesting >2. Confirm the full
  interop corpus still green via the phase gate at phase boundary (not in-slice) — the
  in-slice gate runs only the touched tests.

### Gate

`npx vitest run test/integration/interop-env-hardening.test.ts && npm run check:types && ./node_modules/.bin/biome check test/integration/interop-helpers.ts test/integration/interop-env-hardening.test.ts`

### Commit

`test(integration): harden interop helper env against ambient git config`

## Slice 2 — Drop redundant local isolation in missing-value-refusal

### Context

> Depends on Slice 1 being landed: this cleanup is only correct because Slice 1's
> hardened `runGitEnv()` now provides the isolated `HOME` + `GIT_CONFIG_NOSYSTEM=1` that
> this suite used to hand-roll. Do this slice AFTER Slice 1 in the same working tree.

**File to edit (only this one):** `test/integration/missing-value-refusal-interop.test.ts`.

**What this suite proves (must keep passing):** valueless-identity refusal — git refuses
to commit / fetch / push when `.git/config` holds a valueless `user.name` /
`remote.origin.url` (exit 128, two-line missing-value message), and tsgit throws
`CONFIG_MISSING_VALUE`; plus the absent-case distinctness (`AUTHOR_UNCONFIGURED` /
`REMOTE_NOT_CONFIGURED`, not `CONFIG_MISSING_VALUE`). The valueless assertions only hold
when git reads NO ambient `user.*` — that is exactly what Slice 1's hardened `runGitEnv()`
now guarantees.

**The duplication to remove (ADR-339, decision (d) alternative 3 — drop ONLY this
suite's duplicated local isolation; behaviour-preserving):**

- **`isolatedHome` state + its lifecycle:**
  - L63 `let isolatedHome: string;` — remove.
  - L67 in `beforeEach`: `isolatedHome = await mkdtemp(path.join(os.tmpdir(),
    'tsgit-missing-value-home-'));` — remove. Keep L66 `ours = await realpath(await
    mkdtemp(...'tsgit-missing-value-ours-'));` (independent — `ours` is the repo dir).
  - L72 in `afterEach`: `await rm(isolatedHome, { recursive: true, force: true });` —
    remove. Keep L71 `await rm(ours, ...)`.
- **`makeCleanEnv` (L45–49)** currently `(isolatedHome) => ({ ...runGitEnv(),
  GIT_CONFIG_NOSYSTEM: '1', HOME: isolatedHome })`. After Slice 1, `runGitEnv()` alone
  provides both `GIT_CONFIG_NOSYSTEM` and the isolated `HOME`, so the override is pure
  duplication. Simplify: `makeCleanEnv` becomes identity over `runGitEnv()` and takes NO
  arg. Cleanest is to **inline `runGitEnv()` at the call sites and delete `makeCleanEnv`**
  (it would be a one-line passthrough = dead indirection). Call sites: L93–95 and
  L144–146 pass `env: makeCleanEnv(isolatedHome)` → replace with `env: runGitEnv()`.
- **`makeIdentityEnv` (L51–59)** currently spreads `makeCleanEnv(isolatedHome)` then adds
  `GIT_AUTHOR_*` / `GIT_COMMITTER_*`. Keep the author/committer additions (they are the
  suite's real intent — proving absent-identity resolves from env). Change its base from
  `makeCleanEnv(isolatedHome)` to `runGitEnv()` and drop the `isolatedHome` param. Call
  site: L219–221 passes `env: makeIdentityEnv(isolatedHome)` → `env: makeIdentityEnv()`.
- **`makeRemoteCleanEnv` (L268–272)** — the SECOND duplication site: a closure currently
  `() => ({ ...runGitEnv(), GIT_CONFIG_NOSYSTEM: '1', HOME: isolatedHome })`. After
  Slice 1 this is identical to `runGitEnv()`. Delete `makeRemoteCleanEnv` and replace its
  FOUR call sites (`env: makeRemoteCleanEnv()` at L283, L332, L374, L423) with
  `env: runGitEnv()`. (Equivalently, if keeping a named helper reads better, point all
  seven clean-env call sites — two `makeCleanEnv`, one `makeIdentityEnv` base, four
  `makeRemoteCleanEnv` — at one `runGitEnv()`; but a bare `runGitEnv()` is clearest. The
  comment at L39–44 explaining why GIT_AUTHOR_* is omitted in the valueless case should be
  retained, attached to the relevant call site / `makeIdentityEnv`.)
- **Imports (L13):** `import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';`
  — `mkdtemp`, `realpath`, `rm`, `writeFile` are ALL still used by `ours` (mkdtemp +
  realpath at L66, rm at L71) and the fixture writes (`writeFile`). So **leave the import
  line UNCHANGED** — none of the four named imports become unused. `os` (L14) and `path`
  (L15) are still used by the `ours` mkdtemp path. Verify with the type-check, do not
  guess.

**Behaviour-preservation proof (already verified — fold in, do not re-derive):**
`isolatedHome` is NEVER a `writeFile` target — every `writeFile` writes to
`ours/.git/config` or worktree files (L90, L110, L141, L187, L201, L216, L233, L279, L298,
L328, L370, L389, L419, L463, L486), never under `isolatedHome`. git reads no ambient
`user.*` either way (its own `mkdtemp` empty HOME before, the helper's non-existent HOME
after), so substituting the helper's isolation changes no on-disk state and no observable
git bytes. The valueless-identity assertions stay green.

### TDD steps

- **RED:** this slice changes no production behaviour and adds no new assertion — it
  removes a duplication of an isolation that Slice 1 now owns. The "red" is the
  *pre-existing* suite as the safety net: before editing, run it to confirm it is GREEN on
  the post-Slice-1 tree (the suite already passes — it depended on its own `mkdtemp` HOME,
  and equally passes under the helper's HOME). There is no failing assertion to author; the
  proof obligation (design Test strategy §2) is that the suite stays green after the
  duplication is deleted. (Per the sizing rule, this is not a standalone test slice — it is
  a behaviour-preserving refactor of test infrastructure whose proof is the unchanged green
  suite, folded with its own commit because it is a distinct conventional-commit subject
  gated on Slice 1.)
- **GREEN:** apply the removals in Context — delete `isolatedHome` (var L63 + mkdtemp L67 +
  rm L72), simplify/inline `makeCleanEnv` → `runGitEnv()` at its two call sites (L94,
  L145), rebase `makeIdentityEnv` onto `runGitEnv()` (drop its `isolatedHome` arg) at its
  one call site (L220), delete `makeRemoteCleanEnv` → `runGitEnv()` at its four call sites
  (L283, L332, L374, L423). Re-run the suite:
  all `it`s stay green (valueless refuses, absent commits, reconstruction matches). After
  the edit call `get_diagnostics_for_file` on the test file (advisory) and confirm
  `npm run check:types` green — this also confirms no import went unused.
- **REFACTOR:** ensure no dead helper / dead import / unused variable remains; keep the
  L39–44 "why GIT_AUTHOR_* is omitted in the valueless case" rationale attached where it
  still applies. No backlog/ADR/phase refs introduced anywhere. Confirm the phase-boundary
  full `npm run validate` (run at phase close, not in-slice) stays green — the load-bearing
  regression proof for the whole change.

### Gate

`npx vitest run test/integration/missing-value-refusal-interop.test.ts && npm run check:types && ./node_modules/.bin/biome check test/integration/missing-value-refusal-interop.test.ts`

### Commit

`test(integration): drop redundant local isolation in missing-value-refusal`
