# Plan — retire-redundant-config-pins

> Source: design doc `docs/design/retire-redundant-config-pins.md` · ADRs `356` (refines `339`)
> The plan is the implementation script AND the knowledge handoff. Slice agents start
> with zero context: whatever a slice block omits is paid later as agent rediscovery.
> `plan-lint.sh` enforces the schema below — the plan phase cannot close without it.

## Sizing rules

- Every slice costs a full agent lifecycle (spin-up, zero-context rebuild, gate) — it
  must earn it. No standalone test-only slices: coverage/interop/property tests fold
  into the implementation slice whose code they exercise.
- A slice that would be a pure test pass over already-landed code merges into its
  neighbour.

> **This entry is legitimately test-infrastructure end-to-end** — there is NO `src/`
> change. The "no test-only slices" heuristic assumes feature code and does not bind
> here (design § "Why this is faithfulness-neutral"; ADR-356 Consequences). Slice 1 is
> a genuine RED→GREEN guard; Slices 2–3 are pure deletions of inert pins whose GREEN
> proof is the slice gate + the phase-boundary `npm run validate` staying green (the
> design's empirical Matrix proves each pin inert, so green-with-pins-gone = the pin
> was inert). Do NOT manufacture production edits to satisfy the heuristic.

## Slicing rationale (read before starting)

The sweep is partitioned **by file, never by pin-type**, so no file is edited in two
slices (the manifest's explicit instruction). The authoritative partition (verified by
`comm` of the two greps, below) is **5 dual-pin files** (carry BOTH a `gpgsign` and a
`conflictStyle=merge` pin) and **20 gpgsign-only files** (no `conflictStyle`):

- **Slice 2** sweeps the **5 dual-pin files** — this is exactly the set of all
  `conflictStyle=merge` removals (ADR-356's highest-risk vector) plus their co-located
  `gpgsign` pins. Isolating it means a conflict-marker-byte regression bisects to one
  commit.
- **Slice 3** sweeps the **20 gpgsign-only files** — uniform, low-risk pure deletions,
  one atomic commit.

Rejected alternatives: one mega-slice of all 25 files (no risk isolation, not bisectable);
splitting Slice 3 further into Form-A-only / Form-B-only (Form A vs Form B is a
mechanical edit detail, not a risk boundary — three uniform pure-deletion slices would
not each earn a lifecycle).

### Authoritative pin inventory (verified by grep, this worktree)

Two mechanical forms (design § "The sweep — two mechanical forms"):

- **Form A** — per-invocation `-c` argument inside a `runGit`/`git`/`tryRunGit` array:
  drop the two adjacent array elements `'-c', 'commit.gpgsign=false'` (or
  `'-c', 'merge.conflictStyle=merge'`) and re-flow the array literal. Leave any OTHER
  `-c` pair (e.g. `'-c', 'commit.cleanup=whitespace'`) intact.
- **Form B** — per-repo `git config` write statement, e.g.
  `git(dir, 'config', 'commit.gpgsign', 'false')` or
  `runGit(['-C', pair.peer, 'config', 'commit.gpgsign', 'false'])`: delete the whole
  statement (and prune any now-orphaned comment).

| file | gpgsign form & lines | conflictStyle (all Form A) lines | dual? |
|---|---|---|---|
| `add-add-content-interop.test.ts` | B @ L62 | L101, L107 | dual |
| `conflict-marker-size-and-labels-interop.test.ts` | A @ L74 | L122, L174, L208, L235, L263 | dual |
| `distinct-types-with-base-interop.test.ts` | B @ L68 | L100, L106, L874, L1361 | dual |
| `merge-conflict-interop.test.ts` | A @ L78 | L120 | dual |
| `merge-tracked-dirty-conflict-refusal-interop.test.ts` | A @ L108 | L139 | dual |
| `blame-interop.test.ts` | B @ L51 | — | gpgsign-only |
| `checkout-replace-symlink-with-file-interop.test.ts` | B @ L111 | — | gpgsign-only |
| `cherry-pick-interop.test.ts` | B @ L55 | — | gpgsign-only |
| `commit-message-interop.test.ts` | A @ L78 | — | gpgsign-only |
| `describe-interop.test.ts` | B @ L64 | — | gpgsign-only |
| `hooks-coverage-interop.test.ts` | A @ L58, L304 | — | gpgsign-only |
| `merge-abort-interop.test.ts` | B @ L42 | — | gpgsign-only |
| `merge-driver-interop.test.ts` | A @ L73, L125, L207, L245 | — | gpgsign-only |
| `merge-interop.test.ts` | A @ L83, L113 | — | gpgsign-only |
| `name-rev-interop.test.ts` | B @ L66 | — | gpgsign-only |
| `network/submodule-add-update-http-backend.test.ts` | A @ L116, L127, L160 | — | gpgsign-only |
| `rebase-interop.test.ts` | B @ L42 | — | gpgsign-only |
| `reset-interop.test.ts` | A @ L91 | — | gpgsign-only |
| `revert-interop.test.ts` | B @ L52 | — | gpgsign-only |
| `rm-interop.test.ts` | A @ L75 | — | gpgsign-only |
| `shortlog-interop.test.ts` | B @ L113 | — | gpgsign-only |
| `show-interop.test.ts` | B @ L65 | — | gpgsign-only |
| `stash-interop.test.ts` | B @ L62 | — | gpgsign-only |
| `status-interop.test.ts` | B @ L60, L86 | — | gpgsign-only |
| `whatchanged-interop.test.ts` | B @ L81 | — | gpgsign-only |

Totals: 25 files carry `gpgsign` (10 Form A, 15 Form B by file; 17 Form-A occurrences +
16 Form-B occurrences = 33); 5 files carry `conflictStyle=merge` (13 occurrences, all
Form A); the 5 conflictStyle files == the 5 dual-pin files. Line numbers are pre-sweep
and shift as earlier edits in the same file are applied — match the literal pin TEXT,
not the line number.

**Comment-handling traps (must-not-orphan, spot-checked in-file):**

- `reset-interop.test.ts` L84–85 — the comment reads *"Signing OFF + whitespace cleanup
  so the peer commit id matches tsgit's (a globally-enabled `commit.gpgsign` would
  otherwise diverge the SHA)."* The `'-c', 'commit.gpgsign=false'` pair (L90–91) is
  removed but the sibling `'-c', 'commit.cleanup=whitespace'` pair (L92–93) STAYS.
  **Split the comment:** drop the "Signing OFF" + parenthetical-gpgsign-hazard clauses,
  keep "whitespace cleanup so the peer commit id matches tsgit's".
