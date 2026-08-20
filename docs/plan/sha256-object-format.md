# Plan — SHA-256 object format

> Source: design doc `docs/design/sha256-object-format.md` · ADRs 681, 683, 685, 693, 694, 695, 696, 697, 701, 702, 703
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

## Preamble — facts every part needs (read once, do not re-derive)

### The authoritative width-sweep enumeration (clears the design's §2a debt)

The design's §2a states 52 and its twelve cluster subtotals sum to 54. **Neither number is
authoritative.** The list below was re-derived by grep over `src/` on this branch and every
`file:line` was opened and read.

**Counting rule.** A *site* is one distinct `file:line` whose **own text** pins an oid width —
a numeric width literal (`20`/`38`/`39`/`40`/`52`/`60`/`62`), a width-bearing regex quantifier,
a 40-character hex or zero string literal, a single-valued `'sha1'` type/constant, or a `const`
declaration that aliases one of those. A line that merely *references* such a constant is a
**carried line**: it changes as a consequence, is named per cluster, and is not counted —
counting carried lines would make the total depend on how the fix is factored.

| # | cluster | sites | `file:line` |
|---|---|---|---|
| C1 | git index | **8** | `src/domain/git-index/index-parser.ts:25,26,27,28,85,143` · `src/domain/git-index/index-writer.ts:17,110` |
| C2 | pack `.idx` v2 | **8** | `src/domain/storage/pack-index.ts:10,49,52,185,186,192,193` · `src/domain/storage/pack-writer.ts:65` |
| C3 | zero-oid / empty-object constants | **4** | `src/domain/objects/object-id.ts:59,66` · `src/application/commands/push.ts:115` · `src/application/primitives/object-resolver.ts:46` |
| C4 | command full-oid fast paths | **8** | `branch.ts:178` · `checkout.ts:63` · `checkout.ts:85` · `internal/commit-ish.ts:18` · `reset.ts:175` · `rev-parse.ts:59` · `tag.ts:94` · `notes.ts:32` (all under `src/application/commands/`) |
| C5 | prefix resolution | **3** | `src/application/primitives/resolve-oid-prefix.ts:16,17,18` |
| C6 | reflog | **1** | `src/domain/reflog/reflog-format.ts:15` |
| C7 | fsck tree validation | **1** | `src/domain/fsck/validate-tree.ts:42` |
| C8 | archive PAX | **2** | `src/domain/archive/tar.ts:118,383` |
| C9 | bundle | **6** | `src/domain/bundle/types.ts:4` · `src/domain/bundle/parse-bundle-header.ts:14,16,38,46,59` |
| C10 | wire protocol | **4** | `src/domain/protocol/v2/sections.ts:51` · `src/domain/protocol/v2/capabilities.ts:67` · `src/domain/protocol/capabilities.ts:6` (`CLIENT_CAPABILITIES_FETCH`) · `:17` (`CLIENT_CAPABILITIES_PUSH`) |
| C11 | repository creation | **2** | `src/application/commands/internal/bootstrap.ts:8,28` |
| C12 | runtime wiring pins | **8** | `src/index.node.ts:95,111` · `src/index.browser.ts:79,84` · `src/adapters/node/node-adapter.ts:55,73` · `src/adapters/browser/browser-adapter.ts:34,44` |

**Authoritative total: 55 width-sweep sites.**

Four **in-scope lines that carry no width literal** and would otherwise be discovered during
implementation (they are edits, not sweep sites):

- `src/application/primitives/internal/serialize-and-hash.ts:20` — `(await ctx.hash.hashHex(bytes)) as ObjectId`
  bypasses `ObjectId.from`, removing the only place a written id's width could be checked
  against the repository's declared width (design §5, R3).
- `src/domain/bundle/serialize-bundle-header.ts:4` (`MAGIC_V2`) and `:28`
  (`if (input.version !== 2) throw …`).
- `src/application/commands/bundle-create.ts:237` (`const VERSION: BundleVersion = 2`).

**Five design claims this enumeration falsifies — do not act on the design's version:**

1. **`push.ts:115` is NOT double-counted as a command fast path.** `src/application/commands/push.ts`
   contains **no** `[0-9a-f]` regex at all (verified by grep). It is only the `ZERO_OID` shadow.
   The fast-path cluster has **8** declaration sites, not 10.
2. **`src/domain/archive/tar.ts:371`** (`size: PAX_RECORD_SIZE`) is a carried line the design's
   §2a never names. It must change with `:118`/`:383` or the ustar header and the PAX payload
   disagree.
3. **`BUNDLE_BAD_HEADER.reason` is typed `string`**, not `'not-a-bundle' | 'malformed-header'` —
   see `src/domain/commands/error.ts:243`. The two-value claim lives only in the factory's
   comment at `:769`. Widening it to a four-member union is a **type narrowing** on a shipped
   payload, so it is an `api.json` change.
4. **`SHA256_CONFIG` is already public** — exported as a value from `src/domain/objects/index.ts:39`
   and already present in `reports/api.json`. The design's "not in the public surface" note is stale.
5. **This repository calls the legacy protocol `v1`, not `v0`** (`FetchWireVersion = 1 | 2`).
   Everywhere ADR-697 and the design say "protocol v0", the code says v1. Use the repo's naming
   in code and tests; never introduce a `v0` identifier.

### The trap, stated once — width-permissive is not width-correct

`looksLikeObjectId` (`src/application/primitives/validators.ts:241`) accepts 40 **or** 64 hex.
Reusing it for the sweep is the wrong fix: in a SHA-256 repository a 40-hex string is a valid
**prefix** (measured: `rev-parse --verify <first 40 hex>` resolves to the full 64-hex id), so a
permissive predicate treats a prefix as a full oid and reads the wrong object. Every swept site
asks the **repository-aware** predicate `isOid(value, hashConfig)` (ADR-694), never the
config-free dual one. `resolve-oid-prefix.ts` is therefore **in** the sweep, not exempt.
`looksLikeObjectId` survives unchanged as a *format* check with a doc comment saying so.

### Repository-wide conventions binding every part

- **Test titles:** `describe('Given <context>')` > `describe('When <action>')` > `it('Then <expected>')`.
  Body is AAA with `// Arrange` / `// Act` / `// Assert` markers. SUT variable is `sut`
  (the function under test — the result goes in `result`). Enforced by `check:test-pyramid`.
- **Error assertions:** try/catch + direct `.data.<field>` assertions. Never `toThrow(Class)` alone.
  Each guard in an `if (A || B)` gets its **own** test.
- **No suppression directives** of any kind. No phase/ADR/backlog refs in source or test.
- **Coverage is 100 %** (statements/branches/functions/lines) over `src/domain/**`,
  `src/ports/**`, `src/adapters/node/**`, `src/adapters/memory/**`, `src/operators/**`
  (excluding `**/index.ts`). Any new branch in those trees needs a unit test or
  `test:coverage` fails. `src/application/**` and `src/repository*` are outside coverage but
  **inside** Stryker's mutation scope.
- **New interop test files need a `@proves` docblock** (`surface:`, `bucket: cross-tool-interop`,
  `unique:`) or `check:test-pyramid` fails. Template: `test/integration/config-boolean-interop.test.ts:1-13`.
- **`@writes` annotation blocks** on writer modules (`src/domain/git-index/index-writer.ts:8-12`,
  `src/domain/storage/pack-writer.ts:8-12`) are read by `check:write-surfaces`. Keep them; update
  the `format:` line only if the on-disk format changes (it does not — DIRC v2 and idx v2 stay).
- **`npm run validate` does not run `test:unit`** — `test:coverage` supersedes it.

### Surface gates (pre-pay in the part that adds the export)

- **New error code:** add to the union in the owning `error.ts` (`src/domain/commands/error.ts`
  or `src/domain/protocol/error.ts`), add a `case` to the renderer switch in
  `src/domain/error.ts` (the `const _exhaustive: never = data;` at `:573` is what fails the
  build if you miss one), add a row to `docs/use/errors.md` under the right `###` group
  (alphabetical within the group; groups at `:36` Adapters & I/O, `:50` Objects/storage/packs,
  `:70` Refs/reflog/revparse, `:95` Index/worktree, `:117` Diff & merge, `:127` Commits &
  identity, `:145` Network/transport, `:184` Hooks, `:191` Repository state; every table is
  `| Code | Payload | Raised when |`).
- **`reports/api.json` is a PREPUSH gate, not a validate gate.** Any new public export or
  changed public type makes it stale. Regenerate with `npm run docs:json` and commit it **in
  the part that changes the surface**. The huge typedoc-id diff is normal.
- **`check:doc-coverage`** only gates `docs/use/commands/<kebab>.md` existence + the README index
  row for Tier-1/Tier-2 names parsed out of `src/repository.ts`. It does **not** check
  `docs/use/errors.md` or `docs/understand/**` — those are manual and are named per part below.

---

## Part 1 — Fix the shipped `.git/index` SHA-256 corruption

### Context

**This is a live data-integrity bug on the current release**, reachable today with no new
option: `openRepository({ algorithm: 'sha256' })` on the memory entry (`src/index.default.ts:42`,
a documented public option that already wires `SHA256_CONFIG` at `:98`) then `add` writes a
corrupt `.git/index`, and `status` then reports the entry oid as a silently **truncated 40-hex**
id with no error. Land it first, alone, so it is independently reviewable and can be cherry-picked
onto a release branch on its own.

**The mechanism.** An index entry is `40 bytes of stat data` + `oid` + `2 bytes of flags` + name.
`src/domain/git-index/index-writer.ts` writes the 32-byte oid correctly at `offset + 40`
(`:102`) and then writes the flags at `offset + 60` (`:110`) and the name at
`offset + ENTRY_HEADER_SIZE` = `offset + 62` (`:119`) — **on top of the oid's last 14 bytes**.
Measured bytes for blob `2cf8d83d9ee29543b34a87727421fdecb7e3f3a183d337639025de576db9ebb4`:
oid-prefix `2cf8…f3a1`, then `0005`, then `612e747874` (`a.txt`), then `576db9ebb4`.

**`index-writer.ts:102` (`buf.set(shaBytes, offset + 40)`) is CORRECT at both widths and MUST
NOT be touched.** The ten preceding `setUint32` calls (`:90-99`: ctime, ctime-ns, mtime,
mtime-ns, dev, ino, mode, uid, gid, size) occupy exactly 40 bytes, and `shaBytes` comes from
`hexToBytes(entry.id)`, which self-sizes. Confirmed by real git: a SHA-256 index's first entry
oid sits at byte 52 = 12 (header) + 40 (stat). Write an explicit test pinning that.

**The latent read/read asymmetry this also closes (R4a).** `src/application/primitives/read-index.ts:40`
already does `const trailerSize = ctx.hashConfig.digestLength` and validates the trailer at that
width, then hands the **full** buffer to `parseIndex(bytes)` at `:54`, which re-frames it with its
own hard-coded 20. Two readers of one file with two widths; latent only because both are 20 today.

**Exact sites (C1, 8 sites + carried lines + signatures):**

| file:line | current text | change |
|---|---|---|
| `src/domain/git-index/index-parser.ts:25` | `const INDEX_OID_LENGTH = 20;` | derive from the new parameter |
| `:26` | `const INDEX_CHECKSUM_SIZE = INDEX_OID_LENGTH;` | derive |
| `:27` | `const ENTRY_HEADER_SIZE = 62;` | `40 + digestLength + 2` |
| `:28` | `const CACHE_TREE_OID_LENGTH = INDEX_OID_LENGTH;` | derive |
| `:85` | `const flagsRaw = view.getUint16(offset + 60);` | `offset + 40 + digestLength` |
| `:143` | `const flagsRaw = view.getUint16(offset + 60);` (in `decodeFlags`) | same |
| `src/domain/git-index/index-writer.ts:17` | `const ENTRY_HEADER_SIZE = 62;` | derive |
| `:110` | `view.setUint16(offset + 60, flagsRaw);` | `offset + 40 + digestLength` |

Carried lines in `index-parser.ts`: `:57` (`maxEntryBytes`), `:67`, `:82` (**the `offset + 40`
here is class D — keep**), `:125` (`trailerSha`), `:149`, `:183` (`extensionEnd`), `:275`, `:278`,
`:279`. Carried in `index-writer.ts`: `:39`, `:116`, `:119`.

