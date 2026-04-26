# Design: Commands (Tier 1)

**Status: Implemented (2026-04-25)** — Phase 9 of the [backlog](../BACKLOG.md).

### Round 4 Review Notes (post-implementation)

Post-implementation review applied four parallel reviewers (code, security, TypeScript/perf, test) plus one Stryker mutation pass.

**Security findings applied:**
- `materializeFile` now uses `openWithNoFollow` for the leaf write (was plain `fs.write`) — closes a TOCTOU symlink-swap window flagged in the security review.
- Network pipeline composition reordered so `withLogging` wraps the OUTSIDE of `withAuth` — guarantees the logger never observes the injected `Authorization` header even if the redactor is weakened.
- `validateUrl` is now wired into `clone` (was unreachable dead code per the review).
- `isBlockedIpv6` extended to handle hex-form IPv4-mapped addresses (`::ffff:7f00:1` etc.) — closes the canonical bypass.
- `validatePath` rejects components containing `:` — covers NTFS Alternate Data Streams (`.git:$DATA`) and Windows drive-letter qualifiers.
- `blockedHost` factory now applies `sanitizeForDisplay` to its host/reason fields.

**Code-quality findings applied:**
- `reset.ts` was throwing a bare `Error` for unresolvable targets — replaced with `revparseUnresolved` (preserves the structured-error contract).
- `merge.ts` overloaded `MERGE_HAS_CONFLICTS` for three unrelated conditions — split into `UNSUPPORTED_OPERATION` (detached HEAD), `NON_FAST_FORWARD` (ff-only impossible), and `UNEXPECTED_OBJECT_TYPE` (non-commit target).
- `status.ts` was writing blob objects during a read-only query — now hashes locally without persisting.
- `add.ts` and `rm.ts` narrowed their `catch` clauses on `readIndex` to only swallow `FILE_NOT_FOUND` / `INVALID_INDEX_*` (was swallowing all errors silently).
- Dynamic `await import('../primitives/read-object.js')` calls in `commit.ts` / `merge.ts` converted to static imports.
- `commit.ts` `writeSubtree` now writes sub-trees in parallel (`Promise.all`) and removes the redundant pre-sort.
- `repo-state.ts` `assertNoPendingOperation` now fans out the four marker checks in parallel.
- `network-pipeline.ts` no longer mutates caller-owned `ctx.config` (the `Object.freeze` side effect moved to Phase 10's facade).
- `internal/working-tree.ts` `byteLength` now uses a hoisted `TextEncoder` (was allocating a new one per call).
- `as never` casts in `log.ts` / `diff.ts` replaced with proper `validateRefName` calls.

**Test-quality findings applied:**
- All `toBeInstanceOf(TsgitError)`-only assertions strengthened with `.data.code` checks.
- Added missing branch coverage: `branch rename` non-current, `branch create --force` over existing, `branch create` with explicit `startPoint`, `merge --no-ff`, `merge --ff-only` on diverged histories, `reset --hard`, `commit --allow-empty`, `checkout` on the current branch, `log` from a non-HEAD ref, `log` from an oid, `log` on an unborn branch.
- Added URL credentials-embedded SSRF test (`user:pass@private-host`).
- Added IPv6 hex-form IPv4-mapped bypass test.
- Added boundary tests for path lengths (4095/4096/4097), component sizes (255/256), control chars (0x1F), CGNAT range (`100.63`/`100.64`/`100.127`/`100.128`), 172.16/12 endpoints, multicast endpoints.
- Added stale-lock boundary tests (age == threshold, age == threshold-1).

**Mutation testing.** Final score: **76.85%** (1136 mutants, 250 survivors). The remaining survivors fall into three buckets:
1. **Provably equivalent** (~120 of 250): boundary mutants where the alternative produces identical observable behavior — e.g., `i < length` vs `i <= length` in loops where `arr[length] === undefined` and the loop body short-circuits the same way; `n > 0` vs `n >= 0` where `n` is always non-negative (`split('\n')` always returns ≥1 elements).
2. **Adapter-observation gaps** (~80 of 250): `chmod` flag mutations, `assumeValid` / `extended` index-entry boolean flags, ns-precision timestamps — the memory adapter (which all command tests use) does not expose these to assertions. Killing requires Node-adapter integration tests.
3. **StringLiteral / regex mutants on internal sentinel values** (~50 of 250): mutations of error-data field strings that match equally against any test that only asserts `.data.code`. Killing requires per-field assertions on every error throw site, which yields heavy churn for marginal value.

The Phase 7/8 precedent for accepting equivalent mutants is followed: surviving mutants are documented per-bucket above rather than per-line. The break threshold remains at 90 in `stryker.config.json`; CI will report Phase 9 below threshold until Phase 10 lands the adapter-level integration test layer that closes bucket 2.

### Review Notes

**Round 3 — applied** (architecture/consistency + security regression + plan-readiness, three independent reviewers):

- **Variant count reconciled.** §4.2 command-specific union has 23 variants; total new = 3 `RepositoryError` + 2 `ApplicationError` + 1 `ProtocolError` + 23 `CommandError` = **29** new entries (+ `OPERATION_IN_PROGRESS` added in this round = 30). All 30 listed in §4.2.1 with format strings. Step 0 widens `TsgitErrorData` and the `extractDetail` switch in lockstep.
- **Size budget arithmetic propagated.** §10.1 + §6 updated to `28 kB` (was `20 kB`). Per-command 1.5 kB × 16 entries amortize via shared `internal/*` chunks.
- **`mergeBase` deterministic tie-breaker.** When both frontiers reach overlapping commits on the same step, the algorithm returns the candidate with the lexicographically smallest `ObjectId`. Test fixtures pin the rule.
- **`dnsResolver` location consolidated.** Both §4.7 and §4.8 reference `ctx.config.dnsResolver` (was inconsistent).
- **Mutation table covers all 16 commands + new internals** (§7.3).
- **§11 backward-compat claim corrected.** Adding variants to a discriminated union DOES break consumers without a `default:` arm. Documented as a minor-version-only obligation; `default: throw new UnreachableError(e)` is the recommended consumer pattern.
- **§5.7 branch rename wording.** "Composite ref-lock" replaced with "four steps with hand-rolled per-step rollback" (consistent with the body).
- **§5.10 step ordering / Phase 7 amendment.** New §10.5 ordered implementation map; Step 0 is the Phase 7 amendment commit (single PR).
- **§4.11 Repository-state guards.** New section. Before any state-mutating command, `assertNoPendingOperation(ctx)` checks for `MERGE_HEAD`, `CHERRY_PICK_HEAD`, `REVERT_HEAD`, `REBASE_HEAD`. Throws `OPERATION_IN_PROGRESS` (new variant — total +1).
- **`getRepoRoot` realpath pinning.** §4.3: calls `fs.realpath(ctx.cwd)` once before the upward walk. Pinned realpath is the repo root for the lifetime of the cached `RepoState`.
- **Glob-expansion path validation.** §5.2: each path produced by glob expansion is individually re-validated through `validatePath`. Closes the symlink-via-glob escape.
- **Abort policy.** §4.10: every state-mutating command wraps the whole operation in `try/finally` to release locks even on `OPERATION_ABORTED`. Documented contract.
- **Empty-input semantics.** `add([])`, `rm([])` throw `EMPTY_PATHSPEC` (require explicit `'.'`). `fetch({ refspecs: [] })` uses the configured default fetch refspec (`refs/heads/*:refs/remotes/origin/*`). `push({ refspecs: [] })` defaults to "current branch only" (matching `git push` with `push.default = current`).
- **Network fixture worked example.** §7.2.1 — minimal upload-pack response byte layout walking through `encodePktStream`, sideband, pack header.
- **Dep-cruiser rule patterns.** §10.1 — actual `from`/`to` regex patterns ready to paste into `.dependency-cruiser.cjs`.
- **Test-file paths for new domain modules.** §10.1 — explicit paths + one sample test scenario each.
- **`mergeBase` test scenarios.** §10.1 — linear and criss-cross fixtures pinned.

**Security regression checks.**
- **`BLOCKED_HOST` log injection.** §4.2.1 — host and reason fields run through `sanitizeForDisplay` (`\xNN` escapes) before interpolation. Same pattern applied to `INVALID_URL.reason`, `BLOCKED_HOST.host`, `PUSH_REJECTED.reason`, `REVPARSE_UNRESOLVED.expression`.
- **`rmRecursive` traversal-symlink hardening.** §10.1 contract strengthened: "Does NOT follow ANY symlink during traversal. When `lstat` shows a directory entry is a symlink, removes the symlink itself (not its target) and stops descent at that point." Closes the mid-path traversal vector during clone rollback.
- **`withAuth` injected-header sentinel.** §4.7/§4.8: `withAuth` exposes `injectedHeaderNames: ReadonlySet<string>` on the wrapped transport; `internal/network-pipeline.followRedirect` reads it before deciding which headers to drop on cross-origin redirect. Concrete mechanism documented.
- **`withRetry`/`withAuth` use the wrapped logger.** §4.7: middleware accepts an optional `logger` parameter; `network-pipeline.withDefaults` passes the same `safeLogger` to all three. If a Phase 8 middleware doesn't accept `logger` (it currently doesn't), the Phase 9 implementation amends Phase 8 in lockstep — recorded in §10.1 cross-cutting amendments.
- **Conflict-marker escape sequences are safe.** `\xNN` hex escapes only contain ASCII hex digits — no shell-glob characters, no NUL, no newlines. Verified safe across all consumers.

---

**Round 2 — applied** (architecture + security + plan-readiness, three independent reviewers):

- **Size budget arithmetic fixed.** §1 cap raised to **28 kB gzipped** to accommodate the per-command sub-entries. Per-command entries are 1.5 kB, but `internal/*` shared chunks (`network-pipeline`, `url-validate`, `ref-spec`, `working-tree`) are amortized — counted once in the barrel cap, not duplicated per command. The size-limit script verifies both the barrel and each per-command artifact.
- **`TsgitErrorData` exhaustiveness regression closed.** §4.2.1 added: every new variant (24 total: 3 `RepositoryError`, 2 `ApplicationError`, 1 `ProtocolError`, 18 command-specific — including `OPERATION_ABORTED` re-use) lists its `extractDetail` format string. Step 0 of the implementation plan widens `TsgitErrorData` and the `extractDetail` switch in lockstep.
- **`breakStaleLockMs` hoisted to `ctx.config`.** Removed from per-command options. Optional per-call override survives via a single `breakStaleLockMs?: number` on the same shape (overrides `ctx.config.breakStaleLockMs`). Reduces option surface by ~9 declarations.
- **`ctx.config` defensive freeze.** §4.7 — `withDefaults(ctx)` calls `Object.freeze(ctx.config)` on first invocation. Phase 10 makes it a constructor obligation; Phase 9 keeps the runtime guard until then.
- **Phase 7 amendment notes.** Phase 9 §10.1 cross-links to a "Round-5 amendment" hook in `docs/design/primitives.md` for `mergeBase` + `writeSymbolicRef` + `EMPTY_TREE_OID` + `getRepoRoot`. The Phase 9 implementation plan owns the actual amendment commit (single PR amends both designs together).
- **`getRepoRoot` moves to Phase 7.** Repository-root discovery is a primitive concern (every primitive needs `.git/`). `commands/internal/repo-state.ts` becomes a thin re-export of the Phase 7 function.
- **`revParse` dependency table.** §3.1 row updated to include `readIndex` (for `:0:<path>` stage lookups).
- **`reset` does not call `revParse` command.** Both consume `internal/rev-parse-grammar.parse(ctx, expr)`. The `revParse` command is a thin wrapper. Closes the intra-tier import violation.
- **`isBare` cache consolidated** with `repoRoot` cache via a single `WeakMap<Context, RepoState>` carrying both fields.
- **`openWithNoFollow` consistency.** §4.6 inline `fs.open` updated to call the new `FileSystem.openWithNoFollow` port method. Port additions are honored.

