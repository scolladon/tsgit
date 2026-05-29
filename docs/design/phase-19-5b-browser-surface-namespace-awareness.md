# Phase 19.5b — Browser-surface audit: namespace awareness

Wave 0 (test base) continuation. 19.5a stood up
`tooling/audit-browser-surface.ts` as a blocking completeness contract:
every command and primitive bound on the `Repository` facade is either
exercised in a browser-reachable spec/scenario, or explicitly allowlisted
with a written reason.

20.8 then migrated four CRUD families (`remote`, `branch`, `tag`,
`sparseCheckout`) from the action-discriminator shape to nested namespaces
typed `commands.XNamespace`, joining `config` (already a namespace since
20.6). ADR-194 records that these five lines do **not** match the audit's
`TIER1_RE = /^ {2}readonly (\w+):\s*BindCtx</` parser, so they fall **off**
the browser-surface gate. 20.8 closed the matching doc-coverage gap (taught
`check-doc-coverage.ts` the namespace shape) but explicitly **deferred** the
browser-surface half to this item.

This phase closes that gap: teach the audit's parser to capture
`commands.XNamespace` bindings *and* teach its call-site scanner to detect
dotted `repo.X.verb(` invocations, then bring all five namespaces under the
gate. Four of the five (`remote`, `branch`, `tag`, `sparseCheckout`) already
carry dotted call sites in existing parity scenarios, so they go green for
free. Only `config` has zero browser/parity coverage today — this phase adds
a `config` parity scenario to close it (rather than allowlist-exempt a
surface that is fully browser-capable).

## 1. Goals

1. **Namespaced commands are gate-enforced.** A `repo.X` namespace bound as
   `readonly X: commands.XNamespace` must be exercised in a browser-reachable
   spec/scenario, exactly like a flat `BindCtx<…>` command — or allowlisted
   with a written reason.
2. **Dotted call sites count as coverage.** A `repo.X.verb(` invocation in a
   `test/browser/*.spec.ts` or `test/parity/scenarios/*.ts` file marks the
   namespace `X` as covered (namespace granularity — one verb call covers the
   namespace, mirroring how doc-coverage maps one page per namespace).
3. **`config` gets real coverage, not an exemption.** `config` (local scope)
   reads/writes `.git/config` through pure FS I/O — no transport, no POSIX —
   so it runs unchanged on Node + Memory + Browser/OPFS. A `config` parity
   scenario closes the gap with genuine cross-runtime coverage.
4. **No new product code.** Pure tooling + a new parity scenario. `src/` is
   untouched.
5. **Parser stays consistent with doc-coverage.** The namespace regex mirrors
   `check-doc-coverage.ts`'s `TIER1_NAMESPACE_RE` byte-for-byte, so the two
   audits parse `repository.ts` identically (the invariant ADR-194 relies on).

Deliberately out of scope:

- Per-verb coverage granularity. The bound surface name is the namespace
  (`config`), not its verbs; coverage is asserted at namespace granularity to
  match both the parser's unit and doc-coverage. Per-verb enforcement would
  require parsing each `XNamespace` interface body — a larger change with no
  precedent and no ADR-194 mandate.
- The four transport commands (`clone`/`fetch`/`fetchMissing`/`push`) and
  `runHook` — they stay on the existing allowlist (19.8 / adapter design).

## 2. Current behaviour (the gap)

`tooling/audit-browser-surface.ts` parses two tiers:

```ts
const TIER1_RE = /^ {2}readonly (\w+):\s*BindCtx</gm;   // flat commands
const TIER2_RE = /^ {4}readonly (\w+):\s*BindCtx</gm;   // primitives
```

`src/repository.ts` binds the five namespaces as:

```ts
readonly branch: commands.BranchNamespace;
readonly config: commands.ConfigNamespace;
readonly remote: commands.RemoteNamespace;
readonly sparseCheckout: commands.SparseCheckoutNamespace;
readonly tag: commands.TagNamespace;
```

None match `BindCtx<`, so `parseRepositoryInterface` never yields them —
they are absent from `bound.commands`, hence never counted as gaps. The
call-site scanner is the symmetric half:

```ts
const COMMAND_CALL_RE = /\brepo\.([a-zA-Z][\w]*)\s*\(/g;
```

`repo.config.get(` does not match (after `repo.config` comes `.`, not `(`),
so even the existing dotted calls in scenarios are invisible to the audit.

## 3. Design

### 3.1 Parser — capture namespace bindings

Add a namespace regex mirroring `check-doc-coverage.ts` and union it into the
tier-1 result before the `TIER1_SKIP` filter:

