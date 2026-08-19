# Plan — Ownership trust gate

> Source: design doc `docs/design/ownership-trust-gate.md` · ADRs 669–679, 682, 684, 698, 699, 700
> The plan is the implementation script AND the knowledge handoff. Part agents start
> with zero context: whatever a part block omits is paid later as agent rediscovery.
> `plan-lint.sh` enforces the schema below — the plan phase cannot close without it.

## Sizing rules

- Every part costs a full agent lifecycle (spin-up, zero-context rebuild, gate) — it
  must earn it. No standalone test-only parts for FEATURE code: coverage/interop/property
  tests fold into the implementation part whose code they exercise. EXCEPTION:
  test-infra-only and docs-only parts (tooling config, test helpers, fixtures,
  harness/ADV/property suites, docs/prose) with no `src/` delta ARE standalone — they
  have no implementation part to fold into.
- A part that would be a pure test pass over already-landed code merges into its
  neighbour.

## Shared preconditions — read before Part 1

**This plan lands SECOND**, after `docs/plan/repository-format-acceptance-gate.md`. Three
symbols are **created by that plan and consumed here** — never created here:

| symbol | home | consumed by |
|---|---|---|
| `assertAcceptedRepository` | `src/application/primitives/internal/repo-state.ts` | Part 4 |
| the eleven repointed call sites (`config.ts` writers, all six `remote.ts` verbs) | `src/application/commands/{config,remote}.ts` | Part 4, Part 5 (asserted as behaviour, never as tier membership) |
| the `check:assert-tier` guard (`tooling/audit-assert-tier.ts` + its allowlist JSON) | `tooling/` | phase-boundary `npm run validate` only |

Two more artefacts **may** already exist when a part opens; each part says what to do
either way rather than guessing:

- a shared "this layout was refused" predicate used by the config-scope guard (Part 5);
- a third literal on the `CONFIG_SCOPE_NOT_AVAILABLE` `reason` union in
  `src/domain/commands/error.ts:185-188` (today: `'browser-adapter' | 'worktree-extension-unset'`).

If `assertAcceptedRepository` is absent when Part 4 opens, **STOP and escalate**
`{ part, reason, ≤3 options }`. Do not create the tier and do not repoint call sites: two
plans creating one symbol collide.

**House rules that bite in every part of this feature.** No provenance refs (ADR/phase/backlog
numbers) in source or test — the rationale goes in the prose, the number never does. No
suppression directives. Error assertions assert `.data` fields, never `toThrow(ErrorClass)`
alone. `if (A || B)` guards need a test triggering EACH disjunct alone. Coverage gates
`src/domain/**`, `src/ports/**`, `src/adapters/{node,memory}/**`, `src/operators/**` at 100%
(`vitest.config.ts:82-95`, `src/**/index.ts` excluded); Stryker mutates all of `src` with
bucket floors `domain` break 99, `application` (includes `src/repository/**`) break 95,
`adapters` break 85, `infra` (includes `src/ports/**`) break 90 (`mutation-budgets.json`).
`reports/api.json` is a **PREPUSH** gate, not a validate gate: regenerate with
`npm run docs:json` and commit it in the part that widens the public type surface.

## Part 1 — The ownership predicate as an optional probe capability

### Context

**What lands:** `LayoutProbe` gains one optional member; the node shim wires it; the
sandboxed probe deliberately does not. Nothing consumes it yet (Part 3 does) — a transient
unused member is fine, `npm run validate` runs at the phase boundary, not per part.

**`src/ports/layout-probe.ts`** — the whole file is the `LayoutProbe` interface: `stat`
(line 19, resolves `{ isDirectory, isFile, size } | undefined`), `readUtf8` (line 28), and
the optional `readLink` (line 39) whose JSDoc is the **exact template** for the new member:
it states what the capability is, that it is OPTIONAL, which adapters omit it, and what the
omission means. Add, after `readLink`:

```ts
/**
 * Whether `path` is owned by the caller. OPTIONAL: only an adapter over a
 * real multi-user filesystem can answer. Adapters that omit it declare that
 * foreign ownership cannot exist in their world (memory, browser, and any
 * platform whose owner model this adapter does not implement), and the trust
 * gate reads the omission as "trusted".
 */
readonly isOwnedByCaller?: (path: string) => Promise<boolean>;
```

`LayoutProbe` is **not** in the public barrel (its own file header says so), so this adds
nothing to `reports/api.json`.

**New file `src/adapters/node/owner-predicate.ts`.** The predicate lives here, not inline in
`src/index.node.ts`, for two measurable reasons: `src/adapters/node/**` is inside the 100 %
coverage scope while `src/index.node.ts` is not, and injecting the two dependencies makes the
"`stat` is never called when there is no owner model" row provable with a counting stub
instead of `vi.mock('node:fs/promises')`. Shape:

```ts
export interface OwnerProbe {
  /** The caller's effective uid; `undefined` on a platform with no POSIX owner model. */
  readonly callerUid: () => number | undefined;
  /** Owner uid of `path`; `undefined` when the path cannot be stat'd. */
  readonly ownerUid: (path: string) => Promise<number | undefined>;
}

export const ownedByCallerPredicate =
  (probe: OwnerProbe) =>
  async (path: string): Promise<boolean> => { … };
```

Three behaviours, each deliberate and each its own test row:

- **`owner === self`, never truthiness.** `uid` 0 is an ordinary value on both sides: root
  metadata read by root is owned; root metadata read as uid 501 is not.
- **An absent path is owned.** A path that does not exist cannot be foreign, and the lenient
  explicit-route contract (`resolve-layout.ts:222-236`) requires `init`/`clone` to bootstrap
  into a directory that is not there yet.
- **`callerUid()` returning `undefined` yields `true` without calling `ownerUid`.** That is
  the Windows branch and a documented divergence, not an accident.

**`src/index.node.ts` wiring.** `nodeLayoutProbe` is the module-private const at lines
143-159 (`stat` / `readUtf8` / `readLink`), sitting under a JSDoc explaining why it must stay
raw (never routed through a bounded `NodeFileSystem`: the walk climbs above `cwd`). `stat` is
already imported from `node:fs/promises` at line 7. Add, beside `readLink`:

```ts
isOwnedByCaller: ownedByCallerPredicate({
  callerUid: () => process.getuid?.(),
  ownerUid: async (p) => (await stat(p).catch(() => undefined))?.uid,
}),
```

`process` is already used unimported in this module (`process.cwd()` at the top of
`openRepository`). `stat(p).uid` is a plain `number` here — the `{ bigint: true }` form used
by `NodeFileSystem.mapStat` (`src/adapters/node/node-file-system.ts:363-364`) is not in play.

**`src/repository/file-system-layout-probe.ts` must NOT gain the member.** Its `FileSystem`
sources are the sandboxed adapters, which hardcode `uid: 0`
(`src/adapters/memory/memory-file-system.ts:472`, `src/adapters/browser/browser-file-system.ts:305`);
a predicate derived from that value would declare every memory/browser repository
foreign-owned for any non-root process. Omission is the single place "a sandbox is trusted"
lives. Add a one-line comment there recording *why* the member is absent, and pin the absence
with a test.

**Tests.**
- New `test/unit/adapters/node/owner-predicate.test.ts`. Sibling style:
  `test/unit/adapters/node/path-policy.test.ts`. Plain stub objects, no `vi.mock`.
- `test/unit/repository/file-system-layout-probe.test.ts` (exists, 4.7 K) — extend with the
  omission row.

### TDD steps

**RED 1 — `test/unit/adapters/node/owner-predicate.test.ts`**, one `it` per row, each row an
isolated stub so no guard hides behind another. Failure reason for every row: the module does
not exist (`Cannot find module`).

| `Given` | `When` | `Then` |
|---|---|---|
| caller uid 501, owner uid 501 | the predicate runs | `true` |
| caller uid 501, owner uid 0 | the predicate runs | `false` — the truthiness trap |
| caller uid 0, owner uid 0 | the predicate runs | `true` — root reading root-owned metadata |
| caller uid 0, owner uid 501 | the predicate runs | `false` |
| caller uid 501, `ownerUid` resolves `undefined` (absent path) | the predicate runs | `true` — nothing to distrust |
| `callerUid()` returns `undefined` | the predicate runs | `true` **and** the counting `ownerUid` stub records **zero** calls |

The last row asserts the call count, not only the verdict — that is what kills a mutant that
drops the early return and stats anyway.

**RED 2 — `test/unit/repository/file-system-layout-probe.test.ts`**: `Given a FileSystem-backed
layout probe` / `When its capability set is inspected` / `Then isOwnedByCaller is undefined`.
Fails today only after Part 1's port change compiles — write it as a value assertion
(`expect(sut.isOwnedByCaller).toBeUndefined()`), which is red the moment a well-meaning
implementer adds the member to this shim.

**GREEN** — add the optional member to `src/ports/layout-probe.ts`, create
`src/adapters/node/owner-predicate.ts`, wire `nodeLayoutProbe`.

**REFACTOR** — the predicate body must stay under 20 lines with early returns; keep the
`OwnerProbe` JSDoc on the interface members rather than repeating it in the factory.

