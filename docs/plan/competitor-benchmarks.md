# Plan — Competitor benchmark comparison

> Source: design doc `docs/design/competitor-benchmarks.md` · ADRs `480, 481, 482, 483, 484`
> The plan is the implementation script AND the knowledge handoff. Part agents start
> with zero context: whatever a part block omits is paid later as agent rediscovery.
> `plan-lint.sh` enforces the schema below — the plan phase cannot close without it.

## Scope (what the ratified ADRs collapse this to)

A **documentation + measurement** change. The ADRs remove every production-code fork:

- **ADR-480** — the runnable comparison peer is **isomorphic-git only** (already a devDep).
  `simple-git` (native `git` binary) and `wasm-git` (libgit2-in-WASM) are **reference
  points cited as prose**, never bench columns. `nodegit` is excluded. The runnable bench
  set stays exactly two names (`tsgit`, `isomorphic-git`), so **`test/bench/support/bench-dsl.ts`
  and `tooling/bench-summarize.ts` are UNCHANGED** (no N-competitor renderer). **No new
  devDependency is committed** — reference points are measured out-of-band.
- **ADR-481** — the comparison adds **zero library/command surface**: no command, error
  code, or public export. Touches only `docs/**`, `README.md`, `RUNBOOK.md`, and
  `reports/api.json` (regenerated, not authored).
- **ADR-482** — the README gains a compact **"Why tsgit"** slice (≤ ~10 lines): a ~3-row
  curated table (one win, one parity, one honest loss) + a pointer to
  `docs/understand/performance.md` + the ±20%-variance caveat. `performance.md` stays the
  full-dataset home.
- **ADR-483** — published numbers are a **committed, hand-transcribed snapshot with
  provenance** (platform / CPU / Node / iso-git version / date), regenerated via
  `npm run bench:summary`. **No new `bench:publish` script.** Per-release refresh is a
  **manual release-checklist step** (RUNBOOK.md `### Release Process`).
- **ADR-484** — the published scenario set is the existing **six small-repo scenarios**
  (`log`, `readBlob:cold`, `readBlob:warm`, `status:clean`, `status:dirty`, `clone`). **No
  new bench scenarios.** The honest tsgit-slower rows (`readBlob:cold`, `log:walk`) stay.

**Net deliverable files:** `docs/understand/performance.md` (refresh numbers, fix the
Roadmap line, add a labelled reference-point sub-table, update the Methodology comparison-set
bullet), `README.md` (add the "Why tsgit" slice) + `reports/api.json` (regenerated in the
same slice — the typedoc README embed makes it stale), and `RUNBOOK.md` (add the manual
per-release refresh step). All doc-authoring; no `src/` delta.

## Sizing rules

- Every part costs a full agent lifecycle (spin-up, zero-context rebuild, gate) — it
  must earn it. No standalone test-only parts for FEATURE code: coverage/interop/property
  tests fold into the implementation part whose code they exercise. EXCEPTION:
  test-infra-only and **docs-only** parts (tooling config, test helpers, fixtures,
  harness/ADV/property suites, docs/prose) with no `src/` delta ARE standalone — they
  have no implementation part to fold into. **All four parts below are docs-only /
  session-measurement parts; there is no `src/` delta and no coverage/mutation obligation
  (bench files + `tooling/**` + docs are outside `vitest.config.ts` coverage `include`).**

## Coverage / mutation note (applies to every part)

No file under the coverage `include` (`src/{domain,ports,adapters/node,adapters/memory,operators}/**`)
changes. `test/bench/**`, `tooling/**`, `docs/**`, `README.md`, `RUNBOOK.md`, and
`reports/api.json` are all outside it (ADR-481 consequence). The validation/mutation phase
auto-skips — **do not manufacture a test obligation by inventing code parts.** These are
prose/measurement parts; "RED" for a doc part is a verification assertion the edit must
satisfy (e.g. "the four-name Roadmap line still present ⇒ not yet done"), not a vitest test.

