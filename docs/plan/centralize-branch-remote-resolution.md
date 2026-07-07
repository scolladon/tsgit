# Implementation plan — centralize branch/remote resolution

Source of truth (read before implementing any part):
- Design: `docs/design/centralize-branch-remote-resolution.md` (the **Post-decision reconciliation** at the end is authoritative over earlier text).
- ADRs: `docs/adr/456-branch-remote-resolution-primitives.md`, `docs/adr/457-fetch-default-remote-canonical-git.md`, `docs/adr/458-push-remote-and-push-default-canonical-git.md`.

12 parts. Parts 1–4 (refactor substrate + ADR-457 fetch/pull) land ahead of the ADR-458 push body (Parts 5–12). Sequential — one working tree, each builds on the last.

## Conventions binding every part

- **TDD**: RED (failing test + expected failure reason) → GREEN (minimal impl) → REFACTOR. No production line without a red test first.
- **Test shape**: `describe('Given …') > describe('When …') > it('Then …')`, AAA body with section comments, system-under-test named `sut`. 100% line/branch. Mutation-resistant: assert error **data** (`.code`, `.branch`, `.remote`, `.value`) via try/catch — never `toThrow(Class)` alone; one **isolated** test per `||`/`??` branch (a test that trips two guards at once proves neither); assert literal return values (`toBe('origin')`, not a computed expectation).
- **No provenance refs** (phase/ADR/backlog numbers) in any source or test file.
- **No suppression directives** (`@ts-ignore`, `v8 ignore`, `stryker-disable`, `biome-ignore`) without explicit approval.
- **Git-faithful**: pin observable behaviour byte-for-byte against real git; the library emits structured data only (ADR-249) — interop reconstructs git's stderr from the tsgit error fields.
- **Per-part gate** (green before commit): `npx vitest run <touched test files> && npm run check:types && npx biome check <touched source+test files>`. **Phase-boundary gate**: `npm run validate` green. Network interop suites are slow and spawn git — run the specific file and give it a generous timeout; reuse a shared `beforeAll` fixture where the existing suite already does.

## Interop-harness decision (verified against the test tree)

Network commands (`fetch`/`pull`/`push`) already own a real-git-twin harness at **`test/integration/network/{fetch,pull,push}-http-backend.test.ts`** — a local `git-http-backend` server over Node http, with `runGit`/`runGitEnv` from `test/integration/interop-helpers.ts` that scrub every `GIT_*`, set an isolated `HOME` + `GIT_CONFIG_NOSYSTEM=1` (so **signing is OFF** and no global config leaks), and `@proves` docblocks. This IS the faithfulness harness for these commands — every ADR-457/458 behaviour (success AND refusal, with error code + data) is pinned by **extending these three files**, not the top-level `*-interop.test.ts` (which are for local, non-network commands). Refusals are local (git refuses before contacting the remote), so a refusal case asserts the tsgit error `.code`+`.data` via try/catch and confirms the real-git twin refuses with the matching fatal; it does not need the server contacted, but lives in the same suite for cohesion. **Remote-selection cases need 2–3 distinguishable bare backends** — add extra `git init --bare` dirs, `git remote add <name> <bareUrl>` for each, and assert *which* bare received the push via `git --git-dir=<bare> rev-parse <ref>`.

## Surface-gate summary (decided up front)

- **All new resolution primitives + constants are INTERNAL.** `HEADS_PREFIX`, `DEFAULT_REMOTE`, `shortBranchName`, `branchRefFromHead`, `currentBranchRef`, `defaultRemoteName`, `resolvePushRemote`, `planPushRefspecs`, `finalizePushRefspecs`, `parsePushDefault`, `findInvalidPushDefault` — imported by **direct module path** only. Do NOT add any of them to `src/domain/refs/index.ts`, `src/domain/index.ts`, `src/application/primitives/index.ts`, or the `repository.ts` facade (those `export *` / bind to the public surface). Each internal part's gate asserts **`git diff --stat reports/api.json` is empty** — a non-empty diff means a barrel leak; fix the import path, do not regenerate.
- **Public surface IS touched by two categories** (pre-pay `npm run docs:json` + commit `reports/api.json` in that same part — it is a **prepush** gate, invisible to local `validate`):
  1. **`ParsedConfig` widening + new exported `PushDefaultMode`** (Part 5) — `ParsedConfig` is re-exported through the primitives barrel and appears in `reports/api.json`.
  2. **New `CommandError` union members** (Parts 7, 8, 9, 10, 12) — `CommandError` flows into `TsgitErrorData` (public) and into `reports/api.json`.
- **New error code = three edits, one gate, in the same part** (no `exhaustiveness.ts` file, but the switch is real): (1) add the member + a factory to `src/domain/commands/error.ts`'s `CommandError` union; (2) add a `case '<CODE>':` arm to `extractDetail`'s `switch (data.code)` in `src/domain/error.ts` — the `const _exhaustive: never = data` at its tail fails `check:types` until you do; (3) `npm run docs:json` + commit `reports/api.json`. No barrel-surface error-code snapshot test exists (verified). No new Tier-1 command, so none of the command-facade/doc-coverage/browser-scenario/README-count gates fire.

## Plan at a glance

| # | Goal | Behaviour |
|---|---|---|
| 1 | Leaf constants + pure resolution units (internal) | additive, no consumer wired |
| 2 | ADR-456 HEAD-derivation migrations + full 8-site `refs/heads/` consolidation | behaviour-preserving |
| 3 | Submodule `resolveDirect(HEAD)` → `currentBranchRef` | behaviour-preserving |
| 4 | ADR-457 fetch tracking-aware + sole-remote; pull remote → `defaultRemoteName` | **behaviour-change** |
| 5 | Config parser: `branch.*.pushRemote`, `remote.pushDefault`, `push.default` enum | additive infra (public surface) |
| 6 | push remote-selection chain (`resolvePushRemote`) + wire push (still current-branch refspec) | **behaviour-change** |
| 7 | push.default `current` + plan/finalize seam + `PUSH_DETACHED_NO_REFSPEC` | **behaviour-change** |
| 8 | push.default `nothing` + `PUSH_DEFAULT_NOTHING` | **behaviour-change** |
| 9 | push.default `upstream` + `triangular` + `PUSH_REMOTE_NOT_UPSTREAM` | **behaviour-change** |
| 10 | push.default `simple` (the default) + `PUSH_UPSTREAM_NAME_MISMATCH` | **behaviour-change** |
| 11 | push.default `matching` + finalize expansion against advertisement | **behaviour-change** |
| 12 | invalid `push.default` hard refusal (`findInvalidPushDefault` + `INVALID_PUSH_DEFAULT`) | **behaviour-change** |