**Security fixes round 2.**
- **Logger sanitization across the entire pipeline.** `wrapLoggerSanitizer` now wraps `ctx.logger` ONCE before pipeline composition and the wrapped logger is passed to ALL middleware (`withAuth`, `withRetry`, `withLogging`). Closes the bypass on retry/auth diagnostic events.
- **Cross-origin credential strip is total.** `internal/network-pipeline` strips `Authorization`, `Cookie`, `Proxy-Authorization`, AND any header injected by `withAuth` (tracked via a sentinel set of injected names) on cross-origin redirects. Custom headers a user adds via plain `req.headers` are preserved (they're user-intent, not credentials we injected).
- **Pack header byte offsets explicit.** §5.10 step 5 rewritten with 0-indexed half-open ranges: signature `[0, 4)`, version `[4, 8)`, object-count big-endian uint32 at `[8, 12)`. Read 12 bytes total before any object-body inflation.
- **NTFS `.git` alternates.** §4.6 path-component rejection on Windows additionally rejects `.git ` (trailing space), `.git.` (trailing dot), and any 8.3 short name resolving to `.git` (matched via `fs.realpath` of the tentative target). Memory FS / OPFS skip the realpath check (no NTFS).
- **Lock mtime guard against negative skew.** §4.5 stale-lock recovery adds: `breakStaleLockMs` triggers ONLY when `(now - mtime) > breakStaleLockMs && (now - mtime) >= 0`. Backward NTP step (now < mtime) is treated as "unknown age" — never break.
- **`force-with-lease` + `force` interaction explicit.** §5.12 reaffirms: a passing lease check does NOT bypass the fast-forward check. If `force === false`, the FF check still runs after the lease succeeds. The lease-versus-force matrix is now a small table in §5.12.
- **Sanitization escape sequence.** `wrapLoggerSanitizer` and `merge` conflict-marker label both use `\xNN` hex escapes (not `?`) for non-printable bytes. Distinguishable from real characters; consistent across modules.

**Plan-readiness fixes.**
- **`mergeBase` API contract.** Returns `Promise<ObjectId | undefined>` — the FIRST commit visited from both sides. Octopus / criss-cross may yield non-optimal bases; documented limitation. v2 returns `Promise<ReadonlyArray<ObjectId>>` for `recursive`-strategy support. `status.ahead/behind` is single-upstream only (`ctx.config.upstreamRef`); octopus upstream is v2.
- **No composite ref-lock primitive.** §5.7 `branch rename` performs hand-rolled per-step rollback (write new, delete old, write HEAD if current). Each step is independently atomic via Phase 7's `updateRef` + `writeSymbolicRef`. Documented failure modes for each in §5.7.
- **Symlink Windows fallback byte format.** §4.6 mode mapping for `120000` on Windows / OPFS: write the link target string as UTF-8 bytes with **no** trailing newline, no BOM. Index entry stores the same bytes as the blob — guarantees cross-platform hash reproducibility.
- **`revParse` corrupt-repo behavior.** Missing intermediate object propagates as `OBJECT_NOT_FOUND` verbatim — NOT wrapped in `REVPARSE_UNRESOLVED`. Caller distinguishes "expression valid but pointed at a missing object" vs "expression syntactically unresolvable". Documented in §5.16.
- **Error-message format table.** §4.2.1 (new) lists the `extractDetail` template for every variant.
- **`ctx.config` shape.** §4.7 lists every config field Phase 9 reads (or writes via Phase 10's facade): `user`, `auth`, `parallelism`, `upstreamRef`, `allowInsecure`, `allowPrivateNetworks`, `maxResponseBytes`, `maxObjectsPerPack`, `detectRenames`, `breakStaleLockMs`. Phase 7's `parallelism` constant is reused (no new config key).
- **`DEFAULT_RETRY` lives in §4.7 only.** Removed from §10.1 caps table (was duplicated).
- **Port error contracts.** §10.1 `rmRecursive`/`openWithNoFollow` rows expanded with idempotency, symlink behavior, error variants.
- **`domain/ignore` signatures.** §5.2.1 expanded with `parseGitignore(text)`, `matches(rules, path, isDir)`, `IgnoreRuleset` shape, blank/comment-line handling.
- **`bootstrapRepository` signature.** §10.1 lists `bootstrapRepository(ctx, opts: BootstrapOptions): Promise<BootstrapResult>` — same option shape as `InitOptions`, returns `BootstrapResult` carrying the gitDir + initial branch + bare flag.
- **`readHeadRaw` signature.** §4.3 lists it explicitly: `readHeadRaw(ctx): Promise<{ kind: 'symbolic'; target: RefName } | { kind: 'direct'; id: ObjectId }>`.
- **`ReportStatus` import path.** Phase 8 owns it at `domain/protocol/receive-pack.ts` — confirmed exported. §4.2 cites the import.
- **`wrapLoggerSanitizer` byte exceptions** spec'd ONCE in §4.7: preserves `\n` and `\t`, escapes everything else outside `0x20`–`0x7E` as `\xNN`.
- **`clone --bare` path.** §5.10 explicit: bare skips checkout, writes refs at `refs/<name>` (no `refs/heads/*` rewrite), HEAD as symref to advertised default. Documented as a separate sub-bullet under step 9.

---

**Round 1 — applied** (architecture + security + implementation feasibility, three independent reviewers):

- **Tier discipline.** `clone` no longer re-implements `init` semantics inline. Both consume a shared `internal/bootstrap.ts` `bootstrapRepository(ctx, opts)` helper. The intra-tier rule (commands cannot import each other) is intact, and `commands/internal/` is explicitly carved out of the dep-cruiser rule (§10).
- **Network pipeline cache invariant.** `ctx.config` is documented as **immutable** for the lifetime of `ctx` (§4.7). The `WeakMap<Context, HttpTransport>` is sound under that contract; mutation is a Phase 10 facade concern.
- **Error model consolidation.** `INDEX_LOCKED` → cross-tier `RESOURCE_LOCKED`. `BARE_REPOSITORY` and `NOT_A_REPOSITORY` moved to a new `RepositoryError` family in `domain/` so `readIndex` etc. can also raise them. `REFSPEC_INVALID` joins `ProtocolError`. `PUSH_REJECTED` now carries the parsed report-status payload rather than being a sibling. Net: 24 → 19 command-specific codes.
- **`mergeBase` extracted to a primitive.** Reused by `merge`, `status` (`ahead`/`behind`), and `push` (ancestor check). Listed in §3.1 and the additions table (§10.1).
- **`writeSymbolicRef` extracted to a primitive.** Required for `commit` step 8 (HEAD update via symref), `checkout --detach`, `branch rename` (when current branch is renamed), and `merge`. Existing `updateRef` writes direct oids only — `writeSymbolicRef` is new.
- **Three new commands added.** `rm`, `reset`, `revParse`. `mv`, `restore`, `switch`, `show`, `ls-files`, `ls-tree`, `cat-file`, `remote`, `config`, `stash`, `pull`, `rebase`, `cherry-pick` are documented as v2 (§9).
- **`assertNotBare` helper.** Centralized in `internal/repo-state.ts` alongside the cached `core.bare` lookup.
- **`assertRepositoryRoot` helper.** Centralized repo-root resolution (also caches per-ctx).
- **`LogOptions.until_` renamed.** Date-range bound is now `before: Date`; oid-list stop set is now `excluding: ReadonlyArray<string>`.

**Security fixes.**
- **SSRF — IPv4-mapped IPv6 added to blocklist.** `::ffff:0:0/96` rejected before resolving; the embedded IPv4 quad re-checked against all RFC-1918 / loopback ranges.
- **SSRF — DNS rebinding mitigation.** The validator resolves the host once, pins the IP, and the network pipeline connects by IP with the original `Host` header preserved. No per-attempt re-resolution. Documented in §4.8.
- **Working-tree TOCTOU.** `materializeFile` opens the target with `O_NOFOLLOW` on the final component (POSIX); on platforms without `O_NOFOLLOW` (browser OPFS) the operation falls back to the realpath check. Symlink-vs-file race window is closed.
- **`.git` path-component rejection.** `materializeFile` rejects any path component equal to `.git` (case-insensitive on Windows / macOS, case-sensitive on Linux — matches Git's CVE-2014-9390 fix).
- **Log injection from ref names.** `internal/network-pipeline` sanitizes any string derived from response bodies (ref names, advertised capabilities) before they reach `ctx.logger` — strips bytes outside `0x20`–`0x7E`, replacing with `\xNN` escapes.
- **Clone rollback scope.** `clone` records `didCreateTarget` and only rolls back recursively when it was responsible for creating the target. Rollback uses an explicit recursive walker (FileSystem port has no recursive `rm`; we add `rmRecursive` to the port — see §10.1).
- **Pack-bomb cap.** New `PACK_TOO_LARGE` error variant; `clone`/`fetch` reject pack headers whose object count exceeds `MAX_OBJECTS_PER_PACK = 50_000_000` before any object is inflated.
- **`PATHSPEC_OUTSIDE_REPO` is the primary check** for `add`, runs before any I/O, and is unconditional (not "defense-in-depth").
- **`--force-with-lease`.** Added to `PushOptions` as `forceWithLease?: ObjectId | 'auto'`. `'auto'` reads `refs/remotes/<remote>/<ref>` as the expected old id; an explicit oid is checked verbatim.
- **Stale-lock recovery hint.** `RESOURCE_LOCKED` carries `{ resource: 'index'|'ref', path, mtime }`. New `opts.breakStaleLockMs?: number` on `add` / `commit` / `branch` / `tag`: when the lock file's mtime is older than the threshold, the command removes it and retries once.
- **Bare detection default.** Missing `.git/config` (or missing `core.bare` key) defaults to `false` (non-bare). Documented in §4.4.
- **Conflict marker label sanitization.** `merge` strips newlines and bytes outside `0x20`–`0x7E` from the source-side label written into `<<<<<<<`/`>>>>>>>` markers. Prevents a malicious branch name like `HEAD\n<<<<<<< HEAD` from injecting fake conflict markers.

**Implementation fixes.**
- **`log` path filter snippet rewritten.** Reads the parent commit object before passing tree oids to `diffTrees`. Documents an LRU cache on parent reads to avoid quadratic I/O across long histories.
- **Multi-round fetch dropped from v1.** §5.11 ships single-round `haves` capped at `MAX_HAVES = 256` (matches isomorphic-git). Multi-round protocol-v0 is a v2 extension.
- **`clone` refs.** Step 7 explicitly: every advertised ref → `refs/remotes/origin/<name>`; only the *checked-out* branch → `refs/heads/<branch>`. HEAD set to `ref: refs/heads/<branch>`.
- **`serializeTag`** corrected to `serializeTagContent` (the actual export); tagger fallback chain mirrors commit author resolution.
- **`isBinary` reused.** §5.6 references `domain/diff/line-diff.isBinary` and the existing `BINARY_DETECTION_BYTES` constant — no new helper.
- **`pipe` no-op identity removed.** Operator chains use a conditional spread (`...(opts.limit !== undefined ? [take(opts.limit)] : [])`) instead of `(x) => x`, which doesn't satisfy the operator type.
- **`domain/ignore/` module added** to §2 (`parse-gitignore.ts` + `match.ts`). Phase 9 owns it.
- **`EMPTY_TREE_OID`** constant added to `domain/objects/object-id.ts` alongside `ZERO_OID`. Used by `merge` for unrelated-history base.
- **Rollup config extension.** Phase 9 explicitly modifies `rollup.config.ts` to add 13 per-command entry points, plus a per-command `.size-limit.json` budget (1.5 kB each = ~20 kB total cap).
- **Multi-round caveat in §9.7.** v2 will add multi-round `fetch`, `--depth` deepening, and `force-with-lease` server-side lease semantics.

---

## 1. Overview

Phase 9 adds the **Tier 1 application layer**: high-level user-facing commands built by composing Tier 2 primitives (Phase 7), the operators toolkit (Phase 6), the transport middleware (Phase 8), and the domain layer.

Sixteen commands total, grouped by their I/O surface:

| Cluster | Commands | Surface |
|---|---|---|
| Repository setup | `init` | Filesystem-only |
| Working tree ↔ index | `add`, `rm`, `status`, `checkout`, `reset`, `diff` | FS + index + objects |
| History | `commit`, `log`, `branch`, `tag`, `merge`, `revParse` | Objects + refs |
| Network | `clone`, `fetch`, `push` | Objects + refs + transport |

**Tier discipline.**

```
Tier 1 — commands/      (this phase)
              │
              ▼
Tier 2 — primitives/    (Phase 7)
              │
              ▼
          domain/ + ports/ + operators/ + transport/
```

Commands compose primitives and transport. Primitives never import commands (Phase 7 §3 already forbids this). The Phase 10 facade (`openRepository()`) wires `ctx` and exposes commands as bound methods; commands themselves remain free functions.

**Scope boundary.** Phase 9 does *not* implement:

- Hooks (`pre-commit`, `pre-push`, etc.). Out of scope for v1.
- Submodules, sparse-checkout, partial-clone, shallow-clone (`--depth`). Phase 11 follow-up.
- Reflog updates. Reads exist conceptually but not exposed; ref updates do not write reflog entries.
- `rebase`, `cherry-pick`, `revert`, `stash`, `bisect`, `blame`. v2.
- Server-side dumb HTTP transport. Smart HTTP only.
- Notes, signed commits, GPG verification. v2.
- Working-tree symlink-safety on Windows (we follow Git's behavior: symlinks materialize on POSIX, fall back to a flat file containing the link target on Windows — same as Phase 5 §11).

**Cancellation.** Every command threads `ctx.signal` through every awaited primitive call and every `transport.request`. Long-running iterations (status, log, diff) check `ctx.signal.aborted` between yields per the Phase 7 cadence.

**Binary-size constraint.** A new `.size-limit.json` entry `"Commands (barrel)"` capped at **28 kB gzipped** (estimated 22 kB: 16 commands × ~0.8 kB unique code + 9 kB shared `internal/*` chunks counted once). 16 per-command entries are individually capped at 1.5 kB gzipped each, but they share the `internal/*` chunks via dynamic-import-style hoisting so the barrel does not pay 16 × 1.5 = 24 kB of duplication. The `scripts/check-size.ts` test verifies both that the barrel meets its cap AND that no per-command entry exceeds 1.5 kB.

Commands are tree-shakable: importing only `init` from `tsgit/commands/init` must not pull `clone`'s transport chain. Each command lives in its own module file and exports a single function — no shared barrel that forces all-or-nothing loading. The `tsgit/commands` index barrel is provided for convenience but is itself sideEffect-free.

---

## 2. Module Structure

```
src/application/commands/
├── init.ts                  # init(ctx, opts?): Promise<InitResult>
├── add.ts                   # add(ctx, paths, opts?): Promise<AddResult>
├── rm.ts                    # rm(ctx, paths, opts?): Promise<RmResult>
├── reset.ts                 # reset(ctx, target, opts?): Promise<ResetResult>
├── commit.ts                # commit(ctx, opts): Promise<CommitResult>
├── status.ts                # status(ctx, opts?): Promise<StatusReport>
├── log.ts                   # log(ctx, opts?): AsyncIterable<LogEntry>
├── diff.ts                  # diff(ctx, opts?): AsyncIterable<DiffEntry>
├── branch.ts                # branch(ctx, action): Promise<BranchResult>
├── tag.ts                   # tag(ctx, action): Promise<TagResult>
├── checkout.ts              # checkout(ctx, target, opts?): Promise<CheckoutResult>
├── clone.ts                 # clone(ctx, url, opts?): Promise<CloneResult>
├── fetch.ts                 # fetch(ctx, opts?): Promise<FetchResult>
├── push.ts                  # push(ctx, opts?): Promise<PushResult>
├── merge.ts                 # merge(ctx, opts): Promise<MergeResult>
├── rev-parse.ts             # revParse(ctx, expression): Promise<ObjectId>
├── error.ts                 # CommandError union + factories
├── types.ts                 # Shared option / result shapes
├── internal/
│   ├── bootstrap.ts         # bootstrapRepository(ctx, opts) — shared by init + clone
│   ├── repo-state.ts        # repoRoot, isBare, assertNotBare, assertRepository
│   ├── config-read.ts       # parse `.git/config` minimally for user.* + remote.* + core.bare
│   ├── working-tree.ts      # Workdir-write helpers with O_NOFOLLOW + .git component reject
│   ├── index-update.ts      # add/remove/replace index entries (under index.lock)
│   ├── url-validate.ts      # SSRF guard with IP pinning + IPv4-mapped v6 + redirect cap
│   ├── ref-spec.ts          # parseRefspec, applyRefspec, MAX_REFSPECS_PER_PUSH
│   ├── network-pipeline.ts  # composes withAuth/withRetry/withLogging, sanitizes log strings
│   ├── commit-message.ts    # Sanitization + author/committer/tagger resolution
│   └── rev-parse-grammar.ts # `HEAD~n`, `<ref>^{tree}`, `:0:<path>`, oid prefixes
└── index.ts                 # Barrel
```

**Test layout.** Mirrors the source tree under `test/unit/application/commands/` with one fixture file (`fixtures.ts`) building memory-context repositories with tunable seeds (commits, refs, packs, working-tree state, optional remote responses).

All files kebab-case (ls-lint). All imports use the `.js` suffix.

---

## 3. Dependency Boundaries

```
commands/ → primitives/        (Phase 7 — composition target)
commands/ → operators/         (Phase 6 — pipe/filter/take/...)
commands/ → transport/         (Phase 8 — only network commands)
commands/ → domain/            (parsers, types, error factories)
commands/ → ports/             (Context only; commands NEVER call adapter constructors)
commands/ ✗→ adapters/         (forbidden — would couple to platform)
commands/ ✗→ repository.ts     (the facade is above commands)
commands/ ✗→ commands/         (no intra-tier imports)
```

A new dep-cruiser rule `commands-cannot-import-each-other` enforces the last bullet. Shared logic lives under `commands/internal/` (where intra-folder imports ARE allowed).

**Why no intra-tier imports?** Two reasons:

1. **Tree-shake.** A user importing `init` should not transitively pull `clone`'s transport chain.
2. **Composition discipline.** `commit` does not call `add`; it consumes the index that `add` (or the user) updated. `push` does not call `commit`; it sends the commits the user already created. The "compose by Tier-2 primitive" pattern is more uniform than ad-hoc Tier-1 chaining and prevents subtle interactions (e.g., `add` mid-way through `commit` would change semantics).

The Phase 10 facade is allowed to call multiple commands in sequence on behalf of users (e.g., a future convenience method `commitAndPush`); commands themselves remain free of cross-references.

### 3.1 Per-command external dependency table

| Command | Primitives | Operators | Transport | Other |
|---|---|---|---|---|
| `init` | — | — | — | `internal/bootstrap`, `FileSystem` via `ctx.fs` |
| `add` | `readIndex`, `writeObject` | — | — | `internal/working-tree`, `internal/index-update`, `domain/ignore` |
| `rm` | `readIndex` | — | — | `internal/working-tree`, `internal/index-update` |
| `reset` | `readIndex`, `readTree`, `resolveRef`, `updateRef` | — | — | `internal/working-tree` (only `--hard`), `internal/index-update` |
| `commit` | `readIndex`, `writeTree`, `createCommit`, `resolveRef`, `writeSymbolicRef` (new), `updateRef` | — | — | `internal/commit-message`, `internal/repo-state` |
| `status` | `readIndex`, `readTree`, `resolveRef`, `walkTree`, `mergeBase` (new — for `ahead`/`behind`) | `pipe`, `filter`, `groupBy` | — | `internal/working-tree` (lstat, mode), `internal/repo-state`, `domain/ignore` |
| `log` | `walkCommits`, `resolveRef`, `readObject` (parent-commit reads for path filter) | `pipe`, `filter`, conditional `take`, `map` | — | — |
| `diff` | `readIndex`, `readTree`, `readBlob`, `diffTrees`, `resolveRef` | `pipe`, `filter`, `flatMap` | — | `internal/working-tree` (for workdir-vs-index mode), `domain/diff/line-diff.isBinary` |
| `branch` | `resolveRef`, `updateRef`, `writeSymbolicRef` (when renaming current branch) | — | — | `internal/repo-state` |
| `tag` | `resolveRef`, `updateRef`, `writeObject` (for annotated tags via `serializeTagContent`) | — | — | `internal/commit-message` (tagger fallback) |
| `checkout` | `readTree`, `readBlob`, `resolveRef`, `updateRef`, `writeSymbolicRef` (new), `readIndex` | `pipe`, `flatMap` | — | `internal/working-tree` (atomic dir-tree materialization) |
| `clone` | `writeObject`, `updateRef`, `writeSymbolicRef` (new), `readObject` (sanity) | — | network pipeline | `internal/bootstrap`, `internal/url-validate`, `internal/network-pipeline`, `internal/ref-spec` |
| `fetch` | `readObject` (sanity), `updateRef`, `resolveRef` | — | network pipeline | `internal/url-validate`, `internal/ref-spec` |
| `push` | `walkCommits`, `readObject`, `resolveRef`, `mergeBase` (new — for ancestor / fast-forward check) | `pipe`, `filter`, `flatMap` | network pipeline | `internal/url-validate`, `internal/ref-spec` |
| `merge` | `walkCommits`, `mergeBase` (new), `readTree`, `readObject`, `writeTree`, `createCommit`, `resolveRef`, `writeSymbolicRef` (new), `updateRef`, `readIndex` | `pipe`, `take` | — | domain/merge `mergeTrees`, `internal/working-tree` |
| `revParse` | `resolveRef`, `readObject` | — | — | `internal/rev-parse-grammar` |

---

## 4. Cross-cutting Concerns

### 4.1 Context

Every command takes `ctx: Context` as the first parameter (per the Phase 4 / 7 convention). Commands NEVER receive raw `FileSystem` / `Compressor` / `HttpTransport` parameters — those live on `ctx`. The facade (`openRepository`) constructs `ctx` once; commands inherit it.

### 4.2 Error model

Error variants live in three locations after consolidation:

**Domain-tier (`domain/repository/error.ts`, new module).** Repository-state errors that primitives can also raise:

```typescript
export type RepositoryError =
  | { readonly code: 'NOT_A_REPOSITORY'; readonly path: FilePath }
  | { readonly code: 'BARE_REPOSITORY'; readonly operation: string }
  | { readonly code: 'ALREADY_INITIALIZED'; readonly path: FilePath };
```

**Cross-tier `ApplicationError` extension (`domain/error.ts`).** Single locking primitive shared with future tiers:

```typescript
| { readonly code: 'RESOURCE_LOCKED'; readonly resource: 'index' | 'ref'; readonly path: FilePath; readonly mtimeMs?: number }
| { readonly code: 'PACK_TOO_LARGE'; readonly objectCount: number; readonly limit: number };
```

**Protocol-tier (`domain/protocol/error.ts`).** `REFSPEC_INVALID` joins the existing protocol errors (it's a parser concern, mirroring `INVALID_REF_LINE`):

```typescript
| { readonly code: 'REFSPEC_INVALID'; readonly raw: string };
```

**Command-tier (`commands/error.ts`).** Variants that are genuinely command-shaped:

```typescript
export type CommandError =
  | { readonly code: 'WORKING_TREE_DIRTY'; readonly paths: ReadonlyArray<FilePath> }
  | { readonly code: 'PATHSPEC_NO_MATCH'; readonly pattern: string }
  | { readonly code: 'PATHSPEC_OUTSIDE_REPO'; readonly path: FilePath }
  | { readonly code: 'NOTHING_TO_COMMIT' }
  | { readonly code: 'EMPTY_COMMIT_MESSAGE' }
  | { readonly code: 'AUTHOR_UNCONFIGURED' }
  | { readonly code: 'BRANCH_EXISTS'; readonly name: RefName }
  | { readonly code: 'BRANCH_NOT_FOUND'; readonly name: RefName }
  | { readonly code: 'TAG_EXISTS'; readonly name: RefName }
  | { readonly code: 'TAG_NOT_FOUND'; readonly name: RefName }
  | { readonly code: 'CANNOT_DELETE_CHECKED_OUT_BRANCH'; readonly name: RefName }
  | { readonly code: 'INVALID_URL'; readonly reason: string }
  | { readonly code: 'BLOCKED_HOST'; readonly host: string; readonly reason: string }
  | { readonly code: 'TOO_MANY_REDIRECTS'; readonly count: number }
  | { readonly code: 'UNSUPPORTED_SCHEME'; readonly scheme: string }
  | { readonly code: 'TARGET_DIRECTORY_NOT_EMPTY'; readonly path: FilePath }
  | { readonly code: 'REMOTE_ADVERTISES_NO_REFS' }
  | { readonly code: 'NON_FAST_FORWARD'; readonly ref: RefName; readonly local: ObjectId; readonly remote: ObjectId }
  | {
      readonly code: 'PUSH_REJECTED';
      readonly ref: RefName;
      readonly reason: string;
      readonly reportStatus: ReportStatus;  // full structured payload from receive-pack response
    }
  | { readonly code: 'MERGE_HAS_CONFLICTS'; readonly count: number }
  | { readonly code: 'CHECKOUT_OVERWRITE_DIRTY'; readonly paths: ReadonlyArray<FilePath> }
  | { readonly code: 'REVPARSE_AMBIGUOUS'; readonly expression: string; readonly candidates: ReadonlyArray<ObjectId> }
  | { readonly code: 'REVPARSE_UNRESOLVED'; readonly expression: string }
  | { readonly code: 'EMPTY_PATHSPEC' }
  | { readonly code: 'OPERATION_IN_PROGRESS'; readonly operation: 'merge' | 'rebase' | 'cherry-pick' | 'revert' };
```

25 command-specific variants. Factories follow the Phase 1 / 8 pattern — one named function per variant. No `new TsgitError(...)` in command bodies.

**Total new variants across tiers: 30** (3 `RepositoryError` + 2 `ApplicationError` + 1 `ProtocolError` + 23 `CommandError` + 1 `OPERATION_IN_PROGRESS` added in §4.11). `OPERATION_ABORTED` is reused from Phase 7.

**Type-merge.** `domain/error.ts`'s `TsgitErrorData` is widened in lockstep with each new family:

```typescript
export type TsgitErrorData =
  | DomainObjectError
  | StorageError
  | RefsError
  | IndexError
  | AdapterError
  | DiffError
  | MergeError
  | ApplicationError    // gains RESOURCE_LOCKED + PACK_TOO_LARGE
  | ProtocolError       // gains REFSPEC_INVALID
  | RepositoryError     // new
  | CommandError;       // new
```

Step 0 of the implementation plan widens the union AND every `extractDetail` arm in a single commit so the exhaustiveness check never goes out of sync.

### 4.2.1 `extractDetail` message templates

| Code | Detail format |
|---|---|
| `NOT_A_REPOSITORY` | `not a git repository: ${path}` |
| `BARE_REPOSITORY` | `operation requires a working tree: ${operation}` |
| `ALREADY_INITIALIZED` | `repository already exists: ${path}` |
| `RESOURCE_LOCKED` | `${resource} locked: ${path}` |
| `PACK_TOO_LARGE` | `pack contains ${objectCount} objects, exceeds limit ${limit}` |
| `REFSPEC_INVALID` | `invalid refspec: ${raw}` |
| `WORKING_TREE_DIRTY` | `working tree has uncommitted changes: ${paths.length} files` |
| `PATHSPEC_NO_MATCH` | `pathspec did not match any files: ${pattern}` |
| `PATHSPEC_OUTSIDE_REPO` | `pathspec resolves outside repository: ${path}` |
| `NOTHING_TO_COMMIT` | `nothing to commit (use allowEmpty: true to commit anyway)` |
| `EMPTY_COMMIT_MESSAGE` | `commit message is empty (use allowEmptyMessage: true to commit anyway)` |
| `AUTHOR_UNCONFIGURED` | `author identity not configured (set ctx.config.user or pass author/committer)` |
| `BRANCH_EXISTS` | `branch already exists: ${name}` |
| `BRANCH_NOT_FOUND` | `branch not found: ${name}` |
| `TAG_EXISTS` | `tag already exists: ${name}` |
| `TAG_NOT_FOUND` | `tag not found: ${name}` |
| `CANNOT_DELETE_CHECKED_OUT_BRANCH` | `cannot delete branch currently checked out: ${name}` |
| `INVALID_URL` | `invalid URL: ${reason}` |
| `BLOCKED_HOST` | `host blocked: ${host} (${reason})` |
| `TOO_MANY_REDIRECTS` | `too many redirects: ${count}` |
| `UNSUPPORTED_SCHEME` | `unsupported URL scheme: ${scheme}` |
| `TARGET_DIRECTORY_NOT_EMPTY` | `target directory is not empty: ${path}` |
| `REMOTE_ADVERTISES_NO_REFS` | `remote advertised no refs` |
| `NON_FAST_FORWARD` | `non-fast-forward update for ${ref}: local=${local} remote=${remote}` |
| `PUSH_REJECTED` | `push rejected for ${ref}: ${reason}` |
| `MERGE_HAS_CONFLICTS` | `merge has unresolved conflicts: ${count} files` |
| `CHECKOUT_OVERWRITE_DIRTY` | `checkout would overwrite uncommitted changes: ${paths.length} files` |
| `REVPARSE_AMBIGUOUS` | `revision expression "${sanitize(expression)}" is ambiguous (${candidates.length} candidates)` |
| `REVPARSE_UNRESOLVED` | `cannot resolve revision: ${sanitize(expression)}` |
| `EMPTY_PATHSPEC` | `pathspec is empty (use "." to mean "all paths")` |
| `OPERATION_IN_PROGRESS` | `${operation} in progress; complete or abort it before running this command` |

`sanitize(s)` applies `\xNN` hex escapes to bytes outside `0x20`–`0x7E` (same rule as `wrapLoggerSanitizer`). Used for `INVALID_URL.reason`, `BLOCKED_HOST.host`, `BLOCKED_HOST.reason`, `PUSH_REJECTED.reason`, `REVPARSE_AMBIGUOUS.expression`, `REVPARSE_UNRESOLVED.expression`. Closes the log-injection vector via attacker-controlled URL/host/expression strings reaching `error.message` even when callers log `.message` directly without going through the wrapped logger.

These templates are exact strings — tests assert via `toBe(...)`, not `toMatch(/.../)` (per CLAUDE.md mutation-resistant pattern).

### 4.3 Repository discovery

Most commands need to know "where is `.git`?". The `getRepoRoot` function lives in **Phase 7**'s `path-layout.ts` (Round-5 amendment — see §10.1) so primitives and commands share a single implementation. `commands/internal/repo-state.ts` is a thin layer that adds command-specific assertions:

```typescript
// Lives in src/application/primitives/path-layout.ts (Phase 7 amended)
export function getRepoRoot(ctx: Context): Promise<FilePath>;

// Lives in src/application/commands/internal/repo-state.ts (Phase 9)
export function assertRepository(ctx: Context): Promise<FilePath>;
  // Wraps getRepoRoot; throws NOT_A_REPOSITORY if none found.

export function assertNotBare(ctx: Context, operation: string): Promise<void>;
  // Throws BARE_REPOSITORY with { operation }.

export function isBare(ctx: Context): Promise<boolean>;
  // Reads core.bare from .git/config; cached.

export function readHeadRaw(ctx: Context): Promise<HeadState>;

type HeadState =
  | { readonly kind: 'symbolic'; readonly target: RefName }
  | { readonly kind: 'direct'; readonly id: ObjectId };
  // Used by commit, branch (rename current), checkout, merge, branch (delete current check).
```

**Cache.** A single `WeakMap<Context, RepoState>` carries `{ repoRoot, isBare, head }`. Lookup populates the entire record lazily on first access. `init`/`clone` evict the cache after construction so subsequent reads see the new state.

**Realpath pinning.** `getRepoRoot` calls `fs.realpath(ctx.cwd)` ONCE before the upward walk. The pinned realpath is what every subsequent command sees as the repository root. This avoids:
- A `cwd` symlink that points into the repo causing the upward walk to escape early at the symlink point.
- A mid-session `cwd` change confusing the cache (the cache key is `ctx`, not `ctx.cwd`).

`init` and `clone` *create* `.git` (via `internal/bootstrap.bootstrapRepository`); they bypass `assertRepository` and use `realpath(ctx.cwd)` directly.

### 4.4 Bare repositories

A bare repository is one where `core.bare = true` (or where `.git` is the actual directory rather than a subdirectory). Commands that touch the working tree throw `BARE_REPOSITORY` with the operation name. `clone --bare`, `fetch`, `push`, `branch`, `tag`, `log`, `commit` work on bare repos.

**Default behavior.** `core.bare` lookup uses `internal/config-read.ts`. If `.git/config` is missing OR exists without `[core] bare`, default is `false` (non-bare). The detection result is cached per-`ctx` via `WeakMap`.

### 4.5 Index locking

Writing to `.git/index` requires holding `.git/index.lock`. The pattern reuses Phase 7's `atomic-write.ts` (lock file + fsync + rename), with one difference: index writes hold the lock across the read-modify-write cycle (read current index, mutate in memory, serialize, fsync, rename).

**Lock acquisition.** If the lock file already exists, throw `RESOURCE_LOCKED` with `{ resource: 'index', path: lockPath, mtimeMs }`. The mtime helps callers diagnose stale locks.

**Stale-lock recovery.** A single `ctx.config.breakStaleLockMs?: number` controls the global default. Per-command overrides exist but are NOT typed individually — they're a single `breakStaleLockMs?: number` on `BaseLockOpts` mixed into the relevant option types. Reduces option-surface churn.

- If unset (default): no auto-recovery, lock contention surfaces as `RESOURCE_LOCKED`.
- If set to N: when the lock file's age `(now - mtime)` is in the half-open range `[N, ∞)`, the command removes the lock once and retries acquisition exactly once. A second contention surfaces as `RESOURCE_LOCKED`.
- **Backward-clock-skew guard.** The command never breaks the lock when `(now - mtime) < 0` — a backward NTP step is treated as "unknown age". This avoids a freshly written lock looking ancient after a system clock correction.

The default-unset behavior is deliberate — silent stale-lock breakage is worse than a clear error. CLI wrappers can default `ctx.config.breakStaleLockMs: 60_000` if they want git's behavior.

### 4.6 Working-tree safety

`internal/working-tree.ts` provides `materializeFile(ctx, path, blob, mode)`, `removeFile(ctx, path)`, and `readFile(ctx, path)`. All three enforce identical path safety:

**Path validation (runs before any I/O).**

1. `path` MUST be repo-root-relative (no leading `/`, no drive letter on Windows).
2. No `..` segments, no NUL bytes, no `\0`-injection.
3. **No path component equal to `.git`** (case-insensitive on Windows / macOS as detected by FS port; case-sensitive on Linux). On Windows / NTFS the rejection list also covers:
   - `.git ` (trailing ASCII space) — NTFS strips trailing spaces during path resolution.
   - `.git.` (trailing dot) — NTFS strips trailing dots during path resolution.
   - 8.3 short names (e.g., `GIT~1`) that `fs.realpath` resolves to `.git`. The check is: after `fs.realpath(parent + '/' + component)`, the basename must NOT equal `.git` case-insensitively.
   Closes CVE-2014-9390-class attacks. Applied to every path component, not just the leaf.
4. After splitting, every component must satisfy `domain/refs/ref-validation.ts`'s allowed-character set (no control chars, no slashes, no DEL).
5. Length cap: total path ≤ 4096 bytes, each component ≤ 255 bytes (matches POSIX/NTFS limits).

**TOCTOU mitigation (atomic write).**

- Writes go to `.git/.tmp/<random>` (random base32 16-byte name) then `rename` into place.
- The destination open uses `O_NOFOLLOW` on the **final component** on POSIX (Node `fs.open(dst, O_WRONLY | O_NOFOLLOW)` for the rename target).
- For non-symlink blobs, the parent directory's realpath is verified to be inside the repo root once before the rename (`realpath(dirname(dst))` startsWith `repoRoot + sep`). The window between realpath and rename is the residual race — accepted because closing it requires `openat` syscalls Node doesn't expose.
- On platforms without `O_NOFOLLOW` support (browser OPFS, Windows): falls back to the realpath check only. Documented as a known limitation.

**Mode mapping.**

- `100644` → write file, chmod 0644.
- `100755` → write file, chmod 0755.
- `120000` → on POSIX, `unlink + symlink(target = blob.contents UTF-8 string, dst)`. On Windows / OPFS (no symlink support), write a regular file whose contents are the link target string as UTF-8 bytes — **no trailing newline, no BOM, byte-exact**. The index entry stores the same bytes as a `100644`-mode blob; the resulting blob hash is reproducible across platforms (the platform delta is in the file mode flag, not in the content).
- `160000` (gitlink / submodule) → throws `UNSUPPORTED_OPERATION` in v1; Phase 11 adds true submodule support.

**Removal.**

`removeFile(ctx, path)` runs the same path-validation pipeline. If the target is a directory, a symlink that no longer matches what we wrote, or has changed mode since the index entry, throws `CHECKOUT_OVERWRITE_DIRTY` instead of blindly removing.

**Logging.** Path-validation failures throw `PATHSPEC_OUTSIDE_REPO` with the offending input — never log raw user paths to ctx.logger (could contain control bytes).

### 4.7 Network pipeline

`commands/internal/network-pipeline.ts` exports `withDefaults(ctx, opts?): HttpTransport`:

```typescript
const DEFAULT_RETRY: RetryConfig = {
  attempts: 3,
  backoff: 'exponential',
  baseMs: 250,
  maxDelayMs: 5_000,
};

export function withDefaults(ctx: Context, opts?: NetworkOpts): HttpTransport {
  // Defensive freeze — Phase 10 facade will freeze in the constructor too.
  if (ctx.config !== undefined && !Object.isFrozen(ctx.config)) {
    Object.freeze(ctx.config);
  }
  // Wrap the logger ONCE so every middleware sees sanitized strings,
  // including withRetry / withAuth diagnostic events.
  const safeLogger = ctx.logger ? wrapLoggerSanitizer(ctx.logger) : undefined;
  const auth = opts?.auth ?? ctx.config?.auth;

  let result: HttpTransport = ctx.transport;
  if (safeLogger !== undefined) {
    result = withLogging({ logger: safeLogger })(result);
  }
  if (auth !== undefined) {
    result = withAuth(auth)(result);
  }
  result = withRetry(opts?.retry ?? DEFAULT_RETRY)(result);
  return result;
}
```

With exponential backoff, three attempts wait at most `250 + 500 + 1000` ms ≈ 1.75 s before giving up.

**`ctx.config` immutability contract.** `ctx.config` MUST NOT be mutated after `ctx` is constructed. Phase 10 freezes it in the constructor; Phase 9 calls `Object.freeze(ctx.config)` defensively on first `withDefaults` invocation as a safety net. Commands rely on this for the per-`ctx` middleware cache (`WeakMap<Context, HttpTransport>`) — without it, a token-refresh on `ctx.config.auth` would silently use the stale wrapper.

Users wanting per-request auth (token refresh, rotating keys) pass `opts.auth` to the relevant command rather than mutating `ctx.config`.

**`ctx.config` shape (fields read by Phase 9).**

| Field | Type | Default | Read by |
|---|---|---|---|
| `user` | `AuthorIdentity` | undefined | `commit`, `tag --annotated` |
| `auth` | `AuthConfig` | undefined | `clone`, `fetch`, `push` |
| `parallelism` | `number` (1..32) | `8` (Phase 7) | `clone`, `checkout`, `add` |
| `upstreamRef` | `RefName` | undefined | `status` (`ahead`/`behind`) |
| `allowInsecure` | `boolean` | `false` | `internal/url-validate` (allows `http`) |
| `allowPrivateNetworks` | `boolean` | `false` | `internal/url-validate` |
| `maxResponseBytes` | `number` | `10 * 1024**3` | `internal/network-pipeline` |
| `maxObjectsPerPack` | `number` | `50_000_000` | `clone`, `fetch` |
| `detectRenames` | `boolean` | `false` | `status`, `diff` |
| `breakStaleLockMs` | `number` | undefined | `add`, `commit`, `branch`, `tag`, `rm`, `reset` |
| `dnsResolver` | `(host) => Promise<string[]>` | platform default | `internal/url-validate` |

Phase 7's `parallelism` field is reused (no new key). Phase 10 finalizes the `Context` type; Phase 9 reads via optional-chaining and falls back to defaults.

**Logger sanitization.** `wrapLoggerSanitizer(logger)` returns a `Logger` whose `log(event)` strips any string field of bytes outside `0x20`–`0x7E`, replacing with `\xNN` escapes. **Exceptions:** `\n` (0x0A) and `\t` (0x09) are preserved verbatim because most log backends format them sensibly. CR (0x0D) is escaped (log injection vector). The same wrapper is used for `withLogging`, `withAuth`, and `withRetry` middleware — the wrapped logger is created once at composition time and shared.

Users wanting different behavior pre-compose their own transport stack and pass it via `ctx.transport`.

### 4.8 SSRF mitigation

`commands/internal/url-validate.ts` runs before any `fetch`-style operation. It returns a tagged `ValidatedUrl` brand `{ readonly url: string; readonly pinnedAddress: string }` that is the only type accepted by `internal/network-pipeline.connect()`.

**1. Scheme allowlist.** Default `['https']`. `http` is opt-in via `ctx.config.allowInsecure === true` (default `false`). Other schemes (`ftp`, `file`, `git`, `data`, `javascript`) are always rejected with `UNSUPPORTED_SCHEME`.

**2. Host resolution.** The validator resolves the host via `ctx.dnsResolver` (pluggable; defaults to Node's `dns.lookup` or browser's no-op which delegates to `fetch`). For each resolved address:

- IPv4 ranges blocked (RFC 1918 / loopback / link-local / multicast / CGNAT):
  - `0.0.0.0/8`, `10.0.0.0/8`, `100.64.0.0/10`, `127.0.0.0/8`, `169.254.0.0/16`, `172.16.0.0/12`, `192.168.0.0/16`, `224.0.0.0/4`, `240.0.0.0/4`.
- IPv6 ranges blocked:
  - `::1/128` (loopback), `fc00::/7` (ULA), `fe80::/10` (link-local), `ff00::/8` (multicast), `::/128` (unspecified).
- **IPv4-mapped IPv6 (`::ffff:0:0/96`)**: the embedded IPv4 address is extracted and re-checked against ALL IPv4 ranges above. Closes the canonical `::ffff:127.0.0.1` SSRF bypass.
- IPv4-translated IPv6 (`::ffff:0:0:0/96` with the alternate format) and 6to4 (`2002::/16`) get the same treatment — extract embedded IPv4, re-check.

Override via `ctx.config.allowPrivateNetworks === true` for testing against local servers. Default `false`.

**3. DNS pinning (anti-rebinding).** The validator resolves the host **once**, stores the IP in the `ValidatedUrl.pinnedAddress`, and `internal/network-pipeline.connect(validatedUrl)` opens the TCP connection to that exact IP with the original host as the `Host` header. The transport never re-resolves DNS on retries or redirects. The Node adapter overrides Node's default behavior by passing `lookup: () => pinnedAddress` to `https.request`.

In the browser, where `fetch` controls DNS resolution opaquely, we accept residual rebinding risk and document it: applications that need hard SSRF guarantees in the browser should run behind a server-side proxy that enforces the validation.

**4. Redirect cap.** `internal/network-pipeline` follows at most `5` redirects per request. Each redirect:

- Re-runs the full URL validator (scheme + IP check + DNS pin).
- **Strips ALL credential headers on cross-origin redirects** (different scheme / host / port). The strip set covers `Authorization`, `Cookie`, `Proxy-Authorization`, AND any header injected by `withAuth` (the middleware records the names of headers it added; the redirect path consults that set). User-supplied headers via plain `req.headers` (not via `withAuth`) are NOT stripped — they're treated as user-intent, not injected credentials.
- Exceeding the cap throws `TOO_MANY_REDIRECTS`.

**5. Total bytes cap.** `internal/network-pipeline` accumulates response body bytes and enforces `ctx.config.maxResponseBytes ?? 10 * 1024 * 1024 * 1024` (10 GiB default). Exceeding throws `PACK_TOO_LARGE` for pack responses, `RESPONSE_TOO_LARGE` for discovery responses (parser caps already cover the per-pkt-line case).

### 4.9 Security boundary recap

| Threat | Mitigation | Module |
|---|---|---|
| SSRF via redirect | Per-redirect re-validation + DNS pinning | `internal/url-validate` |
| SSRF via IPv4-mapped IPv6 | `::ffff:0:0/96` extraction + IPv4 re-check | `internal/url-validate` |
| DNS rebinding | Resolve once, connect by pinned IP | `internal/url-validate` + `internal/network-pipeline` |
| Working-tree path escape (..) | Repo-relative + realpath check + O_NOFOLLOW | `internal/working-tree` |
| `.git` overwrite (CVE-2014-9390) | Path component reject (case-sensitive per platform) | `internal/working-tree` |
| Index lock contention | `RESOURCE_LOCKED` error, opt-in stale-lock recovery | `internal/index-update` |
| Adversarial pack content (oversize blob) | `readObject` enforces 2 GiB inflate cap | Phase 7 (inherited) |
| Adversarial pack content (object-count bomb) | `MAX_OBJECTS_PER_PACK = 50_000_000`, header-checked pre-inflate | `clone.ts`, `fetch.ts` |
| Total response size | `maxResponseBytes` cap, default 10 GiB | `internal/network-pipeline` |
| Adversarial ref names | `validateRefName` (Phase 3) | inherited |
| Log injection from response bytes | `wrapLoggerSanitizer` strips non-printable bytes | `internal/network-pipeline` |
| Force-push without `--force` | `NON_FAST_FORWARD` thrown unless `force: true` | `push.ts` |
| Lost concurrent push | Optional `forceWithLease: ObjectId \| 'auto'` | `push.ts` |
| Conflict marker injection | Strip newlines / non-printable bytes from source label | `merge.ts` |
| Wrong scheme (data:, file:) | Scheme allowlist | `internal/url-validate` |
| Cross-origin credential leak | Drop `Authorization` on cross-origin redirect | `internal/network-pipeline` |

### 4.10 Cancellation

All async iterables yield to `ctx.signal.aborted` between yields. Promise-returning commands check the signal before each I/O round-trip. On abort, an `OPERATION_ABORTED` `TsgitError` propagates (already defined Phase 7).

**Lock release on abort.** Every state-mutating command wraps the whole operation in `try/finally`:

```typescript
const lock = await acquireIndexLock(ctx);
try {
  // ... mutate ...
} finally {
  await lock.release();           // releases lock even on OPERATION_ABORTED
}
```

The same pattern applies to ref locks (`updateRef` already does this internally per Phase 7). Aborts mid-operation never leave dangling lock files.

### 4.11 Repository-state guards

Before any state-mutating command, `internal/repo-state.assertNoPendingOperation(ctx)` checks for in-progress operations by stat-ing four files in `.git/`:

- `MERGE_HEAD` — merge in progress (created by `merge` when conflicts halt completion)
- `CHERRY_PICK_HEAD` — v2 cherry-pick (file unused in v1 but reserved)
- `REVERT_HEAD` — v2 revert
- `REBASE_HEAD` — v2 rebase

If any exists → `OPERATION_IN_PROGRESS` with `{ operation }`. Commands that legitimately resume an operation (`commit` after merge-conflict resolution, `merge --abort` if/when added) bypass the check explicitly.

Applied by: `add`, `commit`, `branch.create`, `branch.delete`, `branch.rename`, `tag.create`, `tag.delete`, `checkout`, `clone` (target dir), `merge`, `pull` (v2), `reset`. NOT applied by: `status`, `log`, `diff`, `revParse`, `branch.list`, `tag.list`, `fetch`, `push` (read-only or remote-only).

---

## 5. Per-command Specifications

Each command section documents: signature, options, return type, semantics, errors, edge cases.

### 5.1 `init`

```typescript
interface InitOptions {
  /** Initial branch name. Default: 'main'. */
  readonly initialBranch?: string;
  /** Create a bare repository (no working tree). Default: false. */
  readonly bare?: boolean;
  /** Hash algorithm. Default: 'sha1'. ('sha256' is reserved for v2.) */
  readonly hash?: 'sha1';
}

interface InitResult {
  readonly path: FilePath;
  readonly initialBranch: RefName;
  readonly bare: boolean;
}

export function init(ctx: Context, opts?: InitOptions): Promise<InitResult>;
```

**Semantics.** Creates `.git/` (or treats `ctx.cwd` as `.git` when bare), populates:

- `HEAD` → `ref: refs/heads/<initialBranch>` (no commit yet)
- `config` with `[core] repositoryformatversion = 0`, `bare = <bare>`
- `objects/`, `objects/info/`, `objects/pack/`
- `refs/`, `refs/heads/`, `refs/tags/`
- `info/exclude` (empty placeholder)
- `description` ("Unnamed repository; edit this file 'description' to name the repository.")

**Errors.**
- `ALREADY_INITIALIZED` if `.git` already exists. Idempotent re-init NOT supported in v1 (forces caller to be intentional).
- `INVALID_REF` if `initialBranch` fails `validateRefName`.

**Edge cases.**
- Concurrent `init` from two processes: one wins via mkdir EEXIST; the loser sees `ALREADY_INITIALIZED`.
- `ctx.cwd` does not exist: throws `FILE_NOT_FOUND`.

### 5.2 `add`

```typescript
interface AddOptions {
  /**
   * If true, also remove from the index entries whose working-tree files
   * were deleted. Default: false (only added/modified files are staged;
   * removals require `add` with this flag, equivalent to `git add -A`).
   */
  readonly all?: boolean;
  /**
   * Force-add ignored files. (.gitignore parsing is itself in scope —
   * see §5.2.1.) Default: false.
   */
  readonly force?: boolean;
}

interface AddResult {
  readonly added: ReadonlyArray<FilePath>;
  readonly modified: ReadonlyArray<FilePath>;
  readonly removed: ReadonlyArray<FilePath>;
}

export function add(
  ctx: Context,
  paths: ReadonlyArray<string>,
  opts?: AddOptions,
): Promise<AddResult>;
```

**Semantics.** For each `path` (which may be a glob — see §5.2.1):

0. If `paths.length === 0` → throw `EMPTY_PATHSPEC` (require explicit `'.'` for "all paths"). This is symmetric with `git add` requiring at least one argument.
1. **Validate the pathspec UNCONDITIONALLY** before any I/O — `internal/working-tree.validatePath(input)` runs the full §4.6 path-safety pipeline. `..`, leading `/`, NUL bytes, `.git` components → `PATHSPEC_OUTSIDE_REPO`. This is the primary defense, not "defense-in-depth"; `materializeFile` is not in `add`'s call path.
2. Resolve to repo-root-relative `FilePath`.
3. **Re-validate every concrete path produced by glob expansion.** `internal/working-tree.validatePath` is called individually on each result of expanding `**/*.ts` etc. — the same path-safety pipeline runs again, since a glob can match a symlink resolving outside the repo.
4. Apply `.gitignore` filtering (unless `force === true`).
5. If absent on disk and `all === true`, mark as removal (stage deletion).
6. Else hash the file via `writeObject` (yields blob `ObjectId`).
7. Update the index entry (mode, oid, mtime, size, dev/ino if available).

The whole operation runs under `.git/index.lock`. If any single path fails, the entire operation rolls back (lock released without writing). Partial-success is not supported.

#### 5.2.1 Pathspec / globs / `.gitignore`

Phase 9 supports a **subset** of git's pathspec. Documented:

- Literal paths (`src/foo.ts`).
- Directory paths (`src/`) which expand to all entries under that directory.
- Globs (`*.ts`, `src/**/*.ts`) — minimatch-equivalent semantics.
- `.gitignore` parsing lives in **`domain/ignore/`** (new module owned by Phase 9):
  - `parse-gitignore.ts` — parses `.gitignore` content into a `IgnoreRuleset`.
  - `match.ts` — `matches(ruleset, path): 'ignored' | 'unignored' | 'unset'`. Last-matching rule wins (per Git semantics).
- v1 honors only the project-root `.gitignore` (no per-directory `.gitignore`, no global excludes file, no `info/exclude`). Patterns supported: literal paths, `*.ext`, `dir/`, `!negation`, `**` glob. Patterns NOT supported in v1: character classes (`[abc]`), case-insensitive matching, attribute pathspec (`:(attr:foo)`). v2 closes the gap.

**Errors.**
- `PATHSPEC_OUTSIDE_REPO` if a resolved path escapes `.git`'s parent (defense-in-depth even after working-tree's realpath check).
- `PATHSPEC_NO_MATCH` if a glob matches nothing AND `paths` was non-empty (matches `git add` behavior on stale globs).

**Edge cases.**
- File mode change without content change: stages a new entry with the new mode (oid stays the same; index uses the new mode).
- Symlink: stages mode 120000 with content = blob of the link target (UTF-8). Phase 11 may revisit Windows fallback.
- Submodule (gitlink): not supported in v1 — throws `UNSUPPORTED_OPERATION`.
- Adding a file ≥ 2 GiB: throws `UNSUPPORTED_OPERATION` (matches the `readObject` inflate cap — symmetric).

### 5.3 `commit`

```typescript
interface CommitOptions {
  readonly message: string;
  readonly author?: AuthorIdentity;     // defaults to ctx.config.user
  readonly committer?: AuthorIdentity;  // defaults to author
  /** Allow committing with no staged changes. Default: false. */
  readonly allowEmpty?: boolean;
  /** Allow an empty message string. Default: false. */
  readonly allowEmptyMessage?: boolean;
  /** Override parents — useful for amend or octopus merges. Default: HEAD if exists, else []. */
  readonly parents?: ReadonlyArray<ObjectId>;
}

interface CommitResult {
  readonly id: ObjectId;
  readonly tree: ObjectId;
  readonly parents: ReadonlyArray<ObjectId>;
}

export function commit(ctx: Context, opts: CommitOptions): Promise<CommitResult>;
```

**Semantics.**

1. Read the index (`readIndex`) — current staged tree.
2. If index has unmerged entries → throw `MERGE_HAS_CONFLICTS`.
3. Convert index → tree-of-trees via `writeTree`.
4. Compare tree to HEAD's tree (`resolveRef('HEAD')` → `readObject`). If equal AND `!allowEmpty` → `NOTHING_TO_COMMIT`.
5. Resolve author: explicit `opts.author` > `ctx.config.user` > throw `AUTHOR_UNCONFIGURED`.
6. Resolve message: trim trailing whitespace; if empty AND `!allowEmptyMessage` → `EMPTY_COMMIT_MESSAGE`.
7. Build the `Commit` via `createCommit(ctx, { tree, parents, author, committer, message })` (returns the new commit's `ObjectId`).
8. **Update HEAD via the symref discipline.** The Phase 7 `updateRef` writes a direct oid to a ref *file*; it does NOT auto-deref symrefs. So we:
   - Read `HEAD` raw via `internal/repo-state.readHeadRaw(ctx)`. Returns `{ kind: 'symbolic'; target: RefName }` or `{ kind: 'direct'; id: ObjectId }`.
   - **Symbolic HEAD (attached to a branch):** `updateRef(<target>, newId, { expected: previousHeadId ?? 'absent' })`. HEAD itself is not touched; the symref auto-resolves.
   - **Direct HEAD (detached):** write the oid directly via `updateRef('HEAD', newId, { expected: previousHeadId })`. The branch ref (if any) is NOT advanced — detached commits are orphan unless the user later branches from them.

**Errors.** `MERGE_HAS_CONFLICTS`, `NOTHING_TO_COMMIT`, `AUTHOR_UNCONFIGURED`, `EMPTY_COMMIT_MESSAGE`, plus any propagated from primitives (e.g., `REF_UPDATE_CONFLICT` if the target ref changed concurrently).

**Edge cases.**
- Initial commit on a fresh repo: HEAD is `ref: refs/heads/<initialBranch>` and the target ref doesn't exist. `parents` defaults to `[]`. The branch update uses `expected: 'absent'`.
- Detached HEAD: see step 8 above. The state is recoverable via `branch create <name>` from the user.
- `parents` containing duplicates: rejected with `INVALID_COMMIT` (relays the domain validator).

### 5.4 `status`

```typescript
interface StatusOptions {
  /** Restrict to specific paths (same pathspec rules as add). */
  readonly paths?: ReadonlyArray<string>;
  /** Include ignored files in the report. Default: false. */
  readonly includeIgnored?: boolean;
}

interface StatusReport {
  readonly branch?: RefName;            // undefined when detached HEAD
  readonly head?: ObjectId;              // undefined for unborn branch
  readonly ahead?: number;               // commits ahead of upstream
  readonly behind?: number;              // commits behind upstream
  readonly stagedChanges: ReadonlyArray<FileStatus>;
  readonly unstagedChanges: ReadonlyArray<FileStatus>;
  readonly untracked: ReadonlyArray<FilePath>;
  readonly ignored: ReadonlyArray<FilePath>;
  readonly conflicts: ReadonlyArray<FilePath>;
}

interface FileStatus {
  readonly path: FilePath;
  readonly kind: 'added' | 'modified' | 'deleted' | 'renamed' | 'typechange';
  readonly oldPath?: FilePath;          // populated when kind === 'renamed'
}

export function status(ctx: Context, opts?: StatusOptions): Promise<StatusReport>;
```

**Semantics.** Three diffs are computed:

1. **HEAD vs index** → `stagedChanges`.
2. **Index vs working tree** → `unstagedChanges`. Uses index stat-cache (Phase 3 §3.7) to skip files whose mtime/size/ino match.
3. **Working tree files not in index, not matching `.gitignore`** → `untracked`.

The walk reuses `walkTree` for HEAD and `readIndex` for the index. The working-tree walk is a parallel-bounded `lstat` traversal (concurrency = `min(ctx.config.parallelism ?? 8, 32)`).

For renames, Phase 5 §1 already provides similarity-based detection in `domain/diff/rename-detect`; `status` opts in only when `ctx.config.detectRenames === true` (default `false` — the comparison is O(N×M) across modified files and can dominate for large repos).

**Errors.** `BARE_REPOSITORY`. `OPERATION_ABORTED` if `ctx.signal` aborts mid-walk.

**Edge cases.**
- Unborn branch (no commits, HEAD points at `refs/heads/main` but it doesn't exist): `head` is `undefined`, `stagedChanges` shows everything in the index as 'added'.
- Detached HEAD: `branch` is `undefined`, `head` is the resolved oid.
- `ahead`/`behind`: computed only when `ctx.config.upstreamRef` is set (e.g., `refs/remotes/origin/main`); skipped otherwise.

### 5.5 `log`

```typescript
interface LogOptions {
  /** Starting points (refs or oids). Default: ['HEAD']. */
  readonly from?: ReadonlyArray<string>;
  /** Stop at these commit ids (exclusive — the boundary is NOT yielded). */
  readonly excluding?: ReadonlyArray<string>;
  /** Only commits touching these paths. */
  readonly paths?: ReadonlyArray<string>;
  /** Maximum number of commits to yield. */
  readonly limit?: number;
  /** Walk order. Default: 'topo'. */
  readonly order?: 'topo' | 'first-parent';
  /** Filter by author email substring. */
  readonly author?: string;
  /** Filter by committer email substring. */
  readonly committer?: string;
  /** Filter by message regex. */
  readonly grep?: RegExp;
  /** Filter by committer date — yield only commits ≥ since. */
  readonly since?: Date;
  /** Filter by committer date — yield only commits ≤ before. */
  readonly before?: Date;
}

interface LogEntry {
  readonly id: ObjectId;
  readonly tree: ObjectId;
  readonly parents: ReadonlyArray<ObjectId>;
  readonly author: AuthorIdentity;
  readonly committer: AuthorIdentity;
  readonly message: string;
  readonly subject: string;            // first line, trimmed
}

export function log(ctx: Context, opts?: LogOptions): AsyncIterable<LogEntry>;
```

**Semantics.** Composed with operators using a conditional spread (no identity-fn hack):

```typescript
const steps = [
  filter((c: Commit) => matchesDate(c, opts.since, opts.before)),
  filter((c: Commit) => matchesAuthor(c, opts.author, opts.committer)),
  filter((c: Commit) => matchesGrep(c, opts.grep)),
  filter((c: Commit) => matchesPaths(ctx, c, opts.paths)),
  map(toLogEntry),
  ...(opts.limit !== undefined ? [take<LogEntry>(opts.limit)] : []),
];
return pipe(walkCommits(ctx, { from: resolved, until: resolvedExcluding, order }), ...steps);
```

**Path filtering.** `matchesPaths(ctx, commit, paths)` reads each parent commit object to obtain `parent.tree`, then calls `diffTrees(ctx, commit.data.tree, parent.data.tree)` and checks whether any returned change touches `paths`. A small LRU (default 1024 entries, byte-bounded at 4 MiB) caches parent reads on the `ctx` so a long history doesn't re-read the same parents O(N) times. The walker yields commits in topo-sorted order; the LRU hit-rate approaches 100% on linear histories.

The path filter is the most expensive predicate — placed last in the chain so cheaper filters (date, author, grep) reject first.

**Errors.** Propagates from `walkCommits` / `readObject`.

**Edge cases.**
- Empty repo: yields zero entries.
- Cycles in commit graph (shouldn't happen but): `walkCommits` already detects (Phase 7 §6.1) and breaks.
- A commit with no parents (initial commit): `matchesPaths` treats it as "added everything in tree" — matches if any path under `paths` exists in the tree.

### 5.6 `diff`

```typescript
type DiffMode =
  | { readonly kind: 'workdir-vs-index' }
  | { readonly kind: 'index-vs-tree';     readonly tree: string }   // default tree=HEAD
  | { readonly kind: 'tree-vs-tree';      readonly a: string; readonly b: string }
  | { readonly kind: 'commit-vs-commit';  readonly a: string; readonly b: string };

interface DiffOptions {
  readonly mode?: DiffMode;       // default { kind: 'workdir-vs-index' }
  readonly paths?: ReadonlyArray<string>;
  readonly contextLines?: number; // default 3
  readonly detectRenames?: boolean; // default false
}

type DiffEntry =
  | { readonly kind: 'added'; readonly path: FilePath; readonly newId: ObjectId; readonly hunks: ReadonlyArray<DiffHunk> }
  | { readonly kind: 'deleted'; readonly path: FilePath; readonly oldId: ObjectId; readonly hunks: ReadonlyArray<DiffHunk> }
  | { readonly kind: 'modified'; readonly path: FilePath; readonly oldId: ObjectId; readonly newId: ObjectId; readonly hunks: ReadonlyArray<DiffHunk> }
  | { readonly kind: 'renamed'; readonly oldPath: FilePath; readonly newPath: FilePath; readonly oldId: ObjectId; readonly newId: ObjectId; readonly hunks: ReadonlyArray<DiffHunk>; readonly score: number }
  | { readonly kind: 'binary'; readonly path: FilePath; readonly oldId?: ObjectId; readonly newId?: ObjectId };

interface DiffHunk {
  readonly oldStart: number;
  readonly oldLines: number;
  readonly newStart: number;
  readonly newLines: number;
  readonly lines: ReadonlyArray<string>;  // each prefixed with ' ', '+', or '-'
}

export function diff(ctx: Context, opts?: DiffOptions): AsyncIterable<DiffEntry>;
```

**Semantics.** Tree-vs-tree mode delegates to `diffTrees` and `domain/diff/line-diff`. Workdir-vs-index reads files via `internal/working-tree.readFile`.

**Binary detection** reuses `domain/diff/line-diff.isBinary(bytes): boolean` (already exported, scans the first `BINARY_DETECTION_BYTES` = 8000 bytes for NUL). If either side returns `true`, emit a `'binary'` entry without hunks. No new helper introduced.

**Errors.** `BARE_REPOSITORY` for `workdir-vs-index` mode. Propagated `OBJECT_NOT_FOUND` for missing oids.

**Edge cases.**
- Mode change without content change: emits a `'modified'` entry with empty hunks.
- File ≥ 2 GiB: emits `'binary'` (line-diff would OOM).
- Encoding: lines are decoded as UTF-8 with replacement chars; non-UTF-8 inputs are still diffable but lossy. Documented.

### 5.7 `branch`

```typescript
type BranchAction =
  | { readonly kind: 'list'; readonly remote?: boolean }
  | { readonly kind: 'create'; readonly name: string; readonly startPoint?: string; readonly force?: boolean }
  | { readonly kind: 'delete'; readonly name: string; readonly force?: boolean }
  | { readonly kind: 'rename'; readonly from: string; readonly to: string; readonly force?: boolean };

type BranchResult =
  | { readonly kind: 'list'; readonly branches: ReadonlyArray<BranchInfo> }
  | { readonly kind: 'created'; readonly name: RefName; readonly id: ObjectId }
  | { readonly kind: 'deleted'; readonly name: RefName }
  | { readonly kind: 'renamed'; readonly from: RefName; readonly to: RefName };

interface BranchInfo {
  readonly name: RefName;
  readonly id: ObjectId;
  readonly current: boolean;            // matches HEAD
  readonly upstream?: { readonly remote: string; readonly ref: RefName };
}

export function branch(ctx: Context, action: BranchAction): Promise<BranchResult>;
```

**Semantics.** Each subcommand is a small composition of primitive calls wrapped in validation:

- `list`: scan `refs/heads/` (or `refs/remotes/` if `remote`); group by ref directory. Reads `branch.<name>.merge` from `internal/config-read` to populate `BranchInfo.upstream`.
- `create`: resolve `startPoint` (default HEAD) → `updateRef(refs/heads/<name>, id, { expected: force ? undefined : 'absent' })`.
- `delete`: `updateRef(refs/heads/<name>, ..., { delete: true })`. Throws `CANNOT_DELETE_CHECKED_OUT_BRANCH` if `readHeadRaw` returns `{ kind: 'symbolic', target: refs/heads/<name> }`.
- `rename` (four steps with hand-rolled per-step rollback — no composite lock primitive):
  1. Resolve `from`'s oid via `resolveRef`.
  2. `updateRef(refs/heads/<to>, oid, { expected: force ? undefined : 'absent' })`.
  3. `updateRef(refs/heads/<from>, ..., { delete: true })`.
  4. **If the renamed branch is currently checked out** (HEAD's symref target was `refs/heads/<from>`): `writeSymbolicRef('HEAD', refs/heads/<to>)`. Otherwise HEAD is left alone.
  Failure modes: if step 3 fails after step 2 succeeded, the new branch exists with the old still alive — caller can re-run `branch delete --force`. If step 4 fails after steps 1–3, HEAD points at a non-existent branch (unborn) — recoverable via `branch create <to> <oid>`.

**Errors.** `BRANCH_EXISTS`, `BRANCH_NOT_FOUND`, `INVALID_REF`, `CANNOT_DELETE_CHECKED_OUT_BRANCH`.

### 5.8 `tag`

```typescript
type TagAction =
  | { readonly kind: 'list' }
  | { readonly kind: 'create'; readonly name: string; readonly target?: string; readonly message?: string; readonly force?: boolean }
  | { readonly kind: 'delete'; readonly name: string };

type TagResult =
  | { readonly kind: 'list'; readonly tags: ReadonlyArray<TagInfo> }
  | { readonly kind: 'created'; readonly name: RefName; readonly id: ObjectId; readonly annotated: boolean }
  | { readonly kind: 'deleted'; readonly name: RefName };

interface TagInfo {
  readonly name: RefName;
  readonly id: ObjectId;             // the tag object's id (annotated) or the target oid (lightweight)
  readonly target: ObjectId;         // peeled to non-tag
  readonly annotated: boolean;
}

export function tag(ctx: Context, action: TagAction): Promise<TagResult>;
```

**Semantics.**

- `list`: scan `refs/tags/`; for each, peel one level via `peelOneLevel` to detect annotated (the entry maps to a `tag` object) vs lightweight (commit/tree/blob directly).
- `create` lightweight (`message` absent): `updateRef(refs/tags/<name>, targetId, { expected: force ? undefined : 'absent' })`.
- `create` annotated (`message` present):
  1. Resolve tagger via the same fallback chain as commit author: `opts.tagger > ctx.config.user > AUTHOR_UNCONFIGURED`.
  2. Build the `Tag` object value (`{ object: targetId, type: targetType, tag: name, tagger, message }`) and pass through `domain/objects/tag.ts` `serializeTagContent` (the actual export — *not* `serializeTag`).
  3. `writeObject(ctx, { kind: 'tag', data: tagValue })` → `tagId`. `writeObject` accepts the `tag` variant of the `GitObject` discriminated union.
  4. `updateRef(refs/tags/<name>, tagId, { expected: force ? undefined : 'absent' })`.
- `delete`: `updateRef(refs/tags/<name>, ..., { delete: true })`.

**Errors.** `TAG_EXISTS`, `TAG_NOT_FOUND`, `INVALID_REF`, `AUTHOR_UNCONFIGURED` (annotated tags require tagger identity), `OBJECT_NOT_FOUND` (target doesn't exist).

### 5.9 `checkout`

```typescript
interface CheckoutOptions {
  /** Force overwrite of dirty working-tree files. Default: false. */
  readonly force?: boolean;
  /** Restrict to a subset of paths (partial checkout). */
  readonly paths?: ReadonlyArray<string>;
  /** Detach HEAD (do not update branch ref). Default: false. */
  readonly detach?: boolean;
}

interface CheckoutResult {
  readonly head: ObjectId;
  readonly branch?: RefName;
  readonly filesUpdated: number;
  readonly filesRemoved: number;
}

export function checkout(
  ctx: Context,
  target: string,
  opts?: CheckoutOptions,
): Promise<CheckoutResult>;
```

**Semantics.**

1. Resolve `target` (ref name or oid) → `targetId`.
2. Read the target tree (`readTree(ctx, targetId)`).
3. If `paths` is set, narrow to that subset via `walkTree` + filter.
4. Compute the working-tree diff between current HEAD's tree and target tree (reusing `diffTrees`).
5. If any file in the diff is dirty in the working tree AND `!force`, throw `CHECKOUT_OVERWRITE_DIRTY` with the dirty paths (no partial application — atomic).
6. Apply changes: `materializeFile` for added/modified, `removeFile` for deleted.
7. Update the index to match the target tree.
8. Update HEAD:
   - If `detach === true`: `updateRef('HEAD', targetId, { expected: undefined })` — direct oid.
   - Else if `target` resolved to a branch (e.g., `refs/heads/main`): `writeSymbolicRef(ctx, 'HEAD', refs/heads/<branch>)` (new primitive — see §10.1).
   - Else if `target` was an oid or tag (no branch backing): force-detach by writing the oid directly. Document that this is intentional — checking out a tag is detached HEAD, matching Git's behavior.

**Errors.** `CHECKOUT_OVERWRITE_DIRTY`, `BARE_REPOSITORY`, `REF_NOT_FOUND` (when target is a branch that doesn't exist).

**Edge cases.**
- Switching to a branch that doesn't exist with `target` matching `<remote>/<branch>` pattern: NOT auto-created in v1 (Git's `--track` behavior). Caller must `branch create` first.
- Crashed mid-write: working tree is in an inconsistent state. v1 does not provide auto-recovery; user re-runs `checkout`. v2 may add a write-log.

### 5.10 `clone`

```typescript
interface CloneOptions {
  /** Target directory. Default: ctx.cwd. */
  readonly target?: FilePath;
  /** Branch to checkout after fetch. Default: server's HEAD symref target. */
  readonly branch?: string;
  /** Bare clone (no working tree). Default: false. */
  readonly bare?: boolean;
  /** Authentication. */
  readonly auth?: AuthConfig;
  /** Number of commits to fetch (shallow). Default: undefined (full clone). */
  readonly depth?: number;
  /** Logger override. Default: ctx.logger. */
  readonly logger?: Logger;
}

interface CloneResult {
  readonly path: FilePath;
  readonly head: ObjectId;
  readonly branch: RefName;
  readonly objectCount: number;
  readonly bytesReceived: number;
}

export function clone(ctx: Context, url: string, opts?: CloneOptions): Promise<CloneResult>;
```

**Semantics.** Sequential phases:

1. **Validate URL** (`internal/url-validate`) — produces `ValidatedUrl`.
2. **Validate target.** If `target` exists and is non-empty → `TARGET_DIRECTORY_NOT_EMPTY`. Else `mkdir(target)` and record `didCreateTarget = true`.
3. **Bootstrap repository** at `target` via `internal/bootstrap.bootstrapRepository(ctx, { initialBranch: opts.branch ?? <discovered HEAD>, bare })` — same helper `init` uses. Records `didCreateGitDir = true` once `.git/` is in place.
4. **Discovery** (`buildDiscoveryUrl` + `network-pipeline.request(GET)` → `parseAdvertisedRefs`). If `advertisement.refs.length === 0` → `REMOTE_ADVERTISES_NO_REFS`.
5. **Read pack header.** Before draining the pack body, peek the first 12 bytes (zero-indexed half-open ranges):
   - `[0, 4)` — signature (must equal `'PACK'`).
   - `[4, 8)` — pack-format version (big-endian uint32, must be `2` or `3`).
   - `[8, 12)` — object count (big-endian uint32).
   If `objectCount > MAX_OBJECTS_PER_PACK` (default `50_000_000`, configurable via `ctx.config.maxObjectsPerPack`) → `PACK_TOO_LARGE` with `{ objectCount, limit }`.
6. **Negotiate.** Build `WantHaveRequest` with all advertised refs as wants, no haves (full clone). For shallow (`opts.depth`), add `deepen <n>` (Phase 8 §6.2 already supports this single-shot variant).
7. **Fetch pack.** `network-pipeline.request(POST)` → `parseUploadPackResponse` → drain `packBody` into `parsePackfile` (Phase 2) → `writeObject` for every yielded object. Bounded concurrency `min(ctx.config.parallelism ?? 8, 32)` parallel writes.
8. **Update refs.** Write **every** advertised ref → `refs/remotes/origin/<name>` (or `<remote>` if user specified). Write `refs/heads/<branch>` for **only** the checked-out branch (resolved as `opts.branch ?? advertisement.head.target`). Write `HEAD` via `writeSymbolicRef('HEAD', refs/heads/<branch>)`.
9. **Checkout** the branch via internal checkout helper.
   - If `!bare`: materialize working tree from the checked-out branch's tree.
   - If `bare`: SKIP working-tree materialization; SKIP `refs/heads/*` writes; only `refs/<name>` is populated for every advertised ref. HEAD is written as a symref to whatever the server's HEAD pointed at (e.g., `ref: refs/heads/main`); if the server's HEAD is missing, fall back to `ref: refs/heads/<opts.branch ?? 'main'>`.

**Object integrity.** Every object received is hashed by `writeObject` (already does sha verification). A pack-level check (the trailer SHA-1) is performed by `parsePackfile`. Any mismatch aborts the clone with the rollback procedure below.

**Rollback on failure.** Tracked precisely:

- If `didCreateGitDir`: recursive remove of `<target>/.git`.
- If `didCreateTarget`: recursive remove of `<target>` after the `.git` removal.
- Recursive removal uses a new `FileSystem.rmRecursive(path)` port method (added Phase 9 — see §10.1) — NOT `fs.rmdir(.git, { recursive: true })` (that flag is Node-specific; the port is platform-agnostic).
- If neither flag is set, no removal is attempted (pre-existing files survive).

**Errors.** `TARGET_DIRECTORY_NOT_EMPTY`, `INVALID_URL`, `BLOCKED_HOST`, `UNSUPPORTED_SCHEME`, `TOO_MANY_REDIRECTS`, `REMOTE_ADVERTISES_NO_REFS`, `PACK_TOO_LARGE`, plus all transport / object errors.

**Cancellation.** `ctx.signal.aborted` triggers mid-clone runs the same scoped rollback before rejecting with `OPERATION_ABORTED`.

### 5.11 `fetch`

```typescript
interface FetchOptions {
  readonly remote?: string;             // default 'origin'
  readonly refspecs?: ReadonlyArray<string>;
  readonly auth?: AuthConfig;
  readonly prune?: boolean;             // remove deleted upstream branches
  readonly depth?: number;              // shallow extension
}

interface FetchResult {
  readonly updated: ReadonlyArray<{ readonly ref: RefName; readonly oldId?: ObjectId; readonly newId: ObjectId }>;
  readonly pruned: ReadonlyArray<RefName>;
  readonly objectCount: number;
  readonly bytesReceived: number;
}

export function fetch(ctx: Context, opts?: FetchOptions): Promise<FetchResult>;
```

**Semantics.**

1. Resolve `remote` to URL via `internal/config-read` (`remote.<name>.url`).
2. Validate URL → `ValidatedUrl`.
3. Discovery → advertised refs.
4. Compute `wants` = refs we don't have (or have older versions of). Compute `haves` = our local commits reachable from `refs/remotes/<remote>/*`, capped at `MAX_HAVES = 256` most-recent commits (matches isomorphic-git). The cap may cause the server to send objects we already have — fine, write/dedup is idempotent.
5. **Single-round negotiation.** Send all wants + the capped haves in one `git-upload-pack` POST. The server replies with the smallest pack it can compute. v1 does NOT support multi-round protocol-v0 negotiation — reduces complexity and matches the Phase 8 transport surface (single-shot `parseUploadPackResponse`). Multi-round is a v2 obligation, requiring a per-round `RequestBuilder` from Phase 8.
6. Read pack header, enforce `MAX_OBJECTS_PER_PACK` (same as clone §5.10 step 5).
7. Receive pack, write objects (bounded concurrency).
8. Apply refspecs (see below) to update `refs/remotes/<remote>/` (and any explicit user refspecs).
9. If `prune`, delete remote-tracking refs that no longer exist in the advertisement.

**Refspec parsing** (`internal/ref-spec.ts`):

- `refs/heads/*:refs/remotes/origin/*` (default fetch refspec)
- `+refs/heads/main:refs/remotes/origin/main` (force update with `+`)
- Validation: each side must be a valid ref pattern (`validateRefName` per component); the LHS may include `*` only at the end of a path component (matches Git's "wildcard refspec" rules).
- Hard cap: `MAX_REFSPECS_PER_FETCH = 1024` and `MAX_REFSPECS_PER_PUSH = 1024` (defined in `internal/ref-spec.ts`, referenced from §8 caps table).

**Errors.** Same as `clone` plus `REFSPEC_INVALID` (raised from `domain/protocol/error.ts` per §4.2).

### 5.12 `push`

```typescript
interface PushOptions {
  readonly remote?: string;             // default 'origin'
  readonly refspecs?: ReadonlyArray<string>;
  readonly force?: boolean;             // override fast-forward check (unconditional)
  /**
   * Force-with-lease: only force-push if the remote ref is what we expect.
   *  - 'auto'        → expected oid = local refs/remotes/<remote>/<ref>
   *  - <ObjectId>    → expected oid = the explicit value
   *  - undefined     → no lease (default)
   * Mutually exclusive with `force`. Lease check uses the discovered
   * advertised oid: if it differs from `expected`, the push is rejected
   * with NON_FAST_FORWARD even when `force === true` is also set
   * (lease wins — the safer behavior).
   */
  readonly forceWithLease?: ObjectId | 'auto';
  readonly auth?: AuthConfig;
}

interface PushResult {
  readonly accepted: ReadonlyArray<{ readonly ref: RefName; readonly oldId: ObjectId; readonly newId: ObjectId }>;
  readonly rejected: ReadonlyArray<{ readonly ref: RefName; readonly reason: string }>;
}

export function push(ctx: Context, opts?: PushOptions): Promise<PushResult>;
```

**Semantics.**

1. Resolve `remote` URL via `internal/config-read`.
2. Discovery → advertised remote refs (provides `oldId` for each ref we plan to update).
3. For each refspec, compute local `newId` and remote `oldId`. The matrix:

   | `force` | `forceWithLease` | Lease check | FF check | Outcome |
   |---|---|---|---|---|
   | false | undefined | — | runs | FF or reject |
   | true | undefined | — | skipped | always accept |
   | false | set | runs | runs after lease | both must pass |
   | true | set | runs | skipped | lease must pass; FF skipped |

   Concrete steps:
   - If `forceWithLease` is set: `expected = forceWithLease === 'auto' ? readLocalRemoteRef(refs/remotes/<remote>/<ref>) : forceWithLease`. If `oldId !== expected` → `NON_FAST_FORWARD`. **The lease wins** — a passing lease never bypasses the FF check; a failing lease aborts even when `force === true`.
   - Else if `force === true`: no checks, accept.
   - Else: compute `mergeBase(oldId, newId)` via the new `mergeBase` primitive; if `mergeBase !== oldId` (i.e., `oldId` not ancestor of `newId`) → `NON_FAST_FORWARD`.
4. Build a packfile of objects reachable from `newId` but not from `oldId` (uses `walkCommits` + `walkTree` to enumerate, dedup via `Set<ObjectId>` capped at `MAX_PACK_OBJECTS = 16_000_000`). Use thin-pack only when the server advertises `thin-pack`.
5. Build the `ReceivePackRequest` (one update line per ref + the packfile). Hard cap: `MAX_REFSPECS_PER_PUSH = 1024` updates per request.
6. POST the request through `network-pipeline`. Parse the report-status response via Phase 8's `parseReceivePackResponse`.
7. For each rejected ref in the response, surface a `PUSH_REJECTED` carrying the full `ReportStatus` payload (per §4.2 — structured, not just a string).
8. Update local `refs/remotes/<remote>/` to mirror what was accepted.

**Errors.** `NON_FAST_FORWARD`, `PUSH_REJECTED`, plus URL validation and transport errors.

### 5.13 `merge`

```typescript
interface MergeOptions {
  readonly source: string;              // ref or oid to merge into HEAD
  readonly message?: string;            // default: 'Merge <source>'
  readonly strategy?: 'recursive';      // only one strategy in v1
  readonly noFastForward?: boolean;     // force a merge commit even on FF
  readonly noCommit?: boolean;          // leave the merge in the index, don't commit
  readonly author?: AuthorIdentity;
  readonly committer?: AuthorIdentity;
}

type MergeResult =
  | { readonly kind: 'fast-forward'; readonly oldHead: ObjectId; readonly newHead: ObjectId }
  | { readonly kind: 'commit'; readonly id: ObjectId; readonly tree: ObjectId; readonly parents: ReadonlyArray<ObjectId> }
  | { readonly kind: 'conflicts'; readonly count: number; readonly paths: ReadonlyArray<FilePath> }
  | { readonly kind: 'up-to-date'; readonly head: ObjectId };

export function merge(ctx: Context, opts: MergeOptions): Promise<MergeResult>;
```

**Semantics.**

1. Resolve `source` and HEAD.
2. Compute merge base via the **new `mergeBase(ctx, a, b)` primitive** (see §10.1). Implementation lives in `src/application/primitives/merge-base.ts` and is reused by `status` (`ahead`/`behind`) and `push` (ancestor check). The algorithm is a simple bidirectional walk with two `Set<ObjectId>` visited markers and a frontier-intersection test — yields the first commit visited from both sides. Documented limitation: cherry-picks and criss-cross merges may yield non-optimal bases. v2 adds `recursive`-strategy multi-base resolution.
3. If base === source.id → `'up-to-date'` (nothing to do).
4. If base === HEAD.id AND `!noFastForward` → fast-forward: advance HEAD via `writeSymbolicRef` (or direct write if detached), update the working tree via the same materialization helper `checkout` uses, no commit.
5. Else three-way merge via `domain/merge/three-way-merge.ts`:
   - Read three trees: base (`mergeBase` → `readObject` → `commit.tree`), ours (HEAD), theirs (source). When base is undefined (unrelated histories): use **`EMPTY_TREE_OID`** (new constant in `domain/objects/object-id.ts`, value `4b825dc642cb6eb9a060e54bf8d69288fbee4904`, the well-known empty-tree oid). The two-root merge produces a tree containing the union of both sides (everything appears as added on the side that has it).
   - Run `mergeTrees` (Phase 5 §15.4).
   - Apply the resulting tree to the index AND working tree.
   - If conflicts: write conflict markers, leave the index in unmerged state, return `'conflicts'`.
   - Else: build a merge commit (parents = [HEAD, source]), update HEAD, return `'commit'`.

**Conflict marker label sanitization.** The `<<<<<<<`/`>>>>>>>` markers embed the source label. The label is sanitized via `internal/commit-message.sanitizeMarkerLabel(input)`:
- Strip CR (`\r`).
- Replace LF (`\n`), TAB (`\t`), NUL, and any byte outside `0x20`–`0x7E` with the `\xNN` hex escape (consistent with `wrapLoggerSanitizer` — distinguishable from real characters, no shell-glob ambiguity).
- Truncate to 200 bytes.

This prevents a malicious branch name like `HEAD\n<<<<<<< HEAD` from injecting fake conflict markers into the file (CWE-116).

**Errors.** `MERGE_HAS_CONFLICTS` (only when called twice without resolution — first call returns the `'conflicts'` variant; second call sees unmerged index entries), `WORKING_TREE_DIRTY` (refuses to overwrite uncommitted changes).

**Edge cases.**
- `source` is HEAD: returns `'up-to-date'`.
- `source` is HEAD's ancestor: returns `'up-to-date'`.
- `source` is on an unrelated history (no common ancestor): `mergeBase` returns `undefined`; merge proceeds with `EMPTY_TREE_OID` per step 5. Documented as legal.

---

### 5.14 `rm`

```typescript
interface RmOptions {
  /** Remove from index only (leave the working file alone). Default: false. */
  readonly cached?: boolean;
  /** Recurse into directories. Default: false (must be set when paths include dirs). */
  readonly recursive?: boolean;
  /** Stale-lock recovery threshold (ms). Default: undefined (no auto-recovery). */
  readonly breakStaleLockMs?: number;
}

interface RmResult {
  readonly removedFromIndex: ReadonlyArray<FilePath>;
  readonly removedFromWorkdir: ReadonlyArray<FilePath>;
}

export function rm(
  ctx: Context,
  paths: ReadonlyArray<string>,
  opts?: RmOptions,
): Promise<RmResult>;
```

**Semantics.**

1. Validate every path (same `internal/working-tree.validatePath` as `add`).
2. Acquire `.git/index.lock`.
3. For each resolved path:
   - If absent in the index → `PATHSPEC_NO_MATCH`.
   - If `cached === false` AND working-tree file differs from the index entry → `WORKING_TREE_DIRTY` for that path (no partial removal).
   - Otherwise: remove from index (`internal/index-update`); if `!cached` also `removeFile` from disk.
4. Atomically write the new index + release the lock.

**Errors.** `PATHSPEC_NO_MATCH`, `WORKING_TREE_DIRTY`, `RESOURCE_LOCKED`, `BARE_REPOSITORY`.

### 5.15 `reset`

```typescript
type ResetMode = 'soft' | 'mixed' | 'hard';

interface ResetOptions {
  readonly mode?: ResetMode;            // default 'mixed'
  readonly breakStaleLockMs?: number;
}

interface ResetResult {
  readonly previousHead: ObjectId;
  readonly newHead: ObjectId;
  readonly mode: ResetMode;
}

export function reset(
  ctx: Context,
  target: string,
  opts?: ResetOptions,
): Promise<ResetResult>;
```

**Semantics.**

1. Resolve `target` → `targetId` via `internal/rev-parse-grammar.parse(ctx, target)` (NOT the `revParse` command — intra-tier rule). The same internal helper also powers `revParse.ts`. Supports `HEAD~3`, `HEAD^2`, `<sha-prefix>`, plain refs.
2. Read current HEAD.
3. Move HEAD to `targetId`:
   - Symbolic HEAD: `updateRef(<branch>, targetId, { expected: previousHead })`.
   - Detached: `updateRef('HEAD', targetId, { expected: previousHead })`.
4. **`'soft'`**: stop here. Index and working tree unchanged.
5. **`'mixed'`** (default): also reset the index to match `targetId`'s tree. Working tree unchanged.
6. **`'hard'`**: also overwrite working-tree files to match `targetId`'s tree. Uses the same materialization helper as `checkout`. Loses uncommitted changes — no `--force` needed (hard's contract is destructive).

**Errors.** `BARE_REPOSITORY` (mode `mixed`/`hard`), `REF_UPDATE_CONFLICT` (HEAD changed concurrently), `RESOURCE_LOCKED` (index lock for `mixed`/`hard`).

### 5.16 `revParse`

```typescript
export function revParse(ctx: Context, expression: string): Promise<ObjectId>;
```

**Semantics.** Parses git revision expressions and resolves to an `ObjectId`. Supported grammar (`internal/rev-parse-grammar.ts`):

- Plain refs: `HEAD`, `main`, `refs/heads/main`, `refs/tags/v1`, `origin/main`.
- Short oid prefixes: `abc1234` (≥ 7 hex chars). Ambiguity throws `REVPARSE_AMBIGUOUS` with all candidates.
- Parent navigation: `HEAD~3` (third grandparent), `HEAD^` (first parent), `HEAD^2` (second parent of a merge), `HEAD^^^` (= `HEAD~3`).
- Tree/blob peeling: `HEAD^{tree}`, `HEAD^{commit}` (no-op if already a commit).
- Index references: `:0:<path>` resolves the staged blob at `<path>` (stage 0). `:1:`/`:2:`/`:3:` for unmerged stages.

NOT supported in v1: `<ref>@{N}` (reflog navigation — no reflog), `<ref>@{date}`, `^{}` peeling (use `^{commit}` explicitly), `:/regex` log search.

**Corrupt-repo behavior.** When traversal hits a missing object (e.g., `HEAD~3` and the third grandparent is absent from storage), `OBJECT_NOT_FOUND` propagates verbatim — NOT wrapped as `REVPARSE_UNRESOLVED`. The caller distinguishes "expression syntactically invalid" (`REVPARSE_UNRESOLVED`) from "expression valid but pointed at a missing object" (`OBJECT_NOT_FOUND`).

**Errors.** `REVPARSE_UNRESOLVED` (no matching ref or oid), `REVPARSE_AMBIGUOUS`, `REF_NOT_FOUND`, `OBJECT_NOT_FOUND`.

---

## 6. `tsgit/commands` Public Surface

```typescript
// src/application/commands/index.ts
export { add } from './add.js';
export { branch } from './branch.js';
export { checkout } from './checkout.js';
export { clone } from './clone.js';
export { commit } from './commit.js';
export { diff } from './diff.js';
export { fetch } from './fetch.js';
export { init } from './init.js';
export { log } from './log.js';
export { merge } from './merge.js';
export { push } from './push.js';
export { reset } from './reset.js';
export { revParse } from './rev-parse.js';
export { rm } from './rm.js';
export { status } from './status.js';
export { tag } from './tag.js';

export type {
  AddOptions, AddResult,
  BranchAction, BranchInfo, BranchResult,
  CheckoutOptions, CheckoutResult,
  CloneOptions, CloneResult,
  CommitOptions, CommitResult,
  CommandError,
  DiffEntry, DiffHunk, DiffMode, DiffOptions,
  FetchOptions, FetchResult,
  FileStatus,
  InitOptions, InitResult,
  LogEntry, LogOptions,
  MergeOptions, MergeResult,
  PushOptions, PushResult,
  ResetMode, ResetOptions, ResetResult,
  RmOptions, RmResult,
  StatusOptions, StatusReport,
  TagAction, TagInfo, TagResult,
} from './types.js';
```

`package.json` adds 17 export entries: one barrel (`./commands`) and one per command (`./commands/init`, `./commands/add`, ..., `./commands/rev-parse`):

```json
"./commands": { /* full ESM/CJS dual entry */ },
"./commands/init": { /* per-command tree-shake-friendly entry */ },
// ... 15 more
```

**Build wiring.** `rollup.config.ts` adds 16 entries to its `input` map (one per command). Each becomes a self-contained chunk; the barrel re-exports without dragging unused chunks. A new size-limit budget per command (1.5 kB gzipped each, allocated from the §1 28 kB total) is enforced via `.size-limit.json` entries — fewer per-command-bytes encourages composition over duplication.

**Why per-command entries?** Bundlers that don't tree-shake aggressively (older webpack, esbuild without `treeshake: 'recommended'`) pay full barrel cost otherwise. Per-command entries let a user importing only `tsgit/commands/init` ship ~1.5 kB instead of ~20 kB.

**Maintenance.** Adding a new command requires four file edits: the file itself, the barrel, `rollup.config.ts`, `.size-limit.json`. A `scripts/check-commands-wiring.ts` test fails if any of the four falls out of sync.

---

## 7. Testing Strategy

### 7.1 Layers

| Layer | What | Tools |
|---|---|---|
| Unit | Each command in isolation against memory FS + memory transport | vitest |
| Integration | Command pipelines (init → add → commit → status) | vitest with seeded fixtures |
| Property | Refspec parser, URL validator | fast-check |
| Real-server | Smoke tests against a local `git http-backend` over loopback | Phase 11 |

Phase 9 ships ONLY the first three layers. Real-server tests are Phase 11.

### 7.2 Fixtures

`test/unit/application/commands/fixtures.ts` provides:

- `seedRepo(ctx, builder)` — declarative repo construction (commits, refs, working-tree files, index entries, remote advertisements).
- `memoryRemote(advertisements, packBody)` — a memory transport that responds to discovery + upload-pack with the given fixture.
- `recordedTransport()` — captures requests for assertion.

### 7.3 Mutation testing targets

| Module | Score |
|---|---|
| `internal/url-validate.ts` | 100% (security boundary) |
| `internal/ref-spec.ts` | 100% (parser) |
| `internal/rev-parse-grammar.ts` | 100% (parser) |
| `internal/config-read.ts` | ≥ 95% (parser) |
| `internal/repo-state.ts` | ≥ 95% |
| `internal/bootstrap.ts` | ≥ 90% |
| `internal/working-tree.ts` | ≥ 95% (security boundary) |
| `internal/network-pipeline.ts` | ≥ 95% (security boundary) |
| `init.ts`, `branch.ts`, `tag.ts`, `revParse.ts` | ≥ 95% |
| `commit.ts`, `merge.ts`, `reset.ts` | ≥ 95% |
| `add.ts`, `rm.ts`, `status.ts`, `checkout.ts`, `diff.ts`, `log.ts` | ≥ 90% |
| `clone.ts`, `fetch.ts`, `push.ts` | ≥ 90% (network paths require harness assistance) |

### 7.4 Test conventions

Inherited from CLAUDE.md: Given/When/Then titles, AAA bodies, `sut`. Error assertions use `try/catch` + `.data.code` + payload checks. Boundary triples for caps (`maxRedirects`, `MAX_WALK_QUEUE_SIZE` reused, `MAX_REFSPECS_PER_PUSH = 1024`).

---

## 8. Performance Considerations

| Operation | Concern | Mitigation |
|---|---|---|
| `add` 10K files | Sequential hashing | Parallel writeObject up to `parallelism` (default 8) |
| `status` on linux.git | `lstat` per working-tree file | Stat-cache via index (Phase 3 §3.7); only re-hash when stat doesn't match |
| `log` with `--grep` over 100K commits | Predicate cost | Cheap filters (date, author) before message regex |
| `clone` of 1 GB repo | Memory pressure | Streaming pack parsing + bounded write concurrency; never holds whole pack in memory |
| `push` of 1K commits | Object enumeration | `walkCommits` + dedup via `Set<ObjectId>` (capped at 16M oids = ~640 MB max, throws if exceeded) |
| `checkout` of 100K files | Sequential writes | Parallel materialize up to `parallelism`; same cap |
| `merge` with 10K conflicting files | Three-tree comparison | `mergeTrees` already streams; conflict count cap at 100K (throws — repository likely needs manual rebase) |

The single shared `parallelism` knob (`ctx.config.parallelism`, default 8, max 32) governs concurrent FS operations. Network operations are sequential by default (one in-flight request per command); transport-level retries do not count against parallelism.

---

## 9. Open Questions and v2 Deferrals

### v2 commands explicitly deferred (with rationale)

- `mv` — composition of `rm` + `add`; users can implement in <10 lines until then.
- `restore` / `switch` — modern split of `checkout`. v1 ships only `checkout` covering both surfaces (state-restore + branch-switch).
- `show` / `cat-file` / `ls-files` / `ls-tree` — readers. Largely covered by `revParse` + `readObject` from Phase 7. Public commands are convenience wrappers that v2 adds.
- `remote` (add/remove/list) — depends on `config` writes. Multi-remote workflows in v1 require manual `.git/config` editing.
- `config` (get/set) — read-only `internal/config-read.ts` ships in v1; writes are v2.
- `stash` — depends on a separate `refs/stash` log + index snapshotting. v2.
- `pull` — composition of `fetch + merge`. Hooks (`post-merge`) and conflict-resume make this a multi-decision API; explicit `fetch` + `merge` is safer for v1.
- `rebase` / `cherry-pick` / `revert` / `bisect` / `blame` — non-trivial algorithms. v2.

### Open design questions

1. **Reflog.** v1 does not write `.git/logs/refs/...`. Adding it later is additive (no breaking change). The Phase 10 facade may grow a `reflog: true` opt-in to wire `updateRef` to a reflog writer.
2. **Hooks.** v1 skips. The design intentionally has no hook-call points so wiring them later is purely additive — Phase 10 may expose a `ctx.hooks?: HookHost` extension.
3. **`merge --strategy=ours` / `theirs`.** Out of scope; only `recursive` ships.
4. **Sparse-checkout / partial-clone.** Out of scope. `--depth` ships as a single-shot `deepen <n>` (Phase 8 §6.2 already supports this); deepening (`--deepen` / `--unshallow`) is v2 because it requires multi-round negotiation.
5. **Symref-pointing-at-symref.** Git allows `HEAD → symref-foo → refs/heads/main`. v1 follows the chain in `resolveRef` (Phase 7 cap `maxSymbolicDepth = 5`); writing such a chain is currently NOT supported by `writeSymbolicRef` (single-level only). Documented as a v2 nice-to-have.

---

## 10. Phase Ownership

### 10.1 New artifacts (cross-cutting)

**Phase 7 amendment — primitives (the implementation plan must amend `docs/design/primitives.md` Round 5):**

| Primitive | Signature | Used by | Algorithm note |
|---|---|---|---|
| `mergeBase(ctx, a, b)` | `Promise<ObjectId \| undefined>` (undefined = unrelated histories) | `merge`, `status` (`ahead`/`behind`), `push` (FF check) | Bidirectional walk with two `Set<ObjectId>` visited markers + frontier-intersection. Returns the FIRST commit visited from both sides. Octopus / criss-cross merges may yield non-optimal bases — documented limitation. v2 returns `ReadonlyArray<ObjectId>` for `recursive` strategy. |
| `writeSymbolicRef(ctx, name, target)` | `Promise<void>` — writes `ref: <target>\n` atomically (lock + fsync + rename) | `commit`, `checkout` (non-detach), `branch rename` (current branch), `merge`, `clone` | Single-level only in v1 (no symref-pointing-at-symref). |
| `getRepoRoot(ctx)` | `Promise<FilePath>` — walks upward from `ctx.cwd` | every command + every primitive | Cached on `ctx` via the existing path-layout helper. |

The Phase 9 implementation plan amends Phase 7's design + adds the implementation in the same PR. Phase 7's size budget is bumped from 8 kB → 9 kB to absorb the additions.

**`status` ahead/behind constraint.** v1 supports a single configured upstream (`ctx.config.upstreamRef`). Octopus upstreams are v2.

**Domain modules:**

| Module | Purpose |
|---|---|
| `domain/repository/error.ts` | `RepositoryError` union (`NOT_A_REPOSITORY`, `BARE_REPOSITORY`, `ALREADY_INITIALIZED`) |
| `domain/ignore/parse-gitignore.ts` | `IgnoreRuleset` parser |
| `domain/ignore/match.ts` | `matches(ruleset, path)` |

**Domain constants:**

| Symbol | Module | Value |
|---|---|---|
| `EMPTY_TREE_OID` | `domain/objects/object-id.ts` | `'4b825dc642cb6eb9a060e54bf8d69288fbee4904' as ObjectId` |

**Port additions:**

| Port | Member | Signature | Contract |
|---|---|---|---|
| `FileSystem` | `rmRecursive` | `(path: string) => Promise<void>` | Recursively removes file/dir tree at `path`. Idempotent on missing path (returns void). **Does NOT follow ANY symlink during traversal** — when a directory entry's `lstat` shows it is a symlink, removes the symlink itself (not its target) and stops descent at that point. Closes mid-path traversal vector during clone rollback (a malicious or concurrent process replacing `objects/pack/` with a symlink). Throws `PERMISSION_DENIED` on EACCES. |
| `FileSystem` | `openWithNoFollow` | `(path: string, mode: 'read' \| 'write') => Promise<FileHandle>` | Opens with `O_NOFOLLOW` on POSIX (Node node:fs). On platforms without the flag (browser OPFS), throws `UNSUPPORTED_OPERATION` so callers know to fall back to the realpath check. |
| `FileHandle` (new interface) | `read`/`write`/`close`/`stat` | matches Node's `FileHandle` subset | Phase 9-owned subset. Implementations: Node (wraps `fs.FileHandle`), memory, browser (throws on `openWithNoFollow`). |

**`materializeFile` uses the port.** §4.6 calls `ctx.fs.openWithNoFollow(dst, 'write')` on POSIX paths — never `fs.open` directly (commands cannot import `node:fs`).

**Dep-cruiser rules:**

- `commands-cannot-import-each-other` — `application/commands/<X>.ts` cannot import `application/commands/<Y>.ts` for `X !== Y`. Exempts `application/commands/internal/`.
- `commands-cannot-import-adapters` — extends Phase 7's primitive rule.
- `internal-modules-cannot-be-exported` — `application/commands/internal/*` must NOT appear in any `package.json` export.
- `domain-repository-error-is-leaf` — `domain/repository/error.ts` may import only `domain/objects/object-id` (for `FilePath`) — no other domain modules. Prevents circular cross-imports.

**Size-limit budgets (`.size-limit.json`):**

- `Commands (barrel)` — 28 kB gzipped (estimate 22 kB; consistent with §1).
- 16 per-command entries — 1.5 kB gzipped each.

**Caps (constants in respective `internal/*` modules):**

- `MAX_OBJECTS_PER_PACK = 50_000_000` (clone/fetch)
- `MAX_PACK_OBJECTS = 16_000_000` (push enumeration)
- `MAX_HAVES = 256` (single-round fetch)
- `MAX_REFSPECS_PER_PUSH = 1024`
- `MAX_REFSPECS_PER_FETCH = 1024`

`DEFAULT_RETRY` is defined inline in §4.7 (its only consumer); not duplicated here.

**`bootstrapRepository(ctx, opts)` API.**

```typescript
interface BootstrapOptions {
  readonly initialBranch: string;       // validated via validateRefName
  readonly bare: boolean;
  readonly hash?: 'sha1';               // future: 'sha256'
}

interface BootstrapResult {
  readonly gitDir: FilePath;
  readonly initialBranch: RefName;
  readonly bare: boolean;
}

export function bootstrapRepository(
  ctx: Context,
  opts: BootstrapOptions,
): Promise<BootstrapResult>;
```

Both `init` and `clone` call this with options derived from their own inputs. The helper creates the directory structure (objects/info, objects/pack, refs/heads, refs/tags, info/, HEAD, config, info/exclude, description) atomically — all-or-nothing via temp-dir + rename. On any error, `rmRecursive` undoes whatever was created.

**`domain/ignore` module API.**

```typescript
// domain/ignore/parse-gitignore.ts
export interface IgnoreRule {
  readonly pattern: string;             // original input (for diagnostics)
  readonly negated: boolean;             // starts with '!'
  readonly directoryOnly: boolean;       // ends with '/'
  readonly anchored: boolean;            // contains '/' before any '*'
  readonly compiled: RegExp;             // matcher
}

export type IgnoreRuleset = ReadonlyArray<IgnoreRule>;

/**
 * Parse `.gitignore` content into a ruleset. Blank lines and lines starting
 * with `#` are skipped (per Git semantics). Trailing whitespace is preserved
 * unless escaped. Last-matching rule wins at lookup time.
 */
export function parseGitignore(text: string): IgnoreRuleset;

// domain/ignore/match.ts
export type MatchResult = 'ignored' | 'unignored' | 'unset';

export function matches(
  rules: IgnoreRuleset,
  path: FilePath,
  isDir: boolean,
): MatchResult;
```

`matches` returns `'unset'` when no rule applies — caller decides default (e.g., `add` treats `'unset'` as included).

**Type definitions (`commands/types.ts`):**

```typescript
import type { ReportStatus } from '../../../domain/protocol/receive-pack.js';
// Used by CommandError.PUSH_REJECTED.
```

### 10.2 Delegation

This phase delegates to:

- Phase 7 primitives for all object/ref I/O.
- Phase 8 transport for all HTTP.
- Phase 5 / 6 for diff / merge / operators.

### 10.3 Deferred to Phase 10

- Auth resolution from `ctx.config` (Phase 10 freezes config and wires real auth).
- Final per-command export entry validation in `package.json` (Phase 10 ships the `tsgit/commands/<name>` resolution).

### 10.4 Deferred to Phase 11

- Hooks, reflog.
- Real-server integration tests (Playwright + local `git http-backend`).
- Submodules.
- Cross-platform symlink fallback validation (Windows specifically).
- Multi-round fetch negotiation, `--deepen` / `--unshallow`.

### 10.5 Implementation step ordering

The Plan doc breaks this list into TDD red→green→refactor steps.

| Step | What | Why first |
|---|---|---|
| 0 | **Phase 7 amendment commit** — `mergeBase` + `writeSymbolicRef` + `getRepoRoot` + `EMPTY_TREE_OID` + amend `docs/design/primitives.md` (8 → 9 kB budget) in a SINGLE PR | Phase 9 cannot start until these primitives exist on main |
| 1 | Error scaffold — widen `TsgitErrorData` with `RepositoryError` + `CommandError` + 30 `extractDetail` arms + 30 factories + tests (mirrors Phase 8 §1) | Step 2+ test files import these factories from line 1 |
| 2 | Domain modules — `domain/repository/error.ts`, `domain/ignore/parse-gitignore.ts`, `domain/ignore/match.ts` | Pure-domain, no dependencies; can run in parallel |
| 3 | `FileSystem` port additions (`rmRecursive`, `openWithNoFollow`) + node/memory/browser adapters + tests | Required by `internal/working-tree` and `clone` rollback |
| 4 | Shared `internal/*` modules — `repo-state`, `working-tree`, `index-update`, `bootstrap`, `url-validate`, `ref-spec`, `network-pipeline`, `commit-message`, `rev-parse-grammar`, `config-read` | Every command consumes some subset |
| 5 | `init` | Dependency-free among commands; first end-to-end command |
| 6 | `revParse` | Used by `reset`, `log`, `merge` for ref resolution |
| 7 | `add`, `rm` | Index-mutating but no commit semantics |
| 8 | `commit` | Builds on `add` semantics + `writeTree` + `createCommit` |
| 9 | `branch`, `tag` | Ref management; depends on `commit` for tests |
| 10 | `reset` | Depends on `revParse` + index manipulation |
| 11 | `checkout` | Working-tree materialization; consumed by `reset --hard` and `merge` |
| 12 | `status` | Read-only; depends on every prior to seed fixtures |
| 13 | `log`, `diff` | Read-only; depend on `commit` for fixtures |
| 14 | `merge` | Depends on `mergeBase` + `mergeTrees` + `commit` |
| 15 | `clone` | Depends on `bootstrap` + transport + `checkout` |
| 16 | `fetch` | Depends on `clone`-tested transport |
| 17 | `push` | Depends on `mergeBase` + transport |
| 18 | Wiring — `rollup.config.ts` (16 entries), `.size-limit.json`, `package.json` exports, dep-cruiser rules | Last — once all command modules exist |
| 19 | Mutation testing + parallel reviews + squash-merge | Phase 8 precedent |

The Plan doc may parallelize steps 5-13 across multiple branches once their dependencies (steps 0-4) are merged.

---

## 11. Backward Compatibility

Phase 9 adds new public exports under `tsgit/commands` and `tsgit/commands/<name>`. No existing function signatures change. Phase 7 primitives are AMENDED (Step 0 PR adds `mergeBase` + `writeSymbolicRef` + `getRepoRoot` — additive, no breakage). Phase 8 transport is unchanged.

**`TsgitErrorData` widening — minor-version-only obligation.** Adding variants to a discriminated union DOES break consumers whose `switch (e.code)` lacks a `default:` arm — TypeScript's exhaustiveness check fails at the next compile. Phase 9 publishes the new variants under a minor-version bump (semver `0.x → 0.(x+1)` pre-1.0; `1.y → 1.(y+1)` post-1.0).

Recommended consumer pattern:

```typescript
function describe(e: TsgitError): string {
  switch (e.data.code) {
    case 'FILE_NOT_FOUND': return ...;
    // ... other handled cases ...
    default: {
      const _: never = e.data;  // exhaustive-on-purpose
      throw new Error(`unhandled code: ${(e.data as { code: string }).code}`);
    }
  }
}
```

Documented in the changelog so consumers update their switches when upgrading to the Phase-9 release.

---