- `commit-message-interop.test.ts` L71–72 — comment *"peer via canonical git (signing
  off, whitespace cleanup pinned), ours via the porcelain."* The gpgsign `-c` pair
  (L77–78) is removed; the `commit.cleanup=whitespace` pair (L79–80) STAYS. **Split:**
  drop "signing off," keep "whitespace cleanup pinned".
- `rm-interop.test.ts` L72–74 — a 3-line comment entirely about gpgsign ("Signing OFF so
  the peer commit needs no GPG key, even if `commit.gpgsign` is enabled globally…").
  Remove the WHOLE comment with the pin.
- `merge-conflict-interop.test.ts` L113–117 — the docblock above `mergeBothConflict`
  reads *"…The peer is pinned to git's default `merge.conflictStyle` (the host's global
  may select a `diff3`-style variant); tsgit implements that 2-way default."* When the
  `conflictStyle=merge` pin (L120) is removed, drop the now-stale "The peer is pinned…
  variant)" sentence; keep the "Run the (conflicting) merge on both tools; both leave
  markers in the worktree." line and "tsgit implements that 2-way default." as a
  standalone factual note (or fold into the kept first line — implementer's call,
  no-dead-code is the only constraint).
- `conflict-marker-size-and-labels-interop.test.ts` L116 — inline comment *"Act — pin
  the peer to git's default 2-way style (host global may pick diff3)."* Drop the "pin
  the peer to… diff3)" clause when its pin (L117–130 array) goes; keep the bare "Act"
  marker (AAA section comments are load-bearing per test conventions).

