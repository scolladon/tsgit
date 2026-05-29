# Plan — Browser-surface audit: namespace awareness

Implements `docs/design/phase-19-5b-browser-surface-namespace-awareness.md`
and ADR-195. Two slices, ordered so `npm run validate` is green at every
commit boundary.

## Slice dependency graph

```
Slice 1 (config parity scenario)  ──>  Slice 2 (namespace-aware audit)
        coverage data first             gate capability second
```

Slice 1 **must** land before Slice 2: Slice 2's parser change makes the real
audit enforce `config`; if the scenario (its only dotted call site) is not
already present, `npm run validate` would fail on a `config` gap mid-slice.
Slice 1 is purely additive — the unchanged scanner ignores its dotted calls,
so the audit is unaffected while the scenario runs green in the parity suite.

---

## Slice 1 — `config` parity scenario

**Files**
- create `test/parity/scenarios/config.scenario.ts`
- modify `test/parity/scenarios/index.ts` (register `configScenario`)

**Red**
- Write `config.scenario.ts` with a deterministic `ConfigResult` golden
  (`set`/`get`/`unset` at local scope) and register it in `SCENARIOS`.
- `npx vitest run test/parity` — if the `expected` golden is wrong, the
  Node/Memory parity assertion fails first (drives the golden to the real
  read-back values). Confirm the failure names `config`.

**Green**
- Correct the `expected` golden to the observed read-backs. Re-run
  `npx vitest run test/parity` — the new scenario passes on Node + Memory.

**Verify**
- `repo.config.set/get/unset` exact input/result shapes against
  `src/application/commands/config.ts` (`ConfigSetInput`,
  `ConfigGetResult` union `.value`, `ConfigUnsetResult` `.removed`).
- Determinism: no `Date.now`/random; local scope only. Confirm
  `audit-parity-fixtures` stays green.
- Confirm no scenario-count/name snapshot test needs updating (grep
  `SCENARIOS.length` / scenario-name lists in `test/parity`).

**Commit**: `test(parity): config set/get/unset scenario`

---

## Slice 2 — namespace-aware audit (parser + scanner)

**Files**
- modify `tooling/audit-browser-surface.ts`
  - add `TIER1_NAMESPACE_RE = /^ {2}readonly (\w+):\s*commands\.\w+Namespace/gm`
  - union it into `parseRepositoryInterface` (flat first, then namespaces,
    then `TIER1_SKIP` filter)
  - add `NAMESPACE_CALL_RE = /\brepo\.([a-zA-Z]\w*)\.[a-zA-Z]\w*\s*\(/g`
  - union it into `scanCallSites`'s `commands` set (with `TIER1_SKIP` filter)
- modify `tooling/test/unit/audit-browser-surface.test.ts`
- modify `tooling/test/integration/audit-browser-surface.test.ts`

**Red** (unit, write first; run `npx vitest run tooling/test/unit/audit-browser-surface.test.ts`)
- `parseRepositoryInterface`: a `readonly config: commands.ConfigNamespace;`
  line is captured into `commands` alongside flat `BindCtx<…>`. Fails today
  (namespace line invisible).
- `parseRepositoryInterface`: a `readonly foo: commands.Bar;` line (no
  `Namespace` suffix) is **not** captured — locks the `Namespace` suffix
  (kills a loosened-regex mutant that drops or generalises it).
- `parseRepositoryInterface`: flat `BindCtx<…>` + namespace lines in the same
  source yield the merged command list (kills a mutant that drops either the
  flat or the namespace half of the union).
- `scanCallSites`: `repo.config.get(` puts `config` in `commands`. Fails today.
- `scanCallSites`: `repo.primitives.readObject(` keeps `primitives` out of
  `commands` (skip guard on the new loop) while `readObject` lands in
  primitives.
- `scanCallSites`: `mockRepo.config.get(` does **not** add `config` (receiver
  guard).
- `scanCallSites`: `repo.snapshot.head(` adds `snapshot` (permissive — documents
  the harmless-extra-key contract).

**Green**
- Apply the two regex additions + unions in `audit-browser-surface.ts`.
- Re-run the unit file → green.

**Red → Green** (integration; `npx vitest run tooling/test/integration/audit-browser-surface.test.ts`)
- Stub `repository.ts` with `readonly config: commands.ConfigNamespace;` + a
  scenario file calling `repo.config.get(` → exit 0, `config` covered.
- Same stub with **no** dotted call site → exit 1, `config` reported as a
  commands gap (proves enforcement).

**Verify**
- `npm run validate` — the real audit now enforces all five namespaces;
  `branch`/`remote`/`tag`/`sparseCheckout` covered by existing files, `config`
  by Slice 1. Expect exit 0.
- Confirm the parser stays byte-identical to `check-doc-coverage.ts`'s
  `TIER1_NAMESPACE_RE`.

**Commit**: `feat(tooling): namespace-aware browser-surface audit`

---

## Post-slice (workflow steps 6–8)

- Review ×3 (typescript / security / tests), fix-all-until-converged.
- Mutation: `npm run test:mutation` scoped to the touched tooling + scenario;
  kill or annotate survivors.
- Docs: refresh the relevant `docs/use` / `docs/understand` audit notes if any
  reference the parser shape; flip `docs/BACKLOG.md` 19.5b `[ ]` → `[x]`.
- Push + `gh pr create`.
