# Phase 19.5a — Playwright surface coverage audit

Wave 0 (test base) continuation of `v2.0`. 19.5 stood up the shared
`Scenario<TResult>` registry that runs the same scenario against Node +
Memory (vitest) + Browser/OPFS (Playwright). 19.5a turns that registry
into a **completeness contract**: every command and primitive bound on
the `Repository` facade is either exercised in a browser-reachable
spec, or it is explicitly exempted with a written reason.

A new audit (`tooling/audit-browser-surface.ts`) parses
`src/repository.ts`, scans the union of `test/browser/*.spec.ts` and
`test/parity/scenarios/*.ts` for call sites against `repo.<name>(` and
`repo.primitives.<name>(`, and reports any name that is neither covered
nor allowlisted. CI runs the audit and **blocks the PR** if a gap
exists. The "close gaps" half of the phase ships ~a dozen bundled parity
scenarios that pull the gap report down to the documented exempt set
(transport + hooks).

## 1. Goals

1. **Every reachable surface is browser-tested.** A `Repository` member
   that the browser bundle can call must be exercised in a browser-
   reachable spec — either a dedicated `test/browser/*.spec.ts`, or a
   `test/parity/scenarios/*.ts` entry that the existing
   `test/browser/parity.spec.ts` runs against OPFS.
2. **The contract is enforced, not aspirational.** A blocking CI job
   fails any PR that adds a command/primitive without a matching spec.
   Warn-only audits (19.2, 19.4, 19.5) measured drift; this one
   prevents it.
3. **Exemptions are explicit, named, and dated.** When a surface cannot
   be tested in the browser today (transport requires an in-page HTTP
   server; hooks are intentionally Node-only), the exemption lives in a
   versioned allowlist with a `reason` field and a `deferredTo` phase
   tag — never as a silent skip.
4. **No new product code.** Pure test infrastructure + new parity
   scenarios. `src/` is not touched.

Deliberately deferred:

- A browser HTTP transport test harness (transport commands stay
  exempt; addressed in 19.8 alongside the Workers runtime parity work
  that already needs an in-process server).
- Lifting the runtime-parity matrix beyond Node + Browser + Memory
  (19.8).

## 2. Context

### 2.1 What 19.5 left behind

The harness from 19.5 gives us three drivers that run an identical
`Scenario.run(repo, inputs)` against the same golden:

- `test/parity/node.test.ts` — temp dir via `openRepository` from
  `tsgit/auto/node`.
- `test/parity/memory.test.ts` — in-memory FS via `openRepository`
  from `tsgit/auto/memory`.
- `test/browser/parity.spec.ts` — OPFS-backed via Playwright; scenarios
  are looked up by name on `window.__tsgitParity` (ADR-127), inputs
  pass as structured-cloneable data.

That means a single scenario added under `test/parity/scenarios/`
ships browser coverage automatically. **Closing a gap is a one-file
change** — write the scenario; the parity bundle picks it up; the
browser spec exercises it on Chromium and Firefox; the golden
`commit.id` keeps drift honest.

### 2.2 Surfaces today vs surfaces covered

`src/repository.ts` binds:

- 21 tier-1 commands under `repo.<name>`:
  `add`, `branch`, `catFile`, `checkout`, `clone`, `commit`, `diff`,
  `fetch`, `fetchMissing`, `init`, `log`, `merge`, `push`, `reflog`,
  `reset`, `revParse`, `rm`, `sparseCheckout`, `status`, `submodules`,
  `tag`.
- 20 tier-2 primitives under `repo.primitives.<name>`:
  `catFileBatch`, `createCommit`, `diffTrees`, `getRepoRoot`,
  `mergeBase`, `readBlob`, `readIndex`, `readObject`, `readTree`,
  `recordRefUpdate`, `resolveRef`, `runHook`, `updateRef`,
  `walkCommits`, `walkSubmodules`, `walkTree`, `walkWorkingTree`,
  `writeObject`, `writeSymbolicRef`, `writeTree`.

Browser-reachable coverage today:

| Source | Commands | Primitives |
|---|---|---|
| `test/browser/opfs-roundtrip.spec.ts` | `init`, `add`, `commit`, `status` | — |
| `test/browser/surface-parity.spec.ts` | `log`, `branch`, `checkout`, `tag` | — |
| `test/browser/hash-interop.spec.ts` | — | `writeObject`, `readBlob` |
| `test/parity/scenarios/init-add-commit-status` (via `parity.spec.ts`) | (overlaps with `opfs-roundtrip`) | — |
| `test/parity/scenarios/branch-lifecycle` (via `parity.spec.ts`) | (overlaps with `surface-parity`) | — |

So **8 of 21 commands** and **2 of 20 primitives** have browser
coverage; **31 names are gaps**. The audit must surface that number,
and the same PR must drive it down.

### 2.3 Why blocking, not warn-only