### Gate

```
npx vitest run test/unit/adapters/node/owner-predicate.test.ts test/unit/repository/file-system-layout-probe.test.ts \
  && npm run check:types \
  && ./node_modules/.bin/biome check src/ports/layout-probe.ts src/adapters/node/owner-predicate.ts src/index.node.ts src/repository/file-system-layout-probe.ts test/unit/adapters/node/owner-predicate.test.ts test/unit/repository/file-system-layout-probe.test.ts
```

### Commit

`feat(ports): add an optional ownership capability to the layout probe`

## Part 2 — Trust options, their validation, and the allowlist matcher

### Context

**What lands:** the whole caller-facing trust surface — three options, their boundary
validation, and the pure matcher the gate will call — plus the `api.json` regeneration the
new public options require. The options are accepted and validated but not yet acted on;
Part 3 threads them.

**`src/repository.ts` — `OpenRepositoryOptions` (lines 76-141).** Append the three fields
**after** `unsafeRawAdapters` (line 140), keeping the WARNING-register block together with
`hooks` (`:119-122`), `command` (`:130-132`) and `unsafeRawAdapters` (`:136-139`) — those
three JSDocs are the register to match. Verbatim intent:

```ts
/**
 * Trust policy for repositories reached by discovery. Defaults to `'ownership'`:
 * a repository whose metadata is owned by another user is refused, the way
 * git's `safe.directory` refuses it. Ignored on the explicit-`gitDir` route,
 * which is never gated.
 *
 * WARNING: `'always'` disables the ownership check entirely. Following another
 * user's repository metadata is code execution — its `hooks/` are spawned with
 * your environment and its config names shell commands and file reads.
 */
readonly trust?: 'ownership' | 'always';
/**
 * Absolute directories trusted regardless of ownership. The single entry `'*'`
 * trusts every repository. A trailing `/*` trusts every path strictly below the
 * prefix, at any depth. Entries are physically resolved on Node and compared
 * lexically on sandboxed adapters; matching is case-sensitive.
 *
 * WARNING: an over-wide entry (`'*'`, or a `/*` prefix near the filesystem root)
 * re-opens exactly what `trust` closes.
 */
readonly trustedDirectories?: ReadonlyArray<string>;
/**
 * `'explicit'` refuses a repository whose gitdir was reached by walking into it
 * under a name other than `.git` — an "implicit" repository directory, the shape
 * a planted `evil.git` inside your own checkout takes. Whether the repository is
 * bare plays no part in the condition. Defaults to `'all'`. An explicit `gitDir`
 * argument is always accepted, and `trustedDirectories` does not lift this refusal.
 */
