# Plan — Repository-format acceptance gate

> Source: design doc `docs/design/repository-format-acceptance-gate.md` · ADRs `666, 667, 668, 682, 685, 698` (consumes `679`, refines `226, 249, 639, 654, 658, 661, 664, 678`)
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

## Orientation — read this before Part 1

This plan lands **FIRST** on the branch. Three sibling plans (`ownership-trust-gate`,
`sha256-object-format`, `reftable-ref-storage`) build on what it ships. Everything below is
verified against the worktree at this plan's baseline (`find_referencing_symbols` /
`get_symbols_overview`, not inferred from the design's prose).

**What the whole feature is.** Refuse a repository whose `core.repositoryformatversion`
exceeds 1, and — at version 1 — whose `extensions.*` carry a key git itself does not know,
on the exact tier git refuses them on, as structured data. Accept every extension git
knows; where tsgit cannot yet act on an accepted name, refuse precisely rather than
misread.

**The three-tier shape this plan creates** (ADR-682) — sibling plans extend the middle tier,
they do not create it:

```
assertRepository            = HEAD usable + discovery booleans        <- 4 surviving config reads
assertAcceptedRepository    = assertRepository + acceptance gates     <- the 11 movers   (NEW, this plan)
assertOperationalRepository = assertAcceptedRepository + eager [core]  <- 45 operational modules
```

