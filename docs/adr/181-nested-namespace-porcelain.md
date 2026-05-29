# ADR-181: Nested-namespace porcelain for CRUD families

## Status

Accepted (at `ab51e0a`)

Supersedes [ADR-175](175-repo-remote-action-discriminator.md).

## Context

ADR-175 picked a single action-discriminated method (`repo.remote({ kind, … })`) for the remote CRUD family in Phase 20.5, following the precedent of `repo.branch` / `repo.tag` / `repo.sparseCheckout`. Phase 20.6 ships a similar CRUD family for `repo.config` (`get`, `set`, `unset`, `list`, `getAll`, `getRegexp`, `renameSection`, `removeSection`), forcing a re-evaluation of the surface shape.

The candidates considered:

- **A: single action discriminator** — `repo.config({ kind, … })`. Established by ADR-175.
- **B: flat methods** — `repo.configGet`, `repo.configSet`, etc. Pollutes `repo.` autocomplete; long alphabetical wall over time.
- **C: nested namespace** — `repo.config.get(...)`, `repo.config.set(...)`. Matches how the git CLI groups subcommands (`git config get`, `git remote add`, `git branch create`) and how every major TypeScript SDK does it (Octokit, Stripe SDK, Vercel SDK, Prisma).
- **D: free functions, repo as first arg** — `configGet(repo, { key })`. isomorphic-git's style; tree-shakeable; rejected because it breaks the `Repository`-facade story tsgit deliberately committed to.

The user UX evaluation surfaced four dimensions where nested wins decisively over the discriminator: autocomplete drill-down (`repo.config.` filters to config methods), CLI symmetry (`git config get` ↔ `repo.config.get`), low-friction action growth (new methods inside the namespace object, zero `repo.` pollution), and mocking ergonomics (`vi.spyOn(repo.config, 'get')` against a focused surface).

The "type complexity" objection cited in ADR-175's rejection of option C (the `function & { add, remove, … }` intersection) no longer holds: a plain namespace object literal (no callable parent) suffices — the per-action methods are just properties, not overloaded calls.

## Decision

Adopt the nested-namespace shape for every CRUD family on `Repository`:

- `repo.config` is an object `{ get, set, unset, list, getAll, getRegexp, renameSection, removeSection }` — each property a bound method.
- New CRUD-family additions (`repo.config`, future stash/worklog/notes/submodule subcommands) MUST follow the nested shape.
- Existing CRUD families using the action-discriminator (`repo.remote`, `repo.branch`, `repo.tag`, `repo.sparseCheckout`) will be migrated in backlog item **20.8** to match.

Non-CRUD methods (`repo.clone`, `repo.fetch`, `repo.commit`, `repo.status`, `repo.diff`, `repo.merge`, `repo.add`, `repo.checkout`, `repo.log`, `repo.reset`, `repo.rm`, `repo.revParse`, `repo.reflog`, `repo.push`, `repo.fetchMissing`, `repo.init`, `repo.catFile`, `repo.abortMerge`, `repo.continueMerge`) stay flat — they are single-verb operations, not family members. The disjoint-state-machine case ADR-172 protected (`abortMerge` / `continueMerge`) is unchanged.

## Consequences

### Positive

- **Discoverability** — `repo.` autocomplete shows top-level groups (`config`, `remote`, `branch`, `tag`, `status`, `diff`, …) instead of the cross-product. Drilling into a group filters to its actions.
- **CLI mirror** — `repo.config.get(...)` reads exactly like `git config get`. Reduces cognitive translation between docs/help text and the API.
- **Principle of least surprise** — matches the dominant TypeScript-SDK idiom (Octokit, Stripe, Vercel, Prisma) and how tsgit's closest peer (isomorphic-git) groups its surface when not using free functions.
- **Cheap growth** — new actions land as one property on the namespace object. `repo.` surface stays constant.
- **Mocking** — `vi.spyOn(repo.config, 'get')` mocks a small, focused surface. Discriminator-based mocks have to intercept every `kind` branch inside one function.
- **Result types stay per-action** — each method's return type is concrete (`ConfigGetResult`, `ConfigListResult`, …); no discriminated-union narrowing needed at the call site.

### Negative

- **Migration cost** — backlog 20.8 has to rewrite call sites for `repo.remote`, `repo.branch`, `repo.tag`, `repo.sparseCheckout` (porcelain itself + every test + every doc snippet). The diff is mechanical but wide.
- **Two patterns coexist transiently** — until 20.8 lands, `repo.config.get(...)` (nested) and `repo.remote({ kind: 'add', … })` (discriminator) ship side-by-side. Documented in the 20.6 design doc and in this ADR.
- **Slightly more boilerplate per family** — the namespace object has to be assembled (e.g. `config: { get: configGet.bind(null, ctx), set: configSet.bind(null, ctx), … }`) instead of a single method. Mitigated by a small `bindNamespace` helper if the pattern repeats.

### Neutral

- The non-CRUD facade methods are unchanged. ADR-172's flat shape for the merge state machine (`abortMerge`, `continueMerge`) is preserved — that case is disjoint state-machine transitions, not a CRUD family.
- Free functions (option D / isomorphic-git style) remain rejected: the `Repository` facade is a load-bearing public-API decision that 20.6 does not relitigate.

## Alternatives considered

- **A (action discriminator, ADR-175)** — rejected. Hurts autocomplete, requires discriminated-union narrowing at every call site, and pulls every future CRUD family into one large `Result` union that grows with each action.
- **B (flat methods, `repo.configGet`)** — rejected. `repo.` autocomplete grows linearly with every new action across every family. Reads less naturally than the namespaced/CLI form.
- **D (free functions, repo as first arg)** — rejected. Tree-shake benefit acknowledged, but breaks the `Repository`-facade contract and ergonomics (`await using repo = openRepository(...)`).