readonly bareRepositories?: 'all' | 'explicit';
```

That is the **whole** trust surface — three optional fields, no fourth. No deny-by-default
`trust` value ships.

**`src/repository/validate-options.ts`.** `ValidatableOptions` (lines 9-16) gains the same
three fields. `validateOptions` (line 33) calls three new validators immediately after
`validateCeilingDirs(opts.ceilingDirs)` (line 39). The file's own header (lines 27-32) states
the mutation-resistance directives that bind here: **each guard is its own `if`**, boundaries
tested in isolated triples. Reuse `isAbsolutePath` (line 55 — POSIX `/`, UNC `\\`, and the
`ABS_WINDOWS` drive-letter regex) and `invalidOption(option, reason)` from
`../domain/commands/error.js`. Model on `validateCeilingDirs` (lines 68-76), which is the
ratified precedent for "absolute-only, refused rather than warned":

- `validateTrust` — `undefined` returns; anything other than `'ownership'` / `'always'` throws
  `invalidOption('trust', "must be 'ownership' or 'always'")`.
- `validateBareRepositories` — same shape, `"must be 'all' or 'explicit'"`.
- `validateTrustedDirectories` — `undefined` returns; then per entry, **two separate `if`s**:
  empty ⇒ `'entries must not be empty'`; not `'*'` and not absolute ⇒
  `"entries must be '*' or an absolute path"`.

A TypeScript caller cannot pass a bad literal, so the literal validators need a cast in their
tests — same class as the existing `validateDnsResolver` (line 116), which checks `typeof`
against a typed field.

**New file `src/domain/repository/allowlist.ts`** — a pure function, no I/O, no `Context`:

```ts
export const isAllowlisted = (repositoryPath: string, entries: ReadonlyArray<string>): boolean
```

Grammar, and nothing beyond it:

1. entry `'*'` ⇒ match (any path);
2. exact match after stripping ONE trailing `/` from **both** sides — and never turning the
   root `'/'` into `''`;
3. entry ending in `/*` ⇒ match iff `repositoryPath` (stripped) starts with
   `` `${prefix}/` `` where `prefix` is the entry minus the trailing `*`, itself
   trailing-slash-stripped. This is *strictly below*: `'/srv/repo/*'` must **not** match
   `'/srv/repo'`, and `'/srv/repo'` must **not** match `'/srv/repo-evil'` — the classic
   prefix-comparison bug `isContainedIn` guards against in `wrap-fs-validator.ts:188-194`.

Not an fnmatch: `'/srv/nor*'` never matches, `'**'` is not special, a parent directory does
not descend implicitly. Comparison is case-sensitive. The three git artefacts with no array
analogue are deliberately absent and must not be implemented: the valueless-entry reset (an
array *is* the final list), the relative-value *warning* (refused at `validateOptions`
instead), and the literal `.` normalising against cwd.

**Do NOT add `isAllowlisted` to `src/domain/repository/index.ts`.** That barrel feeds
`src/domain/index.ts`; exporting it would widen the published type surface for an internal
collaborator. Part 3 imports it by module path — the same way `find-layout.ts:3` imports
`notARepository` directly from `../domain/repository/error.js`.

**Entry canonicalisation is NOT the matcher's job** — it happens in the shims (Part 3). The
matcher compares the strings it is given.

**Tests.**
- `test/unit/repository/validate-options.test.ts` (exists, 228 lines) — extend.
- New `test/unit/domain/repository/allowlist.test.ts` — the example truth table.
- New `test/unit/domain/repository/allowlist.properties.test.ts` — the property sibling
  (warranted: compositional matcher reducing an array of rules to a verdict, and a total
  function over a small grammar).
- `test/unit/domain/repository/arbitraries.ts` (exists) — extend. It already exports
  `arbPrintableAsciiChar()` (0x20–0x7e) and builds every char set from integer code-point
  ranges, because a literal alphabet trips `CKV_SECRET_6` in `check:security`. Follow that
  rule for any new generator. Never commit a seed.

### TDD steps

**RED 1 — `test/unit/domain/repository/allowlist.test.ts`** (fails: module absent). Rows,
each with `sut = isAllowlisted` and the verdict in `result`:

| entries | repository path | verdict |
|---|---|---|
| `['/srv/repo']` | `/srv/repo` | true (exact) |
| `['/srv/repo/']` | `/srv/repo` | true (trailing slash on the entry) |
| `['/srv/repo']` | `/srv/repo/` | true (trailing slash on the path) |
| `['/srv/repo/.git']` | `/srv/repo` | false — the allowlist keys on ONE path, the repository path |
| `['/srv']` | `/srv/repo` | false — no implicit descent |
| `['*']` | any | true |
| `['/srv/*']` | `/srv/repo` | true |
| `['/srv/*']` | `/srv/a/b/repo` | true — `/*` is any depth, not immediate children |
| `['/srv/repo/*']` | `/srv/repo` | false — strictly below |
| `['/srv/nor*']` | `/srv/normal` | false — not an fnmatch |
| `['/srv/repo/**']` | `/srv/repo/x` | false — `**` is not special |
| `['/srv/repo']` | `/srv/repo-evil` | false — the prefix-boundary bug |
| `['/SRV/REPO']` | `/srv/repo` | false — case-sensitive |
| `[]` | any | false — the identity |
| `['/other', '/srv/repo']` | `/srv/repo` | true — any entry may match |
| `['/']` | `/` | true — the root must not strip to the empty string |

**RED 2 — `test/unit/domain/repository/allowlist.properties.test.ts`**, `Given an arbitrary …`
titles, generators in the shared `arbitraries.ts`:

- **Totality** (100 runs): never throws over arbitrary printable-ASCII no-NUL paths and entry
  arrays.
- **Identity** (200 runs): the empty entry array always yields `false`.
- **Monotone extension** (200 runs): appending an entry never turns `true` into `false` —
  there is no negation in this grammar.
- **Wildcard absorption** (200 runs): an array containing `'*'` yields `true` for every path,
  whatever else it contains.
- **Prefix soundness** (100 runs): for arbitrary `p` and a `q` generated **without** a trailing
  slash, `isAllowlisted(p, [q + '/*'])` implies `p.startsWith(q + '/')`. The oracle is a string
  relation, never a copy of the production loop.

**RED 3 — `test/unit/repository/validate-options.test.ts`**: `trust: 'nope'` ⇒
`INVALID_OPTION { option: 'trust' }` with the exact `reason`; `bareRepositories: 'nope'` ⇒
same for its option; `trustedDirectories: ['']` ⇒ the empty reason; `trustedDirectories: ['rel']`
⇒ the absolute reason; `trustedDirectories: ['*']` and `['/abs']` ⇒ no throw. Assert `.data`
fields (`code`, `option`, `reason`), never the class alone, and give each guard its own `it`
so a `StatementRemoval` on one cannot pass through another. Fails today: the fields are not on
`ValidatableOptions`, so the test does not compile.

**GREEN** — add the three option fields (with the WARNING JSDoc), the three validators, and
`src/domain/repository/allowlist.ts`.

**REFACTOR** — extract the trailing-slash strip and the `/*`-prefix test as named helpers
inside the matcher module; keep `isAllowlisted` a single `entries.some(...)` expression under
20 lines.

**Surface gate, in-part** — regenerate and commit `reports/api.json` (`npm run docs:json`), and
add the three options to the option prose in `docs/get-started/node.md` §"Bare repositories and
explicit layout" (the paragraph naming `gitDir`, `workDir`, `bare`, `ceilingDirs` at line 40).
Keep it to the option table and one shared-repository example; the surviving-verb contract and
the security page are Part 7's.

### Gate

```
npx vitest run test/unit/domain/repository/allowlist.test.ts test/unit/domain/repository/allowlist.properties.test.ts test/unit/repository/validate-options.test.ts \
  && npm run check:types \
  && ./node_modules/.bin/biome check src/repository.ts src/repository/validate-options.ts src/domain/repository/allowlist.ts test/unit/domain/repository/allowlist.test.ts test/unit/domain/repository/allowlist.properties.test.ts test/unit/domain/repository/arbitraries.ts test/unit/repository/validate-options.test.ts
```

### Commit

`feat(repository): accept trust options and match a trusted-directory allowlist`

## Part 3 — The trust verdict, computed before the layout config read

### Context

**What lands:** the gate itself. One evaluation inside `finishLayout`, above the first config
byte the open sequence reads; three present-only-when-present layout fields carrying its
verdict; the options threaded from the node and memory shims. No refusal is thrown yet —
Part 4 does that.

**Where the gate sits, and why exactly there.** `finishLayout`
(`src/repository/resolve-layout.ts:190-220`) today is:

```ts
const commonDir = outcome.commonDir ?? outcome.gitDir;                       // line 198
const fmt = await readRepositoryFormat(probe, outcome.gitDir, commonDir, pathPolicy); // line 199
```

Line 199 is **the first config byte anywhere in the open sequence** — it reads
`<commonDir>/config` and extracts `core.bare`, `core.worktree`, `extensions.worktreeConfig`,
and `core.worktree` then feeds `resolveWorkTree` → `layout.workDir` → `layoutRootsOf` → the FS
validator's root set. Everything Stage 1 consumed above it is structural (a `.git` stat, the
gitfile pointer, `HEAD`, `objects`/`refs`, the `commondir` pointer) — no config. So the verdict
goes **between line 198 and line 199**, and Stage 2 becomes conditional:

```
gated       := outcome.route !== 'EXPLICIT'          # the explicit route is never gated
implicitBare:= gated && outcome.route === 'BARE_DIR'
                     && pathPolicy.basename(outcome.gitDir) !== '.git'
                     && bareRepositories === 'explicit'
verdict     := gated ? await evaluateTrust(...) : TRUSTED
accepted    := verdict.trusted && !implicitBare
fmt         := accepted ? await readRepositoryFormat(...) : EMPTY_FORMAT
```

`EMPTY_FORMAT` is `{ bare: undefined, worktree: undefined, worktreeConfig: false }` — the
`RepositoryFormat` shape at `read-repository-format.ts:14-18`. Declaring it as a module
constant (not an inline literal) is what makes the skip legible.

**What skipping Stage 2 buys, and why it is not a regression.** With `fmt.worktree` undefined,
`resolveWorkTree` (lines 97-118) falls through to the structural rows — `origin` on
`DISCOVERED`, nothing on `BARE_DIR` — so `layoutRootsOf` sees only paths discovery itself
produced and a planted `core.worktree = /` can no longer collapse the containment root set to
`['/']`. With `fmt.bare` undefined, `bareCfg` is `overrides.bare` alone (the caller's own
argument still wins, which is correct) and `bare` takes the structural default via the
`bareCfg !== false` rule at line 212. Skipping Stage 2 also skips the two refusals
`readRepositoryFormat` raises (`CONFIG_BAD_BOOLEAN_VALUE` at `:101` for a malformed
`core.bare`, `CONFIG_MISSING_VALUE` at `:108` for a valueless `core.worktree`). That is the
faithful ordering, not a regression: git's dubious-ownership fatal is measured **shadowing**
`bad boolean config value 'banana'` on the same fixture. A repository is refused on trust,
never on the contents of a file the caller was told not to trust.

**New file `src/repository/trust-verdict.ts`** (mutation bucket `application`, break 95; not
inside the 100 %-coverage globs, so lean on the unit truth table below rather than on the
coverage gate):

```ts
export interface TrustOptions {
  readonly trust?: 'ownership' | 'always';
  readonly trustedDirectories?: ReadonlyArray<string>;
  readonly bareRepositories?: 'all' | 'explicit';
}

export type TrustVerdict =
  | { readonly trusted: true }
  | { readonly trusted: false; readonly foreignPath: string };
```

Members:

- `repositoryPathOf(outcome: WalkOutcome): string` —
  `outcome.route === 'DISCOVERED' ? outcome.origin : outcome.gitDir`. `WalkOutcome` is the
  discriminated union at `src/repository/find-layout.ts:21-37`; only the `DISCOVERED` arm
  carries `origin` (the directory holding the `.git` entry), which is why the union narrows
  here by construction. **Not** `layout.workDir ?? layout.gitDir`: `workDir` does not exist yet
  (Stage 3 is below the gate), and git keys on the discovery work tree rather than the
  `core.worktree` one anyway. The formula reproduces every measured shape: a deep subdirectory
  gives the repository root; a `.git`-**file** work tree gives the work tree, not the far-away
  gitdir it points at; a linked worktree gives the worktree dir, not the common dir; a bare
  gitdir, a `.git` directory entered directly, and a separate gitdir entered directly all give
  the gitdir.
- the **checked set**, as a named, commented derivation — never an inline array literal:

  ```ts
  // The check order is load-bearing, not incidental: the refusal reports the FIRST
  // foreign member, so the repository path comes first. That way the reported path is
  // absent exactly when the refusal's own `path` already names the offending directory,
  // and present exactly when it names one the caller owns.
  const checkedPathsOf = (repositoryPath: string, gitDir: string, commonDir: string) =>
    dedupe([repositoryPath, gitDir, commonDir]);
  ```

  `dedupe` preserves first occurrence. The set collapses by shape and that is the whole cost
  claim: **1** stat for a bare `BARE_DIR` repository, **2** for a normal discovery and for the
  gitfile shape, **3** for a linked worktree, **0** on the explicit route and **0** again
  whenever `trust: 'always'` or the allowlist answers first.
- `evaluateTrust(probe, outcome, commonDir, opts)`, in this order — the order *is* the
  semantics:
  1. `opts.trust === 'always'` ⇒ TRUSTED (capability never called);
  2. `isAllowlisted(repositoryPathOf(outcome), opts.trustedDirectories ?? [])` ⇒ TRUSTED
     (capability never called — the short-circuit keys on ONE path, never on the checked set;
     widening it here would break the measured row where allowlisting a work tree admits a
     gitdir at an unrelated location);
  3. `probe.isOwnedByCaller === undefined` ⇒ TRUSTED (capability omitted);
  4. first member of the checked set the capability reports unowned ⇒
     `{ trusted: false, foreignPath }`; none ⇒ TRUSTED.
- `isImplicitBare(outcome, pathPolicy, bareRepositories)` — the `BARE_DIR` + non-`.git`
  basename + `'explicit'` conjunction. **Bareness plays no part**: two byte-identical copies of
  one gitdir differing only in name land on opposite verdicts, and flipping `core.bare` changes
  neither. `pathPolicy.basename` exists on both implementations
  (`src/adapters/node/path-policy.ts:217`, `src/repository/portable-posix-policy.ts:41`). It is
  computed **independently of the allowlist and of `trust`**: neither `trustedDirectories` nor
  `trust: 'always'` lifts it.

**Both defaults are expressed by comparing against the non-default literal** — `trust === 'always'`
and `bareRepositories === 'explicit'` — never by a `?? 'ownership'` / `?? 'all'` defaulting
expression. That is what makes "the gate is on by default" a property of the absence of an
option rather than of a coalescing operator an equality mutant can flip silently.

**Layout fields.** `RepositoryLayoutInput` (`src/repository.ts:150-164`) and `RepositoryLayout`
(`src/ports/context.ts:21-55`) each gain three optional fields following the existing
`workTreeConfigBogus?: boolean` present-only idiom one line above them
(`repository.ts:161-162`, `context.ts:41-46`):

```ts
/** Discovery reached a repository whose metadata the caller does not own. Present only when true. */
readonly untrusted?: true;
/** Discovery walked into a gitdir under a name other than `.git`, with `bareRepositories: 'explicit'` set. Present only when true. */
readonly implicitBare?: true;
/** The first checked path the ownership predicate reported unowned. Present only when one was found. */
readonly foreignPath?: string;
```

`finishLayout`'s return (lines 213-219) spreads them conditionally exactly like
`workTreeConfigBogus` does at line 218. An untrusted layout therefore carries **only what
discovery produced** — no `core.bare`, no `core.worktree` — alongside the flag saying why.

**Threading the options.** `ExplicitLayoutOptions` (`resolve-layout.ts:14-19`) gains the three
trust fields beside `ceilingDirs`; `resolveLayout` (lines 268-291) forwards them to
`finishLayout`. Keep `finishLayout`'s arity at six: pass them as one named member on the
existing 5th parameter (`LayoutOverrides`, lines 143-147) — e.g. `readonly trustOptions?: TrustOptions`
— rather than adding a seventh positional argument.

- **node** (`src/index.node.ts`, `resolveNodeLayout` lines ~239-283): forward the three fields
  into the `resolveLayout` options object beside `ceilingDirs`, and physically resolve
  `trustedDirectories` entries the way `canonicalizeCeilings` (lines ~181-190) already resolves
  ceilings — `canonicalize` per entry (realpath, best-effort fallback to the literal on
  failure), **skipping the literal `'*'`**, which must never be realpathed into `<cwd>/*`. The
  fallback is what makes an entry with a missing intermediate component (`/t/nope/../normal`)
  correctly fail to match. The repository path needs **no** resolution here: `cwd` is already
  realpathed at the top of `openRepository`, and both `origin` and a cwd-is-gitdir `gitDir` are
  ancestors of a realpath, hence themselves physical.
- **memory** (`src/index.default.ts`, the `resolveLayout` call ~line 74): forward the three
  fields, normalising `trustedDirectories` entries lexically with `portablePosixPolicy.resolve`
  (again skipping `'*'`). No realpath exists in a sandbox.
- **browser** (`src/index.browser.ts` → `src/repository/fixed-entry-layout.ts`): do **not**
  thread. `resolveFixedEntryLayout` always produces `route: 'DISCOVERED'` (line 38 — there is
  no walk, so `BARE_DIR` is unreachable) and `fileSystemLayoutProbe` omits the capability, so
  both gates are inert by construction. Record that in a one-line comment there; do not add a
  parameter that can only ever be ignored.

**`foreignPath` and realpath.** The node shim realpaths `gitDir`/`commonDir`/`workDir` *after*
`finishLayout` returns (lines ~268-282, and the `{ ...resolved, … }` spread preserves the new
fields automatically). `foreignPath` is therefore the path as the gate saw it, which may differ
from the realpathed `gitDir` when `.git` itself is a symlink. That is accepted: the field is
diagnostic, and re-realpathing it would buy nothing and cost a syscall. Do not add one.

**Tests — new file `test/unit/repository/resolve-layout-trust.test.ts`.**
`test/unit/repository/resolve-layout.test.ts` is already 922 lines; this matrix goes in a
sibling, mirroring the existing `test/unit/index-node-root-canonicalisation.test.ts` split.
Reuse that file's fixture idiom (lines 1-17): `MemoryFileSystem({ rootDir: '/repo' })`,
`posixPolicy`, `fileSystemLayoutProbe(fs)`, and the local `makeGitDir` helper (writes
`objects/`, `refs/`, `HEAD`) — a `.git` lacking those three does not validate and the walk
climbs past it.

**This file is load-bearing in a way no other test is: no interop row re-proves any of it.**
Build one recording probe helper and use it everywhere:

```ts
const recordingProbe = (fs: MemoryFileSystem, owned: (path: string) => boolean) => {
  const base = fileSystemLayoutProbe(fs);
  const ownershipQueries: string[] = [];
  const reads: string[] = [];
  return {
    probe: {
      ...base,
      readUtf8: (p: string) => { reads.push(p); return base.readUtf8(p); },
      isOwnedByCaller: async (p: string) => { ownershipQueries.push(p); return owned(p); },
    },
    ownershipQueries,
    reads,
  };
};
```

`reads` is the Stage-2 counting stub: "did `readRepositoryFormat` run at all" is
`reads.some((p) => p.endsWith('/config'))`. `ownershipQueries` proves both the checked set and
the short-circuits. The stub answers **per path**, which is what makes the checked set testable.

### TDD steps

**RED — `test/unit/repository/resolve-layout-trust.test.ts`.** Every row fails today with
"`isOwnedByCaller` is not a known property" or an absent flag on the resolved layout. Group the
`describe`s by the guard each row isolates.

*The verdict and the checked set*
1. alien `gitDir`, owned repository path, nothing allowlisted ⇒ `untrusted: true`. The shape a
   single-path predicate would admit.
2. alien `commonDir`, owned `gitDir` and repository path (linked-worktree fixture) ⇒
   `untrusted: true`.
3. owned everywhere ⇒ no `untrusted` flag, Stage 2 **ran**, and `ownershipQueries` has exactly
   **1** entry for `BARE_DIR`, **2** for a normal discovery, **2** for the gitfile shape, **3**
   for a linked worktree. Assert the recorded list, not just its length — that kills both an
   un-deduplicated set and a reordered one.
4. repository path allowlisted while **every** path is alien ⇒ trusted, `ownershipQueries` is
   **empty**, Stage 2 ran.
5. `trust: 'always'` with every path alien ⇒ trusted, `ownershipQueries` empty. Separate `it`
   from row 4 so neither hides the other.
6. capability omitted (plain `fileSystemLayoutProbe`) with an otherwise-foreign fixture ⇒
   trusted, Stage 2 ran.
7. `route === 'EXPLICIT'` (`opts.gitDir`) with alien ownership and no allowlist ⇒ trusted,
   Stage 2 **ran**, `ownershipQueries` empty.

*What a refused layout does NOT read*
8. untrusted + planted `core.worktree = /` ⇒ `layoutRootsOf(layout)` (import from
   `src/repository/layout-roots.js`) is **not** `['/']`, and Stage 2 did not run. Assert the
   root set itself, not just the flag.
9. untrusted + planted `core.bare = banana` ⇒ resolves **without throwing** (today
   `readRepositoryFormat` throws `CONFIG_BAD_BOOLEAN_VALUE` on that value), Stage 2 did not run.
10. untrusted + a planted `extensions.*` selector ⇒ Stage 2 did not run. Assert only that; if
    the sibling ref-storage work has landed a backend field on the layout by the time this part
    runs, additionally assert it holds the structural default. The claim this row makes is that
    the gate sits *above* the selector, not anything about the selector.

*The implicit-bare predicate, isolated*
11. two fixtures identical but for the gitdir basename (`/repo/wrap/.git` vs
    `/repo/wrap/evil.git`), both reached by the cwd-is-gitdir route, `bareRepositories: 'explicit'`
    ⇒ only the second carries `implicitBare: true`.
12. the same pair with `core.bare` flipped on each ⇒ **no change** to either verdict. This is
    the row that kills a bareness-conditioned mutant, and a test title must never say "bare
    repository" of it.
13. `implicitBare` with **owned** metadata and no allowlist ⇒ `untrusted` **absent**, and Stage
    2 still did **not** run (the `accepted := trusted && !implicitBare` conjunction, which a
    mutant reducing it to `trusted` alone survives). Pair it with a planted `core.worktree = /`
    and assert the root set again.
14. `bareRepositories` left at its default on the same non-`.git` fixture ⇒ no `implicitBare`.
14b. the same non-`.git` fixture with its repository path **allowlisted**, and again with
    `trust: 'always'` ⇒ `implicitBare` is **still** set. Two separate `it`s: neither trust
    escape hatch lifts this refusal, and a mutant folding the two verdicts into one guard dies
    here.

*The repository path and the foreign path*
15. one row per discovery shape asserting the path the gate keyed on (read it back off
    `layout.foreignPath` with a fixture where only the repository path is alien): deep
    subdirectory ⇒ the repository root; `.git`-file work tree ⇒ the work tree, **not** the
    pointed-at gitdir; linked worktree ⇒ the worktree dir, **not** the common dir; bare gitdir
    and `.git` directory entered directly ⇒ the gitdir.
16. exactly one checked path foreign and it is **not** the repository path ⇒ `foreignPath`
    names that path.
17. the repository path itself foreign (everything else owned) ⇒ `foreignPath` equals the
    repository path — the tier omits it later; the layout still carries it.
18. **two** checked paths foreign, chosen so the two candidates are distinguishable ⇒
    `foreignPath` names the repository path, because it is first in the documented order. Write
    the expectation off the documented order, not off the implementation's array — a reordering
    mutant must die here.

**GREEN** — create `src/repository/trust-verdict.ts`; wire the verdict, `EMPTY_FORMAT` and the
three layout fields into `finishLayout`; add the fields to both layout types; thread the options
through `ExplicitLayoutOptions`, `resolveLayout`, `src/index.node.ts` and `src/index.default.ts`.

**REFACTOR** — `finishLayout` must stay readable: extract the verdict block into one call
returning `{ verdict, implicitBare, accepted }` rather than four inline `const`s if the function
grows past 20 lines. No nesting past two levels.

**Surface gate, in-part** — the three layout fields are on public types: regenerate and commit
`reports/api.json` (`npm run docs:json`).

### Gate

```
npx vitest run test/unit/repository/resolve-layout-trust.test.ts test/unit/repository/resolve-layout.test.ts test/unit/index.node.test.ts test/unit/index.default.test.ts test/unit/index.browser.test.ts \
  && npm run check:types \
  && ./node_modules/.bin/biome check src/repository/trust-verdict.ts src/repository/resolve-layout.ts src/repository/fixed-entry-layout.ts src/repository.ts src/ports/context.ts src/index.node.ts src/index.default.ts test/unit/repository/resolve-layout-trust.test.ts
```

### Commit

`feat(repository): compute the trust verdict before the layout config read`

## Part 4 — Two refusal codes on the acceptance tier

### Context

**Precondition:** `assertAcceptedRepository` must already exist in
`src/application/primitives/internal/repo-state.ts`. If it does not, STOP and escalate — see
Shared preconditions.

**What lands:** the two structured codes, their `extractDetail` arms, the exhaustiveness entry,
the two refusals inside the accepted tier, and the `docs/use/errors.md` rows. Distinct codes,
not one code with a `reason` discriminant: there are two conditions, two messages and a
measured ordering between them, and distinct codes kill the `StringLiteral` mutants a shared
code survives.

**`src/domain/repository/error.ts`** — the `RepositoryError` union starts at line 4 and the
factories follow it; `FilePath` is imported at line 2. Add to the union:

```ts
| { readonly code: 'DUBIOUS_OWNERSHIP'; readonly path: FilePath; readonly foreignPath?: FilePath }
| { readonly code: 'IMPLICIT_BARE_REPOSITORY'; readonly gitDir: string }
```

`path: FilePath` follows `NOT_A_REPOSITORY`; `gitDir: string` follows
`WORK_TREE_CONFIG_INVALID`. Factories beside the others, with the optional field spread
conditionally so an absent `foreignPath` is *absent*, never `undefined`:

```ts
export const dubiousOwnership = (path: FilePath, foreignPath?: FilePath): TsgitError =>
  new TsgitError({ code: 'DUBIOUS_OWNERSHIP', path, ...(foreignPath !== undefined ? { foreignPath } : {}) });
```

Three JSDoc obligations, each of which is also a test row:

- On `DUBIOUS_OWNERSHIP`: `path` names the repository path — the work tree when discovery
  produced one, else the gitdir. `foreignPath` is **diagnostic**: it names the **first** member
  of the checked set the ownership predicate reported unowned, in the documented check order —
  one path, never a set — and it is **absent, not equal**, when it would repeat `path`. A
  present `foreignPath` therefore always names a directory *other* than the one the message is
  about.
- On `IMPLICIT_BARE_REPOSITORY`: the name is deliberately imprecise (it follows the wording a
  user will search for), so state the predicate verbatim in the JSDoc:

  > Fires when discovery reached the gitdir by the cwd-is-a-gitdir route **and** the gitdir's
  > basename is not literally `.git`, with `bareRepositories: 'explicit'` set. Whether the
  > repository is bare — by `core.bare`, or by what a bareness query would report — plays no
  > part in the condition.

  Nothing downstream may infer bareness from the name: not a caller branching on the code, not
  a docs sentence, not a test title.

**Barrel:** do **not** add the factories to `src/domain/repository/index.ts`. That barrel
exports five of the seven existing factories (`workTreeUnresolvable` is already absent), and
`repo-state.ts` can import them by module path, exactly as `find-layout.ts:3` does. The error
*codes* remain public through the exported `TsgitErrorData` union regardless, so `api.json`
still moves.

**`src/domain/error.ts` — `extractDetail`.** The repository arms live at lines 299-310 (
`NOT_A_REPOSITORY` uses `basename(data.path)`; `WORK_TREE_CONFIG_INVALID` prints `data.gitDir`
whole). Add two arms in that block, using the `basename()` sanitisation idiom. The
`foreignPath` conditional follows the established shape of the `CONFIG_MULTIPLE_VALUES` arm
(line 451), which already branches on an optional field:

```
DUBIOUS_OWNERSHIP        → `dubious ownership in repository at ${basename(data.path)}`
                           …and, when foreignPath is present, ` (first foreign path: ${basename(data.foreignPath)})`
IMPLICIT_BARE_REPOSITORY → `cannot use implicit git directory: ${basename(data.gitDir)}`
```

Both branches of the conditional get their own exact-format row in the error test. The library
emits **no** `fatal:` string and no hint line; git's four-line rendering is reconstructed inside
the interop test (Part 6), never here.

**`test/unit/domain/exhaustiveness.ts`** — the shared switch (one `case` per code, ending at
line 211). Add both codes near the other repository codes (lines 82-87). Missing entries fail
`check:types` through the `never` assignment in the default arm.

**`src/application/primitives/internal/repo-state.ts` — the refusals.** Inside
`assertAcceptedRepository`, after its inner `assertRepository(ctx)` call and **before**
anything config-derived:

1. `ctx.layout.implicitBare === true` ⇒ throw `implicitBareRepository(ctx.layout.gitDir)`.
   This precedes the ownership refusal — the one explicit ordering measured between the two,
   and `trustedDirectories` does not lift it.
2. `ctx.layout.untrusted === true` ⇒ throw `dubiousOwnership(path, foreignPath?)` where
   `path = (ctx.layout.workDir ?? ctx.layout.gitDir) as FilePath` — the **same root formula**
   `assertRepository` already uses at lines 91 and 94 — and `foreignPath` is passed only when
   `ctx.layout.foreignPath !== undefined && ctx.layout.foreignPath !== path`. Two conditions,
   two isolated test rows.

Both are synchronous reads of frozen layout fields: no I/O, no per-command cost. Discovery
failure still comes first because the accepted tier chains through the bare tier, whose
`hasUsableHead` check runs before either refusal.

**Tests — new file `test/unit/application/commands/internal/repo-state-trust.test.ts`.**
`test/unit/application/commands/internal/repo-state.test.ts` is already 1421 lines; put the
trust matrix in a sibling. Reuse its idiom (lines 1-25): `createMemoryContext()` from
`src/adapters/memory/memory-adapter.js`, a `seedRepo(ctx)` helper writing
`${ctx.layout.gitDir}/HEAD`, and a `seedConfig` helper. Build a refused context with the
established spread idiom (`test/unit/application/primitives/list-worktrees.test.ts:64`):

```ts
const untrusted: Context = { ...base, layout: { ...base.layout, untrusted: true, foreignPath: '…' } };
```

Note that spreading a `Context` produces a **new identity**, and the config caches are keyed on
`Context` identity — that is desirable here (a fresh read), but never write through one
identity and read through the other.

**`docs/use/errors.md`** — a table of `| code | fields | description |` rows (see the
`GITFILE_NO_PATH` / `WORK_TREE_UNRESOLVABLE` rows at lines 205 and 211 for the register). Add
one row per code, in the repository block. `DUBIOUS_OWNERSHIP`'s row must state the
first-in-check-order rule explicitly, so a caller does not read a single value as "the only
one", and name the tsgit-side remedy (`trustedDirectories: [path]`) rather than git's
`git config --global --add safe.directory` hint, which has no analogue here.

### TDD steps

**RED 1 — `test/unit/domain/repository/error.test.ts`** (exists, two describes: "factory data"
and "extractDetail message formatting (exact match)"). Add:
- `dubiousOwnership('/srv/repo')` ⇒ `data` equals `{ code, path }` with **no** `foreignPath`
  key (`toEqual`, so an `undefined`-valued key fails);
- `dubiousOwnership('/srv/repo', '/srv/repo/.git')` ⇒ `data` equals `{ code, path, foreignPath }`;
- `implicitBareRepository('/srv/evil.git')` ⇒ `{ code, gitDir }`;
- three `extractDetail` exact-format rows (with and without `foreignPath`, plus the bare
  repository code).
Fails: the factories do not exist.

**RED 2 — `test/unit/domain/exhaustiveness.ts`** is a helper, not a test; adding the two cases
is what turns the union widening from a `check:types` failure into a pass. Do it in GREEN.

**RED 3 — `test/unit/application/commands/internal/repo-state-trust.test.ts`**, four fixtures ×
three asserts, each an isolated `it`:

| layout | `assertAcceptedRepository` | `assertRepository` | `assertOperationalRepository` |
|---|---|---|---|
| neither flag | resolves | resolves | resolves |
| `untrusted` | `DUBIOUS_OWNERSHIP` with the asserted payload | **does not refuse** | refuses (chains through) |
| `implicitBare` | `IMPLICIT_BARE_REPOSITORY { gitDir }` | **does not refuse** | refuses |
| **both** | `IMPLICIT_BARE_REPOSITORY` — the measured ordering | does not refuse | refuses |

Plus, each its own `it`:
- `foreignPath` present and **different** from `path` ⇒ the thrown `.data.foreignPath` names it;
- `foreignPath` present and **equal** to `path` ⇒ the thrown `.data` has **no** `foreignPath`
  key (assert absence, not equality-to-`path`);
- `foreignPath` absent ⇒ no key either;
- a layout with `workDir` set ⇒ `path` is the work tree; a bare layout (no `workDir`) ⇒ `path`
  is the gitdir;
- missing/garbage `HEAD` **and** `untrusted` ⇒ `NOT_A_REPOSITORY`, proving discovery failure
  still comes first and the inner bare tier runs first under chaining.

Use try/catch + direct `.data` assertions throughout; `toThrow(TsgitError)` alone is not
acceptable here.

**GREEN** — add the union members, the factories, the two `extractDetail` arms, the two
exhaustiveness cases, and the two refusals in `assertAcceptedRepository`.

**REFACTOR** — if the two refusals push `assertAcceptedRepository` past 20 lines, extract a
private `assertTrusted(ctx)` in the same module; keep the ordering explicit and commented.

**Surface gates, in-part** — `docs/use/errors.md` rows (above) and `reports/api.json`
regenerated and committed (`npm run docs:json`).

### Gate

```
npx vitest run test/unit/domain/repository/error.test.ts test/unit/application/commands/internal/repo-state-trust.test.ts test/unit/application/commands/internal/repo-state.test.ts \
  && npm run check:types \
  && ./node_modules/.bin/biome check src/domain/repository/error.ts src/domain/error.ts src/application/primitives/internal/repo-state.ts test/unit/domain/exhaustiveness.ts test/unit/domain/repository/error.test.ts test/unit/application/commands/internal/repo-state-trust.test.ts
```

### Commit

`feat(repository): refuse dubious ownership and implicit bare repositories`

## Part 5 — A refused repository reads as an empty config scope

### Context

**What lands:** the second half of the mechanism. A refused repository's config file is not
merely ignored — it is **never parsed**, at either of tsgit's two config read paths. That is
what makes every config-derived gate downstream a no-op *by construction* rather than by an
explicit precedence rule, and it is what reproduces the measured ordering where the trust
refusal shadows the malformed-`core.bare` refusal, the repository-format refusal and the
ref-backend selection.

**Two sites, not one — and the split is load-bearing.**

| site | what it guards | what it reproduces |
|---|---|---|
| `loadConfigEntry` (`src/application/primitives/config-read.ts:~220`) — the per-`Context` cache entry that **both** `readConfig`'s `parsed` and every token finder consume | return the same `{ parsed: {}, tokens: [], source: path }` the absent-file branch already returns, **without** the `readRawConfig` call | a malformed `core.bare` stops refusing; the eager `[core]` gate finds nothing; the sibling format gate never sees its key |
| `readSingleScopeUncached` (`src/application/primitives/config-scoped-read.ts:44-63`) — the per-scope reader the four surviving porcelain verbs take | for the `local` and `worktree` scopes only, throw `configScopeNotAvailable(scope, <shared reason>)` **before** `resolveScopePath` reads anything | a merged read silently omits the repository scope (`safeReadScopeOrSkip`, lines 74-89, already catches that code and returns `undefined`); an **explicitly named** `local`/`worktree` scope refuses with its own error |

One throw covers both porcelain behaviours because the merged path already swallows exactly
that code — do not add a second branch for the merged case. Do **not** guard the `global` or
`system` scopes: they are outside the repository and are not the attacker's file.

**Why `loadConfigEntry` and not `readConfig`.** `readConfig` (`config-read.ts:169`) is only the
parsed projection; `readConfigEntry` (line 177) is the shared cache accessor, and
`assertDiscoveryBooleansValid` (`repo-state.ts:71-78`) — which runs inside the **bare** tier,
*ahead* of the accepted tier's refusals — reaches the file through
`findFirstInvalidBoolean → readConfigEntry().tokens`, never through `readConfig`. A guard on
`readConfig` alone would leave that path reading the attacker's file and refusing
`CONFIG_BAD_BOOLEAN_VALUE` where the trust refusal is measured. One guard at the cache entry
closes the parsed read and every finder in the same place.

**The predicate.** Both sites key on the same question: was this layout refused?
`layout.untrusted === true || layout.implicitBare === true` — the implicit-bare refusal is
measured producing the *identical* empty-scope posture, so one guard covers both, and each
disjunct needs its own test. **If the sibling format-gate plan already landed a shared
"refused layout" predicate, extend it with these two disjuncts** rather than adding a second
guard. If it did not, create `src/application/primitives/internal/layout-verdict.ts` exporting
a single predicate over `RepositoryLayout` and use it from both sites.

**The `reason` literal.** `CONFIG_SCOPE_NOT_AVAILABLE`'s payload is
`{ scope, reason: 'browser-adapter' | 'worktree-extension-unset' }`
(`src/domain/commands/error.ts:185-188`, factory at line 645, message arm at
`src/domain/error.ts:457`). **Reuse the third literal the sibling gate added.** If it is not
there, add exactly one — `'repository-not-accepted'` — and regenerate `reports/api.json`; do
not add a second literal meaning the same thing.

**What this guard does NOT stop, and must be stated in the tests.** The five config writers do
not read through `readConfig`: `updateConfigEntries` and its siblings reach the file through
`readConfigText` (`src/application/primitives/update-config-sections.ts:222`), a raw text read
that exists to preserve formatting and sits outside the parsed-read guard. **Only tier
membership** stops `repo.config.set()` writing into the attacker's file. That is why the
write-side rows below assert the file's **bytes**, and why they are behaviour assertions rather
than tier-membership assertions.

**Tests.**
- `test/unit/application/primitives/config-read.test.ts` (exists) — extend, or add a focused
  sibling if it grows past ~800 lines.
- New `test/unit/application/primitives/config-scoped-read-untrusted.test.ts` for the scoped
  reader (there is no `config-scoped-read.test.ts` today).
- The surviving-verb contract goes in
  `test/unit/application/commands/internal/repo-state-trust.test.ts` (created in Part 4) — it
  needs both the tier refusals and the empty scope, so it lands here.
- Cache hygiene: `__resetConfigCacheForTests()` (`config-read.ts`) and
  `__resetSectionsCacheForTests()` (`config-scoped-read.ts`) between cases that reuse a
  `Context` identity; both caches are `WeakMap`s keyed on identity.
- The counting `fs` stub wraps `ctx.fs.readUtf8` and records paths, so "zero reads of
  `<commonDir>/config`" is a direct assertion.

### TDD steps

**RED 1 — the parsed read never happens.** With a planted `<gitDir>/config` and a layout
carrying `untrusted`, then again with `implicitBare` (two separate `it`s — one guard covering
both is exactly the shape where a single test hides a missing disjunct):
- `readConfig(ctx)` resolves to `{}` and the counting stub records **zero** reads of the config
  path;
- `findFirstInvalidBoolean(ctx, 'core', undefined, ['bare'])` resolves `undefined` and again
  records **zero** reads. Not redundant with the first: the two share a cache entry, so a guard
  placed one level too high passes the first assertion and fails this one.
Fails today: both read the file and the planted value comes back.

**RED 2 — the ordering, expressed in tsgit's own terms.** A layout carrying `untrusted` **plus**
a planted `core.bare = banana`, called through `assertAcceptedRepository` ⇒ `DUBIOUS_OWNERSHIP`,
**not** `CONFIG_BAD_BOOLEAN_VALUE`. Paired with the same fixture through `assertRepository` ⇒
does not refuse at all. This row is what proves the empty scope — not an assert ordering — is
carrying the measured shadowing, because a config-derived check runs *ahead* of the refusal.
Fails today with `CONFIG_BAD_BOOLEAN_VALUE`.

**RED 3 — the scoped reader**, in
`test/unit/application/primitives/config-scoped-read-untrusted.test.ts`:
- a planted local key, refused layout, `getConfigValue({ ctx, key })` (merged) ⇒ reports the key
  **absent**;
- `readConfigSections({ ctx })` (merged) ⇒ contains **no** `local`-scoped section;
- `readConfigSections({ ctx, scope: 'local' })` ⇒ throws `CONFIG_SCOPE_NOT_AVAILABLE` with
  `.data.scope === 'local'` and the shared `reason` asserted by value;
- `scope: 'worktree'` ⇒ same;
- `scope: 'global'` on the same refused layout ⇒ **does not** throw this error (the guard must
  not overreach);
- each of the two verdict flags gets its own run of the local-scope row.

**RED 4 — the surviving-verb contract, verb by verb** (in the Part-4 trust test file). On a
refused layout, asserting **behaviour**, never tier membership:
- the four survivors — `configGet`, `configGetAll`, `configGetRegexp`, `configList` — each
  succeed, with a planted local key reported absent and the repository scope absent from the
  listing;
- each of the five config writers — `configSet`, `configUnset`, `configUnsetAll`,
  `configRenameSection`, `configRemoveSection` — refuses, **and** the config file's bytes are
  unchanged afterwards (read them before and after). Their read path is outside the parsed-read
  guard, so this is the one place a regression would silently write into the attacker's file.
- each of the six `remote` verbs — `remoteList`, `remoteAdd`, `remoteRemove`, `remoteRename`,
  `remoteSetUrl`, `remoteShow` — refuses. `remote` is **not** a surviving gentle-setup verb, in
  any form, read or write.
- one representative operational command covers the rest.

**GREEN** — add the predicate (or extend the sibling's), guard `loadConfigEntry`, guard
`readSingleScopeUncached` for the two repository scopes, reuse/add the `reason` literal.

**REFACTOR** — the guard must be one early return / one early throw at each site, above the
existing body; do not restructure the caches or the memoisation, which stay unchanged.

**Surface gate, in-part** — regenerate and commit `reports/api.json` **only if** the `reason`
literal had to be added here (a widened public union).

### Gate

```
npx vitest run test/unit/application/primitives/config-read.test.ts test/unit/application/primitives/config-scoped-read-untrusted.test.ts test/unit/application/commands/internal/repo-state-trust.test.ts test/unit/application/commands/config.test.ts \
  && npm run check:types \
  && ./node_modules/.bin/biome check src/application/primitives/config-read.ts src/application/primitives/config-scoped-read.ts src/application/primitives/internal/layout-verdict.ts src/domain/commands/error.ts test/unit/application/primitives/config-read.test.ts test/unit/application/primitives/config-scoped-read-untrusted.test.ts test/unit/application/commands/internal/repo-state-trust.test.ts
```

(Drop `layout-verdict.ts` from the biome list if the sibling predicate was extended instead of
created.)

### Commit

`feat(config): read an unaccepted repository as an empty config scope`

## Part 6 — Interop and parity: pin the gate against canonical git

### Context

Test-infra only — **no `src/` delta**, which is what makes this part standalone rather than
folded: it spans four earlier parts' code and carries its own skip-predicate machinery.

**New file `test/integration/ownership-trust-gate-interop.test.ts`.** Model the header on
`test/integration/bare-repo-custom-gitdir-interop.test.ts:1-32`:

```
/**
 * <one-paragraph summary>
 *
 * @proves
 *   surface:        openRepository
 *   bucket:         cross-tool-interop
 *   unique:         <one line>
 *   interopSurface: trust
 */