19.2, 19.4, and 19.5 each shipped warn-only audits because they
measured a fuzzy property (test pyramid ratios, integration
usefulness, fixture determinism) where a single noisy run shouldn't
block. Browser coverage is binary: a name is either reachable from a
spec or it is not. There is no noise to absorb. ADR-099's posture
("warn first, promote later") only applies when the signal is fuzzy;
when the signal is crisp and the cost of regression is high (a command
silently loses browser coverage on a refactor), promoting straight to
blocking is the right call.

## 3. Architecture

### 3.1 Audit pipeline

```
src/repository.ts ───parseRepositoryInterface──► { commands[], primitives[] }
test/browser/*.spec.ts                ─┐
test/parity/scenarios/*.ts            ─┴─scanCallSites──► CoveredSet
allowlist.json (exemptions)            ───────────────────► ExemptSet

(Bound − Covered − Exempt) = Gaps
Gaps.length === 0  ⇒  exit 0
Gaps.length  > 0   ⇒  exit 1 + write reports/browser-surface-coverage.json
```

### 3.2 Source-of-truth parsing

The regex pair from `tooling/check-doc-coverage.ts` (`TIER1_RE`,
`TIER2_RE`) already extracts the exact names the facade binds. Two
options for re-using it:

- (a) Duplicate the regex in `audit-browser-surface.ts` to keep each
  audit self-contained.
- (b) Extract a shared helper under `tooling/repository-surface.ts`
  and import from both.

(a) — the duplication is two short regex literals plus a five-line
parser. Extracting it would touch the established
`check-doc-coverage` test surface for negligible savings, and a
third consumer hasn't materialized. The new audit owns its parser;
if a third reader appears, refactor then.

### 3.3 Call-site scanning

Both spec files and parity-scenario files name the receiver `repo`
(the `Repository` instance bound from `openRepository`). A regex over
the file text is sufficient:

```
COMMAND_CALL_RE  = /\brepo\.([a-zA-Z][\w]*)\s*\(/g
PRIMITIVE_CALL_RE = /\brepo\.primitives\.([a-zA-Z][\w]*)\s*\(/g
```

Filter the COMMAND_CALL_RE matches by `TIER1_SKIP` ⊕ the literal
`primitives` (the chain root). What remains is the covered command
set.

A few false-positive concerns and how they're handled:

- **`repo.dispose(`** — already filtered via `TIER1_SKIP`.
- **`repo.ctx`** — property access, not a call; the trailing `(`
  filter rejects it.
- **Variable names other than `repo`** — every existing browser/spec
  file uses `repo`. A test-style convention. The audit doesn't try to
  resolve aliases; if a new spec uses a different name, the audit
  will flag the surface as a gap, the author renames the local to
  `repo`, the audit passes. A convention enforced by the test is
  preferable to a parser that pretends to do flow analysis.
- **Cross-evaluate references** — `page.evaluate(async () => { const
  repo = await tsgit.openRepository(...); await repo.log(); })` is
  matched by the regex even though `repo` is bound inside the
  callback. That's the intended behaviour: the call happens against
  the OPFS-backed `Repository`, which is the surface we want to
  exercise.

### 3.4 Allowlist file

`tooling/audit-browser-surface.allowlist.json`:

```json
{
  "commands": [
    {
      "name": "clone",
      "reason": "smart-HTTP transport needs an in-page server; deferred",
      "deferredTo": "19.8"
    },
    { "name": "fetch", "reason": "…", "deferredTo": "19.8" },
    { "name": "push", "reason": "…", "deferredTo": "19.8" },
    { "name": "fetchMissing", "reason": "…", "deferredTo": "19.8" }
  ],
  "primitives": [
    {
      "name": "runHook",
      "reason": "hooks are Node-only by adapter design (browser has no .git/hooks)",
      "deferredTo": null
    }
  ]
}
```

Schema (validated at audit start; a malformed file fails the audit):

```typescript
interface AllowEntry {
  readonly name: string;        // must match a bound surface name
  readonly reason: string;      // non-empty
  readonly deferredTo: string | null; // phase tag or null for permanent
}
interface Allowlist {
  readonly commands: ReadonlyArray<AllowEntry>;
  readonly primitives: ReadonlyArray<AllowEntry>;
}
```

Validation rules:

- Every `name` must be present in the corresponding facade tier; an
  entry for a removed surface fails loudly (prevents allowlist rot).
- Every `reason` must be non-empty. `null` reasons are rejected.
- `deferredTo` is a free-form string for traceability; the audit does
  not check that the named phase exists.

### 3.5 Report file

`reports/browser-surface-coverage.json` — written every run, never
gitignored (so PR diffs show coverage changes):

```json
{
  "summary": {
    "commands": { "bound": 21, "covered": 21, "exempt": 4, "gaps": 0 },
    "primitives": { "bound": 20, "covered": 19, "exempt": 1, "gaps": 0 }
  },
  "covered": {
    "commands": [
      { "name": "init",
        "sources": ["test/browser/opfs-roundtrip.spec.ts",
                    "test/parity/scenarios/init-add-commit-status.scenario.ts"] }
    ],
    "primitives": [...]
  },
  "exempt": {
    "commands": [{ "name": "clone", "reason": "...", "deferredTo": "19.8" }],
    "primitives": [...]
  },
  "gaps": { "commands": [], "primitives": [] }
}
```