Carried **doc comments that must be rewritten, not deleted** — they are the specification:
`index-parser.ts:16-24` ("The index parser is SHA-1-only, deliberately and as a whole … that is
why `parseCacheTree` takes no `digestLength` parameter the way the pack-side parsers do") and
`:213-216` (the cache-tree oid width note). The stated reasoning — entry oid, trailer and
cache-tree oid must widen **together** — is correct and becomes the new comment's premise.

**Signatures to change** (the design names these only in §3b, not in §2a):

```ts
// src/domain/git-index/index-parser.ts:40
export function parseIndex(bytes: Uint8Array): GitIndex
// src/domain/git-index/index-parser.ts:218
export function parseCacheTree(data: Uint8Array): CacheTreeEntry
// src/domain/git-index/index-writer.ts:33
export function serializeIndex(index: GitIndex): Uint8Array
```

Each gains a trailing `digestLength: 20 | 32` parameter. `parseCacheTreeEntry` (`:226`) and
`readCacheTreeChildren` thread it. Barrel: `src/domain/git-index/index.ts:17` re-exports
`parseCacheTree, parseIndex` — no new names.

**Public-surface decision — these three are PUBLIC.** All of `parseIndex`, `serializeIndex` and
`parseCacheTree` already appear in `reports/api.json` (verified). A changed signature makes it
stale, and `check:doc-typedoc` catches that at **prepush**, not at `validate` — a locally green
`validate` can still be rejected by the push hook. **Run `npm run docs:json` and commit
`reports/api.json` in this part.** No new exported name is added, so no barrel, facade,
`check:doc-coverage` page or exhaustiveness switch is involved.
`src/domain/git-index/index-writer.ts:8-12` carries a `@writes` block read by
`check:write-surfaces`; the on-disk format is still DIRC v2, so leave `format:` and `kind:` alone.

**All three call sites** (there are exactly three):

- `src/application/primitives/read-index.ts:54` — `return { ...parseIndex(bytes), … }` →
  pass `ctx.hashConfig.digestLength` (the same value `:40` already reads).
- `src/application/primitives/internal/index-lock.ts:122-127` — `serializeIndex({ version: 2,
  entries: [...entries], extensions: [], trailerSha: new Uint8Array(0) })`; the trailer is
  already width-correct (`ctx.hash.hash(body)` then `checksum.length` at `:128-132`). Pass
  `ctx.hashConfig.digestLength`.
- `src/application/commands/internal/fsck/roots.ts:198` — `parseCacheTree(extension.data)`;
  a `Context` is in scope there.

**Do not confuse with a SHA-256 bug:** `index-lock.ts:122` passes `extensions: []`, so the
cache-tree is dropped on that write path. Pre-existing, unrelated, out of scope.

**REUC:** `parseExtensions` (`index-parser.ts:177-205`) stores unrecognised extensions as opaque
`{ signature, data }` and only rejects lowercase (mandatory) signatures, so it round-trips at any
width. Add a doc-comment note that a future REUC *decoder* inherits the width problem.

**Tests to extend** (all exist):
`test/unit/domain/git-index/index-parser.test.ts` (1213 lines, `describe('parseIndex')` at `:97`
with ~40 nested `Given …/When parsing` pairs) · `test/unit/domain/git-index/index-parser.properties.test.ts`
(79 lines, describes at `:31/32/47/62`) · `test/unit/domain/git-index/index-writer.test.ts`
(578 lines: `compareEntryPath` `:47`, `serializeIndex` `:96`, property-based `:336`, index-v3
extended flags `:392`).

**This part also creates the interop file every later part appends to:**
`test/integration/sha256-object-format-interop.test.ts`. Follow
`test/integration/config-boolean-interop.test.ts` for shape and
`test/integration/bundle-interop.test.ts:151-267` for the shared-fixture pattern. Mandatory:

- A `@proves` docblock (`surface: openRepository, add, status`, `bucket: cross-tool-interop`,
  `unique: …`) — `check:test-pyramid` fails without it.
- `describe.skipIf(!GIT_AVAILABLE)` at the top level.
- **One shared `beforeAll(fn, 60_000)`** building a single
  `git init --object-format=sha256` repository (one commit, one tag, one branch, one repacked
  pack); each row copies it. The default 10 s hook timeout fails under full-validate concurrency.
- Helpers from `./interop-helpers.js`: `GIT_AVAILABLE`, `runGit`, `runGitEnv`, `git`, `gitAsync`,
  `tryRunGitWithExit`, `makePeerPair` (its `dispose()` is the cleanup). Every `GIT_*` var is
  already scrubbed by `SAFE_ENV`; add author/committer dates via `{...runGitEnv(), GIT_AUTHOR_*, GIT_COMMITTER_*}`.
- Call `disableAutoMaintenance(dir)` on any fixture asserting `objects/pack/` shape.
- Scratch dirs must live **inside** the repo dir so `NodeFileSystem` containment passes.

### TDD steps

1. **RED** — `test/unit/domain/git-index/index-writer.test.ts`: `Given an index entry with a
   32-byte oid` > `When serializeIndex frames it at digestLength 32` > `Then the flags word sits
   at offset+72 and the oid's 32 bytes at offset+40 survive intact`. Byte-literal oracle: build
   one entry for `a.txt` with oid
   `2cf8d83d9ee29543b34a87727421fdecb7e3f3a183d337639025de576db9ebb4` and assert the 32 bytes at
   `offset+40`, `getUint16(offset+72)`, and the name bytes at `offset+74`.
   *Fails:* `serializeIndex` takes no `digestLength`; a TypeScript arity error, then the byte
   assertion fails because `0x0005` is written at `offset+60` over the oid.
2. **RED** — same file: `Given a SHA-1 entry` > `When serializeIndex frames it at digestLength 20`
   > `Then the emitted bytes are byte-identical to today's golden` (R6 regression).
3. **RED** — `index-writer.test.ts`: `Given entries at both digest lengths` > `When the oid is
   written` > `Then it always starts at offset+40`. This pins the class-D line `:102` that a
   width sweep is most likely to "fix" into a bug. Name the invariant in the test title.
4. **RED** — `test/unit/domain/git-index/index-parser.test.ts`: a git-produced **literal**
   SHA-256 index fixture (bytes captured from `git init --object-format=sha256; git add`) parses
   to the expected entry set at `digestLength: 32`; the existing SHA-1 fixtures still parse at 20.
   *Fails:* `parseIndex` arity, then mis-framing.
5. **RED** — `index-parser.test.ts`: `Given one buffer` > `When read-index's trailer view and
   parseIndex's framing are computed at digestLength 32` > `Then they agree on the payload
   boundary`. This is the R4a regression guard: it passes today at 20 and would fail at 32.
6. **RED** — `index-parser.test.ts`: cache-tree extension parsed at `digestLength: 32` yields
   32-byte oids (`parseCacheTree`).
7. **RED** — `test/integration/sha256-object-format-interop.test.ts` (new file): after tsgit
   `add` into a `git init --object-format=sha256` repo, `git ls-files --stage` exits 0 and prints
   the full 64-hex oid git itself computes for the blob. Twin row: git's own `add` produces the
   same `lsStage` output.
   *Fails:* git rejects tsgit's index / reports a truncated id.
8. **GREEN** — thread `digestLength: 20 | 32` through `parseIndex`, `parseCacheTree`,
   `parseCacheTreeEntry`, `readCacheTreeChildren`, `decodeFlags`, `serializeIndex` and its entry
   writer; replace the four constants with values derived from it; update the three call sites.
   Rewrite the `index-parser.ts:16-24` and `:213-216` doc comments to state the new contract
   (one width per file, supplied by the caller from `ctx.hashConfig.digestLength`).
9. **REFACTOR** — extract a single `entryHeaderSize(digestLength)` / `flagsOffset(digestLength)`
   pair so the arithmetic exists once per module; keep every function < 20 lines; no function
   gains a boolean parameter. Re-run the index property tests at both widths.
10. **SURFACE** — `npm run docs:json` and commit `reports/api.json` (the three changed public
    signatures). Skipping this leaves a green `validate` and a red prepush hook.

### Gate

```
npx vitest run test/unit/domain/git-index test/unit/application/primitives/read-index.test.ts test/integration/sha256-object-format-interop.test.ts \
  && npm run check:types \
  && ./node_modules/.bin/biome check src/domain/git-index/index-parser.ts src/domain/git-index/index-writer.ts src/application/primitives/read-index.ts src/application/primitives/internal/index-lock.ts src/application/commands/internal/fsck/roots.ts test/unit/domain/git-index test/integration/sha256-object-format-interop.test.ts
```

### Commit

`fix: frame the git index at the repository's own oid width`

## Part 2 — `HashConfig.algorithm` and the repository-aware oid predicate

### Context

ADR-694's substrate. Everything downstream of here asks one predicate what a full oid is.

**`src/domain/objects/hash-config.ts` is the whole file today (14 lines):**

```ts
export interface HashConfig {
  readonly digestLength: 20 | 32;
  readonly hexLength: 40 | 64;
}
export const SHA1_CONFIG: HashConfig = Object.freeze({ digestLength: 20, hexLength: 40 });
export const SHA256_CONFIG: HashConfig = Object.freeze({ digestLength: 32, hexLength: 64 });
```

Add `readonly algorithm: 'sha1' | 'sha256'` and populate both frozen constants. `HashConfig` is
public (`src/domain/objects/index.ts:38`, re-exported by `src/public-types.ts:86` via
`export type *`), and `SHA1_CONFIG`/`SHA256_CONFIG` are public values (`index.ts:39`, both
already in `reports/api.json`). **This is an `api.json` change — regenerate in this part.**

**New file `src/domain/objects/oid-pattern.ts`:**

```ts
export const oidPattern = (config: HashConfig): RegExp
export const isOid = (value: string, config: HashConfig): boolean
```

`isOid` is true iff `value` is exactly `config.hexLength` lower-case hex characters. It takes its
config **as an argument** rather than reading a context — that is what lets the bundle sites
(Part 11) pass the *bundle's* declared algorithm instead of the repository's (R15). Build the
regex per config; do not cache in a mutable module-level map (mutable shared state). Export both
from `src/domain/objects/index.ts` (alphabetical placement near `hash-config`).

**Ban to encode in the doc comment:** no site may branch on `hexLength === 40` or
`digestLength === 20` to mean "sha1". A 40-hex string is a valid prefix in a SHA-256 repository,
so width does not determine algorithm. The discriminator is `config.algorithm`.

**First consumer, converted in this part:** `src/application/primitives/object-resolver.ts:46`

```ts
return hash.digestLength === 32 ? EMPTY_TREE_OID_SHA256 : EMPTY_TREE_OID;
```

becomes an `algorithm === 'sha256'` name comparison. It is the pattern §6 says not to propagate.

**Also in this part — the boundary bypass.** `src/application/primitives/internal/serialize-and-hash.ts:20`
casts the computed digest straight to `ObjectId` (`(await ctx.hash.hashHex(bytes)) as ObjectId`),
bypassing `ObjectId.from`. Under one algorithm that is a harmless hot-path shortcut; under two it
removes the only place a written id's width could be checked against the declared width. Replace
the cast with a check against `ctx.hashConfig` — this is a **hot path**, so use `isOid` (a single
`RegExp.test`), not `ObjectId.from`'s per-character scan, and keep the failure typed.

**Property test (CLAUDE.md lens 3 — total function over an algebraic grammar).**
`src/domain/objects/oid-pattern.properties.test.ts` is the wrong location — property siblings live
beside the **example test**, so: `test/unit/domain/objects/oid-pattern.properties.test.ts` with
generators in `test/unit/domain/objects/arbitraries.ts` (create it if absent).

- For an arbitrary lower-case hex string of arbitrary length: `isOid(s, cfg) === (s.length === cfg.hexLength)`.
- For arbitrary bytes: `isOid(toHex(bytes), cfg) === (bytes.length === cfg.digestLength)`.
- No input in the ASCII-hex safe subset makes it throw.
- `numRuns: 100` (invariant tier). **Generate the hex alphabet from character ranges, never a
  literal alphabet string** — a literal trips `CKV_SECRET_6` in the secret scanner.
- Never commit a seed.

Lenses 1, 2 and 4 do not apply here (no round-trip pair, no rule-list reduction, no counting
invariant). Lens 1 is claimed by the bundle header in Part 11.

**Consistency test** on the two frozen configs: `hexLength === 2 * digestLength` and `algorithm`
agrees with both — this keeps a future third algorithm from being added half-populated.

### TDD steps

1. **RED** — `test/unit/domain/objects/hash-config.test.ts` (create): `Given SHA1_CONFIG` >
   `When its fields are read` > `Then algorithm is 'sha1' and hexLength is twice digestLength`;
   same for `SHA256_CONFIG`. *Fails:* `algorithm` does not exist.
2. **RED** — `test/unit/domain/objects/oid-pattern.test.ts` (create): a full sweep — 40 hex under
   `SHA1_CONFIG` true; 40 hex under `SHA256_CONFIG` **false** (it is a prefix, and this row is the
   whole point); 64 hex under `SHA256_CONFIG` true; 64 hex under `SHA1_CONFIG` false; 39/41/63/65
   chars false; upper-case false; non-hex false; empty false.
3. **RED** — `test/unit/domain/objects/oid-pattern.properties.test.ts` (create) with the three
   properties above.
4. **RED** — `test/unit/application/primitives/object-resolver.test.ts`: `Given a SHA-256
   hash config` > `When emptyTreeOid selects` > `Then it returns the SHA-256 empty-tree oid`,
   asserted as the literal `6ef19b41225c5369f1c104d45d8d85efa9b057b53b14b4b9b939dd74decc5321`,
   and the SHA-1 twin as `4b825dc642cb6eb9a060e54bf8d69288fbee4904`. Assert against literals so a
   derivation bug cannot self-agree.
5. **RED** — a test that `serializeAndHash` throws a typed error (assert `.data.code`, not the
   class) when the hash service returns a digest whose hex width contradicts `ctx.hashConfig`.
   Two isolated tests, one per direction (sha1 service + sha256 config, and the reverse).
6. **GREEN** — add `algorithm` to `HashConfig` and both constants; write `oid-pattern.ts`; export
   both names from `src/domain/objects/index.ts`; convert `object-resolver.ts:46`; replace the
   `as ObjectId` cast at `serialize-and-hash.ts:20`.
7. **REFACTOR** — no duplicated regex construction; `oidPattern` is the only place a width becomes
   a pattern. Confirm no new `digestLength === 32` appears anywhere.
8. **SURFACE** — `npm run docs:json` and commit `reports/api.json` (new public `isOid`,
   `oidPattern`, and the widened `HashConfig`).

### Gate

```
npx vitest run test/unit/domain/objects test/unit/application/primitives/object-resolver.test.ts \
  && npm run check:types \
  && ./node_modules/.bin/biome check src/domain/objects/hash-config.ts src/domain/objects/oid-pattern.ts src/domain/objects/index.ts src/application/primitives/object-resolver.ts src/application/primitives/internal/serialize-and-hash.ts test/unit/domain/objects
```

### Commit

`feat: add a repository-aware oid predicate and an algorithm-bearing hash config`

## Part 3 — Zero-oid and empty-object constants, and their fan-out

### Context

C3 (4 sites) plus the highest-fan-out consumer sweep in the change.

**`src/domain/objects/object-id.ts:59`**

```ts
export const ZERO_OID: ObjectId = ObjectId.from('0000000000000000000000000000000000000000');
```

git's null oid is `hexsz` zeros. Measured: in a SHA-256 repository, `git update-ref --stdin` with
a 40-zero `<old-oid>` dies `fatal: update refs/heads/zz: invalid <old-oid>: 000…0`, and the
64-zero form succeeds. Reflogs write 64 zeros for the create row.

**`src/domain/objects/object-id.ts:66`**

```ts
export const EMPTY_TREE_OID: ObjectId = ObjectId.from('4b825dc642cb6eb9a060e54bf8d69288fbee4904');
```

Its SHA-256 twin currently lives one tier away, in
`src/application/primitives/object-resolver.ts:41` (`EMPTY_TREE_OID_SHA256`). Co-locate the pair
in the domain with a selector. Pinned constants (independently re-derived — `sha256("tree 0\0")`
and `sha256("blob 0\0")`):

| object | SHA-256 | SHA-1 |
|---|---|---|
| empty tree | `6ef19b41225c5369f1c104d45d8d85efa9b057b53b14b4b9b939dd74decc5321` | `4b825dc642cb6eb9a060e54bf8d69288fbee4904` |
| empty blob | `473a0f4c3be8a93681a267e3b1e9a7dcda1185436fe141f7749120a303721813` | `e69de29bb2d1d6434b8b29ae775ad8c2e48c5391` |

**`src/application/commands/push.ts:115`**

```ts
const ZERO_OID = ObjectId.from('0'.repeat(40));
```

A **local shadow** of the domain constant: wrong width *and* duplicated. **Delete it**, do not
widen it.

**Shape.** `ZERO_OID` and `EMPTY_TREE_OID` are public exports (`src/domain/objects/object-id.ts`
is re-exported wholesale by `export * from './object-id.js'` at `src/domain/objects/index.ts:43`,
and both are in `reports/api.json`). **Do not remove them** — a removal breaks consumers.
Keep them as the SHA-1 constants with a doc comment saying so, and add
`zeroOid(config: HashConfig): ObjectId` and `emptyTreeOid(config: HashConfig): ObjectId` beside
them. Public additions ⇒ `npm run docs:json` + commit `reports/api.json` in this part.

**The fan-out to sweep** — every `ZERO_OID` consumer. Enumerate with
`grep -rn --include='*.ts' 'ZERO_OID' src/` (the design names: `update-ref`, `reflog`, `push`,
`fetch`, `branch`, `remote`, `tag`, `worktree`, `submodule`, `clone`, `stash-ref`, `fsck/roots`,
`fsck/refs-verify`). For each: if a `Context` is in scope, call `zeroOid(ctx.hashConfig)`;
if the module is a pure domain helper with no config, take a `HashConfig` parameter from its
caller. **Do not** add a `hashConfig` field to a domain value object to smuggle it through.

`EMPTY_TREE_OID`'s only current consumer is `object-resolver.ts:45-46` (already converted in
Part 2) — repoint it at the domain selector and delete `EMPTY_TREE_OID_SHA256` from
`object-resolver.ts:41`.