```

Every git invocation goes through `test/integration/interop-helpers.ts`, never a bare `spawn`:
`GIT_AVAILABLE`, `git(dir, ...args)`, `runGit`, `runGitEnv()`, `tryRunGit`,
`tryRunGitWithExit`, `disableAutoMaintenance`. Its `SAFE_ENV` already scrubs every `GIT_*`,
points `HOME`/`XDG_CONFIG_HOME` at a non-existent path, and sets `GIT_CONFIG_NOSYSTEM=1` — so
`runGitEnv()` spread plus one added variable is how the forcing hatch is set. `mkdtemp` roots
must be `realpath`-resolved (macOS `/tmp → /private/tmp`). **One shared `beforeAll(fn, 60_000)`
per scenario group** — git-spawning interop suites that build a fixture per test hit the
hook-timeout class. Re-open with a fresh `openRepository` after any git-side write.

**Three groups; the predicates are evaluated once in module scope, before any `describe`.**

```
GIT_ASSUME_DIFFERENT_OWNER =
  GIT_AVAILABLE && (in a throwaway `git init` repo, `git log` with
  GIT_TEST_ASSUME_DIFFERENT_OWNER=1 exits 128 AND stderr starts with
  'fatal: detected dubious ownership')      // guards a future git dropping the hatch