Determinism: every list is sorted by name so the diff is human-
readable when a scenario lands or a name moves between sections.

### 3.6 New parity scenarios

The "close gaps" deliverable adds ~12 bundled scenarios. Each one
follows the existing pattern (deterministic inputs, golden output,
self-contained `run`):

| Scenario file | Closes |
|---|---|
| `cat-file.scenario.ts` | `catFile`, `catFileBatch` |
| `diff.scenario.ts` | `diff`, `diffTrees`, `mergeBase` |
| `merge-ff.scenario.ts` | `merge` (fast-forward path; no conflicts) |
| `reflog.scenario.ts` | `reflog` |
| `reset-rm.scenario.ts` | `reset`, `rm` |
| `rev-parse.scenario.ts` | `revParse` |
| `sparse-checkout.scenario.ts` | `sparseCheckout` |
| `submodules-empty.scenario.ts` | `submodules`, `walkSubmodules` |
| `read-pipeline.scenario.ts` | `readObject`, `readTree`, `readIndex`, `getRepoRoot` |
| `refs.scenario.ts` | `resolveRef`, `updateRef`, `writeSymbolicRef`, `recordRefUpdate` |
| `walk.scenario.ts` | `walkCommits`, `walkTree`, `walkWorkingTree` |
| `write-pipeline.scenario.ts` | `createCommit`, `writeTree` |

Each new scenario is registered in `test/parity/scenarios/index.ts`;
the browser bundle picks them up automatically through the existing
`tooling/build-parity-bundle.ts` step. The Node and Memory drivers
discover them via `describe.each(SCENARIOS)`.

The `expected` golden is computed by running the scenario once on
Node and copying the result into the literal — same workflow 19.5
established for `branch-lifecycle` and `init-add-commit-status`.

### 3.7 Wireit integration

A new `check:browser-surface` script joins the existing
`check:doc-coverage` chain:

```jsonc
"check:browser-surface": {
  "command": "tsx tooling/audit-browser-surface.ts",
  "files": [
    "src/repository.ts",
    "test/browser/**/*.spec.ts",
    "test/parity/scenarios/**/*.ts",
    "tooling/audit-browser-surface.ts",
    "tooling/audit-browser-surface.allowlist.json"
  ],
  "output": ["reports/browser-surface-coverage.json"]
}
```

It joins the `check` and `validate` aggregates so a local `npm run
validate` and the corresponding CI job both run it.

## 4. Testing strategy

- **Unit (Vitest, in `test/unit/tooling/audit-browser-surface.test.ts`):**
  - `parseRepositoryInterface` already has full coverage in the doc-
    coverage suite; the shared-helper extraction adds a regression
    test that both consumers receive the same lists.
  - `scanCallSites` over a literal source string exercises the
    `repo.X(` and `repo.primitives.X(` regexes, including the
    `dispose`/`ctx`/`primitives` filters.
  - `loadAllowlist` rejects malformed JSON, empty reasons, and
    entries naming nonexistent surfaces.
  - `computeGaps` returns sorted diff lists for every combination
    of (covered ∩ exempt ∩ bound) inputs.
- **Integration (Vitest, in `test/integration/tooling/audit-browser-surface.test.ts`):**
  - Run the audit's `main()` against a temp tree containing a
    miniature `src/repository.ts`, two spec stubs, and an allowlist.
    Assert exit 0 / 1 and report content.
  - `@proves: tooling/audit-browser-surface.ts:cli`.
- **No new product tests.** The scenarios themselves are E2E and
  contribute to the parity matrix.

## 5. Key design decisions (ADRs)

- **ADR-130** — Browser coverage is the union of dedicated
  `test/browser/*.spec.ts` and parity scenarios (the latter are
  browser-reachable via `test/browser/parity.spec.ts`). Both
  contribute to coverage equally; the audit makes no preference.
- **ADR-131** — Allowlist file format and discipline (per-entry
  `reason` + `deferredTo`, validated against bound surfaces).
- **ADR-132** — Blocking gate, not warn-only. Coverage is a binary
  property; the warn-then-promote pattern from ADR-099 / ADR-125
  doesn't apply.
- **ADR-133** — Transport commands (`clone`, `fetch`, `push`,
  `fetchMissing`) and `runHook` are the only opening exemptions, each
  with a dated rationale.

## 6. Out of scope

- Building an in-page HTTP server for transport scenarios (19.8).
- Property-based scenarios (19.6) and canonical-git interop (19.7).
- Lifting coverage of internal helpers under `src/` that aren't bound
  on the facade — those are tested at the unit tier and don't ship
  as user surface.
- Aliasing analysis in the call-site scanner (the `repo` naming
  convention is a sufficient contract; deviations get caught by the
  audit and are fixed by renaming).