## Per-part gate command (manifest gates.part)

`npx vitest run <touched-tests> && npm run check:types && ./node_modules/.bin/biome check <touched-files>`

For a docs-only part there are **no touched tests** and **no `src`/`ts` touched files**
(markdown is not linted by biome, not type-checked). The honest per-part gate for the doc
parts is therefore the **verification checks named in that part's `### Gate`** (link
integrity via `npm run check:doc-links`, and — for Part 3 — the `reports/api.json` prepush
gate). `npm run check:types` and `biome check` are no-ops here (no `.ts` touched) and are
included only to satisfy the mechanical gate string; they must stay green (they will —
nothing type-relevant changes).

---

## Part 1 — Measure: refresh tsgit-vs-iso numbers + capture reference points (SESSION-EXECUTED)

### Context

**This part is SESSION-EXECUTED, not delegated to a short-lived part-implementer agent.**
Bench runs take minutes and this sandbox reaps long foreground bash, so the run must be
**detached** (`nohup … & disown`, then poll). A part-implementer agent cannot reliably block
on it. Its OUTPUT — a transcribed number block — is the documented input to Parts 2 and 3.
This part writes **no committed file**; its artifact is the numbers captured into the session
(and staged into a scratch note the doc parts read). It is listed as a plan part so the
sequence is explicit and the measurement provably precedes transcription.

**Reference host provenance (verified on this host, bake into the doc parts):**
- Platform: `darwin-arm64`
- CPU: `Apple M3 Pro` (from `sysctl -n machdep.cpu.brand_string` / `os.cpus()[0].model`)
- Node: `22.22.3` (`node -v`)
- isomorphic-git: `1.38.7` (`package.json` devDependencies)
- git binary: `2.55.0` (for the `clone` CGI + any simple-git reference point)
- Capture date: the run date (today).

**Runnable-peer measurement (the six published scenarios):**
- Run `npm run build && npm run bench:summary` on THIS host, DETACHED (nohup + poll).
  `bench:summary` is a wireit script (`package.json`) that depends on `test:bench` (writes
  `reports/benchmarks/raw.json`) then runs `tooling/bench-summarize.ts` → writes
  `reports/benchmarks/summary.md`. **`summary.md` is `.gitignored` / NOT committed** — it is
  the scratch source the human transcribes from.
- `summary.md` shape (from `tooling/bench-summarize.ts`): a provenance line
  `Generated <iso> on \`darwin-arm64\` (Node v22.22.3, Apple M3 Pro).` then one row per
  scenario: `| <scenario> | <tsgit> ms (hz, ±rme%) | <iso> ms (hz, ±rme%) | <speedup>× |`.
  The `speedup` column is `iso ÷ tsgit` (**> 1× ⇒ tsgit faster**) — this equals the
  `tsgit/iso` column direction in `performance.md`'s existing table (0.66× = tsgit slower,
  1.95× = tsgit faster). Transcribe the median ms for tsgit and iso, and the ratio, per row.
- The six scenario group names to expect (from the bench files): `clone:small-repo`
  (`clone-small-repo.bench.ts`), `log:walk-50-commits` (`log.bench.ts`),
  `readBlob:cold-cache` + `readBlob:warm-cache` (`read-blob.bench.ts`), `status:clean` +
  `status:dirty-25-files` (`status.bench.ts`). These are exactly the six rows in the current
  `performance.md` table (lines 13–18) — the refresh replaces the numbers, keeps the row set.
- **Watch the `readBlob:cold-cache` row:** PR #225 optimised the fs-containment hot path
  (the extra `lstat` this row was blamed on — `performance.md` line 45). The current 0.67×
  may have moved. Transcribe the FRESH number; do not carry forward the stale 0.67×. If the
  direction flipped (now ≥ 1.0×), Part 2's "Why … slower" section (lines 42–45) must be
  updated to match reality, and Part 3's curated loss row must pick a scenario that is still
  genuinely a loss (if `readBlob:cold` is no longer a loss, use `log:walk` as the honest-loss
  row — it is the other slower scenario).