**Do not touch** `src/domain/repository/head-ref.ts:30` (`/^[0-9a-fA-F]{40}/`, deliberately
unanchored at the end, comment at `:25-29` — git consumes a leading hex run and ignores the rest,
so a 64-hex id's first 40 characters pass; it is already dual) or
`src/application/primitives/internal/parse-shallow.ts:31` (`SHALLOW_HEX_RE` keyed by
`40 | 64` — the cleanest parameterised parser in the codebase and the model for the rest).

### TDD steps

1. **RED** — `test/unit/domain/objects/object-id.test.ts`: `Given SHA256_CONFIG` > `When zeroOid
   is called` > `Then it returns 64 zeros`; the SHA-1 twin returns 40. Assert the literal strings.
2. **RED** — same file: `emptyTreeOid` returns each literal above per config.
3. **RED** — `test/unit/domain/objects/object-id.test.ts`: `ZERO_OID` and `EMPTY_TREE_OID` still
   hold their SHA-1 values (R6 regression — these are shipped public constants).
4. **RED** — for each swept consumer with meaningful behaviour, one test that the SHA-256 path
   emits the 64-zero form. Highest value: the reflog create row (`update-ref`) and the push
   delete/create update lines. Assert the produced line bytes, not just the constant.
5. **GREEN** — add the two selectors to `src/domain/objects/object-id.ts`; delete
   `push.ts:115`; sweep every consumer; delete `EMPTY_TREE_OID_SHA256` from `object-resolver.ts`.
6. **REFACTOR** — check no consumer now imports both the constant and the selector; no consumer
   reintroduces a local zero literal. `grep -rn "repeat(40)\|'0000000000" src/` must return only
   the domain declaration.
7. **SURFACE** — `npm run docs:json`, commit `reports/api.json`.

### Gate

```
npx vitest run test/unit/domain/objects test/unit/application/commands/push.test.ts test/unit/application/primitives \
  && npm run check:types \
  && ./node_modules/.bin/biome check src/domain/objects/object-id.ts src/application/commands src/application/primitives test/unit/domain/objects
```

### Commit

`feat: scale the zero oid and empty-object constants to the repository's algorithm`

## Part 4 — Pack `.idx` v2 read and write at 32-byte oids

### Context

C2 (8 sites). This is the failure that makes a packed SHA-256 repository report
`OBJECT_NOT_FOUND` rather than "unreadable": the `.idx` size check fails at 20-byte strides, so
the object is reported **absent**.

**Measured format facts (git 2.55.0).** `.idx` magic `ff 74 4f 63`, **version 2 — unchanged**.
Oid table stride 20→32; trailer 40→64 bytes (pack checksum + idx checksum). No new field, no
version bump. Arithmetic check on a 12-object repo:
`8 + 1024 + 12·32 + 12·4 + 12·4 + 64 = 1576` = actual file size.

**`src/domain/storage/pack-index.ts`:**

| line | current | change |
|---|---|---|
| `:10` | `const IDX_SHA_LENGTH = 20;` | becomes the parsed index's own field |
| `:22` | `export function parsePackIndex(bytes: Uint8Array): PackIndex` | gains `digestLength: 20 \| 32` |
| `:49` | `const trailerOffset = bytes.length - 40;` | `2 * digestLength` |
| `:52` | `… + objectCount * 4 + objectCount * 4 + 40;` | `+ 2 * digestLength` |
| `:185` | `if (prefix.length > 40) {` | `> hexLength` |
| `:186` | `` `prefix too long: maximum 40 hex chars, …` `` | interpolate the real cap |
| `:192` | `const lowerHex = prefix.padEnd(40, '0');` | `padEnd(hexLength, '0')` |
| `:193` | `const upperHex = prefix.padEnd(40, 'f');` | `padEnd(hexLength, 'f')` |

Carried: `:46`, `:86`, `:88`, `:175`, `:176`. `findByPrefix` (`:181`) must read the width from its
`PackIndex` argument — **do not** add a second parameter; the index already knows.
The **minimum** prefix stays 4 (`:182-184`) — measured: a 4-char prefix resolves under both
algorithms. `IDX_SHA_TABLE_OFFSET = 1032 = 8 + 1024` is class D; leave it.

**`parsePackIndex` is the only pack-artefact parser that takes no width parameter** —
`parsePackRevIndex(bytes, digestLength, objectCount)` and `parseMultiPackIndex(bytes, digestLength)`
both do. Adding one aligns it with its siblings, and there is exactly **one** call site:
`src/application/primitives/pack-registry.ts:298`
(`parsePackIndex(await readBoundedIdx(ctx, idxPath))`, inside a `createPromiseMemo`), where
`ctx.hashConfig.digestLength` is in scope — the same value already passed to
`loadPackRevIndex` twelve lines below at `:311`.

**`src/domain/storage/pack-writer.ts`:**

```ts
const IDX_SHA_LENGTH = 20;                                    // :65
export function serializePackIndex(                           // :67
  entries: ReadonlyArray<PackIndexWriterEntry>,
  packChecksum: Uint8Array,
  presorted?: ReadonlyArray<SortedEntry>,
): Uint8Array {
  if (packChecksum.length !== IDX_SHA_LENGTH) {               // :72 — REJECTS a valid 32-byte checksum
    throw invalidPackIndex(`packChecksum must be ${IDX_SHA_LENGTH} bytes, got ${packChecksum.length}`);  // :74
```

**Derive the width from `packChecksum.length`**, exactly as `serializePackRevIndex` already does
(`src/domain/storage/rev-index.ts:117-125`: refuses any width but 20/32, then
`const hashId = digestLength === 32 ? 2 : 1`). The guard at `:72` becomes "20 or 32", not
"equals 20". Carried: `:91` (`shaTableSize`), `:95` (`checksumSize`), `:134` (`bytes.set`).
Sole caller: `src/application/primitives/internal/write-pack-artifacts.ts:34`, whose header
comment already documents the single-width-source discipline.

**Do NOT touch these — they are already dual (a diff here is a review flag):**
`src/domain/storage/rev-index.ts` (12 sites), `midx.ts` (12), `bitmap.ts` (6), `pack-entry.ts` (2).
`.rev`, multi-pack-index and commit-graph already handle their hash-identifier fields correctly —
the design audit falsified its own opening hypothesis on this point. `midx.ts:98-104` validates
the hash-version byte against the caller's declared width and `rev-index.ts:75-79` deliberately
does **not** cross-check; both policies are confirmed faithful against real git.

**Public-surface decision — `parsePackIndex`, `serializePackIndex` and `findByPrefix` are
PUBLIC.** All three already appear in `reports/api.json` (verified), so the signature changes make
it stale. `reports/api.json` is a **prepush** gate, not a `validate` gate — run
`npm run docs:json` and commit it in this part. No new exported name, so no barrel/facade/
doc-coverage/exhaustiveness work. `src/domain/storage/pack-writer.ts:8-12` carries a `@writes`
block (`format: git-packfile-v2`) read by `check:write-surfaces` — the format is unchanged; leave
it.

**Fixture discipline.** Each format gets a **fixture pair** — literal sha1 bytes and literal
sha256 bytes, both produced by real git — never a single width-parameterised fixture. A computed
fixture and a computed parser agree with each other even when both are wrong; only a literal
disagrees.

**Tests to extend:** `test/unit/domain/storage/pack-index.test.ts` (889 lines: `parsePackIndex`
`:78`, `lookupPackIndex` `:152`, `findByPrefix` `:215`, `entryOffsets` `:322`, truncated `:382`,
large-offset `:425`, security guards `:455`, binary-search branches `:514`/`:538`) ·
`test/unit/domain/storage/pack-writer.test.ts` (509 lines: `serializePackfile` `:49`,
`serializePackIndex` `:149`, property-based `:435`).

**Interop rows to append** to `test/integration/sha256-object-format-interop.test.ts`
(created in Part 1): git-written sha256 `.idx` and `.pack` read by tsgit; tsgit-written `.idx`
passing `git verify-pack` (exit 0); the SHA-1 control asserting the trailer is still 40 bytes.

### TDD steps

1. **RED** — `pack-index.test.ts`: `Given a git-written SHA-256 .idx fixture` > `When
   parsePackIndex frames it at digestLength 32` > `Then objectCount and every oid match git's
   verify-pack listing`. *Fails:* arity, then the `minExpectedSize` check rejects the file.
2. **RED** — `pack-index.test.ts`: the existing SHA-1 fixtures still parse identically at 20 (R6).
3. **RED** — `pack-index.test.ts`, `findByPrefix`: `Given a SHA-256 index` > `When a 63-char
   prefix is looked up` > `Then it resolves`; and a 64-char prefix is accepted while a 65-char one
   throws `INVALID_PACK_INDEX` with the cap in `.data`. Assert `.data`, not the class.
   Separate isolated tests for the too-short (`< 4`) and too-long guards.
4. **RED** — `pack-writer.test.ts`: `Given a 32-byte pack checksum` > `When serializePackIndex
   writes the index` > `Then the file size is 8 + 1024 + n*32 + n*4 + n*4 + 64`. *Fails:* the
   `:72` guard throws.
5. **RED** — `pack-writer.test.ts`: a 24-byte checksum still throws, with the accepted widths in
   `.data` (the guard must refuse everything but 20 and 32, not merely stop refusing 32).
6. **RED** — interop: tsgit writes a pack + `.idx` into a SHA-256 repo, `git verify-pack -v`
   exits 0; converse — tsgit reads a git-repacked SHA-256 pack and `log` returns git's oids.
7. **GREEN** — thread `digestLength` into `parsePackIndex` and store it on `PackIndex`; derive
   the writer's width from `packChecksum.length`; update the two call sites.
8. **REFACTOR** — one helper for `2 * digestLength` (the trailer) and one for the sha-table
   stride; no restated literals; `hexLength` derived as `2 * digestLength`, never restated.
9. **SURFACE** — `npm run docs:json` and commit `reports/api.json` (`parsePackIndex`,
   `serializePackIndex`, `findByPrefix`).

### Gate

```
npx vitest run test/unit/domain/storage/pack-index.test.ts test/unit/domain/storage/pack-writer.test.ts test/unit/application/primitives/pack-registry.test.ts test/integration/sha256-object-format-interop.test.ts \
  && npm run check:types \
  && ./node_modules/.bin/biome check src/domain/storage/pack-index.ts src/domain/storage/pack-writer.ts src/application/primitives/pack-registry.ts src/application/primitives/internal/write-pack-artifacts.ts test/unit/domain/storage test/integration/sha256-object-format-interop.test.ts
```

### Commit

`fix: frame the pack index at the repository's own oid width`

## Part 5 — Reflog, fsck tree validation, and the tar PAX record

### Context

Three small, unrelated domain clusters sharing one property: each is invisible to any test that
exercises tsgit against itself. The reflog is **symmetrically wrong** (read and write use the same
40-char offsets, so a tsgit round-trip passes while git rejects the file); the tar PAX record is
**write-only** (no read-side symptom at all). Both are caught only by the git-reads-tsgit
direction. Grouping them keeps each edit small and gives them one shared interop pass.

**C6 — `src/domain/reflog/reflog-format.ts:15` (1 site).**

```ts
const OID_LENGTH = 40;               // :15
const NEW_ID_START = OID_LENGTH + 1; // :16
const NEW_ID_END = NEW_ID_START + OID_LENGTH; // :17
const IDENTITY_START = NEW_ID_END + 1;        // :18
```

Carried: `:40` (the separator probe `meta[OID_LENGTH] !== FIELD_SEPARATOR && meta[NEW_ID_END] !== …`)
and `:43-44` (`meta.slice(0, OID_LENGTH)`, `meta.slice(NEW_ID_START, NEW_ID_END)`). They are
fixed slice offsets, so they break together. `serializeReflogLine` (`:23`) and `parseReflogLine`
(`:35`) both take the width; find every caller with `grep -rn 'parseReflogLine\|serializeReflogLine\|parseReflog(' src/`
and thread `ctx.hashConfig.hexLength`.
Test: `test/unit/domain/reflog/reflog-format.test.ts` (372 lines: `serializeReflogLine` `:44`,
`parseReflogLine` `:114`, `parseReflog` `:230`, `sanitizeReflogMessage` `:293`, round-trip
property `:328`). **Assert against git-written bytes, never against a tsgit round-trip** — a
round-trip passes either way.

**C7 — `src/domain/fsck/validate-tree.ts:42` (1 site).**

```ts
const SHA_LENGTH = 20;                        // :42
const shaEnd = nullIdx + 1 + SHA_LENGTH;      // :67  (carried)
```

Every entry after the first mis-frames. Its siblings `validate-commit.ts:29` and
`validate-tag.ts:23` are already dual (`/^[0-9a-f]{40}$/` there is one arm of an explicit
`{40}|{64}` alternation — leave them). `validate-tree.ts` is the outlier because it parses
**binary** rather than hex. Thread `digestLength` from the caller.
**There is no `validate-tree.test.ts`** — the file is covered only through
`test/unit/domain/fsck/validate-object.test.ts` (3131 lines, flat top-level `Given …` describes
at `:102, 134, 172, 208, 232, 272, 296, 329, …`). Add the SHA-256 rows there. Coverage is 100 %
over `src/domain/**`, so every new branch needs a unit test.

**C8 — `src/domain/archive/tar.ts:118` and `:383` (2 sites), plus carried `:371`.**

```ts
/** "52 comment=" (11) + 40-hex oid + "\n" (1) = 52 bytes, self-inclusive. */  // :117
const PAX_RECORD_SIZE = 52;                                                    // :118
    size: PAX_RECORD_SIZE,                                                     // :371  ← carried, NOT in the design's list
  const record = `${PAX_RECORD_SIZE} comment=${oid}\n`;                        // :383
```

At 64 hex the true length is `11 + 64 + 1 = 76`, so the emitted global header declares 52 and
carries 76 — a corrupt tar that both `tar` and `git archive` reject. Compute the record length
from the oid (`` `${n} comment=${oid}\n` `` where `n` is the record's own byte length including
the digits of `n` — the length is self-inclusive, so 11 + oid + 1 + digits). Rewrite the `:117`
comment as the derivation, not a restated number. `:371` sets the ustar `size` field and must
take the same computed value or the header and payload disagree.
Tests: `test/unit/domain/archive/tar.test.ts` (1247 lines, flat `Given …/When tarArchive is
called` describes at `:128, 148, 168, 192, 216, 248, 321, 373, 395, 420, 440, 469, 493, 519, 542,
563, 589, 615, 640, 674, …`) and `test/unit/domain/archive/tar.properties.test.ts` with
`test/unit/domain/archive/arbitraries.ts`.

**Public-surface decisions for this part, made here:**

- `parseReflogLine` and `serializeReflogLine` are **PUBLIC** — both already appear in
  `reports/api.json` (verified), so the signature change makes it stale. Run `npm run docs:json`
  and commit `reports/api.json` in this part (**prepush** gate, not a `validate` gate).
- `validateTree(raw: Uint8Array, strict: boolean)` (`src/domain/fsck/validate-tree.ts:226`) is
  **internal** — not in `reports/api.json` (verified). Add `digestLength` as a third positional
  parameter. Its existing `strict: boolean` is a pre-existing smell and is **out of scope**;
  do not restructure it, and do not add a second boolean.
- `tarArchive` (public, `src/index.ts`) keeps its signature — the PAX fix is internal to
  `src/domain/archive/tar.ts`, so no `api.json` change from the tar work.

**Interop rows to append** to `test/integration/sha256-object-format-interop.test.ts`: after a
tsgit write into a SHA-256 repo, `git reflog show` exits 0 and prints the expected entries; a
tsgit `archive` passes `tar -t` and `git archive --list`; `git fsck` exits 0.

### TDD steps

1. **RED** — `reflog-format.test.ts`: `Given a git-written SHA-256 reflog line` (literal bytes
   captured from `git init --object-format=sha256; git commit`) > `When parseReflogLine reads it
   at hexLength 64` > `Then oldId, newId, identity and message match`. *Fails:* arity, then the
   separator probe at `:40` misses.
2. **RED** — `reflog-format.test.ts`: `Given a create entry in a SHA-256 repository` > `When
   serializeReflogLine writes it` > `Then the old id is 64 zeros` and the bytes equal git's
   literal line. SHA-1 goldens unchanged (R6).
3. **RED** — `test/unit/domain/fsck/validate-object.test.ts`: `Given a SHA-256 tree with three
   entries` > `When validateTree frames it at digestLength 32` > `Then all three entries are
   reported valid`; and a truncated one reports the specific `.data` fields.
4. **RED** — `tar.test.ts`: `Given a 64-hex commit oid` > `When the PAX global header is emitted`
   > `Then the record's declared length equals its actual byte length`. State the invariant in the
   title — it is the write-only class's only oracle. Add the SHA-1 twin (declared 52, actual 52).
5. **RED** — interop: tsgit `archive` on a SHA-256 repo → `tar -t` exits 0 and
   `git archive --list` exits 0; `git reflog show` on a tsgit-written reflog exits 0.
6. **GREEN** — thread the width into all three modules and their callers; compute the PAX record
   length rather than declaring it.
7. **REFACTOR** — the reflog's four offset constants become one derivation from `hexLength`;
   `tar.ts:371` and `:383` read one computed value, not two.
8. **SURFACE** — `npm run docs:json` and commit `reports/api.json` (`parseReflogLine`,
   `serializeReflogLine`).

### Gate

```
npx vitest run test/unit/domain/reflog test/unit/domain/fsck/validate-object.test.ts test/unit/domain/archive test/integration/sha256-object-format-interop.test.ts \
  && npm run check:types \
  && ./node_modules/.bin/biome check src/domain/reflog/reflog-format.ts src/domain/fsck/validate-tree.ts src/domain/archive/tar.ts test/unit/domain/reflog test/unit/domain/fsck test/unit/domain/archive test/integration/sha256-object-format-interop.test.ts
```

### Commit

`fix: widen the reflog, fsck tree validator and tar PAX record to the repository's oid width`

## Part 6 — Command full-oid fast paths and prefix resolution

### Context

C4 (8 sites) + C5 (3 sites). All consume `isOid(value, ctx.hashConfig)` from Part 2.

**The idiom, repeated eight times:** "if it looks like a full oid, take it verbatim; otherwise
resolve as a ref", spelled as a literal `/^[0-9a-f]{40}$/`. Under SHA-256 a legitimate 64-hex oid
fails the test and is routed to `resolveRef`, producing a spurious ref-not-found.

| file:line | current text |
|---|---|
| `src/application/commands/branch.ts:178` | `if (/^[0-9a-f]{40}$/.test(startPoint)) return startPoint as ObjectId;` |
| `src/application/commands/checkout.ts:63` | `if (/^[0-9a-f]{40}$/.test(rev)) return rev as ObjectId;` |
| `src/application/commands/checkout.ts:85` | `const detached = opts.detach === true \|\| /^[0-9a-f]{40}$/.test(opts.rev);` |
| `src/application/commands/internal/commit-ish.ts:18` | `if (/^[0-9a-f]{40}$/.test(target)) return target as ObjectId;` |
| `src/application/commands/reset.ts:175` | `if (/^[0-9a-f]{40}$/.test(target)) return target as ObjectId;` |
| `src/application/commands/rev-parse.ts:59` | `if (/^[0-9a-f]{40}$/.test(base)) return ObjectIdFactory.from(base);` |
| `src/application/commands/tag.ts:94` | `const targetId = /^[0-9a-f]{40}$/.test(target) ? …` |
| `src/application/commands/notes.ts:32` | `const OID_RE = /^[0-9a-f]{40}$/;` (used at `:89` in `resolveObject`) |

**`checkout.ts:85` is worse than the rest** and gets its own interop row: a raw SHA-256 oid is not
recognised as detaching, so it is treated as a **branch name** and
`validateRefName('refs/heads/<64 hex>')` runs.

`notes.ts:29` (`FULL_HEX = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/`) is class C — already dual, used for
the annotated-object oid. Leave it. Only `OID_RE` at `:32` is the bug.

**C5 — `src/application/primitives/resolve-oid-prefix.ts` (3 sites), the subtlest failure in the
sweep because it returns `undefined` rather than throwing:**

| line | current | at 64 hex |
|---|---|---|
| `:16` | `const FULL_OID = /^[0-9a-f]{40}$/;` | a full 64-hex oid falls through to the prefix scan |
| `:17` | `const OID_PREFIX = /^[0-9a-f]{4,39}$/;` | upper bound must be `hexLength - 1` = 63 |
| `:18` | `const LOOSE_NAME = /^[0-9a-f]{38}$/;` | the loose filename tail is `hexLength - 2` = 62; abbreviated resolution silently finds nothing |

`LOOSE_NAME` is used at `:31` inside `scanLoose`, where the directory listing is filtered.
**The lower bound stays 4** — measured: a 4-char prefix resolves under both algorithms.
`resolveOidPrefix` already takes a `Context`, so `ctx.hashConfig.hexLength` is in scope.

**`looksLikeObjectId` (`src/application/primitives/validators.ts:241`) stays**, with its doc
comment amended to say it is a *format* check, true of the string and silent about the
repository. Its three consumers each need a decision, made here:

- `src/application/primitives/read-tree.ts:10` — has `ctx`; becomes `isOid(ref, ctx.hashConfig)`.
- `src/application/commands/submodule.ts:444` (`coerceRef`) — pure helper; its caller
  `submoduleList` has `ctx`; pass the config down.
- `src/application/primitives/validators.ts:62` (`isMalformedParentOid`) — a last-gate check
  before commit serialisation. `create-commit.ts:38` already calls
  `assertWellFormedParents(parents, ctx.hashConfig.hexLength)`, so the width is available on that
  path; make `isMalformedParentOid` take the config too rather than leaving two disagreeing
  parent checks.

**Interop rows to append** to `test/integration/sha256-object-format-interop.test.ts`
(cross-format confusion, design §1d/§1f):

- a **40-hex prefix of a SHA-256 oid resolves to the full 64-hex oid** — it is a prefix, not an
  algorithm signal. This is the row that guards `checkout.ts:85`.
- a 64-hex id in a SHA-1 repository is not found (git: `fatal: Not a valid object name`).
- `checkout` on a raw 64-hex oid detaches HEAD rather than attempting a branch name.

**Public-surface decision — this part adds NO new exported symbol and needs NO `api.json`
regeneration.** `looksLikeObjectId` and `isMalformedParentOid` are **internal**: neither appears
in `reports/api.json` (verified), and both live in `src/application/primitives/validators.ts`,
which is not re-exported from `src/index.ts` or `src/public-types.ts`. `resolveOidPrefix` gains no
parameter (it already takes a `Context`). The eight command fast paths are private module bodies.
If a later reviewer finds one of these on the public surface, that is a blocker to report, not a
silent `api.json` commit.

**Test file for the prefix work:** `test/unit/application/primitives/resolve-oid-prefix.test.ts`
(309 lines, `describe('resolveOidPrefix')` at `:23`, nested at `:24, 42, 92, 107, 136, 163, 183,
204, 223, 246, 260, 276`). Fixtures: `./fixtures.js` (`buildSeededContext`, `instrumentedContext`)
and `./pack-fixture.js` (`writeSyntheticPack`) — both need a SHA-256 axis.

### TDD steps

1. **RED** — `test/unit/application/primitives/resolve-oid-prefix.test.ts`: `Given a SHA-256
   repository` > `When a full 64-hex oid is resolved` > `Then it returns verbatim with no scan`
   (use `instrumentedContext` to assert zero readdir calls). *Fails:* it falls through to the scan.
2. **RED** — same file: `Given a SHA-256 repository with one loose object` > `When a 10-char
   prefix is resolved` > `Then it returns the full 64-hex oid`. *Fails:* `LOOSE_NAME` rejects the
   62-char filename.
3. **RED** — same file: a 63-char prefix resolves; a 64-char string is treated as a full oid, not
   a prefix. Separate isolated tests for each bound.
4. **RED** — same file: the existing SHA-1 rows still pass unchanged (R6).
5. **RED** — one test per fast-path site, at 64 hex: `checkout` detaches on a raw SHA-256 oid;
   `branch --start-point <64 hex>` takes it verbatim; `reset`, `tag`, `rev-parse`, `notes`,
   `commit-ish` likewise. Eight tests, one per site — a single sweeping test leaves seven mutants
   alive.
6. **RED** — the trap row: `Given a SHA-256 repository` > `When a 40-hex string is passed to the
   fast path` > `Then it is NOT taken verbatim` (it is a prefix, and must reach prefix
   resolution). This is the test that fails if someone reaches for `looksLikeObjectId`.
7. **RED** — interop cross-format-confusion rows above.
8. **GREEN** — replace the eight literals with `isOid(value, ctx.hashConfig)`; derive
   `resolve-oid-prefix.ts`'s three patterns from `ctx.hashConfig.hexLength`; convert the three
   `looksLikeObjectId` consumers; amend the `looksLikeObjectId` doc comment.
9. **REFACTOR** — the eight fast paths now share one call shape; if three or more sit in the same
   module, extract a named local. No function gains a boolean parameter.

### Gate

```
npx vitest run test/unit/application/primitives/resolve-oid-prefix.test.ts test/unit/application/primitives/validators.test.ts test/unit/application/commands test/integration/sha256-object-format-interop.test.ts \
  && npm run check:types \
  && ./node_modules/.bin/biome check src/application/primitives/resolve-oid-prefix.ts src/application/primitives/validators.ts src/application/primitives/read-tree.ts src/application/commands test/unit/application test/integration/sha256-object-format-interop.test.ts
```

### Commit

`fix: resolve full oids and prefixes at the repository's own oid width`

## Part 7 — Read `extensions.objectFormat`, with git's value grammar

### Context

ADR-696. The config-value refusal family — a **third** tier, distinct from the acceptance gate's
refusals (ADR-668) and from the point-of-use refusal (ADR-685). These fire at the Stage-2 layout
read, i.e. **open time**, strictly before any `assert*` tier runs.

**`src/repository/read-repository-format.ts` (430 lines) is the whole surface to change.**
The machinery is already there:

```ts
const EXTENSIONS_SECTION = 'extensions';                       // :29
const lastTopLevelEntry = (tokens, section, key): ScannedEntry | undefined => …  // :101-113
interface ScannedFormat { bare; worktree; worktreeConfig; tokens }  // :274-279
worktreeConfig: lastTopLevelEntry(tokens, EXTENSIONS_SECTION, WORKTREE_CONFIG_KEY),  // :300
export interface RepositoryFormat { bare; worktree; worktreeConfig; refusal }  // :21-27
```

Adding the read is: one constant (`OBJECT_FORMAT_KEY = 'objectformat'` — the key is matched
lower-cased at `:92`), one `lastTopLevelEntry` call in `scanConfigFile` (`:281-303`), one field on
`ScannedFormat`, one resolver beside `resolveBare` (`:349`) / `resolveWorktree` (`:358`), and one
field on `RepositoryFormat`.

**Two things must NOT be copied from the neighbouring keys:**

- **Scoping.** `core.bare` and `core.worktree` go through `pickScoped` (call at `:406`, definition at `:424`).
  The format keys do **not** — a `repositoryformatversion` or `extensions.*` planted in
  `config.worktree` is inert even with `extensions.worktreeConfig = true`. `objectFormat` reads
  `<commonDir>/config` only. Call `lastTopLevelEntry` on `local` and never consult `scoped`.
- **Leniency.** `scanConfigFile`'s absent-file-behaves-as-empty rule (`:285-294`) is right for
  `objectFormat` (absent ⇒ sha1) but the present-and-malformed cases are **refusals**, matching
  the `configBadBooleanValue` / `configMissingValue` throws the same function already performs.

**The measured value grammar (git 2.55.0) — every row is a test:**

| value | verdict |
|---|---|
| `sha1` | accepted — sha1 (an explicit, legal no-op) |
| `sha256` | accepted — sha256 |
| `SHA256`, `Sha256` | `error: invalid value for 'extensions.objectformat': 'SHA256'` + `fatal: bad config line N in file <F>`, exit 128 — the value is **case-sensitive** (the *key* is lower-cased in the message) |
| `sha-256`, `sha256x` | same invalid-value pair |
| `objectFormat =` (empty string) | same invalid-value pair, reporting `''` — **not** the missing-value shape; `=`-with-nothing is an empty string, valueless is git NULL |
| `  sha256  ` | accepted — the config tokeniser strips; the value grammar never sees the spaces |
| `objectFormat` (valueless, no `=`) | `error: missing value for 'extensions.objectformat'` + `fatal: bad config line N in file <F>`, exit 128 |
| `sha256` then `sha1` | **last-wins** ⇒ sha1 (exactly what `lastTopLevelEntry` already does) |
| key absent, at v1 | accepted ⇒ **sha1** |
| `[extensions "x"] objectFormat = sha256` | the **acceptance gate's** refusal, not this one — `lastTopLevelEntry` skips subsectioned entries at `:108`, which is already correct |
| `objectFormat = sha256` at v0 | again the acceptance gate's refusal |

**The case-sensitivity row is its own test.** A `toLowerCase()` added "for symmetry with the key"
is the single most likely faithfulness regression in this part, and only that row kills it.

**New error code — `CONFIG_INVALID_ENUM_VALUE { key, source, value }`.** Surface gates, all in
this part:

1. Union member in `src/domain/commands/error.ts` beside `CONFIG_BAD_BOOLEAN_LITERAL` (`:165`)
   and `CONFIG_BAD_BOOLEAN_VALUE` (`:159`); factory beside `configBadBooleanValue` (`:587`).
2. Renderer `case` in `src/domain/error.ts` — the switch ends with
   `const _exhaustive: never = data;` at `:573`, so a missed case fails `check:types`.
   Render shape follows `CONFIG_BAD_BOOLEAN_LITERAL`'s neighbour convention; the interop test
   reconstructs git's two lines from the fields (ADR-249 — the library emits no rendered line).
3. `docs/use/errors.md` — a new row under **`### Repository state`** (`:191`), alphabetical:
   `| `CONFIG_INVALID_ENUM_VALUE` | `key, source, value` | … |`. Also extend
   `CONFIG_MISSING_VALUE`'s key list at `:197` with `extensions.objectformat`.
4. `npm run docs:json` + commit `reports/api.json`.

**Keep it general from day one** — `extensions.refStorage` (`files`/`reftable`) has the identical
grammar and is this code's second caller, landing in the sibling reftable change. Do not name
`objectFormat` in the code path, the message, or the doc row's wording beyond the example.

**The valueless arm reuses `CONFIG_MISSING_VALUE` unchanged** (`configMissingValue(key, source,
line)` at `src/domain/commands/error.ts:548`) — a docs key-list row, not a code.

**Test file:** `test/unit/repository/read-repository-format.test.ts` (412 lines,
`describe('readRepositoryFormat')` at `:15`, nested `Given …/When readRepositoryFormat runs` at
`:16, 40, 61, 82, 107, 133, 155, 177, 209, 241, 265`). Extend with an `it.each` sweep over the
grammar table, but give the **two refusal arms separate tests** — `invalid value` and
`missing value` are one `if/else` apart, so each guard must be proven alone. Refusal rows use
try/catch + direct `.data` assertions.

**Interop rows to append** to `test/integration/sha256-object-format-interop.test.ts`: the full
grammar table driven through `openRepository`, each refusal's structured fields reconstructing
git's exact two lines and each accepted row matching `git rev-parse --show-object-format`.

### TDD steps

1. **RED** — `read-repository-format.test.ts`: `Given a config with extensions.objectFormat =
   sha256` > `When readRepositoryFormat runs` > `Then objectFormat is 'sha256'`. *Fails:*
   `RepositoryFormat` has no such field.
2. **RED** — `Given extensions.objectFormat = sha1` > … > `Then objectFormat is 'sha1'`.
3. **RED** — `Given no extensions.objectFormat at v1` > … > `Then objectFormat is 'sha1'`.
4. **RED** — `Given extensions.objectFormat = SHA256` > … > `Then it throws
   CONFIG_INVALID_ENUM_VALUE with key 'extensions.objectformat', the config path as source and
   value 'SHA256'`. try/catch, assert each `.data` field. This is the case-sensitivity guard.
5. **RED** — separate tests for `sha-256`, `sha256x`, and the **empty string** (`objectFormat =`),
   each asserting `CONFIG_INVALID_ENUM_VALUE` with the right `value` (`''` for the empty case).
6. **RED** — a **separate** test: `Given a valueless extensions.objectFormat` > … > `Then it
   throws CONFIG_MISSING_VALUE with key, source and the 1-based line`. Proves the second guard
   alone.
7. **RED** — `Given whitespace-padded '  sha256  '` > … > `Then it is accepted as sha256`.
8. **RED** — `Given sha256 then sha1 in that order` > … > `Then last-wins yields sha1`; and the
   reverse order yields sha256.
9. **RED** — `Given extensions.objectFormat planted in config.worktree with worktreeConfig true`
   > … > `Then it is inert and the format stays sha1` (the no-`pickScoped` rule).
10. **RED** — interop: each grammar row's tsgit verdict twinned against
    `tryRunGitWithExit(['-C', dir, 'rev-parse', '--show-object-format'])`, exit code and all.
11. **GREEN** — add the constant, the scan entry, the `ScannedFormat` field, the resolver, the
    `RepositoryFormat` field, the error code, the renderer case and the docs rows.
12. **REFACTOR** — the resolver is a small total function over `ScannedEntry | undefined`; extract
    a shared `resolveEnum(entry, source, key, allowed)` so `refStorage` can call it unchanged.
13. **SURFACE** — `npm run docs:json`, commit `reports/api.json`.

### Gate

```
npx vitest run test/unit/repository/read-repository-format.test.ts test/unit/domain/error.test.ts test/integration/sha256-object-format-interop.test.ts \
  && npm run check:types \
  && ./node_modules/.bin/biome check src/repository/read-repository-format.ts src/domain/commands/error.ts src/domain/error.ts test/unit/repository test/integration/sha256-object-format-interop.test.ts
```

### Commit

`feat: read extensions.objectFormat with git's measured value grammar`

## Part 8 — The algorithm reaches the Context by both channels

### Context

ADR-693. Two channels, the option wins, a contradiction refuses. **One mechanism cannot serve
both tiers** — any implementation that pretends otherwise is wrong.

**Three structural facts, already true — verify, do not re-derive:**

1. **The three async entry points already resolve layout before constructing adapters.**
   `src/index.node.ts` resolves at `:70` (`resolveNodeLayout` → `resolveLayout` → `finishLayout` →
   `readRepositoryFormat`, opening and tokenising `<commonDir>/config`) and constructs
   `new NodeHashService()` at `:95`. `src/index.browser.ts` resolves at `:70`
   (`resolveFixedEntryLayout`) and constructs at `:79`. `src/index.default.ts` resolves at `:74-80`
   and constructs at `:93`. **Detection needs no reordering on any of them.**
2. **The two sync factories structurally cannot detect.** `createNodeContext`
   (`src/adapters/node/node-adapter.ts:48`) and `createBrowserContext`
   (`src/adapters/browser/browser-adapter.ts:26`) return `Context`, not a promise, and build their
   layouts purely lexically (`buildLayout(...)` at `node-adapter.ts:60`; an object literal at
   `browser-adapter.ts:38-42`). Neither touches disk. Making them detect means making them
   `async` — a breaking signature change on a public surface. They take the explicit option.
3. **`syntheticFallbackLayout` (`src/repository/resolve-layout.ts:214-242`) reads nothing from
   disk** by design — the found-nothing bootstrap path `init` and `clone` take. A repository being
   *created* can never have its format detected; it can only be told.

**The channel out of `finishLayout`.** Today `fmt` dies there:
`src/repository/resolve-layout.ts:244-300` consumes `readRepositoryFormat`'s result and folds
every field into `bare` / `workDir` / `workTreeConfigBogus`; the returned
`RepositoryLayoutInput` has no slot for anything else. Add `objectFormat?: 'sha1' | 'sha256'` to
`RepositoryLayoutInput` and, per ADR-658, as an **additive optional field** on
`RepositoryLayout` (`src/ports/context.ts:35-70`, beside `commonDir` at `:52`). Public type ⇒
`api.json`.

**The four wiring pins to convert (C12, 8 sites).** Each constructs the hash service with no
argument (taking the `= 'sha1'` default) and pairs it with a literal `SHA1_CONFIG`:

| entry | hash construction | hashConfig pin | import |
|---|---|---|---|
| `src/index.node.ts` | `:95` `new NodeHashService()` | `:111` `hashConfig: SHA1_CONFIG` | `:20` |
| `src/index.browser.ts` | `:79` `new BrowserHashService()` | `:84` | `:12` |
| `src/adapters/node/node-adapter.ts` | `:55` `new NodeHashService()` | `:73` | `:3` |
| `src/adapters/browser/browser-adapter.ts` | `:34` `new BrowserHashService()` | `:44` | `:2` |

**The precedent to copy** is already in the repository, twice —
`src/index.default.ts:50, 93, 98` and `src/adapters/memory/memory-adapter.ts:51, 52, 64`:

```ts
const algorithm = opts.algorithm ?? 'sha1';
… hash: new MemoryHashService(algorithm),
   hashConfig: algorithm === 'sha256' ? SHA256_CONFIG : SHA1_CONFIG,
```

All three `HashService` implementations already take `(algorithm: 'sha1' | 'sha256' = 'sha1')`
and all three really compute SHA-256 (`node-hash-service.ts:16,22` `createHash(this.algorithm)`;
`memory-hash-service.ts:24` `SUBTLE_ALGO` table; `browser-hash-service.ts:11,16,56` ternary).
`src/ports/hash-service.ts:19,21` already declares `algorithm` and `digestLength`.

**Option surface.** Promote `algorithm?: 'sha1' | 'sha256'` from the memory-only
`OpenMemoryRepositoryOptions` (`src/index.default.ts:41-42`) to the **core**
`OpenRepositoryOptions` (`src/repository.ts:76` — verified exact), and add it to `NodeAdapterOptions`
(`src/adapters/node/node-adapter.ts:19-46`) and `BrowserAdapterOptions`
(`src/adapters/browser/browser-adapter.ts:14-21`). `MemoryAdapterOptions` already has it
(`memory-adapter.ts:18`). All public ⇒ `api.json`.

**The contradiction refusal — the load-bearing half.** Without it, (c) re-opens the
`ctx.hash` / `ctx.hashConfig` desync that exists **today**: `openRepository({ hash: new
NodeHashService('sha256') })` on the Node entry yields `ctx.hash.algorithm === 'sha256'` paired
with `ctx.hashConfig === SHA1_CONFIG`, and nothing refuses it (`src/repository.ts:516`
`hashConfig: fallback.hashConfig` is the only consumer; `hash` goes through `composeAdapters`
(`src/repository/compose-adapters.ts:53`) whose `AdapterFallback` does not even carry
`hashConfig`; `createContext` (`src/ports/context.ts:221-232`) is a bare spread + freeze with
zero validation). `serialize-and-hash.ts:19-20` uses both in consecutive lines.

Reconcile at **one** place — `createContext` is the wrong place (it is a frozen spread with no
error vocabulary); do it in `src/repository.ts` where `fallback` and `opts` are both in hand,
just before `baseCtx` is built (`:503-518`). Refuse when any two of these disagree:
`opts.algorithm`, `layout.objectFormat`, `opts.hash?.algorithm`, `fallback.hashConfig.algorithm`.
New code (name it for the condition, not the key — e.g. `OBJECT_FORMAT_CONFLICT` carrying
`{ requested, declared, source }`). It is an **option/config conflict**, not a repository
property, so it sits **outside** ADR-682's acceptance tier and must not be raised from any
`assert*` function. Same surface gates as Part 7's code (union, renderer case, `docs/use/errors.md`
row under `### Repository state`, `api.json`).