**The sequencing contract every part must honour (orchestrator's call, binds this plan).**
ADR-667 accepts all nine extensions git knows, but SHA-256 support (`objectFormat`) and the
reftable backend (`refStorage`) land in SIBLING plans AFTER this one. Accepting those two
names now would be a lie: tsgit would misread the repository. So this plan ships a
**point-of-use refuse set** — one `ReadonlyArray<string>` constant, `UNBACKED_EXTENSIONS`, in
`src/repository/read-repository-format.ts` — holding exactly three lower-cased names:

```
'compatobjectformat'   // permanent — git itself refuses this on the reference build (§1i)
'objectformat'         // TRANSIENT — the SHA-256 sibling plan DELETES this line when its support lands
'refstorage'           // TRANSIENT — the reftable sibling plan DELETES this line when its support lands
```

Every commit is then honest: the gate accepts what git accepts, and the first operation that
would misread refuses precisely with `REPOSITORY_EXTENSION_UNSUPPORTED { extension, value }`.
**Design the set as data an implementer can shrink by deleting one array element** — a sibling
part must be one deleted line plus one flipped interop row, never a refactor. Say so in the
constant's JSDoc, in exactly those words.

**The one honest divergence this creates, and why it is accepted.** Real git *opens* a
`--object-format=sha256` / `--ref-format=reftable` repository and runs `config --list` on it;
after Part 3, tsgit refuses to open it. That is a deliberate, transient over-refusal, held for
the handful of commits between Part 3 and the sibling plans in the SAME PR. It replaces a
measured **misread** (`OBJECT_HASH_MISMATCH` on a sha256 repo, `INVALID_REF` on a reftable
repo — *unsupported reported as corrupt*), which ADR-667's standing rule ranks strictly worse.
The interop rows that pin it are explicitly labelled TRANSIENT so the sibling implementer
flips them rather than deleting them.

**Two things that are NOT this plan's, even though they are adjacent.**
`implicitBare` / `untrusted` (the ownership gate's two refusals) are the sibling's — this
plan creates `assertAcceptedRepository` with the format arm only, and leaves an explicit
insertion point above it. The `loadConfigEntry` half of ADR-679's dropped-scope guard is the
sibling's too; this plan touches only the `config-scoped-read.ts` half (§2 measures that the
format arm must NOT sit at `loadConfigEntry` — `assertDiscoveryBooleansValid` reads through
there and must keep refusing on a v99 repository).

**Deliberate cross-part file overlaps (plan-lint reports these as warnings — they are
intentional, do not merge the parts).** `src/repository/read-repository-format.ts` is touched
by Parts 1–3 because one module carries three separable stories (the codes it raises, the
version arm, the extension arms) and one 300-line atomic part would be the hardest thing in
this plan to review. `src/application/primitives/internal/repo-state.ts` is named by Part 1
(as the consumer of the new factories) and edited by Part 4. `src/application/commands/config.ts`
is edited by Part 4 and *read* by Part 7's audit. `reports/api.json` is regenerated by every
part that widens a public type — that is a mechanical regeneration, never a hand edit, and the
last regeneration subsumes the earlier ones.

**Repo-wide non-negotiables that bind every part.** Serena for all TypeScript navigation and
editing. No suppression directives of any flavour. No provenance refs (ADR / phase / backlog
numbers) in source or test. Test titles split across `describe('Given …')` >
`describe('When …')` > `it('Then …')`; AAA body with section comments; the system under test is
named `sut` (the function, never the result — the result goes in `result`). Error assertions
assert `.data` fields via try/catch, never `toThrow(ErrorClass)` alone. Guard clauses get one
isolated test per condition. `src/domain/**` is inside the 100 % coverage scope;
`src/repository/**` and `src/application/**` are outside it but Stryker mutates all of `src`.
Never commit on a red gate.

## Part 1 — The three refusal codes

### Context

**Goal.** Land the two acceptance-gate codes (ADR-668) and the one point-of-use code
(ADR-685) as domain error variants, factories, rendered details, exhaustiveness arms, and
`docs/use/errors.md` rows. Nothing raises them yet; Parts 2–5 do.

**Files to touch (exact paths).**

- `src/domain/repository/error.ts` (45 lines) — the `RepositoryError` union + factories.
  Current union members: `NOT_A_REPOSITORY`, `BARE_REPOSITORY`, `WORK_TREE_REQUIRED`,
  `WORK_TREE_CONFIG_INVALID`, `WORK_TREE_UNRESOLVABLE`, `ALREADY_INITIALIZED`. Factories are
  arrow consts returning `new TsgitError({...})`; JSDoc on each explains git's own condition.
- `src/domain/repository/index.ts` (6 lines) — the barrel. It exports
  `type { RepositoryError }` plus five factories. Note `workTreeUnresolvable` is deliberately
  **absent** from the barrel: an internal-only factory precedent. Follow it.
- `src/domain/error.ts` — `extractDetail` (`function extractDetail(data: TsgitErrorData): string`
  at line 177) is one exhaustive `switch (data.code)` ending in a
  `default: { const _exhaustive: never = data; … }` arm. The repository arms live at lines
  299–310 (`NOT_A_REPOSITORY` … `ALREADY_INITIALIZED`). `WORKING_TREE_DIRTY` (line 311) is the
  house precedent for a list-bearing code: it renders a **count**, not the list.
- `test/unit/domain/exhaustiveness.ts` — a second exhaustive switch
  (`assertExhaustiveSwitch(data: TsgitErrorData): void`) whose `never` arm is what makes
  `npm run check:types` fail if a new code is not listed. **Adding a code without editing this
  file turns the type-check red.**
- `test/unit/domain/repository/error.test.ts` (the existing suite) — two describe groups:
  `'factory data'` (one `describe('Given <factory>(…)')` > `describe('When checking data')` >
  `it('Then …')` per factory, asserting `result.data` with `toEqual`) and
  `'extractDetail message formatting (exact match)'` (a `cases: ReadonlyArray<readonly [RepositoryError, string]>`
  table driven by `it.each`, asserting `new TsgitError(data).message` **exactly**). Extend both.
- `docs/use/errors.md` — the `### Repository state` section starts at line 191, a
  `| Code | Payload | Raised when |` table. Row depth to match: the neighbouring
  `WORK_TREE_CONFIG_INVALID` and `CONFIG_BAD_BOOLEAN_VALUE` rows.
- `cspell.json` — `check:spelling` runs over `src/**/*.ts`, `test/**/*.ts`, `docs/**/*.md` and
  `*.md`, and its `words` array is a sorted lower-case allowlist. Already present:
  `repositoryformatversion`, `reftable`, `worktreeconfig`, `objectformat`,
  `compatobjectformat`, `refstorage`, `partialclone`. **Two gaps to be aware of:** the
  all-lower-case config-key spellings of `preciousObjects` and `relativeWorktrees` are NOT in
  the dictionary. Part 3 sidesteps both by building its registries from git's own camelCase
  spellings and lower-casing at construction; if any file you write ends up containing those
  two tokens literally in lower case, add them to `cspell.json`'s sorted `words` array in the
  same part rather than leaving `validate` red for the next one. Note that camelCase is split
  by cspell, so `preciousObjects` / `relativeWorktrees` in prose need no entry at all.
- `reports/api.json` — regenerate with `npm run docs:json` and commit it **in this part**.
  This is a **PRE-PUSH** gate, not a `validate` gate: a green local `validate` can still be
  followed by a rejected push. `RepositoryError` is a publicly exported type, so widening its
  union changes `api.json` even though the new factories stay internal (verified:
  `WORK_TREE_UNRESOLVABLE` appears in `reports/api.json` today despite its factory being
  off-barrel).

**Public-surface decision for this part — decided here, not later.**

| new symbol | public or internal | why + gates paid in-part |
|---|---|---|
| the three union members on `RepositoryError` | **public** (the union type is barrel-exported) | `test/unit/domain/exhaustiveness.ts` arm + `extractDetail` arm + `docs/use/errors.md` row + regenerated `reports/api.json` |
| `repositoryFormatVersionUnsupported`, `repositoryExtensionsUnsupported`, `repositoryExtensionUnsupported` factories | **internal** — NOT added to `src/domain/repository/index.ts` | only `src/repository/read-repository-format.ts` and `src/application/primitives/internal/repo-state.ts` construct them; follows the `workTreeUnresolvable` precedent, and keeps `api.json` churn to the type union alone |

Because the factories stay off the barrel, their two consumers **deep-import** them:
`src/repository/read-repository-format.ts` (Part 3) takes `repositoryExtensionUnsupported` from
`'../domain/repository/error.js'`, and `src/application/primitives/internal/repo-state.ts`
(Part 4) takes the two gate factories from `'../../../domain/repository/error.js'` — note that
that module currently imports `notARepository` / `workTreeConfigInvalid` / `workTreeRequired`
from the `'../../../domain/index.js'` **barrel**, which will not carry the new names. Deep
domain imports are normal in the application tier (`config-scoped-read.ts` already deep-imports
`'../../domain/commands/error.js'`), so `check:architecture` is unaffected.

**Exact shapes to add to `RepositoryError`** (ADR-668 §Decision, ADR-685 §Decision):

```ts
| { readonly code: 'REPOSITORY_FORMAT_VERSION_UNSUPPORTED'; readonly version: number }
| {
    readonly code: 'REPOSITORY_EXTENSIONS_UNSUPPORTED';
    readonly version: number;
    readonly extensions: ReadonlyArray<string>;
  }
| { readonly code: 'REPOSITORY_EXTENSION_UNSUPPORTED'; readonly extension: string; readonly value: string }
```

Payload rules that are load-bearing and must appear in the factories' JSDoc:

- `version` is the **parsed integer**, never the config literal — `1k` must carry `1024`.
- `extensions` names are the **lower-cased key** with the **subsection preserved verbatim**,
  joined by `.` (so `[extensions "X"] bogus` ⇒ `X.bogus`, `[extensions ""] bogus` ⇒ `.bogus`).
  Same convention `CONFIG_BAD_BOOLEAN_VALUE` already documents for its `key`.
- Singular vs plural is derivable from `extensions.length` — it is a rendering concern, never
  a payload one.
- `version` on `REPOSITORY_EXTENSIONS_UNSUPPORTED` is what selects which of git's two
  extension messages a caller reconstructs (`0` ⇒ the v1-only line, `1` ⇒ the unknown line),
  which is why the payload is total and needs no sentinel.
- `REPOSITORY_EXTENSION_UNSUPPORTED.value` carries what the config declared, because git's
  refusal is presence-triggered and value-independent — a caller never re-opens the config to
  answer "declared as what?".

**Exact rendered details** (assert these byte-for-byte in the `extractDetail` table; they keep
config-supplied text bounded by naming a count plus the first offender, per the
`WORKING_TREE_DIRTY` precedent):

```
REPOSITORY_FORMAT_VERSION_UNSUPPORTED: unsupported repository format version: 99
REPOSITORY_EXTENSIONS_UNSUPPORTED: unsupported repository extensions at format version 1: 2 (first: bogus)
REPOSITORY_EXTENSION_UNSUPPORTED: repository extension not supported: compatobjectformat = sha1
```

**`docs/use/errors.md` row content** (three rows, alphabetical inside `### Repository state`):

- `REPOSITORY_FORMAT_VERSION_UNSUPPORTED` | `version` | the effective (last-wins)
  `core.repositoryformatversion` exceeds 1. `version` is the **parsed** integer, so `1k`
  carries `1024` and `0777` carries `511`. Values ≤ 1 — including negatives — are accepted, as
  is an absent key and an absent config file. Reconstructs
  `fatal: Expected git repo version <= 1, found <version>`. Refuses every repository-needing
  verb; the four `config` read verbs survive with the repository config scope dropped.
- `REPOSITORY_EXTENSIONS_UNSUPPORTED` | `version, extensions` | at version 1, one or more
  `extensions.*` entries name a key git itself does not know; at version 0, one or more name a
  key git treats as v1-only. `version` selects which condition. `extensions` carries **every**
  offender in config-file order, duplicates included. Same tier as the version code.
- `REPOSITORY_EXTENSION_UNSUPPORTED` | `extension, value` | the repository declares an
  extension git accepts but tsgit cannot yet act on; refused at the point of use rather than
  read wrong. Distinct from the two gate codes by **tier, not severity**: the gate codes refuse
  a repository git also refuses, this refuses an operation on a repository git's format gate
  accepts. State the current membership in the row while keeping the code general.

**Mutation-resistance notes for the tests.** The `it.each` message table is one test per code —
that is what stops a `StringLiteral` mutant in one arm hiding behind another. Assert
`result.data` with `toEqual` on the full object (not field-by-field) so a dropped field is
caught.

### TDD steps

1. **RED** — in `test/unit/domain/repository/error.test.ts`, add to the `'factory data'` group:
   `describe('Given repositoryFormatVersionUnsupported(99)')` > `describe('When checking data')` >
   `it('Then code and parsed version preserved')`, asserting
   `{ code: 'REPOSITORY_FORMAT_VERSION_UNSUPPORTED', version: 99 }`.
   Expected failure: `repositoryFormatVersionUnsupported` is not exported from
   `src/domain/repository/error.js` — TS2305 at import, suite fails to load.
2. **RED** — same group: `repositoryExtensionsUnsupported(1, ['bogus', 'alsoBogus'])` ⇒
   `{ code: 'REPOSITORY_EXTENSIONS_UNSUPPORTED', version: 1, extensions: ['bogus', 'alsoBogus'] }`,
   and a second test at `version: 0` with `['objectformat']` — the two conditions are separate
   guards downstream, so they get separate tests here. Same expected failure.
3. **RED** — same group: `repositoryExtensionUnsupported('compatobjectformat', 'sha1')` ⇒
   `{ code: 'REPOSITORY_EXTENSION_UNSUPPORTED', extension: 'compatobjectformat', value: 'sha1' }`.
   Same expected failure.
4. **RED** — add three rows to the `extractDetail` `cases` table with the exact strings above.
   Expected failure: `_exhaustive` never-arm returns `String(data)`, so the message is
   `REPOSITORY_FORMAT_VERSION_UNSUPPORTED: [object Object]` — a mismatch, not a throw.
5. **GREEN** — add the three union members to `RepositoryError` in
   `src/domain/repository/error.ts` with the documented JSDoc; add the three factories
   (arrow consts, matching the file's style); do **not** touch
   `src/domain/repository/index.ts`. Add the three `case` arms to `extractDetail`
   (`src/domain/error.ts`) beside the existing repository arms. Add the three codes to
   `test/unit/domain/exhaustiveness.ts` — without it `npm run check:types` is red.
6. **GREEN** — add the three rows to `docs/use/errors.md` `### Repository state`, then run
   `npx cspell lint docs/use/errors.md` and fix any gap it reports by adding the word to
   `cspell.json`'s sorted `words` array.
7. **REFACTOR** — re-read the three factories: each must be < 20 lines, no boolean params, no
   magic values. Confirm `npx vitest run test/unit/domain/repository/error.test.ts` is green,
   then run `npm run docs:json` and commit the regenerated `reports/api.json` as part of this
   part's single commit.

### Gate

```
npx vitest run test/unit/domain/repository/error.test.ts \
  && npm run check:types \
  && ./node_modules/.bin/biome check src/domain/repository/error.ts src/domain/error.ts test/unit/domain/repository/error.test.ts test/unit/domain/exhaustiveness.ts
```

Plus, before committing: `npm run docs:json` (regenerates `reports/api.json`) and
`npx cspell lint docs/use/errors.md src/domain/repository/error.ts`.

### Commit

```
feat(domain): add the repository-format and unsupported-extension refusal codes
```

## Part 2 — The version arm: read, refuse above the ceiling, carry the verdict

### Context

**Goal.** Resolve `core.repositoryformatversion` from `<commonDir>/config` with git's two
distinct resolution models on one key, refuse above a **named ceiling**, and carry the verdict
as a frozen field on the layout so the command tier can read it synchronously.

**The module being changed — `src/repository/read-repository-format.ts` (168 lines).** Read it
whole before editing. Its current shape:

- `RepositoryFormat` (line 14): `{ bare: boolean | undefined; worktree: string | undefined; worktreeConfig: boolean }`.
- Section/key constants at lines 20–26 (`CORE_SECTION`, `EXTENSIONS_SECTION`, `BARE_KEY`,
  `WORKTREE_KEY`, `WORKTREE_CONFIG_KEY`, `CONFIG_FILE`, `WORKTREE_CONFIG_FILE`).
- `ScannedEntry` (line 29): `{ value: string | null; line: number }` — `line` is **1-based**
  (`token.startLine + 1`).
- `lastTopLevelEntry(tokens, section, key)` (line 39) — last-wins, case-insensitive on section
  and key, **skips subsections** (`currentSubsection !== undefined ⇒ continue`), matches one key.
  It carries a `// Stryker disable next-line StringLiteral: equivalent` comment on line 44 —
  leave it exactly as is.
- `scanConfigFile(probe, path)` (line 73) — `probe.stat`; absent **or non-regular** ⇒
  `undefined` (deliberate leniency for the `init`/`clone` bootstrap, and a FIFO guard);
  `probe.readUtf8`; `tokenizeConfig(text, path)`; returns
  `{ bare, worktree, worktreeConfig }` as `ScannedEntry | undefined` triples. **The tokens are
  currently discarded.**
- `resolveBare` (line 97) — throws `configBadBooleanValue('core.bare', source, value)`;
  valueless ⇒ `true`.
- `resolveWorktree` (line 106) — throws `configMissingValue('core.worktree', source, line)`.
- `isWorktreeConfigActive` (line 112) — a malformed boolean is **inert** here (the
  discovery-tier gate in `assertDiscoveryBooleansValid` is what raises it). Do not change this.
- `readRepositoryFormat(probe, gitDir, commonDir, pathPolicy)` (line 136) — scans
  `<commonDir>/config`, conditionally scans `<gitDir>/config.worktree`, `pickScoped`s
  `bare`/`worktree`, returns.
- `pickScoped` (line 162) — scoped wins when present.

**The integer grammar already exists — do not write one.** `parseGitInt(value: string | null): GitIntResult`
lives at `src/domain/config/config-ini.ts:750`; it returns `{ ok: true, value: number }` or
`{ ok: false, reason: 'invalid unit' | 'out of range' }` and reproduces **every** measured
version literal: `0x1` ⇒ 1, `0777` ⇒ 511, `1k` ⇒ 1024, `08` ⇒ `invalid unit`, `+1`/`-1`, leading
whitespace, both int64 bounds.

**The two resolution models on one key — this is the part's whole subtlety.** Measured on git
2.55.0 (design §1a):

| config | verdict |
|---|---|
| `= 0`, then `= 99`, then `= 0` | **accepted** — the effective value is **last-wins** |
| `= 0`, `= 0`, `= 99` | refused (99) |
| `= abc` early, then `= 0` later | refused with `bad numeric … 'abc'` — a parse failure fires **per line** and is NOT rescued by a later valid line |
| `= 0` first, then `= abc` | refused with `bad numeric … 'abc'` |
| `[CoRe]` / `RePoSiToRyFoRmAtVeRsIoN = 99` | refused — section and key are case-insensitive |
| `[core "x"] repositoryformatversion = 99` | **accepted (ignored)** — a subsectioned `core` is not `[core]` |
| key absent entirely | accepted, and the result is **`undefined`** — a third state, never `0` |
| the whole `config` file absent | accepted, `undefined` |

So: **any** malformed occurrence throws (streaming, in file order, first failure wins), while
the accept/refuse decision uses the **last** well-formed occurrence. `lastTopLevelEntry` gives
half of it; the streaming half is new. This is `core.maxTreeDepth`'s split
(`src/application/primitives/internal/repo-state.ts:160-180` documents the mirror case) with
the halves swapped — read that JSDoc; do not try to fold the version into
`pickLowerLine`.

**Genericity (design §6, binding).** The comparison is
`version > MAX_REPOSITORY_FORMAT_VERSION` with the ceiling a **named constant = 1** —
**never** membership in `{0, 1}`. §1a's `-1` row proves a membership test refuses where git
accepts, and a named ceiling makes a future v2 a one-line change.

**Scoping asymmetry (design §1e, R7 — the trap).** The two key families read from the same
Stage-2 scan have **different** scoping rules. `core.bare` / `core.worktree` **are** scoped
(`<gitDir>/config.worktree` wins). The format keys are **not**: a
`repositoryformatversion = 99` or an `extensions.*` planted in `config.worktree` is **inert**,
even with `extensions.worktreeConfig = true` at v1. So `pickScoped` must NOT be applied to the
version, and the streaming grammar throw must NOT run over the scoped file's tokens. The
natural refactor — one shared `pickScoped` over all four keys — would be **wrong**.

**Implementation shape to land** (keeps the one-scan property and keeps the throw local to
`<commonDir>/config`):

- Widen `ScannedFormat` (line 67) with `readonly tokens: ReadonlyArray<ConfigToken>` and have
  `scanConfigFile` return the array it already builds. Only the **local** scan's tokens are
  ever consulted; the scoped scan's are ignored (that ignoring IS §1e).
- Add `const MAX_REPOSITORY_FORMAT_VERSION = 1;` and
  `const VERSION_KEY = 'repositoryformatversion';`
- Add a module-local `resolveFormatVersion(tokens, source): number | undefined` — walk the
  tokens in file order tracking `currentSection` / `currentSubsection` exactly as
  `lastTopLevelEntry` does; for every top-level `[core] repositoryformatversion` entry run
  `parseGitInt(entry.value)`; on the FIRST `ok: false` throw
  `configBadNumericValue('core.repositoryformatversion', source, entry.value ?? '', parsed.reason)`
  — note `?? ''`, because a valueless entry is reported by git as `value ''`; otherwise keep
  the value and continue, returning the last one (or `undefined` when the key never appeared).
- Add the refusal type in `src/ports/context.ts` (see below) and import it here.
- Widen `RepositoryFormat` with `readonly refusal: RepositoryFormatRefusal | undefined`.
  In this part only the version arm can populate it:
  `version !== undefined && version > MAX_REPOSITORY_FORMAT_VERSION ⇒ { kind: 'version', version }`.

**Ordering inside `readRepositoryFormat`** (design §1d's chain, steps 2 then 3 then 4):
tokenize (may throw `CONFIG_PARSE_ERROR`) → resolve the version grammar (may throw
`CONFIG_BAD_NUMERIC_VALUE`) → scan `config.worktree` if active → `resolveBare` /
`resolveWorktree` (may throw) → compute the carried refusal. Pin the one measured row that
constrains this: **v99 + `core.bare = banana` ⇒ the bad-boolean fatal wins**, because the
version verdict is *carried*, never thrown.

**Where the refusal type lives — public-surface decision, decided here.**

| new symbol | public or internal | why + gates paid in-part |
|---|---|---|
| `RepositoryFormatRefusal` (the discriminated union) | **public** — declared in `src/ports/context.ts` beside `RepositoryLayout`, re-exported from `src/ports/index.ts` (which already exports `RepositoryLayout` on line 10) | it is the payload of a public layout field callers read as `repo.ctx.layout.formatRefusal`; gate = regenerated + committed `reports/api.json` (PRE-PUSH gate) |
| `RepositoryLayout.formatRefusal?` (`src/ports/context.ts`, beside `workTreeConfigBogus` at line 46) | **public** | same `api.json` gate; JSDoc required |
| `RepositoryLayoutInput.formatRefusal?` (`src/repository.ts:150-164`, beside `workTreeConfigBogus` at line 162) | **public** | same `api.json` gate |
| `MAX_REPOSITORY_FORMAT_VERSION`, `resolveFormatVersion` | **internal** — module-local in `read-repository-format.ts`, not exported | no gates |

Do **not** put `RepositoryFormatRefusal` in `src/domain/` — `src/ports/context.ts` already
imports domain types (`RefName`, `HashConfig`), the reverse would invert the dependency rule,
and `read-repository-format.ts` already imports from `src/ports/` (`LayoutProbe`).

```ts
/** … JSDoc: absent means accepted; `version` is always the PARSED integer. */
export type RepositoryFormatRefusal =
  | { readonly kind: 'version'; readonly version: number }
  | {
      readonly kind: 'extensions';
      readonly version: number;
      readonly extensions: ReadonlyArray<string>;
    };
```

**Plumbing the field through the layout.** `finishLayout`
(`src/repository/resolve-layout.ts:190`) is Stages 2–4 and is the ONLY caller of
`readRepositoryFormat` anywhere in `src/` (verified with `find_referencing_symbols`) —
line 199: `const fmt = await readRepositoryFormat(probe, outcome.gitDir, commonDir, pathPolicy);`.
Its return object (lines 213–219) uses conditional spreads for optional fields
(`...(workTreeConfigBogus === true ? { workTreeConfigBogus: true as const } : {})`). Follow
that exactly: `...(fmt.refusal !== undefined ? { formatRefusal: fmt.refusal } : {})` — omitting
the key when absent is what keeps every existing `toStrictEqual` layout assertion green.
`src/repository/fixed-entry-layout.ts:39` (the browser shim) routes through the same
`finishLayout`, so it inherits the field for free. `syntheticFallbackLayout`
(`resolve-layout.ts:160`) deliberately reads no config and must NOT gain the field.
`src/repository.ts:467` already `deepFreeze`s the layout, and `src/repository/deep-freeze.ts`
walks arrays via `Object.keys`, so the `extensions` array is frozen with no extra work.

**Tests to extend.**

- `test/unit/repository/read-repository-format.test.ts` (412 lines). Harness already in
  place: `new MemoryFileSystem({ rootDir: '/repo' })`, `fileSystemLayoutProbe(fs)`,
  `posixPolicy`, config written with `await fs.writeUtf8('/repo/.git/config', …)`, and
  `readRepositoryFormat(fileSystemLayoutProbe(fs), '/repo/.git', '/repo/.git', posixPolicy)`.
  The file has **six** `toStrictEqual` assertions on the whole result object; all six **will
  break** when `refusal` is added — update them to include `refusal: undefined`. That breakage
  is expected and is the cheapest possible proof the field is total.
- `test/unit/repository/resolve-layout.test.ts` (32 KB) — one group proving `finishLayout`
  carries a v99 verdict onto the layout and omits the key on a v0 repository.

**Interop rows this part owns** — create
`test/integration/repository-format-acceptance-interop.test.ts`. Model on
`test/integration/config-boolean-interop.test.ts` and
`test/integration/max-tree-depth-config-interop.test.ts`. Non-negotiable mechanics:

- The file needs a `@proves` JSDoc header or `check:test-pyramid` reports it:
  `surface: repo-state`, `bucket: cross-tool-interop`, `unique: <one sentence>`.
- `describe.skipIf(!GIT_AVAILABLE)(…)`; helpers from `./interop-helpers.js`:
  `GIT_AVAILABLE`, `runGit`, `runGitEnv`, `tryRunGit`, `tryRunGitWithExit`. Never spawn `git`
  any other way: those helpers scrub every `GIT_*` variable through a shared `SAFE_ENV`, and a
  bare `spawnSync('git', …)` inherits `GIT_DIR` from the husky pre-push hook and silently
  operates on the wrong repository. `-C <dir>` does **not** override an inherited `GIT_DIR`.
- **ONE shared `beforeAll(fn, 60_000)`** builds a single one-commit source repository; each row
  copies it. The default 10 s hook timeout fails under full-validate concurrency — this is a
  known, repeatedly-hit failure in this repo. Do not use a per-test `beforeEach` that runs
  `git init`.
- Fixtures written with **raw `writeFile`** on `.git/config`: git's CLI cannot emit a valueless
  entry, and file-line order is load-bearing in §1a.
- tsgit is driven through the `openRepository` facade from `src/index.node.js`. At this part
  the verdict is observable as `repo.ctx.layout.formatRefusal` — assert **that**, plus git's
  exact stderr **reconstructed from tsgit's structured fields**
  (`` `fatal: Expected git repo version <= 1, found ${refusal.version}` ``). The library emits
  no display string; the test builds it.

Rows for this part (design Test strategy 1–4):

1. v0 accepted; v1 with no extensions accepted (`formatRefusal === undefined`, git exits 0).
2. `2`, `99`, `1k` refused — the `1k` row is the one that proves the payload carries the
   **parsed** integer (`found 1024`), and it is the single most valuable row in the suite.
3. `-1` and `0x1` accepted, and the absent key accepted — the rows a membership test, or an
   absent-⇒-`0` default, would fail.
4. `abc` and `9223372036854775808` ⇒ `openRepository` throws `CONFIG_BAD_NUMERIC_VALUE` with
   `reason` `'invalid unit'` / `'out of range'`, reconstructing git's single-line
   `fatal: bad numeric config value '<v>' for 'core.repositoryformatversion' in file <F>: <reason>`.

### TDD steps

1. **RED** — `test/unit/repository/read-repository-format.test.ts`:
   `describe('Given core.repositoryformatversion = 99')` >
   `describe('When readRepositoryFormat runs')` >
   `it('Then it carries a version refusal and throws nothing')`, asserting
   `result.refusal` `toStrictEqual({ kind: 'version', version: 99 })`.
   Expected failure: `refusal` does not exist on `RepositoryFormat` — TS2339 / `undefined`.
2. **RED** — one test per accepted literal, as a single `it.each` over a uniform table
   (`0`, `1`, `-1`, `+1`, `' 1 '`, `0x1`) asserting `result.refusal` is `undefined`; then a
   separate `it.each` over the refused literals (`2`, `3`, `99`, `0777` ⇒ 511, `1k` ⇒ 1024)
   asserting the carried `{ kind: 'version', version }` with the **parsed** value.
3. **RED** — grammar rows, each its own test with try/catch + direct `.data` assertions
   (never `toThrow`): `abc`, `''` (empty value), `1.0`, `08`, a **valueless** entry (no `=`),
   `9223372036854775808`, `-9223372036854775809`, `999999999999999999999999999999`. Assert
   `{ code: 'CONFIG_BAD_NUMERIC_VALUE', key: 'core.repositoryformatversion', source, value, reason }`
   with `reason` isolated per arm (`'invalid unit'` vs `'out of range'`) — one test per arm, so
   a mutant that collapses the two reasons cannot hide.
4. **RED** — the four resolution rows, each as its **own** test because they are separate
   guards: last-wins accepted (`0`, `99`, `0`), last-wins refused (`0`, `0`, `99`),
   early-malformed (`abc` then `0` ⇒ still throws), late-malformed (`0` then `abc` ⇒ throws).
5. **RED** — case-insensitivity (`[CoRe]` + `RePoSiToRyFoRmAtVeRsIoN = 99` ⇒ refused) and the
   `[core "x"] repositoryformatversion = 99` no-op (⇒ `refusal === undefined`).
6. **RED** — §1e: `repositoryformatversion = 99` planted in `<gitDir>/config.worktree` with
   `extensions.worktreeConfig = true` at v1 in `<commonDir>/config` is **inert**
   (`refusal === undefined`); and, as the mirror, a `core.bare` planted there still **wins**.
   Two tests, so the asymmetry is pinned from both sides.
7. **RED** — §1d step 3 beats step 4: v99 **plus** `core.bare = banana` throws
   `CONFIG_BAD_BOOLEAN_VALUE` and never returns a verdict.
8. **RED** — `test/unit/repository/resolve-layout.test.ts`: a v99 repository's finished layout
   carries `formatRefusal`; a v0 repository's layout has **no** `formatRefusal` key
   (`expect('formatRefusal' in layout).toBe(false)` — proving the conditional spread, not just
   an undefined read).
9. **RED** — create `test/integration/repository-format-acceptance-interop.test.ts` with the
   `@proves` header, the shared `beforeAll(fn, 60_000)` fixture, and rows 1–4 above.
   Expected failure: `repo.ctx.layout.formatRefusal` is `undefined` on the v99 fixture.
10. **GREEN** — implement in this order: `RepositoryFormatRefusal` in `src/ports/context.ts`
    + `src/ports/index.ts`; `formatRefusal?` on `RepositoryLayout` and on
    `RepositoryLayoutInput` (`src/repository.ts`); `tokens` on `ScannedFormat`;
    `MAX_REPOSITORY_FORMAT_VERSION`, `VERSION_KEY`, `resolveFormatVersion`; the `refusal` field
    on `RepositoryFormat`; the conditional spread in `finishLayout`.
11. **REFACTOR** — `readRepositoryFormat` must stay under 20 lines: extract the version arm
    into a named helper rather than inlining the predicate. Update the existing
    `toStrictEqual` assertions in the read test to carry `refusal: undefined`. Re-read §1e and
    confirm no `pickScoped` call touches the version. Regenerate and commit
    `reports/api.json` (`npm run docs:json`) — three public type surfaces changed.

### Gate

```
npx vitest run test/unit/repository/read-repository-format.test.ts test/unit/repository/resolve-layout.test.ts test/integration/repository-format-acceptance-interop.test.ts \
  && npm run check:types \
  && ./node_modules/.bin/biome check src/repository/read-repository-format.ts src/repository/resolve-layout.ts src/ports/context.ts src/ports/index.ts src/repository.ts test/unit/repository/read-repository-format.test.ts test/unit/repository/resolve-layout.test.ts test/integration/repository-format-acceptance-interop.test.ts
```

Plus `npm run docs:json` before committing.

### Commit

```
feat(repository): refuse a repository format version above the supported ceiling
```

## Part 3 — The extension arms and the unbacked-extension refuse set

### Context

**Goal.** Enumerate every `[extensions]` entry from `<commonDir>/config` (subsectioned ones
included), fire the two version-selected extension arms, and refuse at open the accepted names
tsgit cannot yet act on.

**Read first:** Part 2's finished `src/repository/read-repository-format.ts`, and design
§§1b, 1c, 1i, 3. This part completes the module.

**Why `lastTopLevelEntry` cannot be reused.** It skips subsections
(`currentSubsection !== undefined ⇒ continue`) and matches exactly one key. The acceptance
check needs **every** entry under an `[extensions]` header, subsectioned ones included, in
file order, with duplicates preserved. Write a sibling enumerator over the same
`ConfigToken[]`. `ConfigToken` (`src/domain/config/config-ini.ts:38-64`) has a `'header'`
variant carrying `section` / `subsection` / `line` and an `'entry'` variant carrying `key` /
`value: string | null` / `startLine` (0-based) / `endLine`.

**Enumerator shape to land** (exported, because the property test needs it and knip tolerates
test-only `src` exports — `__resetSectionsCacheForTests` in `config-scoped-read.ts` is the live
precedent):

```ts
export interface ExtensionEntry {
  /** Reported name: `subsection === undefined ? key : `${subsection}.${key}`` — key ALWAYS lower-cased, subsection ALWAYS verbatim. */
  readonly name: string;
  /** The lower-cased key alone; registry lookups use this and only when `subsection === undefined`. */
  readonly key: string;
  readonly subsection: string | undefined;
  readonly value: string | null;
  /** 1-based, `token.startLine + 1` — matches `ScannedEntry.line`. */
  readonly line: number;
}

export const enumerateExtensionEntries = (
  tokens: ReadonlyArray<ConfigToken>,
): ReadonlyArray<ExtensionEntry> => …
```

**Git's registry — two constants, and they describe GIT, not tsgit's capabilities** (design
§6, ADR-667). Neither shrinks when tsgit lacks support for a name and neither grows when tsgit
gains it; only a new git release moves them.

Spell the members in **git's own documented camelCase** and lower-case at construction: it
keeps the constants readable against git's docs, keeps the comparison total (every lookup is
against a lower-cased key), and keeps `check:spelling` green without new dictionary entries.

```ts
const lowerCasedSet = (names: ReadonlyArray<string>): ReadonlySet<string> =>
  new Set(names.map((name) => name.toLowerCase()));

// git 2.55.0 knows exactly these nine. This describes GIT, not tsgit's capabilities.
const GIT_KNOWN_EXTENSIONS = lowerCasedSet([
  'noop', 'noop-v1', 'worktreeConfig', 'preciousObjects', 'partialClone',
  'relativeWorktrees', 'objectFormat', 'compatObjectFormat', 'refStorage',
]);
// The five git refuses at version 0.
const GIT_V1_ONLY_EXTENSIONS = lowerCasedSet([
  'noop-v1', 'objectFormat', 'compatObjectFormat', 'refStorage', 'relativeWorktrees',
]);
```

**The three literal, independent predicates** (design §1c — an absent version is a THIRD
state and must never be folded into `0`):

```
refuse VERSION   when version > MAX_REPOSITORY_FORMAT_VERSION           (Part 2, already landed)
refuse UNKNOWN   when version >= 1 and unknown names are present
refuse V1_ONLY   when version === 0 and v1-only names are present
```

Measured cross-table that makes the absent state load-bearing:

| version | + a v1-only name (`objectFormat`) | + an unknown name (`bogus`) |
|---|---|---|
| key absent | **accepted** | **accepted** |
| `-5`, `-1` | **accepted** | **accepted** |
| `0` | refused (v1-only) | accepted (ignored) |
| `1` | accepted | refused (unknown) |
| `2` / `99` | refused (version) | refused (version) |

The v1-only arm keys on `version === 0` **exactly** — any relaxation to `<= 0` refuses three
shapes git accepts. Membership rules:
`unknown = entries.filter(e => e.subsection !== undefined || !GIT_KNOWN_EXTENSIONS.has(e.key))` —
a subsectioned spelling of a known name is **not** known. `v1Only` counts only
`e.subsection === undefined && GIT_V1_ONLY_EXTENSIONS.has(e.key)`. Both map to `e.name` and
preserve file order and duplicates.

**Measured list shapes to pin** (design §1c; `<TAB>`/`<LF>` are literal bytes in git's stderr,
which the interop test reconstructs — the payload carries names only):

| condition | reported names |
|---|---|
| v1, one unknown | `['bogus']` |
| v1, two unknown | `['bogus', 'alsoBogus']` — file order |
| v1, three unknown (`zzz`, `aaa`, `mmm`) | `['zzz', 'aaa', 'mmm']` — **config-file order, never sorted** |
| v1, the same unknown name twice | listed **twice** |
| v1, unknown **valueless** | same single-name refusal — the value is never consulted |
| v1, `[extensions "X"] bogus = 1` | `['X.bogus']` — subsection verbatim |
| v1, `[extensions ""] bogus = 1` | `['.bogus']` |
| v1, `[extensions "x"] worktreeConfig = true` | a subsectioned known name is **not** known |
| v0, one v1-only | `['objectFormat']`-shaped |
| v0, v1-only **and** unknown together | the v1-only refusal; the unknown name is ignored |

**One discrepancy in the design you must settle empirically, not by reading.** Design §1c's
prose rule says names are the **lower-cased key** with the subsection verbatim, and its §1i row
shows `x.compatobjectformat` (lower-cased). But one §1c table cell shows `x.worktreeConfig`
(camel). They cannot both be right. Implement the **stated rule** (lower-cased key, subsection
verbatim) — it is consistent with §1i's measured bytes and with `CONFIG_BAD_BOOLEAN_VALUE`'s
documented `key` convention — and **pin it against real git in the interop row** with a
subsectioned mixed-case key. If real git disagrees, git wins and you change the
implementation, not the test.

**The unbacked refuse set — the sequencing contract (see this plan's Orientation).**

```ts
/**
 * Extension names git accepts that tsgit accepts at the gate but cannot yet act on.
 * Each is refused precisely at open rather than misread. DELETE an entry — one array
 * element, nothing else — the moment its support lands; the entry IS the promise that
 * nothing reads the repository wrong.
 */
const UNBACKED_EXTENSIONS: ReadonlyArray<string> = [
  'compatobjectformat',
  'objectformat',
  'refstorage',
];
```

`compatobjectformat` is permanent: git itself refuses it on the reference build
(`fatal: compatibility hash algorithm support requires Rust`), on **every** tier —
`config --list` and `rev-parse --git-dir` included. `objectformat` and `refstorage` are
**transient**, deleted by the SHA-256 and reftable sibling plans respectively, in the same PR.

**The refuse-set predicate — narrow, and every guard is independent** (design §1i):

```
refuse UNBACKED  when the format verdict ACCEPTED the repository
                 and version === 1
                 and a TOP-LEVEL entry whose lower-cased key is in UNBACKED_EXTENSIONS is present
                 and it has a value (not git NULL)
```

Every other state is answered by an earlier step: absent and negative versions accept
outright, `0` takes the v1-only arm, `> 1` takes the version arm, a subsectioned spelling is an
unknown name, and a valueless one is a config-syntax refusal. The value is never consulted
beyond being present — `sha1` and `sha256` refuse identically.

`version === 1` is the faithful predicate and is **measured** for `compatObjectFormat`: git
*accepts and operates* an absent-version or negative-version repository carrying it, so
refusing there would over-reach. Applying the same predicate uniformly leaves one known,
unmeasured residual: a repository with the version key **absent** and
`extensions.objectFormat = sha256` is accepted by tsgit today and would be misread. It is
out of scope here (git's own behaviour in that corner is unmeasured, and the SHA-256 sibling
design owns object-format reading) — escalate it as a blocker
(`{ unit, reason, ≤3 options }`) if you believe it must be closed here; do not widen the
predicate on a guess.

**Measured precedence rows this arm must not break** (design §1d, all four are separate tests):

| fixture | winner |
|---|---|
| v1 + `compatObjectFormat` + `core.bare = banana` | the bad-boolean fatal |
| v1 + `compatObjectFormat` + `extensions.worktreeConfig = banana` | the bad-boolean fatal |
| v1 + `compatObjectFormat` + `extensions.bogus = 1` | the **format verdict** (unknown-extension) |
| v99 + `compatObjectFormat` | the **version** arm |
| v1 + `compatObjectFormat` + `core.sparseCheckout = banana` | the **compat refusal** wins (the eager `[core]` gate is command-time) |

Row 1 falls out for free: `resolveBare` already throws before the refuse-set arm runs. **Row 2
does not** — `isWorktreeConfigActive` treats a malformed boolean as inert here, and the
`assertDiscoveryBooleansValid` gate that raises it does not run until first command. So the
refuse-set arm must, immediately before throwing, check the local scan's
`extensions.worktreeConfig` entry with `parseGitBoolean` and, when it fails, throw
`configBadBooleanValue('extensions.worktreeconfig', localPath, entry.value)` instead. Scope
that guard to the refuse-set arm alone — do **not** make `isWorktreeConfigActive` throwing in
general, which would change behaviour for repositories that carry no refuse-set name.

**The valueless arm.** A valueless top-level refuse-set entry at v1 must throw
`configMissingValue(\`extensions.${entry.key}\`, localPath, entry.line)` — git reports
`error: missing value for 'extensions.compatobjectformat'` + `fatal: bad config line N`, and
`CONFIG_MISSING_VALUE` is the code that already reconstructs that pair. Scope it to the
refuse-set names: the general "valueless value-bearing extension" grammar (e.g.
`partialClone`) is explicitly out of scope for this feature.

**Placement inside `readRepositoryFormat`.** Compute the carried verdict first; if it is
`undefined`, run the refuse-set arm; then return. This makes the ordering a **data dependency**
rather than a rule someone has to remember.

**Imports this part adds** to `src/repository/read-repository-format.ts`:
`repositoryExtensionUnsupported` from `'../domain/repository/error.js'` (a deep import — Part 1
kept it off the domain barrel on purpose). `configBadBooleanValue`, `configMissingValue` and
`parseGitBoolean` are **already imported** by this module; reuse them.

**Property test — the one honest candidate** (design's own verdict under CLAUDE.md's four
lenses). The extension **enumerator** earns a sibling on lens 4 (counting/order invariant); the
version parse delegates to `parseGitInt` (its coverage lives there) and the acceptance
predicate is a closed nine-element lookup whose only oracle would be the registry itself (a
tautology). Land
`test/unit/repository/read-repository-format.properties.test.ts` with generators added to the
existing `test/unit/repository/arbitraries.ts` (which today exports `arbSegmentChar()` and
`arbSegment()` — extend it, do not create a second file). Property: for a generated
`[extensions]` block of N entries, `enumerateExtensionEntries(tokenizeConfig(text, path))`
returns exactly N entries, in the same order, each `name` subsection-qualified and
key-lower-cased. `numRuns: 100` (composition/invariant tier). Never commit a seed.

**Tests to extend.** `test/unit/repository/read-repository-format.test.ts` (Part 2's version);
new `test/unit/repository/read-repository-format.properties.test.ts`;
`test/integration/repository-format-acceptance-interop.test.ts` (Part 2 created it).

**Interop rows this part owns** (design Test strategy 5, 6, 7, 13, 14):

5. v1 + one unknown; v1 + three unknown in file order; v1 + a subsectioned unknown — each
   reconstructing the singular/plural header and the `\t`-indented, lower-cased name lines
   from tsgit's `extensions` array.
6. v0 + `objectFormat` (v1-only refusal) and v0 + `bogus` (accepted) — the pair that proves the
   version-conditioned split.
7. **The nine-name acceptance sweep** — each of git's nine planted at v1. For the six backed
   names, both tools accept (`formatRefusal === undefined`, git exits 0). For the three in
   `UNBACKED_EXTENSIONS`, git accepts the *gate* while tsgit throws
   `REPOSITORY_EXTENSION_UNSUPPORTED` at open. **Mark those three rows
   `TRANSIENT — flip when <name> support lands` in a comment**; the compat row is permanent and
   is co-truth (git refuses every verb too). This sweep is the regression detector for the
   registry constant against a future git.
13. **The `compatObjectFormat` version matrix as co-truth**: version absent ⇒ both tools operate
    the repository; `-1` ⇒ both operate; `0` ⇒ both take the v1-only arm; `1` ⇒ both refuse
    (git on every verb including `config --list`; tsgit at `openRepository`); `2`/`99` ⇒ both
    take the version arm. Plus the valueless row ⇒ `CONFIG_MISSING_VALUE`, and the
    subsectioned row ⇒ the unknown arm. The `= 1` row is what will detect a future git gaining
    the Rust-backed support; the surrounding rows are what stop the refusal over-reaching.
14. A real `git init --object-format=sha256` repository and a real `git init --ref-format=reftable`
    repository — assert the **gate's** verdict only. Today that means tsgit throws
    `REPOSITORY_EXTENSION_UNSUPPORTED` at open; label both rows TRANSIENT. **Capability-probe
    both rows** rather than assuming the installed git supports them: run the `git init` in a
    `mktemp` throwaway once inside the shared `beforeAll` and `skipIf` the row when it fails
    (`--object-format=sha256` needs git ≥ 2.29, `--ref-format=reftable` needs git ≥ 2.45).

### TDD steps

1. **RED** — `enumerateExtensionEntries` unit tests: the ten list shapes in the table above, as
   one `it.each` over a uniform `{ config, expected }` table (they share one oracle shape).
   Expected failure: the function does not exist.
2. **RED** — the two extension arms as an `it.each` sweep over each of the nine names ×
   {absent version, v0, v1} plus an unknown name in the same three states, with a uniform
   oracle (`accept` / `v1-only-refuse` / `unknown-refuse`). The **absent** column is what stops
   `0` and "absent" being collapsed — do not drop it. Exclude the three `UNBACKED_EXTENSIONS`
   × v1 cells from the sweep's oracle (they throw rather than carry) and assert them separately
   in step 4.
3. **RED** — the v0 mixed row: a v1-only name **and** an unknown name together ⇒ the v1-only
   refusal, unknown ignored.
4. **RED** — the refuse-set arm, one isolated test per guard (CLAUDE.md requires each guard
   triggered alone): absent version accepts; `-1` accepts; `0` takes the v1-only arm; `2`/`99`
   take the version arm; a subsectioned `[extensions "x"] compatObjectFormat` takes the
   unknown arm; a valueless entry raises `CONFIG_MISSING_VALUE` with
   `key: 'extensions.compatobjectformat'` and the 1-based line; and only a top-level valued
   entry at version exactly 1 throws
   `{ code: 'REPOSITORY_EXTENSION_UNSUPPORTED', extension, value }`. Repeat the throwing row
   once per `UNBACKED_EXTENSIONS` member so deleting an element is visibly one test's worth of
   change.
5. **RED** — the four precedence rows from the table above, each its own test.
6. **RED** — the property sibling: N generated `[extensions]` entries ⇒ N names in order,
   subsection-qualified. Expected failure: the enumerator is not yet exported.
7. **RED** — interop rows 5, 6, 7, 13, 14.
8. **GREEN** — implement `ExtensionEntry`, `enumerateExtensionEntries`, the two registry
   constants, the two extension predicates folded into the existing refusal computation, then
   `UNBACKED_EXTENSIONS` and the refuse-set arm with its two precedence guards.
9. **REFACTOR** — every function under 20 lines; the predicates read as three literal
   conditions, not a nested chain; no magic strings outside the two named registries and
   `UNBACKED_EXTENSIONS`. Re-read the `UNBACKED_EXTENSIONS` JSDoc and confirm it says, in
   words, that a sibling deletes one element and nothing else. **Stryker triage note for the
   later mutation phase:** the unknown arm's `version >= 1` has an `=== 1` mutant that is
   provably equivalent (the version arm already returned for `> 1`) — prove it against the
   final code before suppressing anything; do not add a suppression pre-emptively.

### Gate

```
npx vitest run test/unit/repository/read-repository-format.test.ts test/unit/repository/read-repository-format.properties.test.ts test/integration/repository-format-acceptance-interop.test.ts \
  && npm run check:types \
  && ./node_modules/.bin/biome check src/repository/read-repository-format.ts test/unit/repository/read-repository-format.test.ts test/unit/repository/read-repository-format.properties.test.ts test/unit/repository/arbitraries.ts test/integration/repository-format-acceptance-interop.test.ts
```

### Commit

```
feat(repository): accept every extension git knows and refuse the ones tsgit cannot back
```

## Part 4 — The third assert tier and the eleven movers

### Context

**Goal.** Add `assertAcceptedRepository` between the two existing asserts, move the eleven
non-surviving verbs onto it, and make the carried verdict actually refuse.

**The measurement that decides the membership** (design §1f, ADR-682 — independently
re-verified twice on git 2.55.0). On a v99 repository and on a v1 + unknown-extension
repository, **exactly four** of the fifteen verbs that share bare `assertRepository` survive:

| invocation | exit | note |
|---|---|---|
| `config --list`, `config --list --show-origin` | **0** | repository scope dropped, two `warning:` lines |
| `config <key>`, `config --get-all`, `config --get-regexp` | **1** | "not found" — the repo scope is gone |
| `config --local --list` | 128 | `fatal: --local can only be used inside a git repository` |
| every `config` **writer** | 128 | repository config file **byte-unchanged** |
| `remote`, `remote -v`, `remote get-url`, `remote show -n`, `remote add`, `remote rename`, `remote remove` | **128** | **all refuse** — `remote` is NOT a survivor |
| `log`, `status`, `rev-parse …`, `for-each-ref`, `worktree list`, `fsck`, `gc` | 128 | refuse |

Contrast the gate tsgit already has: `core.bare = banana` kills even `config --list` with 128.
So the acceptance tier is strictly wider-surviving than `assertDiscoveryBooleansValid` and
strictly narrower-surviving than `assertOperationalRepository` — which is why it is a third
tier and not either existing one.

**The call sites — VERIFIED against the symbol at this plan's baseline, not inferred.**
`find_referencing_symbols` on `assertRepository` returns exactly fifteen call sites plus one
internal chain link:

| module | stays on `assertRepository` | moves to `assertAcceptedRepository` |
|---|---|---|
| `src/application/commands/config.ts` | `configGet` (`:47`), `configGetAll` (`:67`), `configGetRegexp` (`:94`), `configList` (`:123`) | `configSet` (`:153`), `configUnset` (`:182`), `configUnsetAll` (`:217`), `configRenameSection` (`:244`), `configRemoveSection` (`:269`) |
| `src/application/commands/remote.ts` | — | `remoteList` (`:118`), `remoteAdd` (`:133`), `remoteRemove` (`:173`), `remoteRename` (`:236`), `remoteSetUrl` (`:306`), `remoteShow` (`:329`) |
| `src/application/primitives/internal/repo-state.ts` | — | `assertOperationalRepository` (`:223`) re-points its inner call at `:224` |

Line numbers are the `await assertRepository(ctx);` statements at the baseline; **re-verify
with Serena before editing** — Parts 1–3 do not touch these files, so they should hold, but
confirm rather than trust.

**Two import routes, and one of them changes.** `remote.ts:16` imports straight from
`'../primitives/internal/repo-state.js'`. `config.ts:29` imports through the deprecated
re-export shim `src/application/commands/internal/repo-state.ts`
(`export { assertEagerConfigValid, assertNoPendingOperation, assertOperationalRepository, assertRepository, branchRefFromHead, currentBranchRef, readHeadRaw, requireWorkTree } from '../../primitives/internal/repo-state.js';`).
`config.ts` now needs **both** asserts, so it imports both **directly** from
`'../primitives/internal/repo-state.js'` and stops routing this symbol through the shim. Leave
the shim itself completely alone — other symbols still flow through it, and Part 7's guard is
call-site based specifically so the shim's existence changes nothing.

**The tier definition to land** in `src/application/primitives/internal/repo-state.ts`
(current shape: `assertRepository` at line 89, `assertEagerConfigValid` at 181,
`assertOperationalRepository` at 223):

```ts
/**
 * The acceptance tier: a repository the gates below reject is not operated on at
 * all. Every verb except the four surviving `config` read verbs takes this or
 * `assertOperationalRepository`.
 *
 * <insertion point — the ownership gate's `implicitBare` and `untrusted` arms
 *  land ABOVE the format arm; their relative order is that design's, not this one's>
 */
export const assertAcceptedRepository = async (ctx: Context): Promise<FilePath> => {
  const root = await assertRepository(ctx);
  const refusal = ctx.layout.formatRefusal;
  if (refusal !== undefined) throwFormatRefusal(refusal);
  return root;
};
```

Imports this adds to `repo-state.ts`: `type RepositoryFormatRefusal` from
`'../../../ports/context.js'` (it already imports `type Context` from there), and
`repositoryFormatVersionUnsupported` + `repositoryExtensionsUnsupported` from
`'../../../domain/repository/error.js'` — a **deep** import, because Part 1 deliberately kept
those factories off the `'../../../domain/index.js'` barrel this file currently uses.

`throwFormatRefusal` is a module-local `(refusal: RepositoryFormatRefusal) => never` that
switches on `refusal.kind` and throws `repositoryFormatVersionUnsupported(refusal.version)` or
`repositoryExtensionsUnsupported(refusal.version, refusal.extensions)` — the same
`throwEagerCandidate` shape already in the file at line 128. Then
`assertOperationalRepository` becomes `assertAcceptedRepository(ctx)` + `assertEagerConfigValid(ctx)`.

The **insertion-point comment is required output of this part** — it is how the sibling plan
knows where its two arms go without re-reading two designs. Write it as prose, with no ADR or
phase number in it.

**Public-surface decision.** `assertAcceptedRepository` is **internal**:
`src/application/primitives/internal/` is not a published subpath, the deprecated shim is not
extended with it, and no barrel gains it. No `api.json` delta from this part's `src` changes.

**Docs owed by this part** — `docs/understand/repository-layout.md` (5.3 KB; sections:
`## The three routes`, `## Work-tree precedence`, `## Reading the result`, `## Refusals`,
`## Deliberate divergences`). Under `## Refusals`, document the **three-tier contract**: which
verbs sit on each assert, and the enumerated four-verb surviving set. This is the enumeration
ADR-666's first consequence requires — it must be a documented contract, never inferred from
which assert a command happens to call. Also mention the new `layout.formatRefusal` field under
`## Reading the result`.

**Tests to extend.**

- `test/unit/application/commands/internal/repo-state.test.ts` (1421 lines) — the existing
  suite. **The design's test-strategy section says these tests live under
  `test/unit/application/primitives/internal/`; they do not** — that directory holds no
  repo-state suite. Extend the file named here; do NOT create a second one. It imports the
  asserts from the **shim** path
  (`src/application/commands/internal/repo-state.js`) and `HeadState` from the primitives path.
  Helpers already present at the top: `seedRepo(ctx, head = 'ref: refs/heads/main\n')` writes
  `${gitDir}/HEAD`; `seedConfig(ctx, config)` writes `${gitDir}/config`; contexts come from
  `createMemoryContext()` (`src/adapters/memory/memory-adapter.js`, `workDir: '/repo'`,
  `gitDir: '/repo/.git'`). Import `assertAcceptedRepository` from the **primitives** path (the
  shim is deliberately not extended).
- To inject a verdict, add one local helper to that test file:
  `const withFormatRefusal = (ctx: Context, formatRefusal: RepositoryFormatRefusal): Context => ({ ...ctx, layout: { ...ctx.layout, formatRefusal } });`
  **Seed HEAD and config through the ORIGINAL `ctx` before deriving**, and use the derived
  context only for the assert call — a spread `Context` gets its own entry in the
  Context-keyed config caches, and writing through one while reading through the other has
  produced intermittent failures in this repo before.
- `test/unit/application/commands/config.test.ts` and
  `test/unit/application/commands/remote.test.ts` — add the tier rows (survivors vs movers).

**Interop rows this part owns** (design Test strategy 8-refusing-side, 10, 11):

8 (refusing side). A **row per verb**, not a spot check: each of the five `config` writers
(asserting the repository config file is **byte-unchanged** afterwards), each of the six
`remote` verbs, and a representative operational verb — refusing in **both** tools on both the
v99 and the v1 + unknown-extension fixtures. This sweep is also the evidence an allowlist entry
points at in Part 7: a verb may only join the allowlist once it has a row here.
10. Route coverage: from a **subdirectory**; explicit `gitDir` with cwd elsewhere;
    **cwd-is-gitdir** into a bare-shaped v99 gitdir; from a **linked worktree** whose common
    config is v99 (and the main checkout too); and a v99 repo nested inside a good outer repo
    with cwd = inner, proving discovery **does not climb past** it.
11. Bootstrap: `init` against an existing v99 repository refuses in **both** tools with the
    config **byte-unchanged**. The oracle is the refusal and the byte-unchanged config, **not**
    a code match — tsgit reaches it by `ALREADY_INITIALIZED` (`init` throws whenever
    `<gitDir>/HEAD` exists, `src/application/commands/init.ts`), git by the format gate. That
    code difference is a pre-existing consequence of tsgit having no re-init, not something
    this gate introduces. Also: a tsgit-created repository is v0 with no `[extensions]` and
    opens in git (`bootstrapRepository` writes `repositoryformatversion = 0`).

### TDD steps

1. **RED** — `repo-state.test.ts`: `describe('Given a layout carrying a version refusal')` >
   `describe('When assertAcceptedRepository is called')` >
   `it('Then it throws REPOSITORY_FORMAT_VERSION_UNSUPPORTED carrying the parsed version')`,
   try/catch + `.data` assertions. Expected failure: `assertAcceptedRepository` is not exported.
2. **RED** — the same for an extensions refusal, **one test per code**, so a mutant that drops
   one guard cannot hide behind the other.
3. **RED** — the survivors' arm: on the **same** layout, `assertRepository` throws **neither** —
   one test per code again.
4. **RED** — `assertOperationalRepository` throws the format code **before**
   `assertEagerConfigValid`'s: a layout carrying a v99 verdict **plus** a
   `core.sparseCheckout = banana` config raises the format code.
5. **RED** — `assertDiscoveryBooleansValid`'s refusal beats all of them: the same layout plus
   `core.bare = banana` raises `CONFIG_BAD_BOOLEAN_VALUE` from `assertAcceptedRepository`.
6. **RED** — `config.test.ts`: each of the five writers refuses on a rejected layout; each of
   the four readers does not. `remote.test.ts`: each of the six verbs refuses.
7. **RED** — interop rows 8 (refusing side), 10, 11.
8. **GREEN** — add `throwFormatRefusal` + `assertAcceptedRepository` to
   `src/application/primitives/internal/repo-state.ts` with the insertion-point comment;
   re-point `assertOperationalRepository`'s inner call; move the eleven call sites; switch
   `config.ts`'s import to the primitives path for both symbols.
9. **GREEN** — update `docs/understand/repository-layout.md` with the three-tier contract and
   the `formatRefusal` field.
10. **REFACTOR** — confirm exactly four `await assertRepository(ctx);` statements remain in
    `src/application/commands/config.ts`, zero in `remote.ts`, and one in
    `repo-state.ts` (inside `assertAcceptedRepository`). Grep the whole of `src/` to prove it
    — Part 7 will make that grep a build gate, and it is far cheaper to be right now.

### Gate

```
npx vitest run test/unit/application/commands/internal/repo-state.test.ts test/unit/application/commands/config.test.ts test/unit/application/commands/remote.test.ts test/integration/repository-format-acceptance-interop.test.ts \
  && npm run check:types \
  && ./node_modules/.bin/biome check src/application/primitives/internal/repo-state.ts src/application/commands/config.ts src/application/commands/remote.ts test/unit/application/commands/internal/repo-state.test.ts test/unit/application/commands/config.test.ts test/unit/application/commands/remote.test.ts test/integration/repository-format-acceptance-interop.test.ts
```

### Commit

```
feat(application): refuse an unacceptable repository on a dedicated acceptance tier
```

## Part 5 — The dropped repository config scope for the four survivors

### Context

**Goal.** Make the four surviving `config` read verbs see an **empty** repository config scope
on a rejected repository, and make an explicitly-named `local` / `worktree` scope refuse — the
last piece of git's measured porcelain behaviour.

**Measured target** (design §1f): on a v99 repository, `config --list` exits **0** printing
only the non-repository scopes; `config <key>` exits **1** ("not found", the repo scope is
gone); `config --local --list` exits **128** with
`fatal: --local can only be used inside a git repository`.

**Where the guard goes, and the one place it must NOT go.** ADR-679 puts the *ownership*
guard at two sites: `loadConfigEntry` (`src/application/primitives/config-read.ts`) **and**
`config-scoped-read.ts`'s per-scope reader. The **format** guard takes only the second site.
Reason, measured: an untrusted repository's config file is never parsed at all, so
`assertDiscoveryBooleansValid` finds nothing and `core.bare = banana` measurably stops
refusing — but the format verdict is *derived from that very file*, and design §1d measures the
opposite outcome for it: on a v99 repository `core.bare = banana` and
`extensions.worktreeConfig = banana` **still** refuse `config --list` with exit 128. One rule —
*a repository the acceptance tier rejects has no readable config scope* — expressed at the
earliest point each verdict permits. Ownership: before the file is read. Format: after it is
read and after the gates that read it have run. **A shared early return in `readConfig` would
be the natural refactor and would be wrong for the format arm.**

**The module — `src/application/primitives/config-scoped-read.ts`.** Structure to know:

- `sectionsCache: WeakMap<Context, Map<ConfigScope, Promise<ReadonlyArray<IniSection>>>>` — a
  per-Context, per-scope single-flight cache.
- `readSingleScopeUncached(ctx, scope)` (~line 43) — `resolveScopePath` then `parseIniSections`;
  `FILE_NOT_FOUND` / `PERMISSION_DENIED` ⇒ `[]`.
- `readSingleScope(ctx, scope)` (~line 64) — the cache wrapper.
- `safeReadScopeOrSkip(ctx, scope)` (~line 72) — used **only** by the merged read; it catches
  `CONFIG_SCOPE_NOT_AVAILABLE` and `CONFIG_SYSTEM_PATH_UNRESOLVED` and returns `undefined`, so
  the scope is silently skipped.
- `readConfigSections({ ctx, scope })` (~line 106) — explicit scope ⇒ `readSingleScope`
  (raises); omitted ⇒ `SCOPE_ORDER` loop through `safeReadScopeOrSkip` (skips).
- `collectScopedMatches(ctx, parsedKey, scope)` (~line 127) — the same split, feeding
  `getConfigValue` and `getAllConfigValues`.

**The elegant consequence: ONE guard gives BOTH measured behaviours.** Throw
`configScopeNotAvailable(scope, <new reason>)` at the **top of `readSingleScope`, before the
cache lookup** when `ctx.layout.formatRefusal !== undefined` and `scope` is `'local'` or
`'worktree'`. A merged read routes through `safeReadScopeOrSkip`, which swallows exactly that
code and drops the scope; an explicitly-named scope routes through `readSingleScope` directly
and raises. Guarding **before** the cache lookup is deliberate: it keeps a rejected promise out
of the memo.

**The new `reason` literal.** `CONFIG_SCOPE_NOT_AVAILABLE` lives in
`src/domain/commands/error.ts`: the union member at lines 184–188 with
`readonly reason: 'browser-adapter' | 'worktree-extension-unset'`, and the factory
`configScopeNotAvailable(scope, reason)` at lines 644–647 repeating the same literal union.
**Both places** need the new literal. The rendered detail
(`src/domain/error.ts:457`: `` `config scope not available: ${data.scope} (${data.reason})` ``)
needs no change — it interpolates the reason.

Name the literal **`'repository-not-accepted'`** — gate-agnostic on purpose: ADR-679 says this
literal is **shared** with the ownership gate rather than duplicated, so it must not say
"format". Update the `CONFIG_SCOPE_NOT_AVAILABLE` row in `docs/use/errors.md` to enumerate the
three reasons. `reason` is part of a publicly exported error union ⇒ regenerate and commit
`reports/api.json` in this part.

**Public-surface decision.** The literal widens an existing public union — no new symbol, but
the `api.json` prepush gate still applies. Nothing else becomes public.

**Sibling coupling to state in the code.** The ownership gate adds a second disjunct to this
same guard (`untrusted` / `implicitBare`). Write the predicate as a named module-local
`const repositoryScopeIsDropped = (ctx: Context): boolean => ctx.layout.formatRefusal !== undefined;`
so the sibling extends one expression rather than restructuring the reader.

**Tests to extend — the paths are verified, do not go hunting.** There is **no**
`config-scoped-read.test.ts`. The scoped-read suite lives inside
`test/unit/application/primitives/config-read.test.ts` (6663 lines), which imports
`getConfigValue`, `getAllConfigValues` and `readConfigSections` from
`../../../../src/application/primitives/config-scoped-read.js` at lines 26–29 under the
top-level `describe('primitives/config-read', …)`. Add the new groups there. Also:
`test/unit/application/primitives/internal/config-scope.test.ts` (and its
`config-scope.properties.test.ts` sibling) for `resolveScopePath`;
`test/unit/domain/commands/error.test.ts` for the new reason literal's rendering; and
`test/unit/application/commands/config.test.ts` for the four survivors' end-to-end behaviour on
a rejected layout.

**Interop rows this part owns** (design Test strategy 8-surviving-side, 9):

8 (surviving side). `config --list` and `--list --show-origin` exit 0 with an **empty
repository scope** in both tools; `config core.bare`, `config remote.origin.url` and
`config --get-regexp ^remote` are "not found" in both; a `config --global --list` row proving
the scopes that remain are untouched; and `config --local --list` refusing in both.
9. **Precedence co-truth**, both tiers per row: `core.bare = banana`,
   `extensions.worktreeConfig = banana` and a syntactically broken config line each **beat**
   the version on `config --list` *and* on an operational verb; `core.sparseCheckout = banana`,
   `core.maxTreeDepth = abc` and a valueless `core.excludesFile` each **lose** to the version on
   the operational verb and never fire on the porcelain. The `compatObjectFormat` rows go here
   too and are the ones that prove the tier is **per-condition**: on a v1 `compatObjectFormat`
   repository `config --list` dies in both tools, while on the v99 repository it survives in
   both.

### TDD steps

1. **RED** — the new reason literal: `configScopeNotAvailable('local', 'repository-not-accepted')`
   carries `{ code: 'CONFIG_SCOPE_NOT_AVAILABLE', scope: 'local', reason: 'repository-not-accepted' }`
   and renders `config scope not available: local (repository-not-accepted)`. Expected failure:
   TS2345 — the literal is not in the union.
2. **RED** — `config-scoped-read`: `describe('Given a layout carrying a format refusal')` >
   `describe('When readConfigSections runs with no scope')` >
   `it('Then local and worktree contribute nothing while global and system survive')`.
3. **RED** — same Given, `describe('When readConfigSections runs with scope local')` >
   `it('Then it raises CONFIG_SCOPE_NOT_AVAILABLE naming the scope and the reason')`. A second,
   isolated test for `scope: 'worktree'` — two guards, two tests.
4. **RED** — the negative arm: with **no** format refusal, `local` still reads its sections
   (a mutant that drops the predicate must die).
5. **RED** — `config.test.ts`: `configList` on a rejected layout returns entries from the
   non-repository scopes only; `configGet` on a repo-local key returns `{ value: undefined }`;
   `configGet` with an explicit `scope: 'local'` raises.
6. **RED** — interop rows 8 (surviving side) and 9.
7. **GREEN** — add `'repository-not-accepted'` to both the union member and the factory
   signature in `src/domain/commands/error.ts`; add `repositoryScopeIsDropped` and the guard at
   the top of `readSingleScope`.
8. **REFACTOR** — confirm `readConfig` / `loadConfigEntry` are **untouched** (that is the whole
   §2 distinction). Update the `CONFIG_SCOPE_NOT_AVAILABLE` row in `docs/use/errors.md`.
   Regenerate and commit `reports/api.json`.

### Gate

```
npx vitest run test/unit/application/primitives/config-read.test.ts test/unit/application/commands/config.test.ts test/unit/domain/commands/error.test.ts test/integration/repository-format-acceptance-interop.test.ts \
  && npm run check:types \
  && ./node_modules/.bin/biome check src/application/primitives/config-scoped-read.ts src/domain/commands/error.ts test/unit/application/primitives/config-read.test.ts test/unit/application/commands/config.test.ts test/unit/domain/commands/error.test.ts test/integration/repository-format-acceptance-interop.test.ts
```

Plus `npm run docs:json` before committing.

### Commit

```
feat(application): drop the repository config scope on a rejected repository
```

## Part 6 — Back `relativeWorktrees` by resolving the admin gitdir pointer

### Context

**Goal.** Make `worktree.list` / `.move` / `.remove` work on a worktree set created with
`git worktree add --relative-paths`. This is the last accepted extension that is neither
implemented, inert, honoured by construction, nor in `UNBACKED_EXTENSIONS` — and the design
measures the whole gap as **one pointer resolution**.

**What git writes with `--relative-paths`** (design §1h; the flag is what turns the extension
on, there is no manual step):

| artefact | absolute default | with `--relative-paths` |
|---|---|---|
| `.git/config` | `repositoryformatversion = 0`, no `[extensions]` | `repositoryformatversion = 1` **and** `[extensions] relativeWorktrees = true` |
| `.git/worktrees/wt/gitdir` | `/abs/…/wt/.git` | `../../../../wt/.git` |
| `<worktree>/.git` | `gitdir: /abs/…/main/.git/worktrees/wt` | `gitdir: ../main/.git/worktrees/wt` |
| `.git/worktrees/wt/commondir` | `../..` | `../..` (already relative in both) |

**The extension gates the WRITER, not the reader** — measured. With the extension *off* and a
relative pointer planted by hand, `git worktree list` and `git status` both exit 0. With the
extension *on*, a plain `git worktree add` still writes **absolute** pointers, and
`git worktree move` **converts a relative pointer to absolute**. So the fix here is
**unconditional**: never gate it on the extension. The write side needs **no** change — tsgit's
`worktree.add` / `worktree.move` write absolute pointers, exactly matching git's own default.
Emitting relative pointers is explicitly out of scope.

**What tsgit does today** (same fixture, through `openRepository`): the main checkout, the
linked worktree, a subdirectory of it, `status` inside it and `log` all resolve **correctly** —
`resolvePointer` (`src/repository/find-layout.ts:174`) already resolves a relative `gitdir:`
pointer against the gitfile's directory, which is why the discovery half works. But
`worktree.list`, `.move` and `.remove` all throw
`PATHSPEC_OUTSIDE_REPO { path: '../../../../wt/.git' }`.

**The single failing site — `linkedEntry` in `src/application/primitives/list-worktrees.ts:117-137`:**

```ts
const linkedEntry = async (ctx: Context, id: string, adminDir: string): Promise<WorktreeEntry> => {
  const gitdirPointer = (await ctx.fs.readUtf8(`${adminDir}/gitdir`)).trim();
  const path = stripGitSuffix(gitdirPointer) as FilePath;
  …
  const worktreeFs = worktreeScopedFs(ctx, path);
  const prunable = (await worktreeFs.exists(gitdirPointer)) ? undefined : { reason: PRUNABLE_REASON };
```

`gitdirPointer` is consumed **unresolved** twice: as the reported `path` (via
`stripGitSuffix`) and as the argument to the worktree-scoped `exists` probe that decides
`prunable`. A relative pointer therefore becomes a relative `FilePath` and escapes the
worktree-scoped filesystem (ADR-298 containment), which is where `PATHSPEC_OUTSIDE_REPO` comes
from.

**The fix, and the helper that already exists.** `resolveWorktreePath(cwd, input)` in
`src/domain/worktree/resolve-path.ts:22` is exactly this rule —
`collapsePosixSegments(input.startsWith('/') ? input : \`${cwd}/${input}\`)` — pure POSIX path
algebra that allows and resolves `..`, already used for user-supplied worktree paths. Resolve
the pointer against `adminDir` **once**, at the top of `linkedEntry`, and use the resolved
value for **both** consumers:

```ts
const gitdirPointer = resolveWorktreePath(adminDir, (await ctx.fs.readUtf8(`${adminDir}/gitdir`)).trim());
```

That is genuinely one line, verified against the helper's implementation — the design's
"one pointer resolution" claim holds. Everything downstream (`stripGitSuffix`, the
`worktreeScopedFs` probe, `byPath` sorting) is unchanged, and an absolute pointer resolves to
itself (`collapsePosixSegments` is idempotent on a clean absolute path), so no existing
behaviour moves.

**Security note to keep in the code comment (why, not what):** resolving **removes** the
escape rather than tolerating it — the resolved path is then subject to the same containment
check every other worktree path is. Do not widen the fs scope.

**`preciousObjects` — nothing to implement, but state it.** It is honoured **by construction**:
tsgit has no `gc`, no `prune`, no `repack`, no `prune-packed` among the 50 command modules, and
every `fs.rm` / `fs.rmRecursive` site in `src/` removes only lock files, temp files, sequencer
and merge/rebase/revert state, loose refs and reflogs, working-tree files, a removed worktree's
own directory, or a gitDir `bootstrap.ts` / `clone.ts` created moments earlier in the same
call. A sibling plan adds `packRefs`, which packs **refs** and deletes no objects, so the
premise survives it. If an object-deleting verb is ever added it inherits the obligation. Put
that reasoning in the design/docs prose, **not** in source comments.

**Tests to extend.** `test/unit/application/primitives/list-worktrees.test.ts` (verified to
exist). New Given/When/Then group for the relative-pointer behaviour.

**Interop row this part owns** (design Test strategy 12): `skipIf`-gated on
`git worktree add --relative-paths` being available on the installed git. Build a relative
worktree set with git, then compare tsgit's `worktree.list` against `git worktree list` — same
paths, same `prunable` verdicts — and repeat the comparison **after relocating the whole tree**
(`mv` the parent directory), which is the property the extension exists for. Note that the
fixture repository this creates is `repositoryformatversion = 1` with
`[extensions] relativeWorktrees = true`, so it doubles as a live acceptance-gate row: the gate
must accept it.

### TDD steps

1. **RED** — `list-worktrees` suite: `describe('Given a linked worktree whose admin gitdir
   pointer is relative')` > `describe('When listWorktrees runs')` >
   `it('Then the entry path matches the one an absolute pointer produces')`. Expected failure:
   the reported `path` is the raw relative string.
2. **RED** — a second, isolated test: `prunable` is computed from the **resolved** path (a
   relative pointer whose target exists is NOT prunable). This is a separate consumer of the
   same value, so it is a separate guard and a separate test.
3. **RED** — a third: a relative pointer that still escapes the worktree scope **after**
   resolution continues to refuse — resolving must not become a containment bypass.
4. **RED** — a regression test: an **absolute** pointer produces the identical entry it does
   today (the idempotence arm).
5. **RED** — interop row 12.
6. **GREEN** — import `resolveWorktreePath` from
   `'../../domain/worktree/resolve-path.js'` in `src/application/primitives/list-worktrees.ts`
   and resolve `gitdirPointer` against `adminDir` once, at the top of `linkedEntry`.
7. **REFACTOR** — confirm `linkedEntry` is still under 20 lines and that the resolved value is
   used by **both** consumers (a mutant that resolves only one of them must die — steps 1 and 2
   are what kill it).

### Gate

```
npx vitest run test/unit/application/primitives/list-worktrees.test.ts test/integration/repository-format-acceptance-interop.test.ts \
  && npm run check:types \
  && ./node_modules/.bin/biome check src/application/primitives/list-worktrees.ts test/unit/application/primitives/list-worktrees.test.ts test/integration/repository-format-acceptance-interop.test.ts
```

### Commit

```
fix(worktree): resolve a relative admin gitdir pointer before using it
```

## Part 7 — The `check:assert-tier` allowlist guard

### Context

**Goal.** Fence the weaker `assertRepository` tier **mechanically**. This part has **no `src/`
delta** — it is tooling plus its own unit test, which is why it legitimately stands alone.

**Why it exists (ADR-682, ADR-698).** The three-tier shape **fails open**: `assertRepository`
keeps the shortest, most natural-sounding name, so a future command that reaches for it
inherits none of the acceptance gates and would silently operate on a rejected or untrusted
repository. ADR-682 records that **without this guard, inverting the default would have been
the correct choice instead** — so the guard is a precondition for the shipped design being
safe, not hygiene. It covers the ownership gate too, since all four acceptance refusals ride
the one tier.

**Why not `check:architecture`.** dependency-cruiser rules are **module**-granular; the four
survivors share `src/application/commands/config.ts` with the five writers that must refuse. No
`from`/`to` path rule can separate them, and making it work would mean splitting a **published
subpath** (`./commands/config`). Verb granularity is what ADR-682 actually requires.

**Artefacts to create.**

| artefact | path |
|---|---|
| the audit | `tooling/audit-assert-tier.ts` |
| the allowlist | `tooling/audit-assert-tier.allowlist.json` |
| the wireit target | `check:assert-tier`, in `package.json`'s `scripts` **and** `wireit`, and in `validate`'s `dependencies` beside `check:write-surfaces` |
| its own test | `tooling/test/unit/audit-assert-tier.test.ts` |

**TWO TOOLING TRAPS — both are real and both have bitten this repo.**

1. **Biome's `files.includes` is an ALLOWLIST, not an ignore list.** `biome.json`'s
   `files.includes` currently names `src/**`, `test/**`, `*.ts`, `*.json` and then **individual
   tooling files** (`tooling/dts-value-exports.ts`, `tooling/truthful-dts.ts`,
   `tooling/audit-test-pyramid.ts`, `tooling/test-pyramid/**/*.ts`, …). A new `tooling/*.ts` is
   **silently unlinted** until it is added. Add `tooling/audit-assert-tier.ts`,
   `tooling/audit-assert-tier/**/*.ts` and `tooling/test/unit/audit-assert-tier.test.ts` to
   `files.includes` **in this part**, and prove it by running biome on the new files and
   seeing it actually report on them.
2. **Tooling that imports `src` must build and import from `dist`.** This script parses source
   with the TypeScript compiler API rather than importing it, which avoids the trap — **keep it
   that way**. `import * as ts from 'typescript'` only; never `import … from '../src/…'`.

**Precedents to copy, not invent.**

- `tooling/dts-value-exports.ts` (100 lines) — the compiler-API precedent:
  `ts.createProgram([...paths], COMPILER_OPTIONS)` with an explicit `ts.CompilerOptions`
  (`module: ESNext`, `moduleResolution: Bundler`, `target: ES2022`, `skipLibCheck: true`,
  `noEmit: true`), then `program.getTypeChecker()` and `checker.getAliasedSymbol(symbol)` for
  alias resolution. That last call is exactly the binding-resolution primitive this audit
  needs.
- `tooling/audit-write-surfaces.ts` (415 lines) + `tooling/audit-write-surfaces/load-allowlist.ts`
  — the allowlist-audit family shape: a typed `AllowlistError` with a `reason` enum
  (`'invalid-json' | 'not-an-object' | 'missing-…-array' | 'entry-not-an-object' | 'missing-field' | 'wrong-field-type' | 'empty-string' | …`),
  an `isPlainObject` guard, per-entry validation with the entry index in the detail, a
  `parseAllowlist(rawContent, config)` pure function, a `formatFindings(report)` line renderer,
  `parseArgs`, an `invokedDirectly()` guard around `main()`, and `process.exit(1)` on findings.
  Split helpers into `tooling/audit-assert-tier/` if the script exceeds ~200 lines, mirroring
  `tooling/audit-write-surfaces/`.
- `tooling/audit-browser-surface.allowlist.json` — the shipped-entries-with-`reason` shape.

**What the audit asserts** — over `src/**/*.ts` **only** (tests, tooling and docs are out of
its scan):

1. Resolve, per module, the **local binding** of the primitives module's `assertRepository`
   export — reached directly, or through **any** re-export barrel, and under **any** local alias
   (`import { assertRepository as gentle }`). Binding resolution via the type checker, **not**
   import-path matching: that is what makes the deprecated
   `src/application/commands/internal/repo-state.ts` shim and a future alias both harmless.
   `config.ts` reaching the symbol through that shim is a **live instance today** — after Part 4
   it imports directly, but the shim still re-exports the symbol, so the arm stays reachable.
2. Collect every `CallExpression` on that binding and attribute each to its **enclosing
   exported declaration** — the nearest ancestor `VariableStatement` / `FunctionDeclaration`
   carrying an `export` modifier — yielding a `{ module, verb, line }` triple. `module` is the
   repo-relative POSIX path.
3. **Fail** on any triple whose `{ module, verb }` is not in the allowlist (**an unguarded
   caller**), and **fail** on any allowlist entry with no matching triple (**a stale entry** —
   the `allowlistRot` posture both sibling audits take).
4. **Fail** on a call site it cannot attribute to an exported declaration, rather than skipping
   it: an unattributable call is the exact shape a bypass would take.

**The allowlist, shipped with exactly five entries** — the four measured survivors plus the one
internal chain link. `reason` is a required non-empty string, validated by the loader; a
malformed allowlist is an **audit failure**, never a silent empty set.

```json
{
  "callers": [
    { "module": "src/application/commands/config.ts", "verb": "configGet",
      "reason": "git's `config --get` exits 1 (not-found), not 128, on a rejected repository; pinned by the tier co-truth sweep." },
    { "module": "src/application/commands/config.ts", "verb": "configGetAll",
      "reason": "same porcelain row as configGet; pinned by the tier co-truth sweep." },
    { "module": "src/application/commands/config.ts", "verb": "configGetRegexp",
      "reason": "git's `config --get-regexp` exits 1 on a rejected repository; pinned by the tier co-truth sweep." },
    { "module": "src/application/commands/config.ts", "verb": "configList",
      "reason": "git's `config --list` exits 0 with the repository scope dropped; pinned by the tier co-truth sweep." },
    { "module": "src/application/primitives/internal/repo-state.ts", "verb": "assertAcceptedRepository",
      "reason": "the tier chain itself — assertAcceptedRepository is defined as assertRepository plus the acceptance gates." }
  ]
}
```

**Failure output** — one line per finding, then a non-zero exit. **Blocking from day one, no
warn-only phase** (unlike `audit-write-surfaces`, which ships `--blocking`-gated). The message
must name the offending verb, its file and line, and the allowlist path, so a future author
hitting it does not have to read an ADR:

```
audit-assert-tier: src/application/commands/stash.ts:41 `stashList` calls bare
  `assertRepository`. That tier skips the acceptance gates (repository format, unsupported
  extension, dubious ownership, implicit bare) — a rejected or untrusted repository would be
  operated on. Use `assertAcceptedRepository` (or `assertOperationalRepository`), or, if
  canonical git really does let this verb survive a rejected repository, add it to
  tooling/audit-assert-tier.allowlist.json with the measurement that proves it.
```

and for the stale arm:

```
audit-assert-tier: allowlist entry `src/application/commands/config.ts` / `configReadAll`
  matches no call site. Remove the stale entry or restore the caller.
```

**The wireit target.** Mirror `check:write-surfaces`:
`"command": "node --experimental-strip-types tooling/audit-assert-tier.ts"`, `files`:
`["src/**/*.ts", "tooling/audit-assert-tier.ts", "tooling/audit-assert-tier/**/*.ts", "tooling/audit-assert-tier.allowlist.json"]`,
and **no `output`** — like `check:architecture`, it is a verdict, not a report. Add
`"check:assert-tier": "wireit"` to `scripts` and `"check:assert-tier"` to `validate`'s
`dependencies` array.

**How a legitimate fifth verb is added** — put this in the script's header JSDoc, three
deliberate steps in order: pin the survival against real git (the verb exits 0 on a v99 fixture
*and* on a v1-unknown-extension fixture, in both tools); add the interop row to the tier
co-truth sweep in `test/integration/repository-format-acceptance-interop.test.ts`; then add the
`{ module, verb, reason }` entry whose `reason` names that row. Editing source alone cannot
widen the surviving set — that is the whole difference between this and a convention.

**Deliberately NOT guarded.** `assertAcceptedRepository` itself has no allowlist. A verb taking
it instead of `assertOperationalRepository` misses only the eager `[core]` gate — a measured
*different* tier with no attacker-relevant content. Widening the guard there would fence a
boundary no measurement makes load-bearing. Say so in the header JSDoc.

**Test file.** `tooling/test/unit/audit-assert-tier.test.ts`, modelled on
`tooling/test/unit/audit-browser-surface.test.ts` and the
`tooling/test/unit/audit-write-surfaces/load-allowlist.test.ts` family. Drive the analyzer off
**in-memory source strings** (a `ts.createProgram` over a custom `CompilerHost` serving a
`Map<string, string>`, or `ts.createSourceFile` where the checker is not needed) rather than
the real tree, so the fixtures are readable and each invariant is isolated. `tooling/` is
outside the 100 %-coverage scope but inside `tooling/test/unit`'s reach — the same posture
`audit-write-surfaces` and `audit-browser-surface` already have. `vitest.config.ts`'s `unit`
project already includes `tooling/test/unit/**/*.test.ts`.

### TDD steps

1. **RED** — allowlist loader: a malformed allowlist raises the loader's typed error rather
   than degrading to an empty allowlist — **one isolated test per malformation**: not an
   object, `callers` not an array, an entry that is not an object, a missing `module`, a
   missing `verb`, a missing `reason`, a non-string `reason`, an empty/whitespace `reason`.
   Assert the error's `reason` field and its `detail`, never just the class.
2. **RED** — a module calling the bare assert from a **non-allowlisted** exported verb is
   reported, with the module, the verb **and the line** present in the finding.
3. **RED** — the same call from an **allowlisted** verb is **not** reported.
4. **RED** — an allowlist entry matching **no** call site is reported as **stale**.
5. **RED** — an **aliased** import (`import { assertRepository as gentle }`) is still
   attributed — binding resolution, not name matching.
6. **RED** — a call reached through a **re-export shim** is attributed to the calling verb, not
   to the shim. This is the arm that would silently pass under an import-path guard.
7. **RED** — a call that cannot be attributed to an exported declaration (module top level, or
   inside a non-exported helper) **fails** rather than being skipped.
8. **RED** — the shipped `tooling/audit-assert-tier.allowlist.json` has **exactly** the five
   documented entries — so shipping a sixth is a diff a reviewer sees in this test too.
9. **RED** — one integration-shaped assertion: the audit run over the **real** `src/` tree
   exits 0. That is the arm that fails the day someone adds a fifth caller, and it is why the
   audit is a `validate` dependency rather than advisory.
10. **GREEN** — implement `tooling/audit-assert-tier.ts` (+ `tooling/audit-assert-tier/`
    helpers if it grows past ~200 lines), write the allowlist JSON, wire the
    `check:assert-tier` script + wireit target + `validate` dependency, and add the three new
    paths to `biome.json`'s `files.includes`.
11. **REFACTOR** — run `npm run check:assert-tier` directly and confirm it exits 0 on the real
    tree; then temporarily point one non-allowlisted verb at bare `assertRepository` in a
    scratch copy under `mktemp` (**never in the worktree**) and confirm it exits 1 with the
    documented message. Confirm biome now lints the new files (they must appear in
    `./node_modules/.bin/biome check tooling/audit-assert-tier.ts` output rather than being
    silently skipped).

### Gate

```
npx vitest run tooling/test/unit/audit-assert-tier.test.ts \
  && npm run check:assert-tier \
  && npm run check:types \
  && ./node_modules/.bin/biome check tooling/audit-assert-tier.ts tooling/test/unit/audit-assert-tier.test.ts biome.json package.json
```

### Commit

```
chore(tooling): gate the acceptance-free assert tier behind a verb-granular allowlist
```