- If `git-http-backend` is absent or the run is under Stryker, `clone:small-repo` SKIPs
  (`clone-small-repo.bench.ts` SKIP guard) → that row shows `_missing entry_` in `summary.md`.
  If so, note "clone not measured on this host" and keep the prior committed `clone` number
  with its OLD provenance date is NOT allowed (mixed provenance) — instead re-run once
  `git-http-backend` is available, or mark the row explicitly as not-measured-this-refresh.

**Reference-point measurement (prose only — simple-git, wasm-git):**
- Measure in a `mktemp -d` THROWAWAY install under `/tmp`, **never the worktree**, **never a
  committed devDep** (ADR-480). Install `simple-git` and/or `wasm-git` there, measure a
  representative scenario (e.g. `clone:small-repo` for simple-git = native git binary;
  a read/log op for wasm-git = libgit2-WASM), record the wall-clock ms as PROSE.
- These are **apples-to-oranges** (simple-git *is* the native `git` binary; wasm-git *is*
  libgit2 in WASM, contradicting tsgit's "Zero WASM" claim). Capture a one-line label naming
  *what each actually measures*. `rm -rf` the throwaway after. Nothing touches the worktree,
  its `.git/config`, or any global npm/git config.
- If either reference point cannot install/run cleanly on this host, record "not measured on
  this host" for it — never fabricate a number. The reference-point sub-table (Part 2) then
  cites only what was actually measured, or is omitted if neither ran.

**Output of this part** (hand-transcribed into a session scratch note the doc parts consume):
1. Six-row block: `scenario | tsgit ms | iso ms | ratio | direction (faster/parity/slower)`.
2. The provenance line (platform / CPU / Node / iso version / date).
3. Reference-point prose: `simple-git (native git) <op> ≈ X ms`; `wasm-git (libgit2-WASM)
   <op> ≈ Y ms` — each with its apples-to-oranges label, or "not measured on this host".
4. A note whether `readBlob:cold` is still a loss (drives Parts 2 & 3 wording).

### TDD steps

- **RED** (verification precondition): `git grep -n 'darwin-arm64' docs/understand/performance.md`
  still shows the OLD provenance date on line 9, and lines 13–18 still carry the OLD numbers
  ⇒ measurement not yet captured. Expected failure reason: no fresh numbers exist to
  transcribe.
- **GREEN** (measure): detached `npm run build && npm run bench:summary`; poll to completion;
  read `reports/benchmarks/summary.md`; run the mktemp reference-point capture; transcribe
  the six-row block + provenance + reference-point prose into the session scratch note.
- **REFACTOR**: sanity-check the transcribed block against the design's expected shape (six
  scenarios present; `readBlob:cold` direction resolved; no `_missing entry_` silently
  transcribed as a real number). No file committed by this part.

### Gate

Measurement part — no committed artifact, no gate command. Verification is: the session
scratch note holds all six scenario numbers with resolved directions, the provenance line,
and the reference-point prose (or explicit not-measured markers). `npm run check:types` and
`biome check` are trivially green (no file touched).

### Commit

None — this part produces no committed artifact (the numbers are transcribed by Parts 2 & 3).
Session-executed measurement only.

---

## Part 2 — `docs/understand/performance.md`: refresh dataset, fix Roadmap, add reference points

### Context

**File:** `docs/understand/performance.md` (85 lines; read in full before editing). This is
the **full-dataset + methodology home** (ADR-482). Consumes Part 1's transcribed numbers.

Exact edit sites (line numbers point-in-time — re-verify against the live file):