**Also in this part — `HashService` gains an optional algorithm factory**, which Part 10's
`clone` needs and which nothing else can provide:

```ts
// src/ports/hash-service.ts
/** Return a service for a different algorithm. Optional: a caller-supplied
 *  service need not be re-instantiable. */
readonly withAlgorithm?: (algorithm: 'sha1' | 'sha256') => HashService;
```

**Optional**, so a user-supplied `HashService` does not break. Implement it on all three adapters
(`new NodeHashService(algorithm)` etc. — one line each). Extend the shared contract at
`test/unit/ports/hash-service.contract.ts:5`
(`hashServiceContractTests(createSut: () => Promise<HashService>): void`) with a SHA-256 axis;
`test/unit/adapters/node/node-hash-service.test.ts:10` and
`test/unit/adapters/memory/memory-hash-service.test.ts:10` already have a `Given sha256` block to
extend. The browser service has no unit test — it is pinned by
`test/browser/hash-interop.spec.ts` (which asserts `ce013625030ba8dba906f756967f9e9ca394464a` for
`hello\n`); add the SHA-256 vector `2cf8d83d9ee29543b34a87727421fdecb7e3f3a183d337639025de576db9ebb4`
there.

**Read-path/read-path symmetry (a rule, not a nicety):** a repository's format is read from
exactly **one** place. If both `readRepositoryFormat` and a later `readConfig(ctx)` derive it,
they can disagree when `config.worktree` is in play. One reader.