ALIEN_OWNER_AVAILABLE =
  probe:  mkdtemp() → fs.chown(dir, <any uid ≠ process.getuid()>, -1)
                    → fs.stat(dir) → rm -rf
  true  ⇔ the chown RESOLVES *and* the re-stat reports stat.uid !== process.getuid()
  false ⇔ process.getuid is undefined            (Windows)
        ∨ the chown rejects                      (EPERM — every non-root POSIX job)
        ∨ the chown resolves but the re-stat still reports the caller's uid
                                                 (a mount that accepts chown as a no-op)
```

The re-stat is not defensive padding: without it, a filesystem that silently ignores `chown`
would run group C against a fixture the caller still owns and every assertion would pass for
the wrong reason. The verdict is taken from what `stat` reports, never from the absence of a
rejection.

**What a skip logs.** A `false` `ALIEN_OWNER_AVAILABLE` emits exactly one `console.warn` at
module scope, before the suite runs:

```
[ownership-trust-gate-interop] group C SKIPPED — no alien-owned fixture is creatable here
  (reason: <EPERM from chown | process.getuid unavailable | chown was a no-op>).
  NOT covered by this run: that the node adapter compares a real stat.uid to a real
  process uid. Its semantics ARE covered by the unit truth table in
  test/unit/repository/resolve-layout-trust.test.ts.