1. **Provenance header — line 9:** `Platform: \`darwin-arm64\`, Node 22.22.3, Apple M3 Pro.`
   Update the Node version if it changed (this host: 22.22.3 — unchanged) and **append the
   capture date + isomorphic-git version** so every published number is dated and
   version-pinned (ADR-483 requires platform / CPU / Node / iso-git version / date). Target
   shape: `Platform: \`darwin-arm64\`, Node 22.22.3, Apple M3 Pro · isomorphic-git 1.38.7 ·
   measured <date>.`

2. **"Current measured numbers" table — lines 11–18:** keep the exact 6-row shape and the
   `| Scenario | tsgit | isomorphic-git | tsgit/iso |` header. Replace each row's numbers
   with Part 1's fresh medians and recompute the `tsgit/iso` ratio + the bold
   `(faster)`/`(slower)`/`(parity)` marker. The six rows (current values shown for the diff
   target — REPLACE with fresh):
   - `clone:small-repo` (1.01× parity)
   - `log:walk-50-commits` (**0.66× slower**)
   - `readBlob:cold-cache` (**0.67× slower** — MAY HAVE MOVED per #225; use fresh)
   - `readBlob:warm-cache` (0.90×)
   - `status:clean` (1.10×)
   - `status:dirty-25-files` (**1.95× faster**)
   Keep the honest tsgit-slower rows (ADR-484) — do not drop or hide a loss.

3. **The `Source:` line (line 7)** and the **±20%-variance caveat (line 20)** stay verbatim
   — they already say "regenerable from `npm run bench:summary`" and "trust direction more
   than absolute numbers." Do not alter; just confirm they survive the edit.

4. **Methodology "Comparison set" bullet — line 27:** currently
   `**Comparison set:** \`isomorphic-git@1.38\` invoked with equivalent options. CGI …`.
   Update to state the **runnable peer is isomorphic-git only** and that simple-git / wasm-git
   are **cited separately as reference points, not peers** (ADR-480). Bump `@1.38` → `@1.38.7`
   for version precision. Keep the existing CGI-lifecycle ADR-017 pointer.

5. **Roadmap line — line 68 (THE single most important doc edit):** currently
   `**Phase 26.7** — Side-by-side competitor benchmarks (\`isomorphic-git\`, \`simple-git\`,
   \`wasm-git\`, \`nodegit\`). Maintained per release.` The four-name enumeration is
   **empirically wrong to publish as a peer list** — the pinned matrix (ADR-480) shows
   simple-git = native git, wasm-git = libgit2-WASM, nodegit = uninstallable. Replace with:
   the **runnable peer is isomorphic-git**; simple-git & wasm-git are **labelled reference
   points**; nodegit is dropped. Match ADR-480's framing exactly. Keep "Maintained per
   release." (ADR-483's manual step — Part 4 documents it).

6. **NEW "Reference points (not pure-JS peers)" sub-table — insert after the main table
   (after line 20's caveat, before the `## Methodology` heading on line 22),** IF Part 1
   measured any reference point. Shape: a small table or prose block citing
   `simple-git` (native `git` binary — apples-to-oranges: measures git itself, not a pure-JS
   library) and/or `wasm-git` (libgit2 compiled to WASM — contradicts tsgit's "Zero WASM"
   claim; different FS/API model). Each carries the apples-to-oranges label naming *what it
   actually measures* and its own measured ms from Part 1. If Part 1 measured NEITHER
   (both "not measured on this host"), omit the sub-table and instead add a one-line note in
   the Methodology comparison-set bullet that reference points were not measured this refresh.

7. **"Why log / readBlob:cold are currently slower" section — lines 42–45:** IF Part 1 shows
   `readBlob:cold` is **no longer a loss** (direction flipped to ≥ 1.0× after #225), rewrite
   the `readBlob:cold-cache` bullet (line 45) to reflect the closed gap (cite the fs-containment
   hot-path optimisation without a phase/PR ref — see the "no provenance refs in prose code"
   nuance below: this is a docs page, so a plain-English "the containment check was optimised"
   is fine, but do NOT write `#225` / `Phase 26.4` in the sentence). If `readBlob:cold` is
   still a loss, leave the section as-is (numbers in the prose need no change — it names no
   figure). The `log:walk` bullet (line 44) stays unless the fresh number flips it too.

**No provenance refs in prose:** `docs/**` pages MAY reference ADR numbers via markdown links
(the existing page does — ADR-471, ADR-017, ADR-056). That is the doc tracking surface and is
allowed (CONTRIBUTING.md "No tracking refs in code" explicitly exempts `docs/`). Do NOT
introduce raw `Phase 26.x` / `#PR` refs in *narrative sentences* where a plain-English
description reads better, but ADR **markdown links** are fine and match the page's style.

**Link integrity:** the page already links `../adr/471-…`, `../adr/017-…`, `../adr/056-…`,
`security.md`, `../BACKLOG.md`. Any new ADR link (e.g. to ADR-480 for the reference-point
framing) must resolve — `npm run check:doc-links` (lychee) is the gate. Relative paths from
`docs/understand/` to `docs/adr/` are `../adr/NNN-…md`.

### TDD steps

- **RED** (verification precondition): `git grep -n 'simple-git.*wasm-git.*nodegit' docs/understand/performance.md`
  matches line 68 (the four-name peer list still present) AND line 9 lacks a capture date /
  iso-git version ⇒ not yet corrected. Expected failure reason: the Roadmap line still
  publishes an unfair four-way peer comparison; provenance is undated.
- **GREEN** (edit): apply edits 1–7 above using Part 1's numbers. Provenance line dated +
  version-pinned; six rows refreshed; Comparison-set bullet names iso-git as the sole peer;
  Roadmap line names the peer + labelled reference points (nodegit dropped); reference-point
  sub-table added iff measured; "slower" section reconciled with fresh direction.
- **REFACTOR**: verify — (a) all six rows present with a direction marker; (b) at least one
  honest loss remains visible; (c) Roadmap line no longer names nodegit/simple-git/wasm-git
  as peers; (d) provenance carries platform / CPU / Node / iso-git version / date; (e)
  ±20%-variance caveat intact; (f) any new ADR link resolves.

### Gate

`npm run check:doc-links` (lychee — all markdown links in `performance.md` resolve, including
any new ADR link) · `npm run check:types` + `./node_modules/.bin/biome check` (trivially green
— no `.ts`/`.json` touched; markdown is neither type-checked nor biome-linted). No vitest tests
touched.

### Commit

`docs(performance): refresh competitor numbers, correct roadmap peer set`

---

## Part 3 — `README.md`: add "Why tsgit" slice + regenerate `reports/api.json`

### Context

**Files:** `README.md` (65 lines) AND `reports/api.json` (regenerated, NOT hand-edited).
Consumes Part 1's numbers and MUST land in the SAME commit as the api.json regen.

**The api.json prepush gate (the single easiest gate to miss — pre-pay it in THIS slice):**
`typedoc.json` sets `"readme": "README.md"`, and the `docs:json` wireit script lists
`README.md` in its `files` and outputs `reports/api.json` (4.2 MB). The README text is embedded
verbatim in `reports/api.json` (confirmed: `grep -c 'Lightning-fast git' reports/api.json` = 1).
Therefore **ANY README.md edit makes `reports/api.json` stale.** The staleness is caught by
`check:doc-typedoc` (`git diff --exit-code -- reports/api.json` after `docs:json`) at
**PREPUSH — NOT at `npm run validate`.** So this slice MUST run `npm run docs:json` and commit
the regenerated `reports/api.json` alongside the README edit. The huge typedoc-id diff is
expected/normal. Missing this = a red prepush after a green local validate.

**README edit — the "Why tsgit" slice (ADR-482):**
- **Insertion point:** between the `## Capabilities` section (ends line 51, the
  `→ [Commands] …` funnel line) and `## Documentation` (line 53). Add a new `## Why tsgit`
  heading there. (Design §Part B: "sits between them or under a new heading.")
- **Content (≤ ~10 lines, lean):** a curated **3-row table** drawn from Part 1's six
  scenarios — **one representative win, one parity, one honest loss** (ADR-482). Recommended
  rows: `status:dirty` (win), `clone:small-repo` (parity), and the honest loss —
  `readBlob:cold` IF still a loss per Part 1, else `log:walk` (the other slower scenario).
  Use the fresh ratios from Part 1. **Must show ≥ 1 honest loss** (ADR-482 consequence: no
  cherry-picking only wins).
- **Pointer + caveat:** one line linking to the full dataset:
  `→ [Full benchmarks + methodology](docs/understand/performance.md)`, and the ±20%-variance
  caveat inline or by pointer (e.g. `_±20% runner variance — trust direction, not absolute
  numbers; re-run on your hardware._`). The relative link from repo-root `README.md` is
  `docs/understand/performance.md` (no `../`).
- **Provenance:** the README slice need not repeat the full provenance line, but must not
  present numbers as timeless — the pointer to `performance.md` (which carries the dated
  provenance) satisfies citability. Keep the slice ≤ ~10 lines.

**DO NOT TOUCH the "43 Tier-1 commands" count line (line 46).** This change adds no command
(ADR-481) — the count stays accurate. No barrel/facade/repository.test/doc-coverage/browser-
scenario surface gate fires (ADR-481; surface-gates.md); the ONLY prepush surface gate here is
api.json via the README embed. Confirm line 46 is byte-identical after the edit.

**Link integrity:** `docs/understand/performance.md` must exist and resolve (it does — Part 2
edits it). `npm run check:doc-links` (lychee) scans `README.md` and gates the link.

### TDD steps

- **RED** (verification precondition): `git grep -n 'Why tsgit' README.md` returns nothing
  ⇒ slice absent. And after a hypothetical README edit without regen,
  `npm run docs:json && git diff --exit-code -- reports/api.json` would exit non-zero ⇒ api.json
  stale. Expected failure reason: no "Why tsgit" slice; api.json would be stale on push.
- **GREEN**: insert the `## Why tsgit` slice (3-row win/parity/loss table + pointer + caveat)
  between `## Capabilities` and `## Documentation`, using Part 1's numbers. Then run
  `npm run docs:json` and stage the regenerated `reports/api.json`. Verify
  `git diff --exit-code -- reports/api.json` is now clean (staged), i.e. the committed api.json
  matches a fresh regen.
- **REFACTOR**: verify — (a) slice ≤ ~10 lines, lean tone preserved; (b) exactly one honest
  loss row present; (c) pointer link resolves; (d) ±20%-variance caveat present; (e) the
  "43 Tier-1 commands" line unchanged; (f) `reports/api.json` regenerated and staged in this
  same slice.

### Gate

`npm run docs:json` then `git diff --exit-code -- reports/api.json` must be clean (the
committed api.json matches a fresh regen — this is the `check:doc-typedoc` prepush gate,
pre-paid here) · `npm run check:doc-links` (README links resolve) · `npm run check:types` +
`./node_modules/.bin/biome check` (trivially green — markdown untouched by both; `reports/api.json`
is generated, not source). No vitest tests touched.

### Commit

`docs(readme): add Why tsgit competitor slice`

---

## Part 4 — `RUNBOOK.md`: add the per-release bench-refresh step

### Context

**File:** `RUNBOOK.md` — the `### Release Process` section (heading at line 165; the numbered
steps 1–5 run lines 167–172, followed by the source-maps paragraph at line 174). ADR-483
mandates a **manual release-checklist step** for refreshing the published numbers; this is its
home (verified: RUNBOOK.md is the only doc with a `### Release Process` section — CONTRIBUTING.md
has only a generic "Branch Finalization Checklist", not release-specific; `docs/` has no
release page).

**Edit:** append one step (as step 6 in the numbered list, or a short note paragraph
immediately after the list at line 172, before the source-maps paragraph at line 174) stating:
before cutting a release, re-run `npm run bench:summary` on the reference host, then
hand-transcribe the fresh numbers into **`docs/understand/performance.md`** (the full table +
provenance date) **and the README "Why tsgit" slice** (the curated 3 rows), updating the
provenance date on both. This keeps the two published surfaces consistent (ADR-482 consequence)
and the citable numbers honestly dated (ADR-483). Phrase it as a manual step, not a scripted
gate (ADR-483: no `bench:publish`, no blocking gate). Match RUNBOOK.md's existing numbered-step
prose style.

**No provenance refs in prose:** RUNBOOK.md already links ADRs/phases in some sections; a plain
`npm run bench:summary` instruction needs none. Do not add a raw `ADR-483` / `Phase 26.7` ref
in the step sentence — describe the action plainly. (RUNBOOK is a doc page, so an ADR markdown
link would be *permitted* per CONTRIBUTING's doc-exemption, but the step is clearer without one.)

**Link integrity:** if the step links `docs/understand/performance.md`, the relative path from
repo-root `RUNBOOK.md` is `docs/understand/performance.md`. `npm run check:doc-links` gates it.

### TDD steps

- **RED** (verification precondition): `git grep -n 'bench:summary' RUNBOOK.md` shows only the
  existing Benchmarking-section mentions (lines ~18–56 / 77–93), NONE inside the
  `### Release Process` section (lines 165–210) ⇒ the per-release refresh step is absent.
  Expected failure reason: the release process does not tell a releaser to refresh the
  published numbers, so they silently go stale.
- **GREEN**: add the manual bench-refresh step to the `### Release Process` numbered list
  (or as a note right after it), naming `npm run bench:summary` + transcribe into
  `performance.md` + the README slice + update the provenance date.
- **REFACTOR**: verify — (a) the step lives inside `### Release Process`; (b) it names both
  published surfaces (performance.md AND the README slice); (c) it says "update the provenance
  date"; (d) it is phrased as manual, not a scripted gate; (e) any link resolves.

### Gate

`npm run check:doc-links` (RUNBOOK.md links resolve) · `npm run check:types` +
`./node_modules/.bin/biome check` (trivially green — markdown untouched by both). No vitest
tests touched.

### Commit

`docs(runbook): document per-release benchmark refresh step`

---

## Phase-boundary gate

After all parts land: `npm run validate` (manifest `gates.phase`) must be green. Note: the
api.json staleness that a README edit introduces is a **prepush** gate (`check:doc-typedoc`),
NOT part of `validate` — it is pre-paid inside Part 3 by regenerating and committing
`reports/api.json`. So a green `validate` here is necessary but NOT sufficient; the Part 3
api.json regen is what keeps the eventual push green.

## Decision candidates

The ADRs (480–484) decide the entire scope; no new load-bearing fork was found during
codebase exploration. One location choice surfaced and is **resolved by the codebase**, not
left open:

| # | Choice | Alternatives (≤3) | Recommendation | Why |
|---|---|---|---|---|
| 1 | Where the manual per-release bench-refresh step (ADR-483) lives | (a) `RUNBOOK.md` `### Release Process` section; (b) CONTRIBUTING.md "Branch Finalization Checklist"; (c) a new `docs/` release page | **(a)** — RESOLVED, not open | `RUNBOOK.md` already has a dedicated `### Release Process` section (line 165) describing the release-please → tag → publish flow; the refresh step belongs with the release steps. CONTRIBUTING.md's checklist is branch-finalization (per-PR), not release-specific; `docs/` has no release page and ADR-482 forbids spawning a new doc page for this. No new decision needed — Part 4 uses (a). |