**Docs to update in this part:** `docs/get-started/node.md` (`## Open a repository` `:18`,
`## Bare repositories and explicit layout` `:30`), `browser.md` (`:52`, `:95`), `memory.md`
(`:16`, `:35`) — the three that document options in prose. `deno.md`, `bun.md` and
`cloudflare-workers.md` have "Parity with Node" sections and need no option list.
Also `docs/understand/architecture.md:80`, which currently reads "The hash configuration (SHA-1
today; SHA-256 reserved for v4)" — falsified by this change.

### TDD steps

1. **RED** — `test/unit/adapters/node/node-adapter.test.ts`: `Given algorithm 'sha256'` > `When
   createNodeContext builds the context` > `Then ctx.hash.algorithm is 'sha256' and
   ctx.hashConfig is SHA256_CONFIG`. Same for `createBrowserContext`. *Fails:* no such option.
2. **RED** — a test that the default (no option) still yields sha1 on both factories (R6).
3. **RED** — `test/unit/repository/…`: `Given a repository whose config declares
   extensions.objectFormat = sha256` > `When openRepository runs on the node entry with no
   algorithm option` > `Then ctx.hashConfig.algorithm is 'sha256'` (the layout channel).
4. **RED** — `Given the same repository` > `When openRepository is called with algorithm 'sha256'`
   > `Then it opens` (agreement is not a conflict).
5. **RED** — three **isolated** conflict tests, one guard each: option vs declared format;
   `opts.hash.algorithm` vs declared format; `opts.hash.algorithm` vs `opts.algorithm`. Each
   asserts the new code's `.data` fields via try/catch. A single test triggering two conditions
   proves neither.
6. **RED** — the desync that exists today: `openRepository({ hash: new NodeHashService('sha256') })`
   on a sha1 repository now refuses instead of silently mis-pairing.
7. **RED** — `test/unit/ports/hash-service.contract.ts` SHA-256 axis + `withAlgorithm` round-trip
   on all three adapters (`sut.withAlgorithm('sha256').digestLength === 32`); a service without
   `withAlgorithm` is still a valid `HashService`.
8. **RED** — interop: `openRepository` on a `git init --object-format=sha256` fixture, then `log`,
   `catFile`, `lsTree`, `revParse HEAD` and `HEAD^{tree}` return exactly git's 64-hex oids.
   **Plus the two regressions named directly from the measurement**, both live defects that must
   be *proven* fixed: `catFile` throws a **typed** `TsgitError` (assert `.data.code`, never the
   class) where it throws a raw `TypeError` today; and `status` no longer reports a truncated
   40-hex id.
9. **GREEN** — add `objectFormat` to `RepositoryFormat` consumption in `finishLayout`,
   `RepositoryLayoutInput` and `RepositoryLayout`; convert the eight wiring pins; add the option
   to the three option types and the core one; add `withAlgorithm` to the port and all three
   adapters; add the conflict code and reconcile in `src/repository.ts`.
10. **REFACTOR** — one `resolveAlgorithm({ option, declared, service })` helper used by every
    entry, so the precedence rule and the refusal live in one place, not five. Delete the
    duplicated `algorithm === 'sha256' ? SHA256_CONFIG : SHA1_CONFIG` ternaries in favour of a
    `configFor(algorithm)` lookup exported from `hash-config.ts`.
11. **SURFACE** — `npm run docs:json`, commit `reports/api.json`; update the three get-started
    pages and `docs/understand/architecture.md:80`; add the errors row.

### Gate

```
npx vitest run test/unit/adapters test/unit/ports test/unit/repository test/unit/public-types.test.ts test/integration/sha256-object-format-interop.test.ts \
  && npm run check:types \
  && ./node_modules/.bin/biome check src/index.node.ts src/index.browser.ts src/index.default.ts src/adapters/node/node-adapter.ts src/adapters/browser/browser-adapter.ts src/adapters/memory/memory-adapter.ts src/ports/hash-service.ts src/ports/context.ts src/repository.ts src/repository/resolve-layout.ts src/domain/objects/hash-config.ts test/unit/adapters test/unit/ports test/unit/repository
```

### Commit

`feat: derive the object algorithm from the repository or the caller, and refuse a contradiction`

## Part 9 — Transport: the algorithm on the wire, both protocols, both directions

### Context

ADR-695 + ADR-697. C10 (4 sites). **Three different states, not one missing check.**

**Naming.** This repository calls the legacy protocol **v1** (`FetchWireVersion = 1 | 2`).
ADR-697's "protocol v0" is this repo's v1. Never introduce a `v0` identifier.

| protocol | tsgit today |
|---|---|
| **v2, send** | `src/domain/protocol/v2/sections.ts:51` emits a **hardcoded** `object-format=sha1\n` in *every* command request |
| **v2, receive** | `src/domain/protocol/v2/capabilities.ts:65-69` parses the advertised value and throws `unsupportedObjectFormat(state.objectFormat)` for anything but `sha1` — the mismatch is already detected here, and the error code already exists |
| **v1** | **no `object-format` handling whatsoever.** A v1 SHA-256 server is silently accepted. |

**Measured (git 2.55.0) — git advertises the algorithm on both protocols:**

| surface | measured |
|---|---|
| v1 `upload-pack --advertise-refs` | capability list ends `… symref=HEAD:refs/heads/main object-format=sha256 agent=git/2.55.0-Darwin` |
| v1 `receive-pack --advertise-refs` | `report-status report-status-v2 delete-refs side-band-64k quiet atomic ofs-delta object-format=sha256 agent=…` |
| v2 | `object-format=sha256` as its own capability pkt-line, in the advertisement **and** echoed by the client |
| `git fetch` sha1 remote → sha256 repo | `fatal: mismatched algorithms: client sha256; server sha1`, exit **128** |
| `git fetch` sha256 remote → sha1 repo | `fatal: mismatched algorithms: client sha1; server sha256`, exit **128** |
| `git push` sha256 → sha1 bare | `fatal: the receiving end does not support this repository's hash algorithm` + `fatal: the remote end hung up unexpectedly`, exit **128** |
| `git push` sha256 → sha256 bare | succeeds |

**Push is v1-only in tsgit by construction** — `src/application/commands/internal/git-service-session.ts:53-61`
scopes the `Git-Protocol: version=2` header to `git-upload-pack`. That is precisely why ADR-697
is load-bearing: without v1 handling the new push code would ship dead.

**The plumbing choke point.** `negotiateDiscovery(session)`
(`src/application/commands/internal/fetch-negotiation.ts:118`) is the **single** entry for both
v1 and v2 advertisement parsing, and it takes **no `Context`**. It calls
`parseV2Capabilities(...)` at `:130` (the only production call site) and
`buildLsRefsRequest(...)` at `:135`. `capabilities.objectFormat` is currently **dropped** — it
never reaches `DiscoveryResult` (`:44-47`, `{ version, advertisement }`). Adding a `ctx` parameter
there is the minimal change that reaches both legs plus the ls-refs request build. Call sites:
`fetch.ts:131`, `clone.ts:133` — `ctx` is in scope at both.

**Exact edits:**

1. `src/domain/protocol/v2/sections.ts:43-55` — `encodeCommandRequest(command, args, payloads)`
   gains an `objectFormat: 'sha1' | 'sha256'` parameter. Its two callers,
   `buildLsRefsRequest` (`src/domain/protocol/v2/ls-refs.ts:23`, called at
   `fetch-negotiation.ts:135`) and `buildV2FetchRequest`
   (`src/domain/protocol/v2/fetch.ts:73`, called at `fetch-negotiation.ts:159` where `ctx` is
   already a parameter), thread it through their options objects. Both are pure domain functions
   — they take the value, never a `Context`.
