# Plan — infra/policy off op signatures

Implements [design](../design/infra-policy-off-signatures.md) /
[ADR-267](../adr/267-infra-policy-off-op-signatures.md). Two slices, each an
atomic breaking commit, validate green throughout.

Decisions locked: (1) `breakStaleLockMs` read repo-wide in `acquireIndexLock`
from `ctx.config`; (2) clone SSRF guard removed entirely from `clone`, transport
wrapper is the sole enforcement point.

---

## Slice 1 — `breakStaleLockMs` → `ctx.config` (repo-wide), drop add/mv/rm option

**Commit:** `refactor(lock)!: source breakStaleLockMs from config, drop add/mv/rm option`

### Red

1. **`index-lock.test.ts`** — add an isolated pair proving the config fallback in
   `acquireIndexLock`:
   - *Given a stale lock and `ctx.config.breakStaleLockMs`, When acquireIndexLock
     (no `opts.breakStaleLockMs`), Then the stale lock is broken.* (Red: acquirer
     ignores config today.)
   - *Given a stale lock, an explicit `opts.breakStaleLockMs`, AND a `ctx.config`
     value that would behave differently, Then the explicit `opts` value wins*
     (precedence: with a fixed `now`, set the lock age between the two values so
     only the `opts` value treats it as stale → break proves `opts` took
     precedence). Pins the `??` against the `||` / `&&` `LogicalOperator` mutants.
   - Keep the existing `opts`-driven and strict (`RESOURCE_LOCKED`, no
     config/opts) cases unchanged — they already cover config-`undefined`
     (`opts.breakStaleLockMs ?? undefined` ≡ `opts.breakStaleLockMs`).

2. **`add.test.ts` / `mv.test.ts` / `rm.test.ts`** — migrate the stale-lock
   cases from per-call to config: bake `config: { breakStaleLockMs: 1 }` into the
   `staleLockCtx` helper's returned context (`{ ...ctx, fs, config: { ...ctx.config, breakStaleLockMs } }`)
   and drop `{ breakStaleLockMs: 1 }` from the `add/mv/rm(...)` calls. (Red until
   the engine reads config + the field is removed.) Leave the
   "held lock, no breakStaleLockMs → `RESOURCE_LOCKED`" cases as-is (they prove
   the strict default).

### Green

3. **`primitives/internal/index-lock.ts`** — in `acquireIndexLock`, resolve:
   ```ts
   const breakStaleLockMs = opts.breakStaleLockMs ?? ctx.config?.breakStaleLockMs;
   ```
   (replacing `const breakStaleLockMs = opts.breakStaleLockMs;`). Update the
   doc-comment to note the config fallback.

4. **`commands/add.ts`** — remove `breakStaleLockMs?` from `AddOptions`; replace
   all three `acquireIndexLock(ctx, opts.breakStaleLockMs !== undefined ? … : {})`
   call sites (literal / pathspec / addAll) with `acquireIndexLock(ctx)`.

5. **`commands/mv.ts`** — remove `breakStaleLockMs?` from `MvOptions` (and its
   JSDoc line); the lone call site → `acquireIndexLock(ctx)`.

6. **`commands/rm.ts`** — remove `breakStaleLockMs?` from `RmOptions`; the lone
   call site → `acquireIndexLock(ctx)`.

### Refactor / verify

7. `repository.ts` — the `add`/`mv`/`rm` bindings forward opts verbatim; the
   removed field flows through `BindCtx<…>`, so `check:types` proves every
   consumer compiles against the smaller option types. No binding edit expected.
8. Regenerate `reports/api.json` (`npm run docs:json`) — the three
   `breakStaleLockMs` fields drop from add/mv/rm option types.
9. `npm run validate`. Commit slice 1 (code + migrated tests + api.json).

**Out of scope (23.4g):** `stageEntry` / `unstageEntry` / `setEntryFlags` keep
their `breakStaleLockMs` option and tests — untouched. They transparently inherit
the config fallback via step 3 (precedence: their explicit opt still wins).

---

## Slice 2 — clone SSRF removed from `clone`; transport wrapper is sole guard

**Commit:** `refactor(clone)!: drop per-call SSRF options; transport wrapper is sole guard`

### Red

1. **`clone.test.ts`** — delete the two in-`clone` SSRF tests
   (`Given a resolver that resolves to a blocked address` and
   `Given a resolver and a public address`). They exercise the deleted code path;
   equivalent blocked-host coverage lives in `wrap-transport-validator.test.ts`
   and the integration network suites (clone through the wrapped transport).

### Green

2. **`commands/clone.ts`**:
   - Remove `resolver?` / `allowInsecure?` / `allowPrivateNetworks?` from
     `CloneOptions` (and the `resolver` JSDoc line).
   - Delete the `if (opts.resolver !== undefined) { await validateUrl(...) }`
     block (incl. both `Stryker disable` comments).
   - Drop the now-unused `import { type DnsResolver, validateUrl } from './internal/url-validate.js';`
     (neither symbol is referenced elsewhere in `clone.ts`). `DnsResolver` /
     `validateUrl` stay defined/exported from `internal/url-validate.ts`.
   - Update the clone doc-comment (the paragraph describing the in-clone
     defense-in-depth path) to state the guard is enforced by the transport
     wrapper.

### Refactor / verify

3. **`test/integration/network/clone-http-backend.test.ts`** — drop the per-call
   `allowInsecure` / `allowPrivateNetworks` / `resolver` from the `repo.clone({…})`
   call (lines ~98–100), leaving `repo.clone({ url })`. The `config` block on
   `openRepository` (the real guard) stays. Sweep the sibling network suites for
   any other `repo.clone({ … resolver/allowInsecure/allowPrivateNetworks })` and
   strip the per-call fields the same way.
4. **`test/bench/clone-small-repo.bench.ts`** — drop the per-call SSRF fields from
   its `clone` call; keep the `config` block.
5. Regenerate `reports/api.json` — the three `CloneOptions` fields drop;
   `DnsResolver` was `internal/`, so no extra api.json delta.
6. `npm run validate`. Commit slice 2.

---

## Post-slice (Steps 6–9)

- **Review ×3** (typescript / security / tests) on `git diff main...HEAD`.
- **Architecture refactor pass** — likely a small no-op or a tiny consolidation;
  the two policy reads are already centralized (`acquireIndexLock`,
  `wrapTransportValidator`). State what was considered.
- **Mutation** — focus on `index-lock.ts` (the new `??` line) and `clone.ts`
  (the deleted block sheds two suppressions; confirm no new survivors).
- **Docs** — `docs/use/commands/{add,mv,rm,clone}.md` (remove the per-call
  options, point at `openRepository({ config })`); `docs/understand/security.md`
  (clone SSRF is config/wrapper-only); scan `docs/understand/architecture.md` and
  referenced `docs/design/*`. Flip BACKLOG **23.4f** `[ ]` → `[x]` with a summary
  line. Regenerate api.json once more if any surface drifted.
- **PR** — push `-u`, `gh pr create` with the removal table + test plan.

## Faithfulness / gate notes

- Default (`config` unset) ⇒ identical to git everywhere: strict
  `RESOURCE_LOCKED`, no auto lock-break; SSRF guard governed by config.
- No new interop golden — no new observable behaviour. The unchanged
  unit/interop/parity suites + `wrap-transport-validator.test.ts` + integration
  network clone are the safety net.
- `npm run validate` green before every commit; never `--no-verify`; no ignore
  directives; no phase/ADR refs in source or test code.
