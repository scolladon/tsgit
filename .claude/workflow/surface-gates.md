# Public-surface gates — tsgit (plan / implement / review context)

A new **public** symbol trips surface gates in separate tooling (not the type system) — each fails `validate` or the `prepush` hook as its own red run. The planner DECIDES public-vs-internal per new symbol up front; public → the slice's context lists the gates so the implementer pre-pays them in-slice (not at the phase-boundary validate). Paths are point-in-time — verify against current code; the gate set is stable, locations may drift.

## Internal vs public — decide first

An export consumed only within `src/` is **internal** (barrel it if a sibling needs it, nothing else). A symbol reachable by library users (a `Repository` method, an exported type/error code, anything re-exported from the package entry) is **public** and trips the gates below.

## New error code / discriminated-union member

1. Add the code to the error union in `src/domain/error.ts`.
2. Wire the **exhaustiveness switches** over the union (`exhaustiveness.ts` + any `switch`/never-check) — the compiler finds these only once you build, so list them for the slice.
3. If barrel-exported, update the **exhaustive barrel-surface test** (asserts the set) in the same slice — don't let it surface at phase-boundary validate.

## New Tier-1 command (full set)

1. **Barrel** — export from `src/application/commands/index.ts` (alphabetical).
2. **Facade** — the `Repository` interface + the guarded binding in `src/repository.ts` + the sorted `Object.keys(sut)` list in `test/unit/repository/repository.test.ts` (surface-snapshot assertion).
3. **`check:doc-coverage`** — `docs/use/commands/<kebab>.md` + an index row in `docs/use/commands/README.md` (missing either fails validate).
4. **`audit-browser-surface`** — invoke `repo.<cmd>(…)` in a `test/parity/scenarios/*.scenario.ts` `run()`, or allowlist with a reason.
5. **Count + api.json** — bump the "N Tier-1 commands" line in root `README.md`, then regenerate `reports/api.json` via `npm run docs:json` (typedoc embeds the README, so the count change makes api.json stale).

## api.json is a prepush gate, not a validate gate

`reports/api.json` staleness is caught by `check:doc-typedoc` at **prepush**, not by `validate` — local validate can be green yet the push hook rejects. Any new public export changes api.json: regenerate with `npm run docs:json` and commit it (the huge typedoc-id diff is normal). Pre-pay in the slice that adds the export.
