# Plan — bundle-size-optimization: stop shipping source maps, re-tighten + enforce the cap

Design: `docs/design/bundle-size-optimization.md` · ADRs: 468 (D1 no-emit + D5
`*.map` guard + D4 tsconfig cleanup), 469 (D2 cap → measured floor), 470 (D3
per-PR gate). All load-bearing choices are settled in those ADRs — see
[Decision candidates](#decision-candidates).

## Nature of this change (read first — it reshapes TDD)

This is **build-config + a bash guard + wireit wiring**, with **zero `src/`
delta and no vitest surface**. Do **not** author any `*.test.ts`. The manifest's
default part gate (`npx vitest run <touched-tests> && …`) matches **no tests
here** — ignore it and run the **explicit per-part commands** each part names.

The **executable spec is the bash guard** `tooling/verify-tarball.sh`
(run via `npm run verify:tarball`). The red→green per part is script-assertion
based:

- **RED** = tighten/add the guard assertion (lower the cap, add the `*.map`
  forbidden-path) and run it against the **current map-shipping build** → the
  guard fails.
- **GREEN** = apply the rollup `sourcemap:false` change, rebuild → the guard
  passes.

Because a committed part must **end green**, the guard-tightening and the rollup
change that satisfies it **co-locate in one atomic part** — the RED is
demonstrated in-sequence during implementation, never committed.

## Pre-flight (facts pinned in this worktree — verified, not guessed)

Baseline `npm pack` (map-shipping, current `HEAD` build): **135 files ·
1053491 bytes (1028.8 KiB) compressed · 3328558 unpacked** — matches the design.

**D1 applied + rebuilt (measured live, then reverted):** clean build (no
`(!) … Rollup 'sourcemap' option must be set …` warning), **zero `.map` files**
(`find dist -name '*.map'` empty), **zero `//# sourceMappingURL=` trailer**.

**Real post-D1 `npm pack` (the D2 contingency authority): 87 files ·
515591 bytes (503.5 KiB) compressed · 1783939 unpacked.**

> **D2 CONTINGENCY TRIGGERED — cap reconciled from 550 → 576 KiB.** ADR-469 sets
> **550 KiB, contingent on the real pack ≤ ~500 KiB**, and mandates scaling by
> **1.1–1.15** if it lands higher. The measured pack is **503.5 KiB > 500 KiB**,
> so 550 KiB gives only **9.2%** headroom (below the 1.1 floor). Scaling into the
> band: 503.5 × 1.1 = 553.9, × 1.15 = 579.0 KiB. The clean KiB boundary in-band
> is **576 KiB (`576 * 1024` = 589824 bytes, ~14.4% ≈ 1.14× headroom)** — matches
> the script's existing `$((N * 1024))` idiom. **This part sets `SIZE_CAP` to
> `576 * 1024`, not 550.** (This is the ADR-mandated measurement reconciliation,
> **not** a re-opened decision — see Decision candidates.) Part 1 re-measures once
> more after its real edits to confirm 503–504 KiB still holds before committing.

**D4 safety (measured live, then reverted):** dropping `declarationMap`+
`sourceMap` from `tsconfig.build.json` → `npm run docs:json` **exits 0** and
regenerates `reports/api.json` **byte-identical to `HEAD`** (typedoc reads the
tsconfig for entry resolution, not map emission; maps never fed api.json). So
**no api.json commit is owed** by D4/D1.

**Neutral gates confirmed green post-D1:** `check:size` (measures
`dist/esm/**/*.js` gzip — never read maps) and `check:exports`
(`attw --pack --profile node16` — resolves types, maps irrelevant) both exit 0.

**Wiring facts (`package.json` `wireit`):**
- `validate.dependencies[]` = `check, check:types, …, check:size, check:exports,
  check:security, …` — **`verify:tarball` is NOT in it** (tag-push only).
- `verify:tarball` = `{ command: "bash tooling/verify-tarball.sh",
  dependencies: ["build"], files: [...], output: [] }`.
- Tag-push invocation: `.github/workflows/pre-publish.yml:23`
  (`npm run verify:tarball`) — **retained untouched**, keeps the full attw check.
- `files: ["dist","LICENSE","README.md"]`; no `.npmignore` (allowlist is the
  sole tarball gate). `dist/` is gitignored — maps are never committed.

**Surface gates (`.claude/workflow/surface-gates.md`) — applicability:**
This change introduces **no new exported symbol, no Tier-1 command, no error
code / union member**. Therefore **none** of the barrel / `Repository` facade /
`repository.test` snapshot / `check:doc-coverage` / `audit-browser-surface` /
README-count / `reports/api.json` gates apply. The only "surface" is the
**tarball contents**, whose executable spec is `verify-tarball.sh` itself. D4's
`docs:json` re-run leaves api.json byte-identical (pinned above), so even the
prepush `check:doc-typedoc` gate stays green with no api.json commit.

**`git` note:** `--no-ext-diff` is rejected by this repo's git proxy — use plain
`git diff` / `grep` for scripted checks in this worktree.

---

## Part 1 — Stop shipping source maps + re-tighten the cap, guarded (D1 + D2 + D4 + D5)

One coherent atomic change: "stop shipping maps and set the cap to the real
floor." The guard-tightening (D2 lower cap + D5 `*.map` forbidden-path) and the
rollup change that satisfies them (D1) co-locate so the RED→GREEN is real. D4
(tsconfig honesty) rides along — it is the config half of the no-maps decision.

### Context

**Files touched (exact paths):**
- `tooling/verify-tarball.sh` (D2 cap, D2 comment rewrite, D5 `*.map` guard)
- `rollup.config.ts` (D1 three flags)
- `tsconfig.build.json` (D4 drop two vestigial flags)

**`tooling/verify-tarball.sh` — current state (verified):**
- Lines 7–13 (comment + cap):
  ```bash
  # Compressed tarball cap. Originally 500 KiB (Phase 11 design §6) when the dist
  # was ~220 KiB; v2.0.0's feature set (cherry-pick / rebase / revert / stash /
  # snapshot engine / …) grew the compressed tarball to ~625 KiB, so the cap is
  # relaxed 10× to 7680 KiB (~7.5 MiB) as a generous temporary ceiling. Bringing
  # the bundle back down is tracked as 26.7 (Phase 26 perf pass) — see
  # docs/BACKLOG.md.
  SIZE_CAP=$((7680 * 1024))
  ```
  → **Replace** the whole block with a provenance-free comment stating the real
  dual-format floor and the new cap:
  ```bash
  # Compressed tarball cap. The published package ships dual ESM+CJS code plus
  # dual .d.ts/.d.cts types (both structurally required — dropping either is a
  # breaking change), so the honest floor is code+types ≈ 482 KiB compressed;
  # the real pack measures ~504 KiB. The cap is set ~14% above that to absorb a
  # few commits of growth before firing. Source maps are not shipped, so they do
  # not count against this cap.
  SIZE_CAP=$((576 * 1024))
  ```
  (No backlog / phase / ADR reference — repo rule.)
- Line 52, the forbidden-path loop (verified):
  ```bash
  for forbidden in "^package/src/" "^package/test/" "^package/reports/" "^package/\.claude/" "^package/\.github/"; do
  ```
  → **Add** the broad `*.map` pattern (ADR-468/D5 option (a), catches `.d.ts.map`
  too):
  ```bash
  for forbidden in "^package/src/" "^package/test/" "^package/reports/" "^package/\.claude/" "^package/\.github/" "^package/.*\.map$"; do
  ```
  The loop already emits `FAIL: tarball contains forbidden path matching
  ${forbidden}` and `exit 1` — no new branch needed.

**`rollup.config.ts` — current state (verified line numbers):**
- Line 42: esm output `sourcemap: true,` → `sourcemap: false,`
- Line 50: cjs output `sourcemap: true,` → `sourcemap: false,`
- Line 66: TS plugin `compilerOptions.sourceMap: true,` → `sourceMap: false,`
- **All three required** (ADR-468): the two output flags drop the `.map` files +
  the `//# sourceMappingURL=` trailer atomically; the TS-plugin flag suppresses
  the `(!) … Rollup 'sourcemap' option must be set to generate source maps.`
  build warning. Leave everything else (`visualizer` →
  `reports/bundle-analysis.html`, `terser`, `dts` config) untouched.

**`tsconfig.build.json` — current state (verified lines 7–8):**
  ```json
  "declaration": true,
  "declarationMap": true,
  "sourceMap": true,
  "stripInternal": true,
  ```
  → **Remove** the `"declarationMap": true,` and `"sourceMap": true,` lines
  (D4b — vestigial for the shipped build; typedoc is the only other consumer and
  does not read them for map emission; confirmed live). Result:
  ```json
  "declaration": true,
  "stripInternal": true,
  ```

**Public-surface decision:** no new exported symbol / command / error code →
**no surface gate applies** (barrel, facade, `repository.test`, doc-coverage,
browser-surface, README-count, api.json all N/A — see Pre-flight). Nothing to
pre-pay.

### TDD steps

**RED (demonstrated in-sequence, not committed):**

1. Ensure the tree is at the map-shipping baseline: `npm run build` then
   `find dist -name '*.map' | wc -l` → **48** (24 `.js.map` + 24 `.cjs.map`).
2. Apply the `verify-tarball.sh` edits **only** (D2 cap → `576 * 1024`, comment
   rewrite, D5 `*.map` forbidden-path). Do **not** touch rollup/tsconfig yet.
3. `npm run verify:tarball` → **FAILS** two ways against the current build:
   - size: `FAIL: tarball scolladon-tsgit-3.0.0.tgz is 1053491 bytes (cap 589824)`
     (1029 KiB > 576 KiB cap), **and/or**
   - maps: `FAIL: tarball contains forbidden path matching ^package/.*\.map$`.
   (Size check runs first and exits, so you'll see the size FAIL; that alone is
   RED. To witness the `*.map` FAIL in isolation, temporarily confirm the grep
   matches: `tar -tzf $(npm pack --silent) | grep -E '^package/.*\.map$' | head`
   → non-empty on the current build. This is the executable proof maps ship
   today.)

**GREEN:**

4. Apply the `rollup.config.ts` D1 flags (lines 42, 50, 66 → `false`) and the
   `tsconfig.build.json` D4 drop (remove the two map lines).
5. Rebuild clean: `rm -rf dist .wireit && npm run build` → **no** sourcemap
   warning in output; `find dist -name '*.map'` **empty**;
   `grep -l sourceMappingURL dist/esm/index.js dist/cjs/index.cjs` **empty**.
6. **Re-measure + reconcile the cap (D2 contingency, ADR-469):**
   `npm pack --dry-run --json | node -e 'const p=JSON.parse(require("fs").readFileSync(0))[0]; console.log(p.size, (p.size/1024).toFixed(1)+" KiB", ((576*1024/p.size-1)*100).toFixed(1)+"% headroom")'`
   → expect **~515591 bytes (~503.5 KiB), ~14.4% headroom**. If the real pack is
   within **503–504 KiB**, `576 * 1024` holds — commit it. If it drifts, re-scale
   by 1.1–1.15 to the nearest clean KiB boundary and update both the `SIZE_CAP`
   value and the "~504 KiB / ~14%" figures in the comment to match (the
   measurement is the authority, per ADR-469).
7. `npm run verify:tarball` → **PASSES**:
   `OK: tarball scolladon-tsgit-3.0.0.tgz verified at ~515591 bytes.` (size < cap, no
   `.map` in inventory, attw still resolves — types dual-emit unchanged).

**REFACTOR:** none — three flag flips, one cap value, one comment, one grep
pattern, two dropped lines. Run `./node_modules/.bin/biome check rollup.config.ts`
(format the touched `.ts`) and confirm `tsconfig.build.json` stays valid JSON
(biome/`check:types` covers this).

### Gate

Explicit commands (the manifest's `vitest` default matches nothing here):

```bash
rm -rf dist .wireit && npm run build          # clean, no sourcemap warning
npm run verify:tarball                          # GREEN — size < cap, no *.map, attw OK
find dist -name '*.map'                          # empty
npm run check:types                              # rollup.config.ts type-correct
./node_modules/.bin/biome check rollup.config.ts # touched .ts formatting
npm run docs:json                                # D4 re-confirm: exits 0
git status --short reports/api.json              # empty — api.json byte-identical, no commit owed
```

Do **not** run full `validate` here (Part 2 wires the new gate in; run `validate`
at the phase boundary after Part 2). `check:size` + `check:exports` are neutral
to map removal (confirmed green live).

### Commit

`build: stop shipping source maps and re-tighten the tarball cap`

(One atomic commit covering D1 + D2 + D4 + D5. No provenance refs. Do **not**
stage `dist/` — gitignored. Do **not** stage `reports/api.json` — byte-identical.
Stage: `rollup.config.ts`, `tsconfig.build.json`, `tooling/verify-tarball.sh`.)

---

## Part 2 — Wire the lightweight tarball guard into the per-PR gate (D3)

The re-tightened cap (Part 1) guards only the tag-push `verify:tarball`. ADR-470
requires the **size cap + `*.map` forbidden-path** to also fire **per PR**,
**without** re-running attw (that stays with the existing `check:exports`, no
double-attw). This part adds that per-PR check.

### Context

**Mechanism chosen (implementation detail — ADR-470 fixed the invariant, not the
vehicle):** add a `--quick` flag to the **one** `verify-tarball.sh` script that
**skips only the attw resolution step**, keeping the size cap + all
required-content + forbidden-path (`*.map`) greps; then add a new wireit script
`check:tarball` → `bash tooling/verify-tarball.sh --quick` (depends on `build`)
and add `check:tarball` to `validate.dependencies[]`. **Rationale:** DRY — one
script serves both cadences (`verify:tarball` full at tag-push,
`check:tarball` quick at PR); the size + `*.map` assertions are defined once and
reused verbatim; a wireit dependency can't pass args, so a distinct wireit key
carrying the flag is the minimal vehicle (a dedicated second script would
duplicate the pack + size + grep logic — rejected as non-DRY).

**Files touched (exact paths):**
- `tooling/verify-tarball.sh` (add `--quick` arg parse + guard the attw block)
- `package.json` (`wireit.check:tarball` new key + `wireit.validate.dependencies[]`
  gains `check:tarball`; add a `"check:tarball": "wireit"` script entry)

**`tooling/verify-tarball.sh` — the attw block to guard (verified lines 60–65):**
```bash
# Resolution check — call the pinned, locally-installed attw rather than …
node_modules/.bin/attw --pack "$TARBALL" --profile node16 || {
  echo "FAIL: arethetypeswrong reported issues" >&2
  exit 1
}
```
→ Parse a `--quick` flag near the top (after `set -euo pipefail`), e.g.:
```bash
QUICK=0
for arg in "$@"; do
  case "$arg" in
    --quick) QUICK=1 ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done
```
→ Guard the attw block so `--quick` skips only it:
```bash
if (( QUICK == 0 )); then
  node_modules/.bin/attw --pack "$TARBALL" --profile node16 || {
    echo "FAIL: arethetypeswrong reported issues" >&2
    exit 1
  }
fi
```
Everything else (pack, `SIZE_CAP` check, required-content, `*.map` forbidden-path,
final `OK:` line) runs in **both** modes. `verify:tarball` (no flag → full attw)
is unchanged at tag-push.

**`package.json` — wiring (verified current state):**
- `wireit.verify:tarball` stays exactly as-is.
- Add a new wireit key mirroring it, with the flag and no attw-tool coupling
  (attw is `node_modules/.bin/attw`, no wireit `files` entry needed for it):
  ```json
  "check:tarball": {
    "command": "bash tooling/verify-tarball.sh --quick",
    "dependencies": ["build"],
    "files": ["tooling/verify-tarball.sh", "dist/**", "package.json", "LICENSE", "README.md"],
    "output": []
  }
  ```
- Add `"check:tarball": "wireit"` to the `scripts` block (next to
  `"verify:tarball": "wireit"`).
- Add `"check:tarball"` to `wireit.validate.dependencies[]` (place it adjacent to
  `check:size` / `check:exports` — the other packaging-adjacent checks — for
  readability; order within the array is not semantically significant to wireit).

**Public-surface decision:** no new exported symbol — a wireit script key is
internal tooling, trips no surface gate.

### TDD steps

**RED (demonstrated in-sequence, not committed).** Part 1 is already committed, so
the map-shipping build no longer exists — the regression Part 2 guards is a
*future* over-cap PR, so the RED proves the **wiring**: that a busted cap makes
`validate` (not just tag-push) fail.

1. Apply the full Part 2 change (add `--quick` to the script, add the
   `check:tarball` wireit key + `scripts` entry, add `check:tarball` to
   `validate.dependencies[]`).
2. Temporarily lower `SIZE_CAP` in `tooling/verify-tarball.sh` to below the real
   pack (e.g. `1 * 1024`) and run `npm run check:tarball` →
   `FAIL: tarball … is 515591 bytes (cap 1024)` and **exit 1** (the `--quick`
   path hits the size check and stops before attw). Then run `npm run validate`
   → it **exits 1** because the new `check:tarball` dependency fails. This is the
   executable proof the per-PR gate now catches a cap regression (the ADR-470
   invariant). **Restore `SIZE_CAP` to `576 * 1024` immediately.**
3. Confirm `--quick` truly skips attw (no double-attw with `check:exports`):
   `npm run check:tarball 2>&1 | grep -i attw` → **empty**;
   `npm run verify:tarball 2>&1 | grep -i attw` → **non-empty** (attw still runs
   at tag-push cadence). Confirm the no-arg `verify:tarball` is unaffected by the
   new arg-parse (it passes zero args → `QUICK=0` → full run).

**GREEN:**

3. With `SIZE_CAP` restored to Part 1's `576 * 1024` and the optimized build:
   `npm run check:tarball` → **PASSES** (`OK: tarball … verified at ~515591
   bytes.`, attw skipped).
4. `npm run validate` → **GREEN end-to-end**: the new `check:tarball` dependency
   packs once, checks size + `*.map`, skips attw; `check:size` + `check:exports`
   stay green (neutral to maps); no double-attw.

**REFACTOR:** none — one arg-parse block, one `if` guard, one wireit key, one
`scripts` entry, one dependency-array insertion. `biome check` /
`check:filesystem` (ls-lint) cover formatting of the touched JSON + shell.

### Gate

Explicit commands:

```bash
npm run build
npm run check:tarball            # GREEN — size < cap, no *.map, attw SKIPPED
npm run verify:tarball           # GREEN — full, attw still RUN (tag-push parity)
npm run validate                 # GREEN end-to-end — new gate wired, no double-attw
npm run check:types              # package.json/wireit unaffected; sanity
```

`npm run validate` is the **phase-boundary gate** for the whole change — it must
be green here (it now includes `check:tarball`).

### Commit

`build: enforce the tarball size and no-source-maps guard in the per-PR gate`

(One atomic commit: `--quick` flag + `check:tarball` wireit key + `validate`
dependency. No provenance refs. Stage: `tooling/verify-tarball.sh`,
`package.json`.)

---

## Decision candidates

**No open decisions — all load-bearing choices are settled in ADRs 468–470:**

- **D1 (source-map handling)** → ADR-468: no-emit (`sourcemap:false` on both code
  outputs + `sourceMap:false` in the TS plugin). Settled.
- **D2 (cap value)** → ADR-469: 550 KiB, **contingent on the real pack ≤ ~500
  KiB, else scale by 1.1–1.15**. The measurement fired the contingency (real pack
  503.5 KiB > 500 KiB), so the plan sets **576 KiB (`576 * 1024`)** per the ADR's
  own scaling rule. This is the **ADR-mandated measurement reconciliation, not a
  re-opened fork** — ADR-469 explicitly delegates the final number to the
  implement-time measurement.
- **D3 (enforcement cadence)** → ADR-470: lightweight per-PR gate (size + `*.map`,
  **no attw**). Settled. The **wiring vehicle** (a `--quick` flag on the one
  script + a `check:tarball` wireit key on `validate`) is an **implementation
  detail** the ADR explicitly leaves to planning — chosen here as the DRY option;
  **not** a user-facing fork.
- **D4 (tsconfig cleanup)** → ADR-468: drop the vestigial `declarationMap`/
  `sourceMap`, guarded by a live `docs:json` confirmation (done — api.json
  byte-identical). Settled.
- **D5 (`*.map` guard)** → ADR-468: broad `^package/.*\.map$`. Settled.

The exploration surfaced **no new load-bearing fork**. The single planning
judgement call — reconciling the cap to 576 KiB — is a measurement outcome the
ADR authorised, recorded in Pre-flight and Part 1.