(The design's Part VII slice 7 — "push.default modes, incrementally" — is realised as Parts 7–11, one mode each; its slice 8 is Part 12.)

---

## Part 1 — Leaf constants + pure resolution units

### Context

Goal: create the shared substrate — two domain constants, one domain transform, two HEAD-derivation primitives, one tracking-aware remote resolver **including the sole-remote fallback** (per the design's Post-decision reconciliation, authoritative). Nothing is wired into a command yet; this part is pure additive surface with its own unit tests.

New files (exact homes, from design Part I):
- `src/domain/refs/ref-prefixes.ts` — `export const HEADS_PREFIX = 'refs/heads/';`
- `src/domain/remote.ts` (NEW file) — `export const DEFAULT_REMOTE = 'origin';`
- `src/domain/refs/short-branch-name.ts` — `export const shortBranchName = (ref: RefName): string => ref.startsWith(HEADS_PREFIX) ? ref.slice(HEADS_PREFIX.length) : ref;` (imports `HEADS_PREFIX` directly from `./ref-prefixes.js`; `RefName` from `../objects/object-id.js`).
- `src/application/commands/internal/default-remote.ts` (NEW) — `defaultRemoteName`.

Edit (add to existing):
- `src/application/primitives/internal/repo-state.ts` — add `branchRefFromHead(head: HeadState): RefName | undefined` and `currentBranchRef(ctx: Context): Promise<RefName | undefined>` (co-located with `HeadState` [lines 36-38] + `readHeadRaw` [line 119]).
- `src/application/commands/internal/repo-state.ts` — the `@deprecated` shim that re-exports from `../../primitives/internal/repo-state.js`; add `branchRefFromHead` + `currentBranchRef` to its re-export list so command consumers (Parts 2–4) import them from `./internal/repo-state.js` alongside `readHeadRaw`.

`defaultRemoteName` exact signature + body (sole-remote INCLUDED — reconciliation overrides the design Part I snippet which omitted it):
```ts
export const defaultRemoteName = (
  config: ParsedConfig,               // '../primitives/config-read.js'
  explicit: string | undefined,
  branch: string | undefined,         // SHORT name; config.branch is keyed by short name
): string =>
  explicit ??
  (branch !== undefined ? config.branch?.get(branch)?.remote : undefined) ??
  (config.remote !== undefined && config.remote.size === 1
    ? [...config.remote.keys()][0]
    : undefined) ??
  DEFAULT_REMOTE;                     // '../../../domain/remote.js'
```

Test files:
- `test/unit/domain/refs/ref-prefixes.test.ts` (NEW)
- `test/unit/domain/remote.test.ts` (NEW)
- `test/unit/domain/refs/short-branch-name.test.ts` (NEW)
- `test/unit/application/commands/internal/repo-state.test.ts` (EXISTING — extend; covers `readHeadRaw`) for `branchRefFromHead` + `currentBranchRef`.
- `test/unit/application/commands/internal/default-remote.test.ts` (NEW)

`ParsedConfig.remote` is `ReadonlyMap<string, {url?; pushUrl?; fetch?; …}>` (config-read.ts:26); `config.remote?.size` and `config.remote.keys()` are the sole-remote inputs. `HeadState = {kind:'symbolic';target:RefName} | {kind:'direct';id:ObjectId}`. Build an in-memory `Context` for `currentBranchRef` the way `repo-state.test.ts` already builds one for `readHeadRaw` (memory adapter, write `.git/HEAD`).

**Internal-only**: do NOT add any of these to `src/domain/refs/index.ts`, `src/domain/index.ts` (line 25 `export * from './refs/index.js'` would leak them), `src/application/primitives/index.ts`, or the facade. Gate asserts `reports/api.json` unchanged.

Property tests: not warranted — `shortBranchName` is a one-way strip; `defaultRemoteName` is a small precedence chain (the repo's "skip property tests for small enums / precedence" rule).

### TDD steps

RED:
- `ref-prefixes`: Given the heads-prefix constant, When read, Then `expect(sut).toBe('refs/heads/')`. (Fails: module absent.)
- `remote`: Given the default-remote constant, When read, Then `expect(sut).toBe('origin')`.
- `shortBranchName`: (a) Given `refs/heads/main`, Then `'main'`; (b) Given nested `refs/heads/feature/x`, Then `'feature/x'` (kills slice-length off-by-one); (c) Given a non-heads ref `refs/tags/v1`, Then `'refs/tags/v1'` unchanged (kills "always slice"). Three isolated `it`s.
- `branchRefFromHead`: (a) Given `{kind:'symbolic',target:'refs/heads/main'}`, Then the exact `RefName`; (b) Given `{kind:'direct',id}`, Then `undefined`. Two isolated `it`s.
- `currentBranchRef`: (a) Given an in-memory ctx whose HEAD is symbolic → the exact `RefName`; (b) Given a detached HEAD → `undefined`.
- `defaultRemoteName` — one isolated `it` per `??` level: explicit wins over tracking+sole+default; tracking (`branch.<b>.remote`) wins when no explicit; **sole-remote** returns the lone remote's name when no explicit/tracking and `config.remote.size===1` (assert the literal lone name, e.g. `'upstreamonly'`, NOT `'origin'`); two remotes with no explicit/tracking → `DEFAULT_REMOTE` (`toBe('origin')`); `branch===undefined` short-circuits the tracking lookup (detached) yet sole-remote still applies; empty/absent `config.remote` → `'origin'`.

GREEN: create the six symbols exactly as specified.

REFACTOR: confirm no duplication with `pull.ts`'s local `shortBranchName` yet (that migration is Part 2). Confirm imports are direct-path.

### Gate

`npx vitest run test/unit/domain/refs/ref-prefixes.test.ts test/unit/domain/remote.test.ts test/unit/domain/refs/short-branch-name.test.ts test/unit/application/commands/internal/repo-state.test.ts test/unit/application/commands/internal/default-remote.test.ts && npm run check:types && npx biome check <the 6 new/edited source files + 5 test files>` — all green. **`git diff --stat reports/api.json` empty.**

### Commit

`refactor: add shared branch/remote resolution primitives`

---

## Part 2 — ADR-456 HEAD-derivation migrations + full 8-site `refs/heads/` consolidation

### Context

Goal: migrate every consumer's HEAD-branch derivation onto the Part 1 atom + transforms, and collapse the 8 duplicated `refs/heads/` constants to the single `HEADS_PREFIX`. **Strictly behaviour-preserving** — every existing command/interop test stays green **unchanged**. **`fetch`/`push` remote resolution and `pull`/`submodule` remote resolution are NOT touched here** (only their `'refs/heads/'` literals, where the meaning is identical).

HEAD-derivation migrations (each keeps its own guard/short/throw shape — Part 1 only replaces the shared atom):
- `src/application/commands/status.ts:121` — `const branch = head.kind === 'symbolic' ? head.target : undefined;` → `const branch = branchRefFromHead(head);` (keeps `head` for `detached = head.kind==='direct'`). Import `branchRefFromHead` from `./internal/repo-state.js`.
- `src/application/commands/rebase.ts:456` — `const branch = head.kind === 'symbolic' ? head.target : undefined;` → `branchRefFromHead(head)` (keeps `head` for `headCommit`).
- `src/application/commands/branch.ts:63-66` — `branchList` currently `head.kind==='symbolic' && head.target.startsWith(HEADS_PREFIX) ? head.target : undefined`. Replace with `const ref = branchRefFromHead(head); const currentTarget = ref !== undefined && ref.startsWith(HEADS_PREFIX) ? ref : undefined;` (guard retained — behaviour-identical). `HEADS_PREFIX` now imported.
- `src/application/commands/pull.ts` — replace the local `HEADS_PREFIX` (line ~27), local `shortBranchName` (63-64), and `shortMergeRef` (66-67) usage: import `HEADS_PREFIX` from `../../domain/refs/ref-prefixes.js` and `shortBranchName` from `../../domain/refs/short-branch-name.js`; derive `currentBranch`/`fallbackRef` via `branchRefFromHead` + `shortBranchName`. **Keep `resolveUpstream`'s remote line `opts.remote ?? tracking?.remote ?? 'origin'` exactly as-is** (its migration to `defaultRemoteName` — which adds sole-remote — is the behaviour-change in Part 4). `shortMergeRef` (undefined-tolerant) may stay as a thin local wrapper over `shortBranchName`, or inline `mergeRef === undefined ? undefined : shortBranchName(mergeRef as RefName)` — behaviour identical.

Full 8-site constant consolidation — replace each local literal/const with an import of `HEADS_PREFIX` from `../../domain/refs/ref-prefixes.js` (constant swap only, behaviour untouched):
- `pull.ts` (done above), `branch.ts:58`, `checkout.ts:50` (`headCheckoutLabel` keeps its `lastSlash` fallback), `submodule.ts:72` (module-level; its internal `headBranchName` [580-583] and other uses keep using the now-imported constant), `worktree.ts:57`, `push.ts:97` (`REFS_HEADS_PREFIX` → import `HEADS_PREFIX`; update the four usages at ~283/286/504/506), `src/application/commands/internal/stash-message.ts:13` (`stashBranchLabel` keeps its `NO_BRANCH` sentinel — imports the constant + slice only), `src/application/commands/internal/refspec.ts:35` (`SHORT_FORM_PREFIX` → import `HEADS_PREFIX`; same literal, `expandShort` behaviour untouched).

No new test files — this is covered by the existing command + interop tests, which must pass **unchanged**. Do NOT alter any existing test's expectations.

**Internal**: no barrel additions; `reports/api.json` unchanged.

### TDD steps

RED: this part has no new behaviour, so the "red" is the existing suite proving the migration is safe — before editing, run the touched commands' tests to confirm green baseline; each edit must keep them green. (The Part 1 unit tests already lock the primitives' behaviour.)

GREEN: apply the mechanical migrations above, one file at a time, re-running that file's tests after each.

REFACTOR: confirm the local `HEADS_PREFIX`/`REFS_HEADS_PREFIX`/`SHORT_FORM_PREFIX`/`shortBranchName` definitions are fully removed (no dead const left); `grep -rn "refs/heads/" src/application/commands src/application/commands/internal` shows only intentional string uses (e.g. path composition), not re-declared prefix constants.

### Gate

`npx vitest run test/unit/application/commands/status.test.ts test/unit/application/commands/rebase*.test.ts test/unit/application/commands/branch.test.ts test/unit/application/commands/pull.test.ts test/unit/application/commands/push.test.ts test/unit/application/commands/checkout.test.ts test/unit/application/commands/worktree.test.ts test/unit/application/commands/internal/stash-message.test.ts test/unit/application/commands/internal/refspec.test.ts && npm run check:types && npx biome check <touched files>` — all green, **no test edits**. `git diff --stat reports/api.json` empty. Submodule tests run in Part 3.

### Commit

`refactor: consolidate refs/heads prefix and HEAD-branch derivation`

---

## Part 3 — Submodule HEAD-read migration

### Context

Goal: migrate the submodule superproject HEAD read from the ref-store path to the shared `currentBranchRef`, and finish the submodule half of the 8-site consolidation. Behaviour-preserving (proven equivalent for HEAD). Kept separate from Part 2 because it is the one non-trivial mechanism change (drops a `getRefStore` dependency on the superproject path).

Edit `src/application/commands/submodule.ts`:
- `resolveBaseUrl` (line ~144): `const head = await getRefStore(ctx).resolveDirect(HEAD_REF);` → derive via `currentBranchRef(ctx)` (import from `./internal/repo-state.js`). Then `const branch = ref !== undefined ? shortBranchName(ref) : undefined` and the base-remote lookup keeps its current inline `(branch !== undefined ? config.branch?.get(branch)?.remote : undefined) ?? 'origin'` shape (import `DEFAULT_REMOTE` for the `'origin'` literal is optional here; **do NOT swap this to `defaultRemoteName`** — that would add the sole-remote fallback, an unpinned behaviour change for submodule that neither ADR-457 nor ADR-458 sanctions; see Risk R1).
- Equivalence to preserve (design Part I): both `resolveDirect(HEAD_REF)` and `readHeadRaw` read `${gitDir}/HEAD` and `parseLooseRef` it; HEAD is present after submodule's repository assertion, so `resolveDirect`'s `missing` variant is unreachable. The existing `submodule init`/`sync` interop tests pin this equivalence.
- The `HEAD_REF` const (line 73) is only used by this call — remove it if now unused; keep `getRefStore` import if still used at the child-repo sites (~631/713 operate on `child`, a different ctx, and are out of scope). Confirm `getRefStore` is not left as a dead import.

No new tests — the existing submodule unit + `test/integration/network/submodule-add-update-http-backend.test.ts` must pass **unchanged**.

**Internal**: `reports/api.json` unchanged.

### TDD steps

RED: green baseline of the existing submodule tests before editing (they are the equivalence pin).

GREEN: apply the `resolveDirect(HEAD_REF)` → `currentBranchRef` migration.

REFACTOR: remove the now-dead `HEAD_REF` const and any unused import; confirm the child-repo `resolveDirect` sites are untouched.

### Gate

`npx vitest run test/unit/application/commands/submodule*.test.ts && npx vitest run test/integration/network/submodule-add-update-http-backend.test.ts && npm run check:types && npx biome check src/application/commands/submodule.ts` — green, **no test edits**. `git diff --stat reports/api.json` empty.

### Commit

`refactor: read submodule superproject HEAD via currentBranchRef`

---

## Part 4 — ADR-457 fetch tracking-aware + sole-remote; pull remote via defaultRemoteName

### Context

Goal: `fetch` (no `<repository>`) becomes tracking-aware with the sole-remote fallback; `pull`'s remote resolution migrates to the shared `defaultRemoteName` (thereby also gaining sole-remote). **Both are behaviour changes** and each carries its own interop pins. (`pull` already resolved `branch.remote ?? origin`; the delta it gains here is only the sole-remote fallback.)

Edit `src/application/commands/fetch.ts`:
- `fetch` (line 79-82): replace `const remoteName = opts.remote ?? 'origin';` with:
  ```ts
  const head = await readHeadRaw(ctx);                        // add import from './internal/repo-state.js'
  const branchRef = branchRefFromHead(head);
  const currentBranch = branchRef !== undefined ? shortBranchName(branchRef) : undefined;
  const config = await readConfig(ctx);
  const remoteName = defaultRemoteName(config, opts.remote, currentBranch);
  ```
  Imports: `branchRefFromHead` from `./internal/repo-state.js`, `shortBranchName` from `../../domain/refs/short-branch-name.js`, `defaultRemoteName` from `./internal/default-remote.js`, `readConfig` already imported. `resolveRemoteUrl` re-reads config today (line 210) — acceptable (config is cached via `readConfig`); no need to thread it. Detached ⇒ `currentBranch===undefined` ⇒ `defaultRemoteName` returns `opts.remote ?? soleRemote ?? DEFAULT_REMOTE` (branch step skipped). No other fetch logic changes.

Edit `src/application/commands/pull.ts` `resolveUpstream` (line ~82): `const remote = opts.remote ?? tracking?.remote ?? 'origin';` → `const remote = defaultRemoteName(config, opts.remote, currentBranch);` (import from `./internal/default-remote.js`). `config` is already read on the line above; keep the `assertNoValuelessConfig(ctx,'branch',currentBranch,['remote','merge'])` guard and the `branch = opts.ref ?? shortMergeRef(tracking?.merge)` line unchanged.

Unit tests (extend existing command tests, in-memory ctx):
- `test/unit/application/commands/fetch.test.ts` — remote resolution: `branch.<cur>.remote` used when no `opts.remote`; `opts.remote` overrides; detached ⇒ branch step skipped; sole-remote used when one non-origin remote and no tracking; two remotes ⇒ `origin`.
- `test/unit/application/commands/pull.test.ts` — sole-remote: single non-origin remote, no `opts.remote`, no `branch.remote` ⇒ pull targets that remote.

Interop pins — extend `test/integration/network/fetch-http-backend.test.ts` (needs up to 2 backend bares to distinguish; add a second `git init --bare` served alongside origin):
1. `branch.<cur>.remote=<upstreamBare>`, no explicit remote, symbolic HEAD → fetched refs land from the upstream bare, not origin (assert `refs/remotes/upstream/*` written, origin untouched).
2. `branch.<cur>.remote` unset, symbolic → fetches origin.
3. explicit `opts.remote` overrides `branch.<cur>.remote`.
4. detached HEAD, `branch.<cur>.remote` set → fetches origin (branch step skipped).
5. **sole-remote** — exactly one remote named non-`origin` (e.g. `solo`), no `branch.remote` → both real git and tsgit fetch `solo` (0/1/2-remote axis).

Interop pin — extend `test/integration/network/pull-http-backend.test.ts`:
6. **pull sole-remote** — single non-origin remote, no `opts.remote`/`branch.remote` → pull integrates from that remote (twin real git). Assert the merged tip via `rev-parse`.

Each interop case runs the real-git twin (`runGitEnv`) against the same bare(s) and compares the observable data (which bare's refs landed).

**Internal**: `reports/api.json` unchanged (fetch/pull result shapes are unchanged).

### TDD steps

RED:
- fetch unit: Given `branch.main.remote=upstream` and no `opts.remote`, When `fetch`, Then it resolves `upstream` — fails today (tsgit hardcodes `origin`). (Assert via the `FetchResult.remote` field / the bare that received refs.)
- fetch sole-remote unit: Given one remote `solo`, no tracking, When `fetch`, Then resolves `solo` — fails today.
- pull sole-remote unit: Given one remote `solo`, no tracking, When `pull`, Then targets `solo` — fails today.
- Interop cases 1, 4, 5, 6 as red twins (tsgit currently diverges on 1/5/6).

GREEN: apply the two edits.

REFACTOR: confirm fetch reads `config` once (avoid a redundant read between the new block and `resolveRemoteUrl`); confirm detached path short-circuits.

### Gate

`npx vitest run test/unit/application/commands/fetch.test.ts test/unit/application/commands/pull.test.ts && npx vitest run test/integration/network/fetch-http-backend.test.ts test/integration/network/pull-http-backend.test.ts && npm run check:types && npx biome check src/application/commands/fetch.ts src/application/commands/pull.ts <touched tests>` — green. `git diff --stat reports/api.json` empty.

### Commit

`feat: fetch resolves tracking remote with single-remote fallback`

---

## Part 5 — Config parser: branch.*.pushRemote, remote.pushDefault, push.default enum

### Context

Goal: extend `ParsedConfig` and the parser for the three keys ADR-458 needs. **No command behaviour changes yet** — this is infra. **Public surface**: `ParsedConfig` and the new `PushDefaultMode` type appear in `reports/api.json`.

Edit `src/application/primitives/config-read.ts`:
1. **Public type `ParsedConfig`** (top of file):
   - `branch` entry (line 39): add `readonly pushRemote?: string;`.
   - `push` bucket (line 72): add `readonly default?: PushDefaultMode;` (keep `gpgSign`).
   - Add top-level `readonly remotePushDefault?: string;`.
   - Add `export type PushDefaultMode = 'nothing' | 'current' | 'upstream' | 'simple' | 'matching';`.
2. **`MutableParsedConfig`** (line 995): mirror — `branch?: Map<string,{remote?;merge?;pushRemote?}>`; `push?: {gpgSign?; default?: PushDefaultMode}`; add `remotePushDefault?: string`.
3. **`mergeBranch`** (line 1210): add the `pushRemote` key. Existing `remote`/`merge` use exact-case `key === …`; the new key uses `key.toLowerCase() === 'pushremote'` (git config keys are case-insensitive; canonical key is `pushRemote`). Skip `value === null` like the siblings. (Leave the pre-existing exact-case `remote`/`merge` inconsistency as-is — out of scope; see design "Out of scope".)
4. **`mergePush`** (line 1356): add `else if (key.toLowerCase() === 'default') { const m = parsePushDefault(value); if (m !== undefined) push.default = m; }`. Add the total classifier:
   ```ts
   const parsePushDefault = (value: string | null): PushDefaultMode | undefined => {
     if (value === 'tracking') return 'upstream';      // deprecated alias
     if (value === 'nothing' || value === 'current' || value === 'upstream'
       || value === 'simple' || value === 'matching') return value;
     return undefined;                                  // present-but-invalid → Part 12 refuses
   };
   ```
   **Case-SENSITIVE** — do NOT lowercase `value` (`Simple`/`TRACKING` → `undefined`). Widen `mergePush`'s `acc.push` param type to carry `default?`.
5. **`remote.pushDefault`** — the subsectionless `[remote]` section is currently unrouted (`dispatchSection`, line 1030, routes `remote` only via `dispatchSubsection` when a subsection is present). Add a subsectionless arm in `dispatchSection` (after the `push` arm): `else if (sec.section === 'remote') mergeRemoteTopLevel(acc, sec);` and a new handler:
   ```ts
   const mergeRemoteTopLevel = (acc: { remotePushDefault?: string }, sec: IniSection): void => {
     for (const { key, value } of sec.entries) {
       if (key.toLowerCase() === 'pushdefault' && value !== null) acc.remotePushDefault = value;
     }
   };
   ```
   **Per-remote `[remote "x"] pushDefault` MUST stay ignored** — do NOT read `pushdefault` in `mergeRemote`/`applyRemoteEntry`. Confirm `dispatchSection`'s subsectioned path still routes `[remote "x"]` to `mergeRemote` only.
6. **`finalize`** (line 1464): add `remotePushDefault` to `finalize`'s local `out` type and `if (acc.remotePushDefault !== undefined) out.remotePushDefault = acc.remotePushDefault;`. The `push` bucket already flows through `finalizeSigningBuckets` — widening its type needs no finalize logic change; widen `FinalizeOut.push` (line 1423) + the `out.push` inline type (line 1498) to include `default?: PushDefaultMode`. Widen `out.branch` (line 1487) to `{remote?;merge?;pushRemote?}`.

The **default** `push.default = simple` is NOT stored — it is applied at read time by the push command (`config.push?.default ?? 'simple'`, Parts 7–11). Absent stays `undefined` (parser's "only store what's present" invariant).

Test file: `test/unit/application/primitives/config-read.test.ts` (EXISTING, extend). Mirror the existing per-key test style (arrange a config string, `readConfig`, assert the `ParsedConfig` field).

Property tests: the config parser already has `config-read.properties.test.ts`. The new keys are simple string fields + a small enum classifier (design Part VI: not warranted). Extend the properties file only if its round-trip grammar already enumerates branch/remote/push keys; otherwise skip per Part VI and note it.

**Public surface**: after GREEN, run `npm run docs:json` and commit `reports/api.json` (ParsedConfig widening + `PushDefaultMode` export change it; caught only at prepush otherwise).

### TDD steps

RED (all fail — parser doesn't model the keys):
- Given `[branch "main"]\n  pushRemote = pushrem`, When `readConfig`, Then `config.branch.get('main').pushRemote === 'pushrem'`.
- Given `[branch "main"]\n  PushRemote = x` (mixed case key), Then parsed as `pushRemote` (`x`) — proves case-insensitive key.
- Given `[branch "main"]\n  pushRemote` (valueless), Then `pushRemote` absent (null skipped).
- Given `[remote]\n  pushDefault = pushdef`, Then `config.remotePushDefault === 'pushdef'`.
- Given `[remote "origin"]\n  pushDefault = x`, Then `config.remotePushDefault === undefined` (per-remote ignored) AND `config.remote.get('origin')` has no such field.
- Given `[push]\n  default = current`, Then `config.push.default === 'current'`; likewise `nothing`/`upstream`/`simple`/`matching` each → itself.
- Given `[push]\n  default = tracking`, Then `config.push.default === 'upstream'` (alias).
- Given `[push]\n  default = Simple`, Then `config.push.default === undefined` (case-sensitive) — isolated from the `bogus` case.
- Given `[push]\n  default = bogus`, Then `undefined` (present-but-invalid; hard refusal is Part 12).
- Given no `[push]` default, Then `config.push?.default === undefined`.

GREEN: apply edits 1–6.

REFACTOR: keep `finalize` under its cognitive-complexity ceiling (the existing `finalize*` extraction helpers pattern); confirm `parsePushDefault` is a total function (never throws).

### Gate

`npx vitest run test/unit/application/primitives/config-read.test.ts && npm run check:types && npx biome check src/application/primitives/config-read.ts <touched tests> && npm run docs:json` — green; **commit `reports/api.json`** (expect a ParsedConfig/PushDefaultMode diff, typedoc-id churn normal).

### Commit

`feat: parse pushRemote, remote.pushDefault, and push.default config`

---

## Part 6 — push remote-selection chain

### Context

Goal: make `push`'s remote selection git-faithful via a new pure `resolvePushRemote`, wired into `push`. **Refspec/refusal logic is unchanged** — push still resolves the current-branch refspec via the existing `resolveRefspecsInput` (that is Parts 7–11). This isolates the remote-selection change and pins it.

Edit `src/application/commands/internal/default-remote.ts` — add (co-located with `defaultRemoteName`, pure over `ParsedConfig`):
```ts
export const resolvePushRemote = (
  config: ParsedConfig,
  explicit: string | undefined,
  branch: string | undefined,          // SHORT name; undefined on detached HEAD
): string =>
  explicit ??
  (branch !== undefined ? config.branch?.get(branch)?.pushRemote : undefined) ??
  config.remotePushDefault ??
  (branch !== undefined ? config.branch?.get(branch)?.remote : undefined) ??
  (config.remote !== undefined && config.remote.size === 1 ? [...config.remote.keys()][0] : undefined) ??
  DEFAULT_REMOTE;
```
Symbolic: `opts.remote ?? branch.<cur>.pushRemote ?? remote.pushDefault ?? branch.<cur>.remote ?? soleRemote ?? origin`. Detached (`branch===undefined`): the two `branch !==` guards short-circuit → `opts.remote ?? remote.pushDefault ?? soleRemote ?? origin` (branch.* excluded — ADR-458 detached rule). Consider extracting the shared `soleRemote` sub-expression into a small internal helper reused by `defaultRemoteName`.

Edit `src/application/commands/push.ts` `pushViaSession` (line 110-113): replace `const remoteName = opts.remote ?? 'origin';` with reading HEAD + config once and computing the remote:
```ts
const head = await readHeadRaw(ctx);                          // already imported
const branchRef = branchRefFromHead(head);                    // add import from './internal/repo-state.js'
const currentBranch = branchRef !== undefined ? shortBranchName(branchRef) : undefined;
const config = await readConfig(ctx);                         // already imported
const remoteName = resolvePushRemote(config, opts.remote, currentBranch);
```
`resolveRemoteUrl` keeps its `REMOTE_NAME_RE` guard + valueless assertion; it just receives the chain output instead of `opts.remote ?? 'origin'`. `resolveRefspecsInput(ctx, opts.refspecs)` is unchanged. Thread `config`/`head` down to Part 7 later; for now local is fine.

Unit test: `test/unit/application/commands/internal/default-remote.test.ts` (extend) — `resolvePushRemote` isolated per level: explicit; `pushRemote`; `remotePushDefault`; `branch.remote`; sole-remote; `DEFAULT_REMOTE`; **detached** (`branch===undefined`) proving `pushRemote` and `branch.remote` are skipped but `remotePushDefault` and sole-remote survive (kills the two guard mutants — two separate `it`s, one asserting `remotePushDefault` still wins detached, one asserting sole-remote wins detached with no pushDefault).

Interop pins — extend `test/integration/network/push-http-backend.test.ts` (needs 3–4 distinguishable bares: origin, upstream, pushdef, pushrem). To isolate remote selection from the not-yet-faithful refspec/refusal logic, drive each case with an **explicit refspec** (`opts.refspecs:['refs/heads/main:refs/heads/main']`) so both git and tsgit push regardless of push.default; assert *which* bare advanced via `git --git-dir=<bare> rev-parse main`:
- P-select: `branch.pushRemote=pushrem` (with `remote.pushDefault=pushdef` and `branch.remote=upstream` also set) → pushrem bare advances, others untouched (pushRemote wins the chain).
- P-detached: detached HEAD + `remote.pushDefault=pushdef` (+`branch.*` set) + explicit `HEAD:refs/heads/main` → pushdef advances (branch.* excluded).

**Internal**: `resolvePushRemote` is internal — `reports/api.json` unchanged (no new public symbol; PushResult shape unchanged).

### TDD steps

RED:
- `resolvePushRemote` unit tests per level (fail: symbol absent).
- Interop P-select: real git with `branch.pushRemote=pushrem` pushes to pushrem; tsgit today pushes origin → assertion on the pushrem bare fails for tsgit.

GREEN: add `resolvePushRemote`; wire it into `push`.

REFACTOR: extract the shared sole-remote sub-expression; confirm `push` reads HEAD/config once.

### Gate

`npx vitest run test/unit/application/commands/internal/default-remote.test.ts && npx vitest run test/integration/network/push-http-backend.test.ts && npm run check:types && npx biome check src/application/commands/push.ts src/application/commands/internal/default-remote.ts <touched tests>` — green. `git diff --stat reports/api.json` empty.

### Commit

`feat: push selects remote via pushRemote/pushDefault chain`

---

## Part 7 — push.default `current` + plan/finalize seam

### Context

Goal: introduce the `push.default` dispatcher (the plan→finalize seam) and implement the `current` mode with its detached refusal. Modes not yet implemented fall back to today's `resolveRefspecsInput` behaviour so the suite stays green; each later part (8–11) moves one mode from that fallback into a faithful arm.

New file `src/application/commands/internal/push-refspecs.ts` (internal):
```ts
export type PushRefspecPlan =
  | { readonly kind: 'explicit';  readonly refspecs: ReadonlyArray<ParsedRefspec> }
  | { readonly kind: 'fixed';     readonly refspecs: ReadonlyArray<ParsedRefspec> }
  | { readonly kind: 'matching' };                                   // filled in Part 7e
```
- `planPushRefspecs(ctx, config, opts, head): Promise<PushRefspecPlan>` — runs **before** the session:
  - explicit `opts.refspecs?.length > 0` ⇒ `{kind:'explicit', refspecs: map(parseRefspec)}` (push.default ignored — pinned; detached-with-explicit pushes normally).
  - else read `mode = config.push?.default ?? 'simple'`, `branchRef = branchRefFromHead(head)`, `cur = branchRef && shortBranchName(branchRef)`, `branchFull = refs/heads/<cur>`.
  - `mode === 'current'`: detached (`cur===undefined`) ⇒ throw `pushDetachedNoRefspec()`; else `{kind:'fixed', refspecs:[parseRefspec(\`${branchFull}:${branchFull}\`)]}`.
  - **any other mode** (`simple`(default)/`upstream`/`nothing`/`matching`): fall back to the legacy `resolveRefspecsInput(ctx, opts.refspecs)` result wrapped as `{kind:'fixed', refspecs}` (preserves today's behaviour: current-branch refspec, or the legacy `invalidOption('refspecs','no-default-refspec (HEAD is detached)')` on detached). This fallback shrinks in Parts 8–11.
- `finalizePushRefspecs(plan, adv): ReadonlyArray<ParsedRefspec>` — `explicit`/`fixed` pass through; the `matching` variant is unreachable until Part 11 (return `[]` as the placeholder branch; Part 11 fills it and extends the signature with `localHeads`). Wire it into `negotiateAndSend` after `discoverReceivePackRefs`: `const refspecs = finalizePushRefspecs(plan, adv)` replacing the pre-resolved array. Thread the `plan` (not the resolved refspecs) from `pushViaSession` into `negotiateAndSend` — `negotiateAndSend`'s parameter changes from `refspecs: ReadonlyArray<ParsedRefspec>` to `plan: PushRefspecPlan`.

Edit `push.ts`: `pushViaSession` computes `plan = await planPushRefspecs(ctx, config, opts, head)` (reusing the `head`/`config` from Part 6) instead of `refspecs = await resolveRefspecsInput(...)`; pass `plan` down. Keep `resolveRefspecsInput` as the legacy fallback helper called inside `planPushRefspecs`.

New error `src/domain/commands/error.ts`: add `| { readonly code: 'PUSH_DETACHED_NO_REFSPEC' }` to `CommandError` + `export const pushDetachedNoRefspec = (): TsgitError => new TsgitError({ code: 'PUSH_DETACHED_NO_REFSPEC' });`. Add a `case 'PUSH_DETACHED_NO_REFSPEC':` arm to `extractDetail`'s switch in `src/domain/error.ts` (message mirroring git: `you are not currently on a branch`).

Unit tests: `test/unit/application/commands/internal/push-refspecs.test.ts` (NEW) — dispatcher over in-memory ctx: `current` symbolic ⇒ fixed `<branchFull>:<branchFull>`; `current` detached ⇒ throws `PUSH_DETACHED_NO_REFSPEC` (try/catch + `.code`); explicit refspec ⇒ `explicit` plan even detached; unimplemented mode ⇒ legacy fixed refspec.

Interop — `test/integration/network/push-http-backend.test.ts`:
- current-success: `push.default=current`, symbolic → `main:main` to the selected remote (twin git).
- current-pushRemote: `push.default=current` + `branch.pushRemote=pushrem` → `main:main` to pushrem.
- current-detached: `push.default=current`, detached HEAD, no refspec → both real git and tsgit refuse; assert tsgit `PUSH_DETACHED_NO_REFSPEC` and real git's `not currently on a branch` fatal.

No existing test changes here (the default is still `simple`→legacy). New tests only.

**Public surface** (new error code): `npm run docs:json` + commit `reports/api.json`.

### TDD steps

RED:
- unit `current` detached ⇒ expect `PUSH_DETACHED_NO_REFSPEC` (fails: code + dispatcher absent).
- interop current-detached (fails: tsgit throws the old `INVALID_OPTION` reason, not `PUSH_DETACHED_NO_REFSPEC`).

GREEN: add the plan type, `planPushRefspecs` (current arm + legacy fallback), `finalizePushRefspecs` pass-through, the new error code + factory + switch arm; wire into push.

REFACTOR: confirm the seam leaves Parts 8–11 as pure additions (each just adds one `mode ===` arm and narrows the fallback).

### Gate

`npx vitest run test/unit/application/commands/internal/push-refspecs.test.ts test/unit/application/commands/push.test.ts && npx vitest run test/integration/network/push-http-backend.test.ts && npm run check:types && npx biome check <touched files> && npm run docs:json` — green; **commit `reports/api.json`**.

### Commit

`feat: implement push.default current mode`

---

## Part 8 — push.default `nothing`

### Context

Goal: implement the `nothing` mode — always refuses, before the remote is contacted. Narrows the legacy fallback in `planPushRefspecs`.

Edit `src/application/commands/internal/push-refspecs.ts`: add `mode === 'nothing'` arm to `planPushRefspecs` — throw `pushDefaultNothing()` unconditionally (symbolic AND detached; before session). Since it throws during the pre-session `plan` phase, the remote is never contacted (assertable).

New error `src/domain/commands/error.ts`: `| { readonly code: 'PUSH_DEFAULT_NOTHING' }` + `export const pushDefaultNothing = (): TsgitError => new TsgitError({ code: 'PUSH_DEFAULT_NOTHING' });`. Add the `case` arm to `extractDetail` (message mirroring git: `you didn't specify any refspecs to push, and push.default is "nothing"`).

Unit + interop:
- unit (`push-refspecs.test.ts`): `nothing` symbolic ⇒ throws `PUSH_DEFAULT_NOTHING`; `nothing` detached ⇒ same code (two isolated `it`s — one per HEAD state, since the refusal must fire independent of HEAD).
- interop (`push-http-backend.test.ts`): `push.default=nothing` → tsgit throws `PUSH_DEFAULT_NOTHING`, real git fatal `push.default is "nothing"`; assert the remote bare did **not** advance (refusal before contact).

**Public surface** (new error code): `npm run docs:json` + commit `reports/api.json`.

### TDD steps

RED: unit `nothing` ⇒ expect `PUSH_DEFAULT_NOTHING` (fails: falls through legacy fallback, pushes current-branch).

GREEN: add the arm + error code + factory + switch arm.

REFACTOR: none.

### Gate

`npx vitest run test/unit/application/commands/internal/push-refspecs.test.ts && npx vitest run test/integration/network/push-http-backend.test.ts && npm run check:types && npx biome check <touched files> && npm run docs:json` — green; **commit `reports/api.json`**.

### Commit

`feat: implement push.default nothing mode`

---

## Part 9 — push.default `upstream` + triangular refusal

### Context

Goal: implement `upstream` mode with the triangular-dominance refusal and the no-upstream refusal, in ADR-458 §3 guard order. Introduces the `triangular` computation reused by `simple` (Part 10).

Compute (in `planPushRefspecs`, when `mode==='upstream'` and not explicit): `pushRemote = resolvePushRemote(config, opts.remote, cur)`, `fetchRemote = defaultRemoteName(config, undefined, cur)` (= `branch.<cur>.remote ?? soleRemote ?? origin`), `triangular = pushRemote !== fetchRemote`, `merge = branch.<cur>.merge` (full ref, may be undefined), `branchFull = refs/heads/<cur>`.

`upstream` decision tree (guard order is load-bearing — the triangular check **dominates** the no-upstream check, per the Post-decision reconciliation and pinned cell S-D):
```
if cur === undefined (detached)   → throw pushDetachedNoRefspec()
elif triangular                   → throw pushRemoteNotUpstream(pushRemote, branchFull)   // fires even when merge IS set (T1/T2) AND when merge is absent (S-D)
elif merge === undefined          → throw noUpstreamConfigured(branchFull)                 // reuse existing pull error
else                              → { kind:'fixed', refspecs:[parseRefspec(`${branchFull}:${merge}`)] }   // no name check (upstream ignores mismatch)
```

New error `src/domain/commands/error.ts`: `| { readonly code: 'PUSH_REMOTE_NOT_UPSTREAM'; readonly remote: string; readonly branch: RefName }` + `export const pushRemoteNotUpstream = (remote: string, branch: RefName): TsgitError => new TsgitError({ code:'PUSH_REMOTE_NOT_UPSTREAM', remote, branch });`. Reuse `noUpstreamConfigured` (already exists, `{code:'NO_UPSTREAM_CONFIGURED', branch: RefName}`, thrown by pull; `branch` = full ref). Add the `case 'PUSH_REMOTE_NOT_UPSTREAM':` arm to `extractDetail` (message mirroring git: `you are pushing to remote '<remote>', which is not the upstream of your current branch '<branch>'`). `NO_UPSTREAM_CONFIGURED` already has a switch arm.

Unit (`push-refspecs.test.ts`) — one isolated `it` per branch of the tree (each guard proven alone):
- detached ⇒ `PUSH_DETACHED_NO_REFSPEC`.
- triangular + merge set (pushDefault≠branch.remote, merge present) ⇒ `PUSH_REMOTE_NOT_UPSTREAM` (`.remote`, `.branch` asserted).
- triangular + no merge ⇒ `PUSH_REMOTE_NOT_UPSTREAM` (dominance — NOT `NO_UPSTREAM_CONFIGURED`).
- central (not triangular) + no merge ⇒ `NO_UPSTREAM_CONFIGURED` (`.branch` = full ref).
- central + merge=`refs/heads/other` ⇒ fixed `<branchFull>:refs/heads/other` (no name check).

Interop (`push-http-backend.test.ts`):
- upstream central, merge=`refs/heads/other` ⇒ pushes `main:other` (twin).
- upstream triangular (merge set, pushDefault→pushdef) ⇒ tsgit `PUSH_REMOTE_NOT_UPSTREAM`, git fatal `not the upstream of your current branch`; remote not advanced.
- upstream triangular + no merge (cell S-D) ⇒ same `PUSH_REMOTE_NOT_UPSTREAM` (dominance).
- upstream central + no merge ⇒ tsgit `NO_UPSTREAM_CONFIGURED`, git fatal `has no upstream branch`.
- `tracking` alias behaves as `upstream` (config `push.default=tracking`, merge=`refs/heads/other` ⇒ `main:other`).

**Public surface** (new error code): `npm run docs:json` + commit `reports/api.json`.

### TDD steps

RED: the five unit trees + triangular interop (fail: `upstream` falls through legacy fallback).

GREEN: add the `upstream` arm with the exact guard order; add `PUSH_REMOTE_NOT_UPSTREAM` code/factory/switch arm.

REFACTOR: factor `triangular`/`pushRemote`/`fetchRemote`/`merge`/`branchFull` into a small shared struct the `simple` arm (Part 10) will reuse.

### Gate

`npx vitest run test/unit/application/commands/internal/push-refspecs.test.ts && npx vitest run test/integration/network/push-http-backend.test.ts && npm run check:types && npx biome check <touched files> && npm run docs:json` — green; **commit `reports/api.json`**.

### Commit

`feat: implement push.default upstream mode with triangular refusal`

---

## Part 10 — push.default `simple` (the default)

### Context

Goal: implement `simple` — the **default** mode (applies when `push.default` is unset). This is the part where the codebase's long-standing "push always pushes the current branch" behaviour becomes git-faithful; existing push tests that pushed **without a matching configured upstream** must be updated.

`simple` decision tree (reuses the 7c triangular struct; guard order per design III.3):
```
if cur === undefined (detached)      → throw pushDetachedNoRefspec()
elif triangular                      → { kind:'fixed', refspecs:[`${branchFull}:${branchFull}`] }   // current-like; NO upstream needed
elif merge === undefined             → throw noUpstreamConfigured(branchFull)
elif shortBranchName(merge) !== cur  → throw pushUpstreamNameMismatch(branchFull, merge)
else                                 → { kind:'fixed', refspecs:[`${branchFull}:${merge}`] }
```
Replace the legacy fallback for the default/`simple` mode with this arm. After this part, the only mode still on the legacy fallback is `matching` (handled in Part 11).

New error `src/domain/commands/error.ts`: `| { readonly code: 'PUSH_UPSTREAM_NAME_MISMATCH'; readonly branch: RefName; readonly upstream: RefName }` + `export const pushUpstreamNameMismatch = (branch: RefName, upstream: RefName): TsgitError => …`. Add the `case` arm to `extractDetail` (message mirroring git: `the upstream branch of your current branch does not match the name of your current branch`).

**Existing-test audit (behaviour refinement)**: real git's default `simple` refuses on a detached HEAD and on a branch whose upstream name mismatches; the existing detached-push test (`push.test.ts` / `push-http-backend.test.ts`) that asserted the old `INVALID_OPTION` reason `no-default-refspec (HEAD is detached)` now expects `PUSH_DETACHED_NO_REFSPEC`. Existing clone-then-push tests keep tracking (`clone` configures `branch.main.remote=origin`, `merge=refs/heads/main`) so `simple` **pushes** — they stay green. Audit `push.test.ts` for any push started from a repo **without** clone-configured tracking + no explicit refspec: update it to add tracking, pass an explicit refspec, or set `push.default=current`, as its intent dictates. Update these existing tests **in this part** (behaviour-change part).

Unit (`push-refspecs.test.ts`) — one isolated `it` per branch: detached; triangular ⇒ current-like fixed (no upstream needed); central + no merge ⇒ `NO_UPSTREAM_CONFIGURED`; central + merge name-mismatch ⇒ `PUSH_UPSTREAM_NAME_MISMATCH` (`.branch`,`.upstream`); central + merge==cur ⇒ fixed `<branchFull>:<merge>`.

Interop (`push-http-backend.test.ts`):
- simple central, merge=main ⇒ `main:main`.
- simple central, merge=`refs/heads/other` ⇒ `PUSH_UPSTREAM_NAME_MISMATCH`, git fatal `does not match the name of your current branch`; remote not advanced.
- simple central, no merge ⇒ `NO_UPSTREAM_CONFIGURED`, git fatal `has no upstream branch`.
- simple triangular (pushDefault≠branch.remote) ⇒ `main:main` to the push bare (current-like).
- simple detached ⇒ `PUSH_DETACHED_NO_REFSPEC`, git fatal `not currently on a branch`.
- simple explicit `origin`, merge=other ⇒ **still refuses** name-mismatch when the explicit remote path routes through simple (cell E4 — verify against the probe: explicit *remote* without explicit *refspec* still applies push.default).

**Public surface** (new error code): `npm run docs:json` + commit `reports/api.json`.

### TDD steps

RED: unit trees + interop mismatch/no-upstream (fail: default currently pushes current-branch unconditionally). Existing detached test now expects the new code (RED until GREEN).

GREEN: add the `simple` arm; update the audited existing tests; add the error code/factory/switch arm.

REFACTOR: confirm `current`/`upstream`/`simple` share the branchFull/merge/triangular derivation; the legacy `resolveRefspecsInput` fallback now serves only `matching`.

### Gate

`npx vitest run test/unit/application/commands/internal/push-refspecs.test.ts test/unit/application/commands/push.test.ts && npx vitest run test/integration/network/push-http-backend.test.ts && npm run check:types && npx biome check <touched files> && npm run docs:json` — green; **commit `reports/api.json`**.

### Commit

`feat: implement push.default simple mode with name-mismatch refusal`

---

## Part 11 — push.default `matching`

### Context

Goal: implement `matching` — HEAD-independent, expands to every local `refs/heads/<b>` **that the push remote already advertises**, `<b>:<b>`. This is the mode that consumes the wire advertisement, so it completes the plan→finalize seam's finalize side.

Edit `src/application/commands/internal/push-refspecs.ts`:
- `planPushRefspecs`, `mode === 'matching'` arm ⇒ `{ kind: 'matching' }` (deferred; works detached — no HEAD dependency; the legacy fallback for `matching` is now removed).
- **Extend `finalizePushRefspecs`'s signature** from `(plan, adv)` (Part 7) to `(plan, adv, localHeads)`: for `{kind:'matching'}`, compute `advertised = new Set(adv.refs.filter(r => r.name.startsWith(HEADS_PREFIX)).map(r => r.name))`; return `localHeads.filter(h => advertised.has(h)).map(h => parseRefspec(\`${h}:${h}\`))`. `localHeads` is the local `refs/heads/*` list.
- Wire in `negotiateAndSend`: compute `localHeads` only when needed — `const localHeads = plan.kind === 'matching' ? (await enumerateRefs(ctx)).filter(r => r.startsWith(HEADS_PREFIX)) : []` (so the **added local-head read** costs nothing on the non-matching path). `enumerateRefs` includes packed heads.

`enumerateRefs` is exported from `src/application/primitives/index.js` (`enumerateRefs(ctx): Promise<ReadonlyArray<RefName>>`). No new error code (empty match set ⇒ nothing to push; not a refusal).

Unit (`push-refspecs.test.ts`): `finalizePushRefspecs` with a `matching` plan — given local heads `[main, feature]` and an advertisement of `[refs/heads/main]` only ⇒ returns `[main:main]` (feature absent on remote not pushed — cell V7); given advertisement of both ⇒ both; given empty intersection ⇒ `[]`. `planPushRefspecs` `matching` detached ⇒ `{kind:'matching'}` (no throw).

Interop (`push-http-backend.test.ts`):
- matching, two local branches both present on the remote ⇒ both pushed; a third local branch absent on the remote ⇒ not pushed (assert each bare ref via rev-parse).
- matching on **detached** HEAD ⇒ still expands and pushes the matching branches (HEAD-independent).

**Internal**: no new public symbol/error — `reports/api.json` unchanged.

### TDD steps

RED: `finalizePushRefspecs` matching unit (fails: matching returns the `[]` placeholder from Part 7); interop matching-partial (fails: matching unimplemented).

GREEN: implement the `matching` plan arm + finalize expansion + local-head enumeration wire-up.

REFACTOR: remove the now-dead legacy fallback branch in `planPushRefspecs` (all five modes now have arms); confirm `resolveRefspecsInput`'s remaining role is only the explicit-empty→current-branch helper the `current`/legacy path used — inline or delete if fully superseded.

### Gate

`npx vitest run test/unit/application/commands/internal/push-refspecs.test.ts && npx vitest run test/integration/network/push-http-backend.test.ts && npm run check:types && npx biome check <touched files>` — green. `git diff --stat reports/api.json` empty.

### Commit

`feat: implement push.default matching mode`

---

## Part 12 — invalid push.default hard refusal

### Context

Goal: make a present-but-invalid `push.default` value (including wrong case, e.g. `Simple`, `bogus`) a **hard config error** naming file+line, faithful to git (probed cells V2/V3). The parser is lenient (`parsePushDefault` → `undefined` on assembly, which would silently behave as `simple` — a divergence); push validates on a cold path using the cached token stream, mirroring `findFirstValuelessEntry` / `findFirstInvalidCompression`.

New cold-path finder in `src/application/primitives/config-read.ts` (co-located with `findFirstValuelessEntry`, line 178, and `findFirstInvalidCompression`, line 274 — reuse `readConfigEntry`'s cached `{tokens, source}`):
```ts
export const findInvalidPushDefault = async (
  ctx: Context,
): Promise<{ key: string; source: string; line: number; value: string } | undefined> => {
  // walk the cached [push] (subsectionless) tokens; the FIRST `default` entry whose value
  // is non-null and parsePushDefault(value) === undefined ⇒ return { key:'push.default', source, line, value }.
};
```
(Valueless `default` is not an invalid-value error — mirror the existing finders' null handling; a valueless key is treated as absent by `mergePush`.)

New error `src/domain/commands/error.ts`: `| { readonly code: 'INVALID_PUSH_DEFAULT'; readonly value: string; readonly source: string; readonly line: number }` + `export const invalidPushDefault = (value: string, source: string, line: number): TsgitError => …`. Add the `case 'INVALID_PUSH_DEFAULT':` arm to `extractDetail` (message mirroring git: `bad config variable 'push.default' in file '<source>' at line <line>`).

Edit `src/application/commands/push.ts`: add `assertValidPushDefault(ctx)` early in `push` (after `assertOperationalRepository`, before contacting the remote) — call `findInvalidPushDefault(ctx)`; if defined, throw `invalidPushDefault(entry.value, entry.source, entry.line)`. This fires regardless of `push.default` mode (git validates the value before acting).

Unit:
- `test/unit/application/primitives/config-read.test.ts` — `findInvalidPushDefault`: `[push]\n default = bogus` ⇒ `{key:'push.default', value:'bogus', line:2, …}`; `default = Simple` ⇒ returned (case-sensitive invalid); `default = current` ⇒ `undefined`; no `[push]` ⇒ `undefined`; valueless `default` ⇒ `undefined`.
- `test/unit/application/commands/push.test.ts` — push with `push.default=bogus` ⇒ throws `INVALID_PUSH_DEFAULT` (`.value`,`.line` asserted) before any session.

Interop (`push-http-backend.test.ts`):
- invalid value (`bogus`) and wrong-case (`Simple`) ⇒ tsgit `INVALID_PUSH_DEFAULT` with key/source/line; real git fatal `bad config variable 'push.default' in file … at line N`; remote not contacted. Two isolated `it`s.

**Public surface** (new error code): `npm run docs:json` + commit `reports/api.json`.

### TDD steps

RED: `findInvalidPushDefault` unit (fails: absent) + push `bogus` unit (fails: today silently behaves as simple).

GREEN: add the finder, the error code/factory/switch arm, and the early assertion in `push`.

REFACTOR: confirm the finder consumes the cached token stream (no extra config read) like its siblings; confirm the assertion is on the cold path (only walks tokens; no cost on the happy path beyond one token scan — matches the existing `assertCoreConfigValid` pattern).

### Gate

`npx vitest run test/unit/application/primitives/config-read.test.ts test/unit/application/commands/push.test.ts && npx vitest run test/integration/network/push-http-backend.test.ts && npm run check:types && npx biome check <touched files> && npm run docs:json` — green; **commit `reports/api.json`**. Then **phase-boundary**: `npm run validate` green.

### Commit

`feat: refuse invalid push.default config value`

---

## Decision candidates

All load-bearing **design** choices are pre-decided by ADRs 456–458 and the design doc's own decision-candidates section (each adopted recommended-first): primitive shapes + homes, `defaultRemoteName` purity + the sole-remote fallback, the fetch tracking chain, the push remote-selection chain, the `push.default` state machine + refusal precedence (triangular dominates), the config keys + enum contract (`tracking` alias, case-sensitive, invalid→hard error), the error taxonomy, `remote.pushDefault` as a flat `ParsedConfig` field, and the plan→finalize integration. The planner does not re-open these.

Two **implementation-sequencing** choices this plan resolved (surfaced here so the orchestrator can override before implementation begins — neither changes the ADR-decided product behaviour):

1. **Plan→finalize seam placement** — *resolved: seam in Part 7, matching-expansion in Part 11.*
   - (a, chosen) Introduce the `plan → finalize` seam with the first mode (Part 7); each later mode is a pure dispatcher arm; the advertisement-consuming `matching` expansion + local-head read land with `matching` (Part 11). Matches the design's recommended decision candidate 1a and the invocation's "matching brings the split".
   - (b) Defer the entire seam to Part 11; Parts 7–10 keep resolving refspecs before the session and Part 11 restructures `negotiateAndSend`. Fewer intermediate touches to `push.ts` but a larger, riskier Part 11.
   - *Recommendation:* (a) — smaller, safer per-part diffs; the placeholder `matching` branch is trivial.

2. **Submodule remote resolution scope** — *resolved: submodule keeps its inline `?? 'origin'` remote; only its HEAD read migrates (Part 3).*
   - (a, chosen) Do NOT route submodule's base-URL remote through `defaultRemoteName` — that would silently add the sole-remote fallback, an unpinned behaviour change no ADR sanctions for submodule. Part 3 migrates only the HEAD read.
   - (b) Route submodule through `defaultRemoteName` too, giving it sole-remote faithfulness (git's `remote_get_default` does apply the single-remote case), with its own `submodule-add-update-http-backend` interop pin — a scope addition beyond the invocation's Part 3.
   - *Recommendation:* (a) — stays inside the invocation's stated scope; (b) is a clean follow-up if submodule sole-remote faithfulness is wanted (see R1).

## Risks & sequencing flags

- **R1 — submodule NOT joining the sole-remote set (decision).** The design's Part I table lists submodule using `defaultRemoteName`, but the Post-decision reconciliation folded the sole-remote fallback *into* `defaultRemoteName` and named only `fetch`/`pull`/`push` as the behaviour-changed set. Migrating submodule's base-URL remote to `defaultRemoteName` would silently give it the sole-remote behaviour — an unpinned change no ADR sanctions. **Decision: Part 3 migrates only submodule's HEAD read; its remote resolution stays inline (`?? 'origin'`).** If the orchestrator wants submodule to also become sole-remote-faithful, it needs its own interop pin (`submodule-add-update-http-backend.test.ts`) and should be an explicit added scope — flag before implementing.
- **R2 — matching/advertisement split placement.** The plan→finalize *seam* lands in **Part 7** (so Parts 8–11 are pure dispatcher additions, per the design's recommended decision candidate 1a), while the finalize-side *expansion* that actually consumes the wire advertisement + enumerates local heads lands in **Part 11** (matching is the only mode needing it, per the invocation). This split is deliberate; the `finalizePushRefspecs` `matching` branch is a documented placeholder (`return []`) between Parts 7 and 11.
- **R3 — legacy-fallback bridge across Parts 7–11.** Between parts, un-implemented `push.default` modes fall back to today's `resolveRefspecsInput` (current-branch or old detached refusal), keeping the suite green. The **default** (`simple`) becomes faithful only in **Part 10** — that is the single part where existing non-tracking push tests and the detached-push test change. The legacy fallback is fully removed in Part 11. Ordering 7→10 ensures the disruptive default-simple change lands once, late.
- **R4 — new error code = three edits + one prepush gate, five times.** Parts 7, 8, 9, 10, 12 each add a `CommandError` member: union+factory (`domain/commands/error.ts`), `extractDetail` switch arm (`domain/error.ts` — else `check:types` red on `_exhaustive: never`), and `reports/api.json` regen (prepush-only, invisible to local `validate`). A part that skips the switch arm fails `check:types`; a part that skips the api.json regen passes local `validate` but the push hook rejects.
- **R5 — public-surface parts.** Part 5 (ParsedConfig widening + `PushDefaultMode`) and Parts 7, 8, 9, 10, 12 (error codes) each carry a `reports/api.json` diff. All other parts (1, 2, 3, 4, 6, 11) are internal — their gate asserts `git diff --stat reports/api.json` is **empty**; a non-empty diff means a symbol leaked through a barrel (`src/domain/index.ts` line 25 `export * from './refs/index.js'` is the trap) — fix the import path, do not regenerate.
- **R6 — interop suite cost.** The `push-http-backend` suite grows large (remote-selection + five modes + refusals). It spawns real git and can time out hooks under `validate`'s concurrency — reuse a shared `beforeAll` bare/clone fixture where the suite already does, give the file a generous timeout, and keep each refusal a distinct `it` (the isolated-guard convention — one mutant must not be killable by a sibling case).
- **R7 — `simple` explicit-remote cell (E4).** Verify against the probe that an explicit *remote* with no explicit *refspec* still applies `push.default` (interop case in Part 10). If the probe shows the explicit-remote path bypasses push.default, adjust the Part 10 interop expectation — pin it, don't assume.