2. `src/domain/protocol/v2/capabilities.ts:65-70` — stop throwing on `!== 'sha1'`. Accept `sha1`
   and `sha256`; refuse anything else (an unrecognised advertised value is a refusal, never a
   fallback to sha1 — a fallback would let a hostile server downgrade the client's verification).
   **`DEFAULT_OBJECT_FORMAT = 'sha1'` at `:5` is class B and stays** — an absent `object-format`
   means sha1 by protocol spec, on both versions. Widening the *accepted set* must not touch the
   *default*. `V2Capabilities.objectFormat` (`:18`) already exists; surface it on
   `DiscoveryResult` (`fetch-negotiation.ts:44-47`).
3. `src/domain/protocol/capabilities.ts` — v1. `parseCapabilities` (`:42`) returns raw tokens and
   the array survives on `Advertisement.capabilities` (`src/domain/protocol/upload-pack.ts:39-43`),
   so **no parsing change is needed** — add a small `readObjectFormat(caps)` reader beside it
   that finds the `object-format=<v>` token and defaults to `sha1`. Add the token to
   `CLIENT_CAPABILITIES_FETCH` (`:6-15`) and `CLIENT_CAPABILITIES_PUSH` (`:17-24`) — but the
   value is per-repository, so it cannot be a module constant: make the two arrays functions of
   the algorithm, or (simpler) append the token in the two selectors that already build the wire
   set, `selectFetchCapabilities` (`src/application/commands/internal/upload-pack-client.ts:42-50`)
   and `selectPushCapabilities` (`src/application/commands/internal/receive-pack-client.ts:34-42`),
   both of which already append `AGENT` the same way. Prefer the selector route — it keeps
   `negotiateCapabilities`'s "echo only what the server offered" contract intact while still
   sending the token, matching git.
4. The mismatch checks. Compare the peer's format against `ctx.hashConfig.algorithm` right after
   discovery — in `fetch.ts` (after `:131`) and in `clone.ts` (after `:133`). Push: compare in
   `sendUpdates` (`push.ts:331-339`, `ctx` in scope) after `discoverReceivePackRefs` (`:174`).
   **`clone` refuses a cross-format peer in this part and starts adopting in Part 10** — that is
   deliberate sequencing, not an oversight: transport establishes one rule on every path, then
   Part 10 narrows the single verb git treats differently (git has no `clone --object-format`; it
   adopts). Write the clone refusal test here and let Part 10 flip it; do not pre-build the
   adoption path.

**Error codes.**

- **`UNSUPPORTED_OBJECT_FORMAT` widens in place** (ADR-695). Today
  `{ code: 'UNSUPPORTED_OBJECT_FORMAT'; format: string }`
  (`src/domain/protocol/error.ts:35`, factory `:102-103`), rendered
  `unsupported object format: ${data.format}` (in `src/domain/error.ts`'s renderer switch —
  locate the `case 'UNSUPPORTED_OBJECT_FORMAT':` by content; this file gains cases every part). Add `local: string`;
  `format` keeps meaning **the peer's**. The reconstruction needs two fields —
  `mismatched algorithms: client <local>; server <format>`.
  **Its `docs/use/errors.md:180` row is FALSIFIED by this change** and must be rewritten in this
  part: it currently reads *"v2 capability advertisement's `object-format` is not `sha1` — tsgit
  only supports sha1 repositories."* The condition is now a **mismatch against the local
  repository**, on both protocol versions, and the row must say so. This is a documentation
  defect the moment ADR-681 lands, not a follow-up.
- **One new code for the push direction.** Name it for the verb, not the key — e.g.
  `PUSH_OBJECT_FORMAT_UNSUPPORTED { local, remote }`. Two conditions, two message shapes,
  selected by verb; keeping them apart is the actionable part for a caller. New row under
  `docs/use/errors.md` `### Network, transport, partial clone` (`:145`), alphabetical.
- Both are transport concerns and sit **outside** ADR-682's acceptance tier: both repositories
  are individually acceptable; only the **pairing** is not.

**Security constraint (design §5):** `object-format` is a **remote-supplied** string. It must
select from a closed two-element set and never be interpolated into a path, a filename, or any
rendered string beyond the refusal payload.

**Interop rows to append** to `test/integration/sha256-object-format-interop.test.ts`. The
in-process server is `test/bench/support/http-backend-server.ts` —
`startGitHttpBackend({ projectRoot, forwardGitProtocol })`; the **boolean `forwardGitProtocol`
option is the sole v1/v2 switch** (it copies the client's `Git-Protocol` header into the CGI's
`GIT_PROTOCOL` env var at `:127`; withheld ⇒ git-http-backend falls back to v1). Parameterise the
rows over both legs, as `test/integration/network/incremental-fetch-http-backend.test.ts:140-145`
already does. **Use `gitAsync` for anything driving the in-process server — a sync `git` spawn
deadlocks it.** Rows: sha256↔sha256 fetch and push succeed; sha1→sha256 and sha256→sha1 fetch
refuse with the right `.data`; push to a sha1 receiver refuses; and the client's own request
carries its **real** algorithm, asserted against a real `upload-pack` advertisement.

### TDD steps

1. **RED** — `test/unit/domain/protocol/v2/sections.test.ts`: `Given objectFormat 'sha256'` >
   `When encodeCommandRequest builds the header` > `Then the third pkt-line is
   object-format=sha256\n`; and the sha1 case is byte-identical to today (R6).
   Also update `test/unit/domain/protocol/v2/sections.properties.test.ts:93`.
2. **RED** — `test/unit/domain/protocol/v2/capabilities.test.ts`: `Given an advertisement
   declaring object-format=sha256` > `When parseV2Capabilities runs` > `Then objectFormat is
   'sha256' and it does not throw`. *Fails:* the `:67` guard throws.
3. **RED** — same file, **isolated**: `object-format=sha512` still throws
   `UNSUPPORTED_OBJECT_FORMAT` with `format: 'sha512'`; an **absent** `object-format` still
   yields `'sha1'` (the class-B default must not move).
4. **RED** — `test/unit/domain/protocol/capabilities.test.ts`: the v1 reader returns `'sha256'`
   from a token list containing `object-format=sha256` and `'sha1'` from one without it.
5. **RED** — `upload-pack-client` / `receive-pack-client` selector tests: the negotiated client
   capability list carries `object-format=<local algorithm>` in both verbs.
6. **RED** — `test/unit/application/commands/fetch.test.ts`: `Given a sha1 local repository and a
   sha256 peer` > `When fetch negotiates` > `Then it throws UNSUPPORTED_OBJECT_FORMAT with
   format 'sha256' and local 'sha1'`; the mirrored direction as a **separate** test.
7. **RED** — `test/unit/application/commands/push.test.ts`: `Given a sha256 local repository and
   a sha1 receiver` > `When push negotiates` > `Then it throws the push-direction code with
   local 'sha256' and remote 'sha1'`. Assert `.data`, not the class.
8. **RED** — interop rows above, run over **both** `forwardGitProtocol: false` (v1) and `true`
   (v2). The v1 push row is the one that proves the push refusal is reachable at all.
9. **GREEN** — thread the algorithm into `encodeCommandRequest` and its two builders; widen the
   v2 accepted set; add the v1 reader and the two selector appends; give `negotiateDiscovery` a
   `ctx` and surface `objectFormat` on `DiscoveryResult`; add both mismatch checks; widen
   `UNSUPPORTED_OBJECT_FORMAT`'s payload and renderer; add the push code.
10. **REFACTOR** — one `assertPeerAlgorithm(local, peer, verb)` helper raising the right code per
    verb, so the two conditions stay distinguishable by code rather than by call site.
11. **SURFACE** — rewrite `docs/use/errors.md:180`; add the push row under `### Network,
    transport, partial clone`; `npm run docs:json`, commit `reports/api.json`.

### Gate

```
npx vitest run test/unit/domain/protocol test/unit/application/commands/fetch.test.ts test/unit/application/commands/push.test.ts test/unit/application/commands/clone.test.ts test/integration/sha256-object-format-interop.test.ts \
  && npm run check:types \
  && ./node_modules/.bin/biome check src/domain/protocol src/application/commands/internal/fetch-negotiation.ts src/application/commands/internal/upload-pack-client.ts src/application/commands/internal/receive-pack-client.ts src/application/commands/fetch.ts src/application/commands/push.ts src/domain/error.ts docs/use/errors.md test/unit/domain/protocol test/integration/sha256-object-format-interop.test.ts
```

### Commit

`feat: negotiate the object format on both wire protocols and refuse a mismatch`

## Part 10 — `init` creates SHA-256 repositories, `clone` adopts the source's format

### Context

ADR-681's full parity (R10). Two very different mechanisms.

**`init` — it is told.** `src/application/commands/internal/bootstrap.ts`:

```ts
interface BootstrapOptions { initialBranch: string; bare: boolean; hash?: 'sha1'; }   // :5-9
const renderConfig = (bare: boolean): string =>                                        // :27-28
  `[core]\n\trepositoryformatversion = 0\n\tfilemode = true\n\tbare = ${bare ? 'true' : 'false'}\n`;
await ctx.fs.writeUtf8(`${gitDir}/config`, renderConfig(opts.bare));                   // :49
```

`hash?: 'sha1'` is a **single-valued option nobody passes** — `init.ts:32` and `clone.ts:94` both
omit it. Dead today; the live parameter under ADR-681. Replace it with
`objectFormat?: 'sha1' | 'sha256'` and add `objectFormat?: 'sha1' | 'sha256'` to `InitOptions`
(`src/application/commands/init.ts:6-9`), threading it at `:32`.

**The measured bytes (`git init --object-format=sha256`, `od -c`-verified, 173 bytes).** Every
indent is one literal TAB, every line ends LF, no trailing blank line. The `[extensions]` block is
written **before** `[core]`, and the key is emitted lower-cased:

```ini
[extensions]
	objectformat = sha256
[core]
	repositoryformatversion = 1
	filemode = true
	bare = false
	logallrefupdates = true
	ignorecase = true
	precomposeunicode = true
```

**Scope the byte contract honestly:** tsgit's `renderConfig` writes only
`repositoryformatversion`, `filemode` and `bare` today, and that stays (this change adds a
capability, never a default change). What the interop row pins is the **block ordering**
(`[extensions]` before `[core]`), the lower-cased `objectformat` key, the TAB indent, and
`repositoryformatversion = 1`. A writer that appends `[extensions]` after `[core]` produces a
semantically identical but byte-different config — the ordering is load-bearing.
Absent an object-format request, `renderConfig` is **byte-identical to today** (R6).

Also measured: `git init` with no flag re-run inside an existing sha256 repo **succeeds**, format
preserved; `git init --object-format=sha1` inside one dies
`fatal: attempt to reinitialize repository with different hash`, exit 128, config untouched.
tsgit's `init` throws `ALREADY_INITIALIZED` when `<gitDir>/HEAD` exists (`init.ts:29-31`), so the
re-init rows are already covered by an earlier refusal — assert that, do not add a new code.

**`clone` — it adopts, and this is the one place the design leaves a hole.** git has **no**
`clone --object-format` in 2.55.0 (`error: unknown option 'object-format=…'`); the algorithm is
learned from the wire advertisement **before** the destination config is written. tsgit's
`clone` today calls `bootstrapRepository` at `src/application/commands/clone.ts:95` — **before**
the session opens at `:119` and before `negotiateDiscovery` at `:134`. A `clone` that keeps that
order writes a sha1 repository and then fills it with sha256 objects.

**Decision (the design does not specify a mechanism; this plan does):**

1. **Move `bootstrapRepository` after discovery.** In `negotiateAndWritePack`
   (`clone.ts:127-133`), immediately after `const discovery = await negotiateDiscovery(session, ctx)`
   at `:134` (Part 9's `assertPeerAlgorithm` call sits at `:139` — **replace it** with adoption), read the peer's advertised `object-format` (Part 9 made it reachable on `DiscoveryResult`), then
   bootstrap with that format. The outer `catch` ending at `clone.ts:105` already does
   `rmRecursive(ctx.layout.gitDir)` on any failure past bootstrap, and git also creates the target
   then cleans up on failure, so the observable end state is unchanged. The
   `targetDirectoryNotEmpty` guard at `:85` stays where it is, before anything else.
   **The ordering risk was checked, not assumed:** `openGitSession`
   (`src/application/commands/internal/git-service-session.ts:69-76`) reads only `parseRemoteUrl(url)`,
   `ctx.ssh` and `ctx.config?.auth` — the caller-supplied `RepositoryConfig`, never the
   destination's on-disk `config`. Opening the session before the gitDir exists is therefore
   behaviour-preserving. Confirm this still holds for the ssh branch
   (`SshGitServiceSession`) before landing; if it resolves `core.sshCommand` through
   `readConfig(ctx)`, the answer is still "no change" (a just-bootstrapped minimal config carries
   no `core.sshCommand` either), but verify rather than assume.
2. **Derive the clone context once, immediately after discovery**, and thread it through every
   subsequent call:
   `const cloneCtx = Object.freeze({ ...ctx, hash: adopted, hashConfig: configFor(algorithm) })`
   where `adopted = ctx.hash.algorithm === algorithm ? ctx.hash : ctx.hash.withAlgorithm?.(algorithm)`.
   **This is the known hazard in this repository: writing through a spread context and reading
   through the original produces intermittent `OBJECT_NOT_FOUND`, because the per-`Context`
   pack-registry and config memos are keyed on the object.** Every call after the derivation —
   `bootstrapRepository`, `fetchPack`, `writeFetchedRefs`, `writeCloneConfig`, every progress
   call — takes `cloneCtx`. Nothing after the derivation may take `ctx`. Make that an explicit
   test, not a review hope.
3. **When `withAlgorithm` is absent** (a caller-supplied `HashService`), refuse with the widened
   `UNSUPPORTED_OBJECT_FORMAT { format, local }` from Part 9 — the peer's format is one this
   client cannot work with. Do not silently continue at the wrong width.
4. **Persist the format.** `writeCloneConfig` (called at `clone.ts:179`) already writes
   `extensions.*` and `repositoryformatversion` through `updateConfigEntries(ctx, entries)`
   (`src/application/primitives/update-config.ts:421`, `ConfigEntry { section, subsection?, key,
   value }`) — it does exactly that for partial clone at `:210-214`. Bootstrap having already
   written the format block, `writeCloneConfig` needs no objectFormat entry; assert that the two
   paths do not both write it.

`clone --depth 1` of a sha256 repo writes a 64-hex line into `.git/shallow`;
`src/application/primitives/internal/parse-shallow.ts` is already keyed by `hexLength`, so this
falls out — pin it with an interop row rather than editing that file.

**Docs, in this part:** `docs/use/commands/init.md` `## Options` (`:22`) gains the object-format
option; `docs/use/commands/clone.md` `## Behaviour` (`:37`) gains the adopt-from-source rule and
`## Options` (`:25`) explicitly states there is **no** object-format option (git has none either).
`npm run docs:json` + `reports/api.json` for the new `InitOptions` field.
`check:doc-coverage` is already satisfied (both pages exist with README rows).

**Interop rows to append** to `test/integration/sha256-object-format-interop.test.ts`:

- a tsgit-created SHA-256 repository whose `.git/config` carries `[extensions]` before `[core]`
  with `objectformat = sha256` and `repositoryformatversion = 1`, on which
  `git rev-parse --show-object-format` prints `sha256` and `git log` reads a tsgit-written commit;
- a tsgit-created default repository byte-identical to today's (R6);
- a git-created SHA-256 repository that tsgit writes into and git then reads (`git fsck` exit 0);
- `clone` from a `file://` SHA-256 source producing a SHA-256 destination.

### TDD steps

1. **RED** — `test/unit/application/commands/init.test.ts`: `Given objectFormat 'sha256'` >
   `When init runs` > `Then .git/config is exactly the [extensions]-then-[core] block with
   objectformat = sha256 and repositoryformatversion = 1`. Byte-literal assertion on the whole
   file, TABs included. *Fails:* `InitOptions` has no such field.
2. **RED** — same file: `Given no objectFormat` > … > `Then .git/config is byte-identical to
   today's golden` (R6).
3. **RED** — same file: `Given objectFormat 'sha256' and bare true` > … > `Then bare = true and
   the [extensions] block still precedes [core]`.
4. **RED** — `test/unit/application/commands/clone.test.ts`: `Given a peer advertising
   object-format sha256` > `When clone runs against a sha1-configured context` > `Then the
   destination config declares sha256 and every written oid is 64 hex`. *Fails:* Part 9 made
   `clone` **refuse** a cross-format peer; this is the test that flips that verb to adopting.
   **Replace Part 9's clone-refusal row** rather than leaving two contradictory tests —
   `fetch` and `push` keep theirs, `clone` does not.
5. **RED** — same file: `Given a hash service without withAlgorithm and a sha256 peer` > `When
   clone runs` > `Then it throws UNSUPPORTED_OBJECT_FORMAT with format 'sha256' and local 'sha1'`.
   Assert `.data`, not the class. This is the one clone path that still refuses, so Part 9's code
   stays reachable from `clone` too.
6. **RED** — the derived-context invariant: instrument the context so any read through the
   **original** `ctx` after the derivation fails the test. This is the guard against the known
   spread-context memo hazard; without it the bug is intermittent and only shows under load.
7. **RED** — interop rows above, including `clone --depth 1` writing a 64-hex `.git/shallow` line.
8. **GREEN** — replace `BootstrapOptions.hash` with `objectFormat`; make `renderConfig` emit the
   two-block form when asked; add `InitOptions.objectFormat`; move `bootstrapRepository` after
   `negotiateDiscovery` in `clone.ts`; derive and thread `cloneCtx`.
9. **REFACTOR** — `renderConfig` stays under 20 lines by composing two small emitters
   (`extensionsBlock`, `coreBlock`); `clone`'s adoption is one named helper
   (`adoptPeerAlgorithm(ctx, advertised)`) returning the derived context or throwing.
10. **SURFACE** — `npm run docs:json`, commit `reports/api.json`; update `init.md` and `clone.md`.

### Gate

```
npx vitest run test/unit/application/commands/init.test.ts test/unit/application/commands/clone.test.ts test/integration/sha256-object-format-interop.test.ts \
  && npm run check:types \
  && ./node_modules/.bin/biome check src/application/commands/internal/bootstrap.ts src/application/commands/init.ts src/application/commands/clone.ts docs/use/commands/init.md docs/use/commands/clone.md test/unit/application/commands test/integration/sha256-object-format-interop.test.ts
```

### Commit

`feat: create sha256 repositories on init and adopt the source's format on clone`

## Part 11 — Bundle v3 header: read, write, and the widened refusal reasons

### Context

ADR-683 + ADR-702. C9 (6 sites). **This is where the v3 work and the width sweep meet — they are
one edit at `parse-bundle-header.ts:14`, not two sections to reconcile.** The six bundle sites
were *correct as written* while v3 was refused and became bugs the moment v3 landed.

**Rule 1 — the bundle declares its own width (R15).** No bundle path takes a width from
`ctx.hashConfig`. The measured proof: `git bundle list-heads` succeeds **outside any repository**,
printing 40- or 64-hex oids according to the bundle's own header. `parse-bundle-header.ts` stays
a pure domain function over bytes — `ctx` appears nowhere in it. It calls Part 2's
`isOid(value, config)` with the **bundle's** config, which is only safe because the predicate
takes its config as an argument.

**`src/domain/bundle/types.ts:4`** — `export type BundleHashAlgorithm = 'sha1';` widens to
`'sha1' | 'sha256'` (`BundleVersion = 2 | 3` at `:3` already admits 3). Public ⇒ `api.json`.

**`src/domain/bundle/parse-bundle-header.ts` (138 lines) — current shape:**

```ts
const MAGIC_V2 = '# v2 git bundle';                                   // :12
const MAGIC_V3 = '# v3 git bundle';                                   // :13
const HEX_PATTERN = /^[0-9a-f]{40}$/;                                 // :14
const isHex40 = (s: string): boolean => HEX_PATTERN.test(s);          // :16
  if (line === MAGIC_V3) { throw bundleUnsupportedVersion(path, 3); } // :32-34
  return { version: 2, hashAlgorithm: 'sha1' };                       // :38
  if (!isHex40(oidStr)) { throw bundleBadHeader(path, 'malformed-header'); }  // :46 (prerequisite)
  if (!isHex40(oidStr)) { throw bundleBadHeader(path, 'malformed-header'); }  // :59 (ref)
    } else if (line.startsWith('@')) { throw bundleBadHeader(path, 'malformed-header'); }  // :91-92
  if (firstLine === MAGIC_V3) { throw bundleUnsupportedVersion(path, 3); }   // :106-107
```

**Rule 2 — the header parse gains a capability phase.** The loop over `contentLines` (`:87-96`)
becomes three ordered phases: capabilities while the line starts with `@` **and** the version is
3; then prerequisites (`-`); then refs. `parseMagicLine` returns `{ version: 2, hashAlgorithm:
'sha1' }` for v2 exactly as now, and for v3 returns the version with the algorithm
**undetermined**, which the capability block then fixes before any oid line is read. Implement
the reader in git's order — do **not** pre-scan for the capability. The
`error: unrecognized header: <first ref line>` behaviour then falls out.

The existing `@`-line throw at `:91-92` **stays, but only for v2**, where an `@` line really is a
malformed header (measured: `error: unrecognized header: @object-format=sha256 (21)`).

**Measured grammar (git 2.55.0) — each row is a test fixture:**

```
# v3 git bundle LF
( @<name>[=<value>] LF )*        capability block
( -<oid> SP <comment> LF )*      prerequisites
( <oid> SP <ref-name> LF )*      refs
LF                               terminator
PACK…
```

- Signature bytes, `xxd`-verified: `# v2 git bundle\n` · `# v3 git bundle\n@object-format=sha256\n`
  · `# v3 git bundle\n@object-format=sha1\n`.
- Capabilities come first, before any oid-bearing line.
- Capability order **among themselves is free** — `@filter` ahead of `@object-format` still parses.
- But `@object-format` must precede the **first oid line**.
- A duplicate `@object-format` is **last-wins**: `sha1` then `sha256` parses a 64-hex body fine;
  `sha256` then `sha1` fails on the first 64-hex ref line. **Both orders must be tested** — the
  second is what proves last-wins rather than first-wins.
- **Exactly two capabilities exist**: `object-format` and `filter`. When both are emitted the
  order is `@object-format` then `@filter`.

**Header refusals, pinned line-for-line** (same message and exit from both `verify` and
`list-heads`):

| crafted header | git |
|---|---|
| `@bogus=1` | `error: unknown capability 'bogus=1'`, exit 1 — carries the whole `name=value` text |
| `@object-format` with no `=` | `error: unknown capability 'object-format'`, exit 1 — a valueless capability is a *different key*, not a missing value |
| `@` alone | `error: unknown capability ''`, exit 1 |
| `@object-format=sha512` | `error: unrecognized bundle hash algorithm: sha512`, exit 1 |
| `@filter=bogus` | `fatal: invalid filter-spec 'bogus'`, exit **128** — the only fatal in the table |
| v3 with **no** capability block | `error: unrecognized header: <first ref line> (80)`, exit 1 — the parenthesised number is the line's byte length |
| v3 with `@object-format` **after** the first ref line | the same `unrecognized header` on that ref line |
| v2 magic **plus** a capability line | `error: unrecognized header: @object-format=sha256 (21)`, exit 1 |
| **v2 magic with 64-hex oids** | `error: unrecognized header: <ref line> (80)`, exit 1 |
| a non-bundle file | `error: '<path>' does not look like a v2 or v3 bundle file`, exit 1 |

**`BUNDLE_BAD_HEADER`'s `reason` widens from two values to four.** Note the actual current type is
`{ code: 'BUNDLE_BAD_HEADER'; path: string; reason: string }`
(`src/domain/commands/error.ts:243`) — `string`, not a union; only the factory's comment at `:769`
claims two values. Introduce and export
`type BundleBadHeaderReason = 'not-a-bundle' | 'malformed-header' | 'unknown-capability' | 'unknown-hash-algorithm'`
and type the field with it. Each reason carries the fields its git line needs (ADR-249 — fields
only, no rendered string): the offending line and its byte length for `malformed-header`, the
capability text for `unknown-capability`, the algorithm value for `unknown-hash-algorithm`.
**The renderer must widen too**: `src/domain/error.ts:531` returns one line
(`'<path>' does not look like a v2 or v3 bundle file`) for **every** reason today, where git has
three distinct lines. Branch on `reason` — that is what the discriminator is for.
Narrowing `string` to a union is an `api.json` change.

**`BUNDLE_UNSUPPORTED_VERSION` does not disappear** — `--version=1` and `--version=4` are refused
as `fatal: unsupported bundle version <n>`, so the code keeps its meaning and merely stops firing
on 3. Its `docs/use/errors.md` row, which today says v3 is unsupported, is **falsified** by this
change and is corrected here.

**Rule 3 — `serializeBundleHeader` becomes a two-branch emitter.**
`src/domain/bundle/serialize-bundle-header.ts:23-42`: `if (input.version !== 2) throw
bundleUnsupportedSerializeVersion(input.version)` (`:28`) goes; v2 emits `MAGIC_V2` (`:4`) and
nothing else; v3 emits the magic then `@object-format=<algorithm>\n` — **always**, including
`sha1`. Prerequisite sorting (`:30`, `sortByOidAscending`), ref order and the blank terminator
(`:39`) are unchanged, so the v2 goldens stay byte-identical (R6).

**`@filter` (ADR-702).** Parse it, **validate it eagerly** against the existing vocabulary —
`parseObjectFilter(spec)` in `src/domain/protocol/object-filter.ts:69`, which supports
`blob:none`, `blob:limit=<n>[kmg]`, `tree:<depth>` and throws
`INVALID_FILTER_SPEC { spec, reason }` — and **expose the parsed filter** on
`ParsedBundleHeader`. Parse-and-ignore is forbidden: a caller would receive a bundle marked
complete when its objects are deliberately absent. Note the layering: `domain/bundle` importing
`domain/protocol/object-filter` is a domain-to-domain edge — confirm `check:architecture`
(`.dependency-cruiser.cjs`) permits it before writing the import; if it does not, move the filter
vocabulary to a shared `domain/` location rather than duplicating it.

**The Stryker suppression at `parse-bundle-header.ts:90-92` must be re-proven, not carried.** Its
text asserts that an `@`-prefixed line "never holds a 40-hex oid before a space, so the false
branch also throws" — a claim about a structure that no longer exists once the `@` branch is
version-conditional and the width is no longer 40. Equivalence proofs are structure-specific:
delete the comment with the structure and either write a fresh proof against the new one or
replace it with a kill test. The `findBlankLineOffset` suppression at `:19` **stands** — that scan
does not change.

**Tests.** `test/unit/domain/bundle/parse-bundle-header.test.ts` (218 lines,
`describe('parseBundleHeader')` at `:13`, nested at `:14, 32, 52, 73, 175, 189, 204`) —
**every v2 row stays untouched** (R6) and the grammar table above is added as literal fixtures.
Each refusal row asserts `.data.reason` (and the reason's own fields) via try/catch — a
four-valued discriminator is exactly the StringLiteral mutant a `toThrow(Class)` check leaves
alive. `test/unit/domain/bundle/serialize-bundle-header.test.ts` (137 lines; note `:118`
`'Given version 3 (unsupported)'` — that describe is now wrong and must be replaced, not deleted
wholesale) gains v2 byte-identical, v3+sha256 and v3+sha1 byte-golden rows.

**Property test (lens 1 — round-trip pair).**
`test/unit/domain/bundle/bundle-header.properties.test.ts` (68 lines,
`describe('Given an arbitrary well-formed v2 bundle header')` at `:19`, round-trip at `:20`)
**already exists** with generators in `test/unit/domain/bundle/arbitraries.ts` — this is an
extension, not a new file. `arbObjectId()` there is hard-coded to 40 hex
(`{ minLength: 40, maxLength: 40 }`); parameterise it by width. The arbitrary widens to
`(version, algorithm)` pairs drawn from the **legal** set (v2 ⟹ sha1 only; v3 ⟹ either) and the
property is `parse(serialize(h)) ≡ h` modulo the documented prerequisite sort. `numRuns: 200`
(round-trip tier). **This is the lens that catches a v3 emitter which forgets `@object-format` on
the sha1 branch** — a bug every example test would have to be written to suspect. Generate hex
from character ranges, never a literal alphabet (`CKV_SECRET_6`). Never commit a seed.

### TDD steps

1. **RED** — `parse-bundle-header.test.ts`: `Given a v3 header declaring object-format sha256` >
   `When parseBundleHeader reads it` > `Then version is 3, hashAlgorithm is 'sha256' and the
   64-hex refs parse`. *Fails:* `:32-34` throws `BUNDLE_UNSUPPORTED_VERSION`.
2. **RED** — same file: v3 + `@object-format=sha1` parses with 40-hex refs.
3. **RED** — same file: capabilities in **swapped** order (`@filter` before `@object-format`)
   parse, exit-0 equivalent.
4. **RED** — same file, **two separate tests**: duplicate `@object-format` `sha1` then `sha256`
   parses a 64-hex body; `sha256` then `sha1` **fails on the first ref line**. The second is what
   proves last-wins.
5. **RED** — same file, one test per refusal row above, each asserting `.data.reason` and the
   reason's own fields via try/catch. Isolated tests — no row may share a test with another.
6. **RED** — same file: every existing v2 row still passes unchanged (R6), including an `@` line
   in a v2 bundle still being `malformed-header`.
7. **RED** — same file: `@filter=blob:none` parses and is exposed on the result;
   `@filter=bogus` throws `INVALID_FILTER_SPEC` with `spec: 'bogus'`.
8. **RED** — `serialize-bundle-header.test.ts`: v3+sha256 and v3+sha1 byte-identical to the
   `xxd` prefixes above; v2 byte-identical to today's golden.
9. **RED** — `bundle-header.properties.test.ts`: the widened `(version, algorithm)` round-trip
   at `numRuns: 200`.
10. **GREEN** — widen `BundleHashAlgorithm`; add the capability phase and the version-conditional
    `@` branch; replace `isHex40` with `isOid(s, configFor(hashAlgorithm))`; add the four-member
    `reason` union with its per-reason fields; branch the renderer; make the serializer
    two-branch; parse and validate `@filter`.
11. **REFACTOR** — the three parse phases become three named functions, each under 20 lines;
    the capability applier is a small total function over `(name, value)`. Delete the `:90-92`
    Stryker comment and write a fresh proof or a kill test for the new structure.
12. **SURFACE** — correct the `BUNDLE_UNSUPPORTED_VERSION` row and add the widened
    `BUNDLE_BAD_HEADER` `reason` values to `docs/use/errors.md`; `npm run docs:json`, commit
    `reports/api.json`.

### Gate

```
npx vitest run test/unit/domain/bundle test/unit/domain/error.test.ts \
  && npm run check:types \
  && ./node_modules/.bin/biome check src/domain/bundle src/domain/commands/error.ts src/domain/error.ts docs/use/errors.md test/unit/domain/bundle
```

### Commit

`feat: read and write v3 bundle headers with the object-format and filter capabilities`

## Part 12 — Bundle commands: version selection, filter exposure, cross-format prerequisites

### Context

ADR-701 + ADR-702 + ADR-703. The command layer over Part 11's domain.

**Rule 3's other half — the writer selects the version rather than being told it.**
`src/application/commands/bundle-create.ts:237` pins `const VERSION: BundleVersion = 2;`, used at
`:264` (`serializeBundleHeader({ version: VERSION, … })`) and `:267`
(`BundleCreateResult.version`). Replace it with the **measured three-trigger rule**:

> **v3 iff the repository's algorithm is not sha1, OR a filter is present, OR v3 was asked for.**
> v2 is *refused*, never silently upgraded, when v3 is required.

| invocation | repo | git writes |
|---|---|---|
| `git bundle create <f> --all` | sha1 | **v2**, no capability block |
| `git bundle create <f> --all` | sha256 | **v3** + `@object-format=sha256` |
| `--filter=blob:none` | sha1 | **v3** + `@object-format=sha1` + `@filter=blob:none` |
| `--filter=blob:none` | sha256 | **v3** + both capabilities, in that order |
| `--version=3 <f> --all` | sha1 | **v3** + `@object-format=sha1` |
| `--version=2 <f> --all` | sha256 | `fatal: cannot write bundle version 2 with algorithm sha256`, exit **128**, no file written |
| `--version=2 --filter=…` | sha1 | `fatal: cannot write bundle version 2 with algorithm sha1`, exit **128**, no file written |
| `--version=1` / `--version=4` | either | `fatal: unsupported bundle version <n>`, exit **128** |

**Write the full rule with the absent inputs defaulted, not an algorithm test.** tsgit has no
`--filter` on `bundleCreate` today, so the rule degenerates to "v3 iff sha256" *for the surface as
it stands* — but coding it as an algorithm test turns a correct implementation into a wrong one
the moment a filter option lands. Note also that the v2-plus-filter refusal reuses the
**algorithm** wording (`…with algorithm sha1`) even though the filter is what forces v3, so the
interop reconstruction must not assume the message names the real cause.

**ADR-701 — `BundleCreateOptions` gains `version?: 2 | 3`.** Current shape
(`bundle-create.ts:27-32`): `{ revs?, all?, branches?, tags? }`. Omitted, the version derives from
the rule above; supplied, it is honoured, and the v2-where-v3-is-required combination refuses.
This is a **format** selector — it changes the bytes on disk, exactly as `objectFormat` does — so
ADR-249 does not exclude it. `bundleUnsupportedSerializeVersion(version)`
(`src/domain/commands/error.ts:784`) already fits the refusal; note it emits the **same**
`BUNDLE_UNSUPPORTED_VERSION` code as the read-side refusal and is told apart only by `path` being
absent (`src/domain/error.ts:533-536`) — a sentinel-shaped distinction. Do not change that shape
here; do assert both arms in tests so the distinction stays alive.
`BundleCreateResult.version` (`:34`) already reports the chosen version, so callers see what they
got with no new field. Public option ⇒ `api.json`.

**Probe trap for whoever writes the interop rows:** git's `--version` must precede the file
argument (`git bundle create --version=3 <file> --all`); placed after it, rev-list consumes it and
git says `error: unrecognized argument: --version=3`. That is a probe artefact, not a git quirk.

**ADR-703 — the cross-format prerequisite refusal.** `src/application/commands/bundle-verify.ts`
maps `OBJECT_NOT_FOUND` into `missingPrerequisites`:

```ts
const missingPrerequisites = await findMissingPrerequisites(ctx, header.prerequisites);  // :39
const isMissingObject = async (ctx, oid) => { try { await readObject(ctx, oid); return false; }
  catch (err) { if (err instanceof TsgitError && err.data.code === 'OBJECT_NOT_FOUND') return true; throw err; } };  // :96-104
```

git draws **two** conditions tsgit currently cannot tell apart:

| condition | git |
|---|---|
| a prerequisite commit is merely **absent** | `error: Repository lacks these prerequisite commits:` + one line per oid, exit **1** |
| a prerequisite oid is in the **wrong algorithm** | `fatal: missing mapping of <oid> to <local-algo>`, exit **128** |

Add a typed refusal `{ oid, bundleAlgorithm, localAlgorithm }` raised **before** the lookup, when
`header.hashAlgorithm` differs from `ctx.hashConfig.algorithm`. **The check must precede the
lookup** — after it, the information that distinguishes the two conditions is gone.
**Narrow the existing `missingPrerequisites` mapping, do not replace it**: the absent-prerequisite
path keeps its exit-1 shape. Do **not** reuse ADR-695's `UNSUPPORTED_OBJECT_FORMAT` — that code is
scoped to transport, and reusing it here would make a code's meaning depend on its call site.
New code ⇒ union member, renderer case, `docs/use/errors.md` row, `api.json`.

**The guard fires only when prerequisites exist.** Measured: a cross-format **complete** bundle
(no prerequisites) verifies `is okay`, exit 0, in **both** directions. So the guard sits on the
prerequisite loop, never on the header read — otherwise `bundleListHeads` (which git runs outside
a repository entirely) would break.

**R15 — no bundle path takes its width from the surrounding repository.** In
`bundle-verify.ts`, `verifyPackTrailer(packBytes, ctx)` (`:43`) and
`walkPackEntries(ctx, packBytes, resolver)` (`:46`) currently frame against `ctx.hashConfig`.
They move to the **bundle's** declared algorithm. Only the prerequisite *lookup* stays a
repository operation. `resolveExternalBase` (`:63-73`) calls
`serializeObject(obj, ctx.hashConfig)` — that one is a repository read and correctly stays.
`bundleListHeads` (`src/application/commands/bundle-list-heads.ts`) already threads
`header.version` at `:22`; `bundleVerify` already threads `header.hashAlgorithm` at `:55`. Those
fields simply stop being single-valued — that is the whole public-surface change on the read side.
Expose the parsed `@filter` on `BundleVerifyResult` (`:24-32`) alongside them.

**Out of scope, do not add:** tsgit has **no** `unbundle` and no clone- or fetch-from-bundle path
(`clone.ts` and `fetch.ts` never mention bundles). Adding one is a new command.
Also out of scope: `bundleVerify`'s pack walk itself. git's `verify` never opens the pack —
flipping a byte inside the packfile still verifies `is okay`, exit 0 — where tsgit runs
`verifyPackTrailer` and `walkPackEntries`. That is a **pre-existing** divergence, unrelated to the
algorithm; R15 keeps the two tools agreeing on every well-formed bundle.

**Interop rows to append** to `test/integration/bundle-interop.test.ts` — **beside its existing
v2 rows, not duplicated into a new file.** Its shared `beforeAll` is at `:151-267` with timeout
`60_000`; the natural extension point for the algorithm pin is the existing
`hashAlgorithm`-field describe at `:973`. A second SHA-256 fixture repo joins the existing pair in
that same `beforeAll` (do not add a second `beforeAll`). Rows:

- a **tsgit-written v3 bundle** from a SHA-256 repository passes `git bundle verify` and
  `git bundle list-heads` (exit 0), and `git clone`ing it yields a repository whose
  `rev-parse --show-object-format` is `sha256` — the row that proves the header is not merely
  parseable but *adoptable*;
- a **git-written v3 bundle** from a SHA-256 repository read by tsgit with the same 64-hex oids,
  same ref set, same version and same `hashAlgorithm`;
- the **SHA-1 v2 control**: a tsgit-written v2 bundle from a SHA-1 repository byte-identical to
  today's golden and still verifying (R6), and git's own v2 bundle still read — the regression
  half, and the one that fails first if the writer's version selection is keyed wrongly;
- `bundleListHeads` on a **cross-format** bundle succeeds in both directions (R15);
- `git bundle create --filter=blob:none` on a **SHA-1** repository writes v3, and tsgit reads it
  with the filter exposed — the row that catches an implementation keyed on the algorithm alone
  rather than on the three-trigger rule;
- `bundleCreate({ version: 2 })` on a SHA-256 repository refuses, twinned against git's
  exit-128 row.

**Docs:** `docs/use/commands/bundle.md` (245 lines; `## Actions` `:83` with `### create` `:85`,
`### verify` `:107`, `### listHeads` `:122`; `## Behaviour` `:133`; `## Throws` `:202` with
`### create` `:204` and `### verify and listHeads` `:216`). Add the `version` option under
`### create`, the version-selection rule under `## Behaviour`, the widened `hashAlgorithm` /
`version` result fields, the exposed filter, and the new refusals under `## Throws`.

### TDD steps

1. **RED** — `test/unit/application/commands/bundle-create.test.ts`: `Given a SHA-256 repository`
   > `When bundleCreate runs with no version option` > `Then the result version is 3 and the
   header carries @object-format=sha256`. *Fails:* `VERSION` is pinned to 2.
2. **RED** — same file: `Given a SHA-1 repository and no options` > … > `Then the version is 2 and
   the bytes are byte-identical to today's golden` (R6).
3. **RED** — same file: `Given a SHA-1 repository and version 3` > … > `Then it writes v3 with
   @object-format=sha1`.
4. **RED** — same file: `Given a SHA-256 repository and version 2` > … > `Then it throws
   BUNDLE_UNSUPPORTED_VERSION with version 2 and no path` (the serialize arm). A **separate**
   test keeps the read arm's `path`-bearing shape alive.
5. **RED** — same file: version 1 and version 4 each refuse, as separate tests.
6. **RED** — `test/unit/application/commands/bundle-verify.test.ts`: `Given a SHA-256 bundle with
   prerequisites verified against a SHA-1 repository` > `When bundleVerify runs` > `Then it throws
   the cross-format refusal with oid, bundleAlgorithm 'sha256' and localAlgorithm 'sha1'`.
   Assert `.data`, not the class.
7. **RED** — same file, the narrowing guard: `Given a same-format bundle whose prerequisites are
   absent` > … > `Then they are still reported in missingPrerequisites` (the exit-1 shape must
   survive). And: `Given a cross-format bundle with NO prerequisites` > … > `Then it verifies
   successfully` — the guard must not fire on the header read.
8. **RED** — same file: `verifyPackTrailer` and `walkPackEntries` frame against the **bundle's**
   algorithm — a SHA-256 bundle verified from inside a SHA-1 repository whose prerequisites are
   empty must walk the pack at 32-byte oids.
9. **RED** — `bundle-list-heads.test.ts`: a v3 SHA-256 bundle lists its refs with 64-hex oids
   regardless of the repository's algorithm.
10. **RED** — the interop rows above in `test/integration/bundle-interop.test.ts`.
11. **GREEN** — replace `VERSION` with the three-trigger selector; add `version?: 2 | 3` to
    `BundleCreateOptions`; add the cross-format guard ahead of `findMissingPrerequisites`; move
    the pack framing onto the bundle's algorithm; expose the filter on `BundleVerifyResult`.
12. **REFACTOR** — `selectBundleVersion({ algorithm, filter, requested })` is one pure function
    with the full rule and its refusal, unit-tested directly; the command calls it once.
13. **SURFACE** — update `docs/use/commands/bundle.md`; add the new error row to
    `docs/use/errors.md`; `npm run docs:json`, commit `reports/api.json`.

### Gate

```
npx vitest run test/unit/application/commands/bundle-create.test.ts test/unit/application/commands/bundle-verify.test.ts test/unit/application/commands/bundle-list-heads.test.ts test/integration/bundle-interop.test.ts \
  && npm run check:types \
  && ./node_modules/.bin/biome check src/application/commands/bundle-create.ts src/application/commands/bundle-verify.ts src/application/commands/bundle-list-heads.ts src/application/commands/internal/read-bundle.ts src/domain/commands/error.ts src/domain/error.ts docs/use/commands/bundle.md docs/use/errors.md test/unit/application/commands test/integration/bundle-interop.test.ts
```

### Commit

`feat: select the bundle version from git's measured rule and refuse cross-format prerequisites`

## Part 13 — Cross-adapter parity, the remaining interop battery, and the point-of-use refuse set

### Context

The closing part. Three jobs, all small, one of which is the deletion this whole plan was
sequenced around.

**Job 1 — the parity harness gains an open-options slot.** `test/parity/scenarios/types.ts`
(26 lines) has no slot for open options:

```ts
export interface Scenario<TResult> {
  readonly name: string;
  readonly inputs: ScenarioInputs;
  readonly expected: TResult;
  readonly run: (repo: Repository, inputs: ScenarioInputs) => Promise<TResult>;
  readonly unsupportedRuntimes?: readonly string[];
}
```

Add a **narrowly typed** slot and spread it in every driver:

```ts
  /** Extra `openRepository` options every driver spreads into its own open call. */
  readonly openOptions?: { readonly algorithm?: 'sha1' | 'sha256' };
```

**Do not type it `Record<string, unknown>`.** Spreading an index-signature object into a typed
options literal fails under this repo's `strict` + `exactOptionalPropertyTypes` settings, and
widening it to `unknown` would push the problem into a cast — which `no any`/`types > runtime
checks` forbids. Keep the field a closed record of exactly the options a scenario may set, and
widen it by adding a named field when a future scenario needs one. Importing a runtime-specific
options type into `types.ts` is also wrong — `types.ts` is shared by all six drivers.

There are **six** drivers, not three:

| driver | file | current open call |
|---|---|---|
| Node | `test/parity/node.test.ts:42` | `openRepository({ cwd: tmpDir })` |
| Memory | `test/parity/memory.test.ts:30` | `openRepository({ files: stageFiles(scenario.inputs) })` |
| Bun × Node | `test/runtime-parity/bun/parity-node.test.ts` | from `dist/esm/index.node.js` |
| Bun × Memory | `test/runtime-parity/bun/parity-memory.test.ts` | from `dist/esm/index.default.js` |
| Deno × Node/Memory | `test/runtime-parity/deno/parity-{node,memory}.test.ts` | from `dist/esm/` |
| Workers × Memory | `test/runtime-parity/workers/parity-memory.test.ts` | splits `supported`/`skipped` |
| Browser | `test/browser/parity.spec.ts` | scenarios invoked **by name** inside `page.evaluate` via `window.__tsgitParity`, published by `test/browser/parity-scenarios.bundle.ts` and bundled by `tooling/build-parity-bundle.ts` — never by passing function references |

Then add `test/parity/scenarios/sha256-object-format.scenario.ts` (registered in
`test/parity/scenarios/index.ts`) proving the **same** 64-hex oids on memory, node and browser
with `openOptions: { algorithm: 'sha256' }`. `test/parity/*` proves cross-adapter agreement only;
it does **not** prove faithfulness — that is the interop suite's job. The runtime-parity drivers
read from `dist/esm/`, so `build:parity` must re-run (its wireit input globs already cover
`test/parity/scenarios/**/*.ts`).

Also check `tooling/audit-browser-surface.ts` (`check:browser-surface`) and
`tooling/audit-parity-fixtures.ts` (`check:parity-fixtures`) still pass; the new scenario exercises
existing commands, so no allowlist entry should be needed.

**Job 2 — the remaining interop rows** in `test/integration/sha256-object-format-interop.test.ts`,
the ones no earlier part owned:

- **Per-format read symmetry** (R4/R9, git writes → tsgit reads), the formats no earlier part
  touched because they are **already dual and must not be edited**: `.rev`, `multi-pack-index`,
  `commit-graph`, `.bitmap`, `packed-refs`, `shallow`, and the loose-object path. A diff touching
  `src/domain/storage/rev-index.ts`, `midx.ts`, `bitmap.ts`, `pack-entry.ts`,
  `src/application/primitives/internal/parse-shallow.ts` or
  `src/domain/storage/loose-path.ts` in this part is a bug in the change, not in the golden.
  Pin: `.rev` hash id `2` and midx/commit-graph hash-version byte `02` read correctly from
  git-written SHA-256 files.
- **SHA-1 invariance** (R6) — the same battery on a sha1 repository, asserting the `.rev` hash id
  is still `1`, the `.idx` trailer is still 40 bytes, the index entry header is still 62 bytes,
  and every oid is still 40 hex.
- **Cross-format meeting points** (R13): a linked worktree of a SHA-256 repository reports sha256
  and writes a 32-byte-oid index (the format is inherited from `<commonDir>/config`; the linked
  worktree's admin dir holds no config, so no worktree-specific branch is needed); a
  foreign-format alternate yields `OBJECT_NOT_FOUND` — **not** `INVALID_PACK_INDEX` — in both
  directions (git *skips* the store with diagnostics and reports the object absent; that is the
  one place in this change where "unsupported" correctly surfaces as "absent"); `submodule add`
  across formats refuses in both directions, leaving the same partial `.git/modules/<name>` state
  git leaves (the clone has already happened when the refusal fires — reproduce the partial state,
  do not tidy it).
- **`compatObjectFormat`** — git itself refuses it on this build
  (`fatal: compatibility hash algorithm support requires Rust`, exit 128), so there is no
  behaviour to replicate. Assert that tsgit refuses at the point of use with the
  `REPOSITORY_EXTENSION_UNSUPPORTED { extension, value }` code the **acceptance-gate change
  already shipped** — this part raises it, it does not specify it.

**Job 3 — the deletion this plan was sequenced for.** The acceptance-gate change ships a
point-of-use refuse set containing `objectFormat`, `refStorage` and `compatObjectFormat`, refused
with `REPOSITORY_EXTENSION_UNSUPPORTED`. `objectFormat` is now **implemented**, so it leaves that
set. Find it with
`grep -rn "REPOSITORY_EXTENSION_UNSUPPORTED\|objectFormat" src/ --include='*.ts'` — as of this
branch neither the code nor the set exists yet, so it lands between this plan being written and
this part running. **It is a one-entry deletion plus a test**, not a refactor: remove
`objectFormat` from the set and flip the corresponding unit-test row from "refuses" to "opens and
reads". `refStorage` and `compatObjectFormat` stay. Do not restructure the mechanism.

**If the set does not exist when this part runs**, that is a blocker, not an improvisation:
report `{ unit: Part 13 job 3, reason: the acceptance-gate refuse set is absent, options: [wait
for the sibling change, land the rest of Part 13 and split job 3 into a follow-up commit, ask the
session] }`.

**Remaining docs, in this part:** `docs/understand/repository-layout.md` (99 lines; `##` at `:9`
The three routes, `:29` Work-tree precedence, `:64` Reading the result, `:74` Refusals, `:90`
Deliberate divergences — currently **zero** mentions of any hash algorithm) gains the format field
under "Reading the result"; `docs/understand/security.md` (`## Object integrity` at `:88-90`, which
says every `readObject` is hashed and compared but never names SHA-1) gains the downgrade note:
a config value now selects the verification function, git has exactly this property (the config
*is* the authority on the format in git too), and the state fails **closed** — a declared-sha1
repository holding 64-hex ids cannot resolve them. State explicitly that tsgit never infers the
algorithm from the **data** (id width, `.rev` hash id, midx hash-version byte); only from the
**declaration**. Inferring from data would let planted data choose its own verifier.

`cspell.json` already carries `objectformat` and `precomposeunicode` (added alongside the design);
verify with `npm run check:spelling` and add any word this part's prose introduces.

### TDD steps

1. **RED** — `test/parity/scenarios/sha256-object-format.scenario.ts` (new) registered in
   `index.ts`, with `openOptions: { algorithm: 'sha256' }` and an `expected` golden of 64-hex
   oids. *Fails:* `Scenario` has no `openOptions`, and the drivers ignore it.
2. **GREEN** — add `openOptions` to `Scenario`, spread it in all six drivers plus the browser
   bundle registry; run `test:parity` on node and memory.
3. **RED** — interop: git-written `.rev`, `multi-pack-index`, `commit-graph`, `.bitmap`,
   `packed-refs` and `shallow` from a SHA-256 repository all read correctly through tsgit, with
   the `.rev` hash id asserted as `2` and the midx/commit-graph hash-version byte as `02`.
   These should pass immediately — they are the regression proof that the already-dual formats
   were not "generalised" by mistake.
4. **RED** — interop SHA-1 invariance battery (R6): `.rev` hash id `1`, `.idx` trailer 40 bytes,
   index entry header 62 bytes, every oid 40 hex.
5. **RED** — interop R13 rows: linked worktree, foreign-format alternate
   (`OBJECT_NOT_FOUND`, not `INVALID_PACK_INDEX`, in both directions), cross-format
   `submodule add` refusing in both directions with the partial `.git/modules/<name>` left behind.
6. **RED** — interop `compatObjectFormat`: both tools refuse; tsgit's is
   `REPOSITORY_EXTENSION_UNSUPPORTED` with `extension: 'compatObjectFormat'`.
7. **RED** — the unit-test row for the point-of-use refuse set, flipped: `Given a repository
   declaring extensions.objectFormat = sha256` > `When an operation runs` > `Then it succeeds`
   (it refuses today).
8. **GREEN** — remove `objectFormat` from the refuse set. One entry.
9. **REFACTOR** — none expected. Confirm `grep -rn "objectFormat" src/` shows the config reader
   and the option plumbing only, never a refusal.
10. **SURFACE** — update `docs/understand/repository-layout.md` and `docs/understand/security.md`;
    run `npm run check:spelling`.

### Gate

```
npx vitest run test/parity test/integration/sha256-object-format-interop.test.ts test/unit/repository \
  && npm run check:types \
  && ./node_modules/.bin/biome check test/parity src/repository docs/understand/repository-layout.md docs/understand/security.md test/integration/sha256-object-format-interop.test.ts
```

### Commit

`feat: prove sha256 parity across adapters and drop objectFormat from the unsupported set`