```

Use `describe.skipIf(...)` so the group stays **visible as skipped** in the reporter rather than
absent, and repeat the condition in the group title so the CI log carries it after the warning
scrolls away. A silently-vacuous test is worse than a skipped one.

**Group A — the anchor: `bareRepositories`, both sides, always on.** `skipIf(!GIT_AVAILABLE)`.
This is the one part of the feature provable end-to-end against real git on every platform,
with no forcing and no escape hatch, so it carries the suite. Fixtures, built once in the shared
`beforeAll`: `bare.git` (a `clone --bare`), `nb3.git` (a copy with `core.bare = false`),
`wrap/.git-other` and `wrap/.git` — **byte-identical copies of one gitdir differing only in
name** — `normal/.git`, and `config-bare` (bare via `core.bare`, discovered through a `.git`
entry).

- Co-refuse with `git -c safe.bareRepository=explicit` versus
  `openRepository({ cwd, bareRepositories: 'explicit' })`: both refuse on `bare.git`,
  `bare.git/refs`, `nb3.git` and `wrap/.git-other`; **neither** refuses on `wrap/.git`,
  `normal/.git`, `config-bare`, or any explicit-`gitDir` invocation.
- Flip `core.bare` on the `.git`-named and non-`.git`-named pair ⇒ **unchanged verdicts** on
  both sides. The byte-identical rename pair is what pins the predicate rather than a plausible
  reading of it — and no test title here may describe it as "refusing a bare repository".
- **The one-line fatal, reconstructed.** git's refusal here is a single line with **no hint
  block**, exit 128:
  ```
  fatal: cannot use bare repository '<GITDIR>' (safe.bareRepository is 'explicit')\n
  ```
  Rebuild exactly those bytes from tsgit's `IMPLICIT_BARE_REPOSITORY { gitDir }` and compare to
  git's stderr byte-for-byte, plus the exit code and the empty stdout. The library emits no such
  string; the test composes it — the same split the four-line refusal takes in group B.
- **The whole empty-config-scope mechanism, on the same fixtures**, because this refusal is
  measured producing the identical posture as the ownership one: with `user.name` planted
  locally, `git config user.name` and `repo.config.get` both report it absent; `git config --list`
  and `repo.config.list()` both omit the repository scope; a write refuses on both sides and
  leaves the value byte-unchanged; `remote` refuses on both sides. This is the group that makes
  the empty-scope contract a co-truth rather than a tsgit-side assertion.

**Group B — git's own bytes, always on wherever the hatch exists.**
`skipIf(!GIT_ASSUME_DIFFERENT_OWNER)`. Everything about git's side that needs no tsgit-side
alien owner:

- The refusal: exit **128**, empty stdout, and the four-line stderr byte-for-byte —
  ```
  fatal: detected dubious ownership in repository at '<PATH>'\n
  To add an exception for this directory, call:\n
  \n
  \tgit config --global --add safe.directory <PATH>\n
  ```
  single-quoted path on line 1, **unquoted** on line 4 — asserted against tsgit's
  reconstruction of the same bytes from a **synthesised** `DUBIOUS_OWNERSHIP`, reading
  **`path` alone**. One row synthesises a payload *with* a `foreignPath` and proves the bytes do
  **not** move. The library emits none of this; the test builds it.
- The named-path table, one row per route: repository root from inside a subdirectory; the
  gitdir when cwd is the gitdir; the bare gitdir from inside it; the **work tree** for a
  `.git`-file layout, not the pointed-at gitdir; the **worktree dir** for a linked worktree,
  not the common dir; and **exit 0, no refusal**, for every explicit-`--git-dir` invocation.
- The value grammar as a **git-side golden table**: each row's verdict from `git -c safe.directory=<v>`
  asserted against `isAllowlisted`'s verdict on the same inputs, so matcher and git agree
  row-for-row by construction. Skip the three rows with no array analogue (the valueless reset,
  the relative-value warning, the literal `.`), and include the physical rows (`//`, `/./`,
  an existing `..` hop, a symlinked value, the unresolved `/tmp` form) as node-shim rows —
  those pass through the shim's realpathing, not the matcher.