All other pins reviewed carry NO comment (clean statement/array-element deletion):
`distinct-types-with-base` L68 (Form B setup) + its conflictStyle helpers
`peerMergeConflict`/`peerMergeClean` (L98–108) and L874/L1361; `merge-driver` L73 and
the merge calls; `show`/`blame`/`describe`/etc. Form B setup writes. No shared helper in
`interop-helpers.ts` carries a pin (verified: the only `gpgsign`/`conflictStyle` match
there is the helper's own doc comment at L33, which is RETAINED — it documents the
helper's isolation rationale, not a per-test pin). Each suite defines its own local
commit wrapper, so no removal orphans a cross-file export.

---

## Slice 1 — Guard: pin the GIT_*-scrub half of the helper env-isolation contract

### Context

**Goal (ADR-356 Decision step 1, design § "The guard step"):** extend the existing
centralized tripwire so the `GIT_*`-scrub half of the helper's env-isolation contract
fails loudly if a future edit drops it. The config-discovery half (`HOME` /
`GIT_CONFIG_NOSYSTEM` / `XDG_CONFIG_HOME`) is ALREADY pinned by four probes in the same
file; this slice adds the missing fifth concern: no `GIT_*` key survives in the spawn
env except the two the helper deliberately re-adds, and the ceiling guard points at
`os.tmpdir()`. **This guard MUST land before any pin is swept** (guard-then-sweep).

**File to edit (the ONLY file this slice touches):**
`test/integration/interop-env-hardening.test.ts` (95 lines; read in full before
editing). Its shape:
- Top: `describe.skipIf(!GIT_AVAILABLE)('interop-env-hardening', () => { describe('Given the hardened interop spawn env', () => { … }) })`.
- Four sibling `describe('When …')` probes inside the `Given` block. The two relevant
  style exemplars to MATCH:
  - the **env-shape** probes (`'When inspecting the spawn env HOME'` L66–79;
    `'When inspecting the spawn env XDG config root'` L81–92) — these set
    `const sut = runGitEnv;`, `Act` calls `sut()`, `Assert` inspects the returned env
    object. This is the exact pattern this slice's new probe follows.
- Existing imports (L14–19): `existsSync` from `node:fs`; `mkdtemp, rm, writeFile` from
  `node:fs/promises`; `* as os` from `node:os`; `* as path` from `node:path`;
  `{ afterAll, beforeAll, describe, expect, it }` from `vitest`;
  `{ GIT_AVAILABLE, runGitEnv, tryRunGit }` from `./interop-helpers.js`. `os` and the
  `runGitEnv` import are already present — **no new imports needed** for the env-object
  assertion (uses `os.tmpdir()`, `Object.keys`, `runGitEnv`).

**The helper contract being pinned** (read `test/integration/interop-helpers.ts`
L50–63 — `buildSafeEnv`):
- strips every key where `key.startsWith('GIT_')` from `process.env`;
- then re-adds exactly two `GIT_*` keys: `GIT_CEILING_DIRECTORIES = os.tmpdir()` and
  `GIT_CONFIG_NOSYSTEM = '1'`;
- `runGitEnv()` returns `{ ...SAFE_ENV }` (the per-call snapshot every consumer derives
  from) — this is the exact surface the sweep relies on, so the assertion targets it
  (env-object, not behavioural; ADR-356: a behavioural probe cannot distinguish
  "scrubbed" from "no GIT_* was set in this process" and false-greens on a clean runner).

**Exact assertion shape (ADR-356 Decision; design § guard step):**
```ts
const env = runGitEnv();
const gitKeys = Object.keys(env).filter((k) => k.startsWith('GIT_'));
expect(gitKeys.sort()).toEqual(['GIT_CEILING_DIRECTORIES', 'GIT_CONFIG_NOSYSTEM']);
expect(env.GIT_CEILING_DIRECTORIES).toBe(os.tmpdir());
```
Place a NEW sibling `describe('When inspecting the spawn env GIT_* keys')` block inside
the existing `describe('Given the hardened interop spawn env')`, after the XDG probe.
`sut` = `runGitEnv` (the env factory — per memory "sut is the System Under Test"; the
result goes in a `result`/`env` local, NEVER named `sut`). GWT split: the `describe`
carries Given+When, the single `it('Then …')` carries only the expectation. AAA body
with `// Arrange`/`// Act`/`// Assert` section comments matching the four existing
probes. No backlog/ADR/phase ref anywhere in the test (provenance lives in the commit).

**Test title (`it`)** must read as the expectation, e.g.
`'Then only the two deliberate GIT_* keys survive and the ceiling guard is os.tmpdir()'`.

### TDD steps

1. **RED** — prove the assertion CAN fail. In a throwaway scratch (NOT the worktree —
   use a local scratch file under `os.tmpdir()`, or a temporary inline variant), write
   the assertion against a deliberately un-scrubbed env constructed locally, e.g.
   `const leaky = { ...runGitEnv(), GIT_DIR: '/bogus' };` and assert
   `Object.keys(leaky).filter(k => k.startsWith('GIT_')).sort()` equals the two-key
   array — confirm it FAILS with `GIT_DIR` present in the actual array (expected failure
   reason: the leaked `GIT_DIR` makes the `toEqual(['GIT_CEILING_DIRECTORIES',
   'GIT_CONFIG_NOSYSTEM'])` mismatch). This demonstrates the guard is not vacuous.
   Discard the leaky construction — it must NOT ship.
2. **GREEN** — add the real probe asserting against `runGitEnv()` (the unmodified
   helper snapshot). It passes because `buildSafeEnv` already scrubs `GIT_*` and re-adds
   exactly the two keys (the helper was hardened in 24.9o; NO helper change is needed —
   the "implementation" that makes this green is the helper already satisfying the
   contract). Run the slice gate; the file now has 5 probes, all green.
3. **REFACTOR** — confirm the new block matches the file's GWT/AAA/`sut` conventions and
   the docblock at the top of the file still reads true (it describes "all three vectors
   the helper closes" — consider whether the new GIT_*-scrub concern warrants a one-line
   docblock touch; keep it factual, no provenance ref). No production code to refactor.

### Gate

```
npx vitest run test/integration/interop-env-hardening.test.ts && npm run check:types && ./node_modules/.bin/biome check test/integration/interop-env-hardening.test.ts
```

### Commit

```
test(integration): pin the GIT_*-scrub half of the interop env contract
```

## Slice 2 — Sweep the 5 dual-pin conflict suites (conflictStyle + co-located gpgsign)

### Context

**Goal (ADR-356 Decision step 2; design § sweep):** remove BOTH pins from each of the
5 files that carry a `merge.conflictStyle=merge` pin AND a `commit.gpgsign=false` pin.
This is the highest-risk slice (the conflictStyle removals — ADR-356 names them the
HIGHEST RISK vector). The empirical pin in the design (git 2.54.0, darwin: under the
helper's `SAFE_ENV`, ambient `merge.conflictStyle=diff3` does NOT leak — git falls to
its built-in 2-way `merge` style; ambient `commit.gpgsign=true` does NOT leak — git
resolves it unset/default-off) licenses every removal: under the hardened helper the
ambient value never reaches spawned git, so each pin is provably inert and removing it
changes NO observable byte. **Each file is edited exactly once** (both its pins in this
slice) so no file is touched again in Slice 3.

**The 5 files + the literal pin text to remove (match TEXT, not line — lines shift as
edits apply):**

1. `test/integration/add-add-content-interop.test.ts`
   - gpgsign **Form B** @ ~L62: `runGit(['-C', pair.peer, 'config', 'commit.gpgsign', 'false']);` → delete the whole statement.
   - conflictStyle **Form A** @ ~L101, ~L107: in `['-C', pair.peer, '-c', 'merge.conflictStyle=merge', 'merge', '--no-ff', '-m', 'm', branch]` drop `'-c', 'merge.conflictStyle=merge',` → `['-C', pair.peer, 'merge', '--no-ff', '-m', 'm', branch]`. Two call sites.
2. `test/integration/conflict-marker-size-and-labels-interop.test.ts`
   - gpgsign **Form A** @ ~L74: in `runGit(['-C', pair.peer, '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', message], …)` drop the `'-c', 'commit.gpgsign=false',` pair.
   - conflictStyle **Form A** @ ~L122 (multi-line array L117–130), ~L174, ~L208, ~L235, ~L263: drop the `'-c', 'merge.conflictStyle=merge',` pair (re-flow the multi-line array at L117–130 to single-line if it now fits, or keep tidy). 5 call sites across `merge`/`cherry-pick`/`rebase`/`stash apply` probes.
   - **comment trap (L116):** drop the "pin the peer to git's default 2-way style (host global may pick diff3)" clause; keep the bare `// Act` marker.
3. `test/integration/distinct-types-with-base-interop.test.ts`
   - gpgsign **Form B** @ ~L68: `runGit(['-C', pair.peer, 'config', 'commit.gpgsign', 'false']);` → delete the whole statement (it sits in a `beforeEach` after the `user.name`/`user.email` writes — those STAY, they are identity setup, out of scope).
   - conflictStyle **Form A** @ ~L100, ~L106 (inside helpers `peerMergeConflict` L98–102 and `peerMergeClean` L104–108), ~L874, ~L1361 (multi-line arrays): drop the `'-c', 'merge.conflictStyle=merge',` pair at each. 4 call sites.
4. `test/integration/merge-conflict-interop.test.ts`
   - gpgsign **Form A** @ ~L78: in `runGit(['-C', pair.peer, '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', message], …)` drop the `'-c', 'commit.gpgsign=false',` pair.
   - conflictStyle **Form A** @ ~L120 (inside `mergeBothConflict`): drop the `'-c', 'merge.conflictStyle=merge',` pair.
   - **comment trap (L113–117 docblock above `mergeBothConflict`):** drop the stale "The peer is pinned to git's default `merge.conflictStyle` (the host's global may select a `diff3`-style variant);" sentence; keep the kept lines factual (no-dead-code).
5. `test/integration/merge-tracked-dirty-conflict-refusal-interop.test.ts`
   - gpgsign **Form A** @ ~L108: drop the `'-c', 'commit.gpgsign=false',` pair from the commit array.
   - conflictStyle **Form A** @ ~L139: drop the `'-c', 'merge.conflictStyle=merge',` pair.

**Do NOT touch:** any `'-c', 'commit.cleanup=whitespace'` pair, any `user.name`/
`user.email`/`init`/identity setup, any `COMMIT_ENV`/`dateEnv` author-date spread (those
are disjoint identity vars the helper does not supply). After each array edit the call
must still be valid (an `add`/`commit`/`merge`/`cherry-pick`/`rebase`/`stash` invocation
with the same non-`-c` args).

**Why green = proof:** these suites assert conflict-marker BYTES match the peer
(`expect(ours).toBe(await read(pair.peer, ...))`, `toContain('<<<<<<< HEAD')` etc.) and
SHA/state equivalence. They run against the hardened helper. If a removed pin were
load-bearing, the marker bytes or SHAs would diverge and the suite would go RED. Green
across all 5 suites + the phase-boundary `npm run validate` is the empirical
confirmation that the ambient `diff3`/`gpgsign` truly do not leak (re-confirming the
design's mktemp pin on the CI base).

### TDD steps

1. **RED is structural, not a new test** — these suites are the existing
   golden/byte-parity assertions; the "RED→GREEN" here is: the suites currently pass
   WITH the pins; after removal they must STILL pass (the design's Matrix predicts they
   will). Before editing, run the 5 suites to confirm a green baseline (so a post-edit
   red is unambiguously the edit, not a pre-existing flake).
2. **GREEN (the edit)** — remove both pins from each of the 5 files per the literal text
   above, handling the three comment traps (conflict-marker-size L116, merge-conflict
   L113–117). Re-flow each touched array literal cleanly. Run the slice gate over the 5
   touched suites — all must stay green (byte-parity holds with pins gone).
3. **REFACTOR** — verify no orphaned comment, no leftover `-c` dangling, no now-unused
   import, and that biome formatting on the re-flowed arrays is clean. Confirm the only
   diff is removed pins + trimmed comments.

### Gate

```
npx vitest run test/integration/add-add-content-interop.test.ts test/integration/conflict-marker-size-and-labels-interop.test.ts test/integration/distinct-types-with-base-interop.test.ts test/integration/merge-conflict-interop.test.ts test/integration/merge-tracked-dirty-conflict-refusal-interop.test.ts && npm run check:types && ./node_modules/.bin/biome check test/integration/add-add-content-interop.test.ts test/integration/conflict-marker-size-and-labels-interop.test.ts test/integration/distinct-types-with-base-interop.test.ts test/integration/merge-conflict-interop.test.ts test/integration/merge-tracked-dirty-conflict-refusal-interop.test.ts
```

### Commit

```
test(integration): retire redundant conflictStyle and gpgsign pins from conflict suites
```

## Slice 3 — Sweep the 20 gpgsign-only suites

### Context

**Goal (ADR-356 Decision step 2; design § sweep):** remove the `commit.gpgsign=false`
pin from each of the 20 files that carry ONLY a gpgsign pin (no `conflictStyle`). Uniform
low-risk pure deletions. Licensed by the same empirical pin: under the helper env
ambient `commit.gpgsign=true` does not leak (git resolves the key unset → default-off),
so spawned commits stay unsigned and the goldens' SHAs match. These suites' goldens
depend on the unsigned-commit SHAs (`show`, `blame`, `describe`, `name-rev`, `shortlog`,
`whatchanged`, `commit-message`, `reset`, …) — green proves each pin inert.

**The 20 files + literal pin text (match TEXT, not line; lines shift within a file as
its earlier edits apply):**

Form B (delete the whole `config commit.gpgsign false` statement; no comment unless
noted):
- `blame-interop.test.ts` ~L51: `git(dir, 'config', 'commit.gpgsign', 'false');`
- `checkout-replace-symlink-with-file-interop.test.ts` ~L111: `runGit(['-C', pair.peer, 'config', 'commit.gpgsign', 'false']);`
- `cherry-pick-interop.test.ts` ~L55: `git(dir, 'config', 'commit.gpgsign', 'false');`
- `describe-interop.test.ts` ~L64: `git(dir, 'config', 'commit.gpgsign', 'false');`
- `merge-abort-interop.test.ts` ~L42: `git(dir, 'config', 'commit.gpgsign', 'false');`
- `name-rev-interop.test.ts` ~L66: `git(dir, 'config', 'commit.gpgsign', 'false');`
- `rebase-interop.test.ts` ~L42: `git(dir, 'config', 'commit.gpgsign', 'false');`
- `revert-interop.test.ts` ~L52: `git(dir, 'config', 'commit.gpgsign', 'false');`
- `shortlog-interop.test.ts` ~L113: `git(dir, 'config', 'commit.gpgsign', 'false');`
- `show-interop.test.ts` ~L65: `git(dir, 'config', 'commit.gpgsign', 'false');`
- `stash-interop.test.ts` ~L62: `git(pair.peer, 'config', 'commit.gpgsign', 'false');`
- `status-interop.test.ts` ~L60 AND ~L86: two separate `git(dir, 'config', 'commit.gpgsign', 'false');` statements — delete BOTH.
- `whatchanged-interop.test.ts` ~L81: `git(dir, 'config', 'commit.gpgsign', 'false');`

Form A (drop the `'-c', 'commit.gpgsign=false',` pair from the array; leave any other
`-c` pair intact):
- `commit-message-interop.test.ts` ~L78: in the multi-line commit array (L73–87) drop the `'-c', 'commit.gpgsign=false',` pair; **KEEP** the sibling `'-c', 'commit.cleanup=whitespace',` pair (L79–80). **comment trap (L71–72):** drop "signing off," from "peer via canonical git (signing off, whitespace cleanup pinned)…", keep "whitespace cleanup pinned".
- `hooks-coverage-interop.test.ts` ~L58 AND ~L304: two `runGit([…, '-c', 'commit.gpgsign=false', 'commit', …])` call sites — drop the pair at BOTH.
- `merge-driver-interop.test.ts` ~L73 (`commitBoth`), ~L125, ~L207, ~L245 (the `merge --no-ff` calls): drop the `'-c', 'commit.gpgsign=false',` pair at all 4 call sites.
- `merge-interop.test.ts` ~L83 (`commit`), ~L113 (`merge --no-ff`): drop the pair at both.
- `network/submodule-add-update-http-backend.test.ts` ~L116 (`commit -qm`), ~L127 (`submodule add`), ~L160 (`commit -qm`): drop the `'-c', 'commit.gpgsign=false',` pair at all 3 `git(dir, '-c', 'commit.gpgsign=false', …)` call sites.
- `reset-interop.test.ts` ~L91: in the multi-line commit array (L86–98) drop the `'-c', 'commit.gpgsign=false',` pair; **KEEP** the sibling `'-c', 'commit.cleanup=whitespace',` pair (L92–93). **comment trap (L84–85):** split the comment — drop "Signing OFF + " and the parenthetical "(a globally-enabled `commit.gpgsign` would otherwise diverge the SHA)."; keep "whitespace cleanup so the peer commit id matches tsgit's".
- `rm-interop.test.ts` ~L75: drop the `'-c', 'commit.gpgsign=false',` pair. **comment trap (L72–74):** remove the WHOLE 3-line comment ("Signing OFF so the peer commit needs no GPG key, even if `commit.gpgsign` is enabled globally…") — it is entirely about the removed pin.

**Do NOT touch:** `user.name`/`user.email`/`init` identity setup, `commit.cleanup=whitespace`
pairs, author-date env spreads. Form B deletions sit alongside identity-config writes
(e.g. `show-interop` L62–64 set `user.name`/`user.email` then L65 sets gpgsign) — delete
ONLY the gpgsign line.

**Why green = proof:** same as Slice 2 — these are existing golden/parity suites; green
with the pin gone confirms the helper neutralizes ambient `commit.gpgsign` (commits stay
unsigned, SHAs match). The phase-boundary `npm run validate` exercises all of them plus
coverage; a divergence would surface as a RED golden.

### TDD steps

1. **RED is structural** — run the 20 suites to confirm a green baseline before editing,
   so any post-edit red is unambiguously the edit.
2. **GREEN (the edit)** — remove the gpgsign pin from each of the 20 files per the
   literal text above; handle the three comment traps (`commit-message` L71–72,
   `reset` L84–85, `rm` L72–74) and the keep-the-other-`-c` cases (`commit-message`,
   `reset` keep `commit.cleanup=whitespace`). Re-flow touched arrays. Run the slice gate
   over all 20 touched suites — all stay green.
3. **REFACTOR** — verify no orphaned comment, no dangling `-c`, no now-unused import or
   helper, biome-clean formatting. Confirm the only diff is removed pins + trimmed
   comments.

### Gate

```
npx vitest run test/integration/blame-interop.test.ts test/integration/checkout-replace-symlink-with-file-interop.test.ts test/integration/cherry-pick-interop.test.ts test/integration/commit-message-interop.test.ts test/integration/describe-interop.test.ts test/integration/hooks-coverage-interop.test.ts test/integration/merge-abort-interop.test.ts test/integration/merge-driver-interop.test.ts test/integration/merge-interop.test.ts test/integration/name-rev-interop.test.ts test/integration/network/submodule-add-update-http-backend.test.ts test/integration/rebase-interop.test.ts test/integration/reset-interop.test.ts test/integration/revert-interop.test.ts test/integration/rm-interop.test.ts test/integration/shortlog-interop.test.ts test/integration/show-interop.test.ts test/integration/stash-interop.test.ts test/integration/status-interop.test.ts test/integration/whatchanged-interop.test.ts && npm run check:types && ./node_modules/.bin/biome check test/integration
```

> Note: the `submodule-add-update-http-backend` suite is an HTTP-backend network suite
> (spawns a git http server); if its standalone run needs the network harness already
> wired by the integration config, run the slice gate from the integration project root
> as configured. If it is gated behind a network flag in CI, the phase-boundary
> `npm run validate` is the authoritative green for it.

### Commit

```
test(integration): retire redundant gpgsign pins from the remaining interop suites
```

## Phase-boundary validation

After Slice 3, the phase-boundary gate is `npm run validate` (all interop suites + unit +
types + lint + coverage + the existing mutation budget). It is the load-bearing proof of
the whole sweep (design § Test strategy 2): because the helper neutralizes the ambient
values, a green `validate` with all pins gone proves each pin was inert. No golden SHA,
ref, reflog, or on-disk-state byte changes. Stryker is unaffected (mutates `src/**`
against `test/unit` only — neither the helper nor the new guard nor the removed pins are
mutated; design § Test strategy 3).

## Decision candidates

**None — design + ADR-356 decided every load-bearing choice.** Exploration surfaced no
new fork: every pin fits cleanly into Form A or Form B; no shared helper carries a pin
(only the helper's own retained doc comment); the comment-splitting cases (`reset`,
`commit-message`, `rm`, `merge-conflict`, `conflict-marker-size-and-labels`) are
mechanical no-dead-code edits the design already flagged ("each removal carries its
now-stale comment with it"), not decisions. Design candidates (a) new ADR-356, (b)
extend `interop-env-hardening.test.ts` with env-object assertion, (c) `test:` commit
type are all already chosen in ADR-356. Candidate (d) (a pin found non-redundant, or a
`config-interop` `--local`/`--file` found inert) stays a LIVE escalation: if a sweep slice
goes RED on a golden, do NOT massage the test — escalate as
`{ slice, reason, ≤3 options }` (the design's empirical pin predicts green; a red would
contradict the Matrix and is a genuine new finding). `config-interop`'s `--local`/`--file`
is out of scope and untouched.