```ts
// Nested-namespace command bindings (`repo.config`, `repo.remote`, …) are
// not `BindCtx<…>` — they are typed `commands.XNamespace`. Capture them so
// the namespaced CRUD families stay browser-surface-enforced alongside flat
// commands (parser kept identical to tooling/check-doc-coverage.ts).
const TIER1_NAMESPACE_RE = /^ {2}readonly (\w+):\s*commands\.\w+Namespace/gm;

export const parseRepositoryInterface = (source: string) => {
  const tier1Bound = matchAll(TIER1_RE, source);
  const tier1Namespaces = matchAll(TIER1_NAMESPACE_RE, source);
  const tier1 = [...tier1Bound, ...tier1Namespaces].filter((n) => !TIER1_SKIP.has(n));
  const tier2 = matchAll(TIER2_RE, source);
  return { commands: tier1, primitives: tier2 };
};
```

`matchAll` already clones the regex internally (`new RegExp(re.source,
re.flags)`), so passing the module-level `TIER1_NAMESPACE_RE` is safe (no
shared `lastIndex` state). Order: flat first, then namespaces — `buildReport`
sorts the output, so ordering is cosmetic, but keeping flat-first matches
doc-coverage.

### 3.2 Scanner — detect dotted namespace calls

Add a namespace-call regex and union its captures into the `commands` set,
applying the same `TIER1_SKIP` filter:

```ts
// Dotted namespace invocations (`repo.config.get(`, `repo.remote.add(`):
// the first segment is the bound namespace name; one verb call covers it.
const NAMESPACE_CALL_RE = /\brepo\.([a-zA-Z]\w*)\.[a-zA-Z]\w*\s*\(/g;

export const scanCallSites = (source: string) => {
  const primitives = new Set(matchAll(PRIMITIVE_CALL_RE, source));
  const commands = new Set<string>();
  for (const name of matchAll(COMMAND_CALL_RE, source)) {
    if (TIER1_SKIP.has(name)) continue;
    commands.add(name);
  }
  for (const name of matchAll(NAMESPACE_CALL_RE, source)) {
    if (TIER1_SKIP.has(name)) continue;
    commands.add(name);
  }
  return { commands, primitives };
};
```

Interaction analysis:

- `repo.config.get(` → `NAMESPACE_CALL_RE` captures `config`. `COMMAND_CALL_RE`
  does **not** match (no `(` after the first segment). No double-count.
- `repo.primitives.readObject(` → `NAMESPACE_CALL_RE` captures `primitives`,
  filtered by `TIER1_SKIP`. `PRIMITIVE_CALL_RE` independently captures
  `readObject` into the primitives set — unchanged. No pollution.
- `repo.snapshot.head(` → captures `snapshot`. Not in `TIER1_SKIP`, not in
  `bound.commands` (it is `readonly snapshot: SnapshotFactory`, not a
  namespace), so it lands as a harmless unused coverage-map entry. The report
  is driven by `bound`, never by coverage keys, so extra keys are inert — this
  matches the scanner's existing permissive contract.
- `repo.ctx.foo(` / `repo.dispose(` → `ctx` / `dispose` filtered by
  `TIER1_SKIP`.
- `mockRepo.config.get(` → `\brepo\.` word boundary requires the receiver to
  be exactly `repo`; `mockRepo` does not match. Receiver-mismatch guard holds.

### 3.3 Coverage outcome

After 3.1 + 3.2, `bound.commands` gains five names. Existing dotted call
sites in coverage dirs (verified by grep):

| namespace | dotted call sites in coverage dirs | result |
|---|---|---|
| `branch` | `branch-lifecycle.scenario.ts` + `surface-parity.spec.ts` + merge scenarios | covered |
| `remote` | `remote-crud.scenario.ts` (`add`/`setUrl`/`rename`/`remove`/`list`/`show`) | covered |
| `tag` | `surface-parity.spec.ts` (`create`/`delete`/`list`) | covered |
| `sparseCheckout` | `sparse-checkout.scenario.ts` (`set`/`list`) | covered |
| `config` | none | **gap → new scenario** |

### 3.4 The `config` parity scenario

`test/parity/scenarios/config.scenario.ts`, registered in
`test/parity/scenarios/index.ts`. Local-scope only (browser-portable). The
result captures deterministic read-backs — never a full `list()`, whose
default entries (`core.repositoryformatversion`, …) can drift across adapter
`init` defaults and break parity:

```ts
interface ConfigResult {
  readonly setScope: string;            // 'local'
  readonly nameAfterSet: string | undefined;   // 'Alice'
  readonly emailAfterSet: string | undefined;  // 'alice@example.com'
  readonly emailAfterUnset: string | undefined;// undefined
  readonly emailRemoved: boolean;       // true
}

run: async (repo) => {
  await repo.init();
  const set = await repo.config.set({ key: 'user.name', value: 'Alice', scope: 'local' });
  await repo.config.set({ key: 'user.email', value: 'alice@example.com', scope: 'local' });
  const name = await repo.config.get({ key: 'user.name', scope: 'local' });
  const email = await repo.config.get({ key: 'user.email', scope: 'local' });
  const unset = await repo.config.unset({ key: 'user.email', scope: 'local' });
  const after = await repo.config.get({ key: 'user.email', scope: 'local' });
  return {
    setScope: set.scope,
    nameAfterSet: name.value,
    emailAfterSet: email.value,
    emailAfterUnset: after.value,
    emailRemoved: unset.removed === true,
  };
}
```

This exercises `set` / `get` / `unset` — three dotted call sites — so the
scanner marks `config` covered, and the parity harness asserts the read-backs
are byte-identical across Node, Memory, and Browser/OPFS.

### 3.5 Allowlist

No allowlist change. The five namespaces are not exemptions — four are
covered by existing scenarios, `config` by the new one.
`validateAllowlistNames` is unaffected: the current allowlist names
(`clone`/`fetch`/`fetchMissing`/`push`/`runHook`) are all still bound, and no
namespace is added to the allowlist.

## 4. Module structure / file layout

| File | Change |
|---|---|
| `tooling/audit-browser-surface.ts` | add `TIER1_NAMESPACE_RE`; union into `parseRepositoryInterface`; add `NAMESPACE_CALL_RE`; union into `scanCallSites` |
| `test/parity/scenarios/config.scenario.ts` | new — config set/get/unset parity scenario |
| `test/parity/scenarios/index.ts` | register `configScenario` in `SCENARIOS` |
| `tooling/test/unit/audit-browser-surface.test.ts` | parser: namespace capture; scanner: dotted-call detection + skip/receiver guards |
| `tooling/test/integration/audit-browser-surface.test.ts` | end-to-end: namespace bound + dotted-call coverage; namespace gap when uncovered |

## 5. Testing strategy

### Unit (`tooling/test/unit/`)

- **parseRepositoryInterface**: a `readonly config: commands.ConfigNamespace`
  line is captured into `commands`; flat `BindCtx<…>` still captured; the
  `commands.\w+Namespace` shape is required (a bare `commands.Foo` without the
  `Namespace` suffix is **not** captured — kills a loosened-regex mutant);
  `TIER1_SKIP` still filters `primitives`/`ctx`/`dispose` from the union.
- **scanCallSites**: `repo.config.get(` marks `config` covered;
  `repo.primitives.readObject(` keeps `primitives` out of `commands` (skip)
  while `readObject` lands in primitives; `repo.snapshot.head(` captures
  `snapshot` (permissive); `mockRepo.config.get(` does **not** count
  (receiver guard); a flat `repo.add(` is unaffected by the namespace regex.

### Integration (`tooling/test/integration/`)

- A staged `repository.ts` stub with a `readonly config:
  commands.ConfigNamespace;` line + a scenario file calling `repo.config.get(`
  → exit 0, `config` reported covered.
- The same stub with **no** dotted call site → exit 1, `config` reported as a
  commands gap (proves the namespace is now gate-enforced, not invisible).

### Parity / interop

- `config.scenario.ts` joins `SCENARIOS`; it runs against Node + Memory
  (vitest) and Browser/OPFS (Playwright) through the existing harness, with
  the golden `ConfigResult` as the load-bearing assertion.

### Property-based testing

Not applicable. The two regexes are anchored matchers over a tiny, fixed
grammar (the five literal namespace lines + dotted call shape) — covered
exhaustively by example + mutation. The four property lenses (round-trip,
compositional aggregator, total function over an algebraic grammar,
idempotence) do not fit a two-line regex extension; a parameterised example
sweep is clearer (per `CLAUDE.md`'s "skip them, no virtue points" guidance
for small-enum / non-algebraic code).

## 6. Mutation resistance

- The namespace regex's `Namespace` suffix is load-bearing — a unit test
  asserts `commands.Foo` (no suffix) is **not** captured, killing a mutant
  that drops `Namespace` from the pattern.
- The `TIER1_SKIP` filter on the namespace-call loop is tested independently
  (`repo.primitives.x(` must not add `primitives` to commands), killing a
  mutant that removes the skip guard from the new loop.
- Coverage outcome assertions (`config` covered with the right source vs
  `config` gap) are split into separate tests so a mutant flipping the
  union/skip logic fails at least one.

## 7. Key decisions (see ADRs)

- **Coverage granularity = namespace, not per-verb** — mandated by ADR-194
  ("dotted `repo.X.verb(` call sites") and consistent with the parser unit
  and doc-coverage. Mechanical; no new ADR.
- **Parser mirrors doc-coverage** — ADR-194 requires the two audits parse
  `repository.ts` identically. Mechanical; no new ADR.
- **`config`: scenario vs allowlist** — genuine judgment call left open by
  ADR-194 ("with whatever new scenarios/allowlist entries that requires").
  Recommendation: a real `config.scenario.ts` — `config` (local scope) is
  fully browser-capable, so an allowlist entry would be a false exemption with
  no legitimate deferral reason. Captured as a new ADR.