- The ordering rows: the bare-repository refusal precedes the ownership one, and
  `safe.directory=*` does not lift it.
- The self-allowlisting row: a `safe.directory` written into the repository's **own** config
  admits neither tool.

No assertion in this group may be phrased as though it refused on tsgit's side for an ownership
reason — that is group C.

**Group C — the uid read itself, gated.** `skipIf(!ALIEN_OWNER_AVAILABLE)`. `chown` a fixture
repository to another uid, then: unmodified `git` refuses and unmodified
`openRepository(…).log()` refuses with `DUBIOUS_OWNERSHIP { path }` naming the same path;
`trustedDirectories: [path]` admits both; `git init` and `repo.init()` both succeed on it; and
the superset row — `chown` the **gitdir alone**, leave the work tree owned, and assert tsgit
refuses with `path` naming the work tree and `foreignPath` naming the gitdir (git's verdict on
that shape is deliberately **not** asserted: tsgit may over-refuse there by design). This group
is **expected to skip** on developer machines and on any CI job without root.

**Parity — one scenario across the memory and browser drivers.** Add
`test/parity/scenarios/trust-defaults.scenario.ts` and register it in
`test/parity/scenarios/index.ts`. Shape: see `test/parity/scenarios/show.scenario.ts` — a
`Scenario<T>` (`types.ts`) with `name`, `inputs` (use `FILES.helloA`, `AUTHOR`, `MESSAGES.seed`
from `test/parity/fixtures.ts`), `expected`, and `run(repo, inputs)`. Assert that with **no**
trust option set the repository initialises, commits and logs normally and `repo.layout` carries
**neither** verdict flag — the capability-omitted-is-trusted path, adapter-independent by
construction since all three shims converge on `finishLayout`. The same scenario is picked up by
the Node driver, the Memory driver and the browser spec automatically. Run
`npm run check:parity-fixtures`.

**Budgets.** `test-pyramid-budgets.json` holds **ratio** targets per tier plus heuristics — not
a per-file list. Run `npm run check:test-pyramid` and only touch the file if the run demands it.
Run `npm run check:write-surfaces` and confirm it stays clean; do **not** add a `@writes` tag —
nothing new writes.

### TDD steps

Interop tests are pins, not drivers, so the RED here is "the assertion fails against the
already-landed implementation" and the fix is in the pin's own expectations only if the
implementation is proven right.

**RED 1** — write group A first and run it. Any co-refusal disagreement is a real defect in
Parts 3–5: fix the source, never the expectation. The `wrap/.git` vs `wrap/.git-other` pair is
the row most likely to expose a bareness-conditioned implementation.

**RED 2** — write group B's byte reconstruction. It fails until the reconstruction reads
exactly `path` and formats the four lines with the right quoting and the leading tab on line 4.
Hex-compare or assert the exact string; do not normalise whitespace.

**RED 3** — write group B's golden allowlist table and group C. Group C is expected to skip
locally; verify the skip **warning actually prints** by running the file directly once.

**GREEN** — the suite passes (with C skipped) and the warning names the reason, the uncovered
claim, and where the claim is covered.

**REFACTOR** — collapse repeated `openRepository` + refusal-shape assertions into one local
helper per group; keep each group's `beforeAll` the single fixture builder.

### Gate

```
npx vitest run test/integration/ownership-trust-gate-interop.test.ts \
  && npx vitest run --project parity \
  && npm run check:types \
  && ./node_modules/.bin/biome check test/integration/ownership-trust-gate-interop.test.ts test/parity/scenarios/trust-defaults.scenario.ts test/parity/scenarios/index.ts
```

### Commit

`test(interop): pin the trust gate against canonical git`

## Part 7 — Document repository trust

### Context

Docs-only — no `src/` delta, no test delta. Three pages, each with a defined slice so this part
does not re-litigate what Parts 2 and 4 already wrote. The errors page belongs to Part 4 alone
and is not edited here, only linked to.

**Already landed, do not duplicate:** the three option entries in `docs/get-started/node.md`
(Part 2), which this part extends with the surviving-verb contract; and the two refusal rows on
the errors page (Part 4), which this part only links to.

**`docs/understand/security.md`** (headings at lines 1-146; `## Adapter wrapping (opt-out is
dangerous)` at 142 and `## What tsgit does NOT do` at 146 close the file). Add a
`## Repository trust` section before the closing one, covering:

- what the gate closes: `hooks/` in the discovered common dir spawned with the caller's full
  environment; `merge.<driver>.driver` as a shell command; `core.excludesFile` /
  `core.attributesFile` as attacker-named file reads; and — the row that closes *before* any
  command runs — `core.worktree` widening the containment root set up to `/`, which is
  structurally impossible when refused because the config is never read;
- that the gate is **on by default** and that the explicit-`gitDir` route is never gated,
  making the blast radius narrower than git's;
- that `unsafeRawAdapters` does **not** bypass it (that option opts out of the FS/transport
  *validators*; the verdict is computed upstream of adapter composition), which is also worth
  one sentence on that option's own JSDoc if it is not already there.

Then extend `## What tsgit does NOT do` with the residuals: an attacker who can write inside a
repository you **own** (the gate answers "who owns this", not "is this safe" — `hooks: false`
and `command: false` remain the content-side mitigations); same-uid attackers; callers who pass
`trust: 'always'`, `'*'`, or an over-wide `/*` prefix; the explicit-`gitDir` route; pointer
redirection resolved before the gate (an alien `.git` file or `commondir` chooses which
directory is judged — the gate still judges the resolved target); **Windows**, where
`process.getuid` is absent, the capability is omitted and every repository is trusted, a named
gap awaiting a Windows-hosted measurement rather than a guess; sandboxed adapters; permission
bits, which are not part of an ownership predicate; TOCTOU (one verdict per `openRepository`,
mirroring git's one per process); and deliberate **over-refusal** — tsgit may refuse a shape git
permits when the repository path is owned but the gitdir or common dir is not, with
`trustedDirectories` as the escape hatch.

**`docs/understand/repository-layout.md`** — extend `## Reading the result` (line 64) with the
three new fields, stating plainly that **a layout carrying `untrusted` or `implicitBare` must be
read as structural**: it holds only what discovery produced, so `bare` is the structural default
and no `core.bare` / `core.worktree` value participated. Add the two refusal codes to the
`## Refusals` table (line 74). Add to `## Deliberate divergences` (line 90): trust configuration
comes from `openRepository` arguments, never from any config file — global and system are
unreachable by the FS port by design and repository-local is the attacker's own file, so a
repository cannot allowlist itself; a non-absolute `trustedDirectories` entry is **refused**
where git warns and ignores; and the ownership check is POSIX-only.

**`docs/get-started/node.md`** — extend the section Part 2 opened with **the surviving-verb
contract, verbatim as a table**, because it is a contract rather than a summary:

| surface | behaviour on a refused repository |
|---|---|
| `openRepository` | resolves; `repo.layout.untrusted === true` |
| `init`, `clone` | bootstrap normally — they run no acceptance tier |
| `repo.config.get`, `.getAll`, `.getRegexp`, `.list` | succeed with an **empty repository scope**; a planted local key reports absent |
| all five `repo.config` write verbs; all six `repo.remote` verbs | refuse with `IMPLICIT_BARE_REPOSITORY`, else `DUBIOUS_OWNERSHIP` |
| everything else | the same refusals |

Add the shared-repository recipe alongside it (a CI container or network mount with mismatched
uids passes `trustedDirectories: ['/srv/checkout']`), and state that turning the gate on by
default is a **breaking behavioural change** for discovery-route callers on foreign-owned
repositories.

**The errors page is not this part's** — Part 4 owns both refusal rows outright, including the
first-in-check-order rule and the exact predicate statement. Link to it from the three pages
above; do not edit it here.

**Release notes.** The default-on change belongs in the release notes as well as the docs; if
this repo carries a changelog fragment convention, follow it, otherwise leave it for the PR body
and say so in the commit.

### TDD steps

Docs-only: the "tests" are the doc gates, run in this order.

1. **RED** — `npm run check:doc-links` fails on any relative link added above that does not
   resolve (the new pages cross-link `../use/errors.md` and `../understand/security.md`).
2. **RED** — `npm run check:spelling` (cspell) flags new vocabulary; add real words to the
   dictionary rather than rewording around them, and note that the British `-ising`/`-ised`
   gap means the full run catches what the commit hook may not.
3. **GREEN** — pages written, both checks green.
4. **REFACTOR** — read the four pages end-to-end as one story: options (get-started) → verdict
   fields (repository-layout) → threat model (security) → refusal payloads (errors). No page may
   restate another's table; each links to it.
5. **Final surface check** — `npm run docs:json` and confirm `reports/api.json` is unchanged
   since Part 5 (a docs-only part must not move it); if it moved, an earlier part skipped its
   regeneration — commit it here and say so.

### Gate

```
npm run check:doc-links \
  && npm run check:spelling \
  && npm run check:types \
  && ./node_modules/.bin/biome check docs/understand/security.md docs/understand/repository-layout.md docs/get-started/node.md
```

### Commit

`docs: document repository trust, its options and its refusals`
