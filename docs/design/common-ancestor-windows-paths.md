# Design — commonAncestor: Windows-correct path algebra for linked-worktree FS rooting

> Brief: Fix `commonAncestor` so linked-worktree `worktreeFs` rooting works on Windows — drive-letter aware, backslash aware — while POSIX behaviour stays byte-identical; re-enable the `index.node` raw-adapter probe on every platform.
> Status: draft → self-reviewed ×3 → accepted

## Context

### What the function does and where it sits

`src/repository/common-ancestor.ts` (whole file, 24 lines) computes the deepest
directory containing a set of absolute paths:

```ts
const segmentsOf = (absolutePath: string): ReadonlyArray<string> =>
  absolutePath.split('/').filter((segment) => segment !== '');

export const commonAncestor = (paths: ReadonlyArray<string>): string => {
  const [first = [], ...rest] = paths.map(segmentsOf);
  const shared: string[] = [];
  for (const segment of first) {
    if (!rest.every((list) => list[shared.length] === segment)) break;
    shared.push(segment);
  }
  return `/${shared.join('/')}`;
};
```

It hardcodes the POSIX separator on **both** the split (`split('/')`) and the
rejoin (`` `/${…}` ``). It has no notion of a drive-letter / UNC root.

**Sole production consumer** — `src/index.node.ts` `makeWorktreeFs` (L83–88):

```ts
makeWorktreeFs: (worktreePaths: ReadonlyArray<string>): NodeFileSystem =>
  new NodeFileSystem(commonAncestor([layout.workDir, ...worktreePaths])),
```

`layout.workDir` is `realpath()`-resolved (L51) — native separators in
production. The returned root roots a fresh **raw** `NodeFileSystem`. Per
[ADR-298](../adr/298-worktree-fs-containment-escape.md), the facade then wraps
that raw fs with a **multi-root** validator confined to `[…worktreePaths,
commonDir]`. So `commonAncestor` only has to be **wide enough** to contain every
input: "too wide" is not a security hole (the multi-root validator is the real
gate); "wrong root / too narrow" spuriously denies real paths.

### The bug (surfaced by the whole-codebase mutation sweep)

On Windows, `C:\Users\me\repo` and `C:\Users\me\repo\wt` share **no** `/`
segment. `segmentsOf` splits them into one segment each
(`['C:\Users\me\repo']`), the shared-prefix loop finds them unequal, and the
function returns `` `/${''}` `` = `'/'`. The raw `NodeFileSystem` is then rooted
at `'/'`. Its own containment gate
(`src/adapters/node/node-file-system.ts` `checkContainment` →
`containmentVerdict` → `containedByPrefix`) normalises the root to `'/'` with a
`'/' + sep` prefix and rejects every real `C:\…` child with `PERMISSION_DENIED`.
Linked-worktree filesystem access is broken on Windows.

`test/unit/index.node.test.ts` L274–317 (`describe('Node shim — worktreeFs raw
adapter root')`) had to be `it.skipIf(process.platform === 'win32')(…)` to land
the sweep. That probe targets the L87 `ArrayDeclaration` mutant (`[layout.workDir,
…worktreePaths]` → `[]`); the skip exists **only** because a `/`-shaped root can
never match a real `C:\…` probe.

### The constraints that shape the fix

- **The path-policy abstraction** — `src/adapters/node/path-policy.ts` is the
  codebase's designed way to run platform-specific path logic on any host. The
  `PathPolicy` interface exposes `sep: '\\'|'/'`, `caseInsensitive`,
  `resolve`, `join`, `dirname`, `basename`, `isAbsolute`,
  `rootOf(p) = path.parse(p).root` (`'/'` POSIX, `'C:\\'` Windows,
  `'\\\\server\\share\\'` UNC), and `normalizeForCompare(p)` (lowercases + strips
  `\\?\` extended prefix on case-insensitive platforms; **identity** on POSIX).
  Exported singletons: `posixPolicy` (caseInsensitive:false), `windowsPolicy`
  (caseInsensitive:true), `nativePolicy = selectNativePolicy(process.platform)`.
  Tests inject `windowsPolicy`/`posixPolicy` to simulate either platform on the
  Linux/macOS CI host.

- **Architecture precedent** — `src/repository/find-layout.ts` already takes
  `pathPolicy: PathPolicy` as a parameter and imports it as `import type
  { PathPolicy } from '../adapters/node/path-policy.js'`. `src/repository/`
  currently imports from `adapters/` **only** as `import type` (no runtime value
  edge yet). `.dependency-cruiser.cjs` forbids `domain/`, `primitives/`,
  `ports/`, `operators/`, `transport/` from reaching adapters — but has **no**
  `repository/ → adapters/` rule, so either a type-only or a runtime import from
  `common-ancestor.ts` passes `check:architecture`.

- **Containment compares separator-sensitively** — `normalizeForCompare`
  lowercases but does **not** normalise separators
  (`src/adapters/node/path-policy.ts` L116–117). `getRootDirPrefix`
  (node-file-system.ts L411–419) normalises `rootDir` **without** resolving it,
  then `containmentVerdict` (L919–931) tests the child (which *was* run through
  `policy.resolve`, L939) with `startsWith(normalizedRoot + policy.sep)`. So the
  root `commonAncestor` returns **must** be in the policy's native-separator
  canonical form — a root carrying a foreign `/` (or mixed separators) would fail
  the prefix test against a native-separator child and spuriously deny.

## Requirements

When this ships, all of the following must hold:

1. `commonAncestor([...])` under `posixPolicy` returns byte-identical results to
   today for every existing case (the 5 example tests in
   `test/unit/repository/common-ancestor.test.ts` pass **unchanged**).
2. `commonAncestor([...], windowsPolicy)` over Windows drive-letter / backslash
   inputs returns the true common ancestor in **native (`\`) separator form**,
   rooted at the correct `C:\…` (or `\\server\share\…`) prefix.
3. For inputs that share a real directory (same volume **and** ≥1 shared segment —
   the production worktree case), the root `commonAncestor` returns, when handed to
   a raw `NodeFileSystem` under the same policy, **contains** every input path
   under that adapter's containment gate (no spurious `PERMISSION_DENIED`). The
   degenerate disjoint-top-level (POSIX `/`) and cross-volume (Decision d) cases
   are documented limitations, not covered by this guarantee.
4. The containment gate still **rejects** genuinely-outside paths (the multi-root
   validator + the raw adapter's own root remain the real security boundary; this
   fix only widens the root to the correct ancestor, never past it).
5. Drive-letter and path-segment comparison is case-insensitive under
   `windowsPolicy` (git treats `C:\Repo` and `c:\repo` as the same path).
6. `test/unit/index.node.test.ts` "worktreeFs raw adapter root" runs on **every**
   platform (the `it.skipIf(process.platform === 'win32')` is removed) and still
   kills the L87 `ArrayDeclaration` mutant on Linux, macOS, and Windows.
7. Windows CI `test:unit` is green. POSIX behaviour is pinned against real
   `git worktree` layout on this host (§ Pin matrix).

## Design

### Signature and import

```ts
// src/repository/common-ancestor.ts
// Shown in the Decision (e) option-1 (default-param) shape; the RECOMMENDED
// option-2 drops the default AND the `nativePolicy` value import, taking
// `policy: PathPolicy` as a required param (type-only import, like find-layout).
import { nativePolicy, type PathPolicy } from '../adapters/node/path-policy.js';

export const commonAncestor = (
  paths: ReadonlyArray<string>,
  policy: PathPolicy = nativePolicy,
): string => { … };
```

The exact injection shape is **Decision (e)**. `import type { PathPolicy }`
mirrors find-layout.ts either way; the `nativePolicy` value import exists only
under option 1.

### Algorithm

Every input is first run through `policy.resolve` to obtain a **native-separator,
canonicalised absolute form** — this is the pivotal step (see § Pin matrix: on
`win32`, `rootOf("C:/Users/me/repo")` returns `"C:/"` with the *foreign* slash,
whereas `resolve("C:/Users/me/repo")` returns `"C:\\Users\\me\\repo"`; taking
`rootOf` of a raw mixed-separator input would emit a `/`-bearing root that fails
the containment `startsWith`). After resolving, `rootOf` and the segment split
are guaranteed separator-clean.

```
commonAncestor(paths, policy):
  resolved = paths.map(policy.resolve)              # native-sep, canonical
  first = resolved[0]
  if first is undefined:                            # empty input (never in prod)
    return policy.sep                               # '/' on posix (preserves the
                                                    # existing empty→'/' test)
  firstRoot = policy.rootOf(first)                  # '/', 'C:\', '\\srv\share\'
  # All paths must live on the same volume/root (case-insensitively). POSIX
  # always shares '/'. Windows cross-drive / cross-share do not.
  if any r in resolved where norm(rootOf(r)) != norm(firstRoot):
    return first                                    # Decision (d): the resolved
                                                    # first input (the repo
                                                    # workDir) — keeps the repo
                                                    # subtree reachable. NOT
                                                    # rootOf(first): a bare
                                                    # volume root contains
                                                    # nothing (see below).
  segLists = resolved.map(p => segmentsOf(p, policy))   # tail after root, split
  shared = longest common prefix of segLists, compared via norm(seg)
  return firstRoot + shared.join(policy.sep)        # firstRoot already ends in sep
```

Helpers:

```ts
const segmentsOf = (resolved: string, policy: PathPolicy): ReadonlyArray<string> =>
  resolved.slice(policy.rootOf(resolved).length).split(policy.sep).filter(Boolean);

// Undefined-safe, case-fold-aware segment equality. The undefined guard is
// load-bearing: a rest-path that is a strict ancestor is shorter than `first`,
// so `list[shared.length]` is undefined and MUST break the loop WITHOUT calling
// normalizeForCompare(undefined) (which throws on Windows via `.toLowerCase()`).
const segEq = (a: string | undefined, b: string, policy: PathPolicy): boolean =>
  a !== undefined &&
  policy.normalizeForCompare(a) === policy.normalizeForCompare(b);
```

`norm(x)` is `policy.normalizeForCompare(x)`. On POSIX it is the identity, so the
root-match check trivially passes (`'/' === '/'`) and `segEq` degenerates to the
current strict `===` — **the POSIX path is behaviourally unchanged**. On Windows
it case-folds, giving drive-letter and segment case-insensitivity (Requirement 5).

**Emitted casing:** segments and root come from the **first input's resolved
form** verbatim (original case, e.g. `C:\Users\me\repo`). Comparison is
case-insensitive (via `norm`); emission preserves the caller's casing. This is
safe because the raw adapter's containment case-folds **both** sides, so the
emitted casing never affects the verdict — and `realpath(rootDir)` still resolves
regardless of drive-letter case on a case-insensitive filesystem.

### Why this is correct at the containment boundary

The emitted root is `firstRoot + shared.join(policy.sep)`. `firstRoot` is
`policy.rootOf` of a **resolved** path, so it already ends in `policy.sep` and
carries no foreign separator; `shared.join(policy.sep)` uses only the native
separator. The whole root is therefore in the exact form
`policy.resolve(<that directory>)` would produce — identical in shape to what the
raw `NodeFileSystem`'s `checkContainment` computes for a child under it
(node-file-system.ts L939). The `getRootDirPrefix` normalisation
(`normalizeForCompare(rootDir)` + `sep`) and the child's resolved-then-normalised
form then compare like-for-like: `norm(child).startsWith(norm(root) + sep)` holds
for every in-tree child (Requirement 3) and fails for out-of-tree paths
(Requirement 4).

**Bare-volume-root pathology (why the two degenerate branches differ).** A root
that is itself a bare volume root (`'/'`, `'C:\'`) is a *pathological*
containment parent: it already ends in `sep`, so `containedByPrefix` appends a
second one and requires the child to start with `'//'` / `'C:\\'` — no real child
does. Empirically confirmed: `'/'` contains no `'/a/x'`; `'C:\'` contains no
`'C:\Users\me\repo'`; only `'/' ⊇ '/'` and `'C:\' ⊇ 'C:\'` hold. This is exactly
why the original `'/'`-collapse broke Windows. It splits the two degenerate cases:

- **Same root, zero shared segments** (POSIX `['/a/x','/b/y']`, and empty input):
  the honest common ancestor *is* the bare shared root `'/'`. This is preserved
  behaviour (Requirement 1) and pathological only for these disjoint-top-level
  inputs, which never occur for real worktrees (a worktree sibling always shares
  a deep prefix such as `/Users/me`). Kept as-is.
- **Different roots** (Windows cross-drive/share): there is *no* shared root to
  return, so Decision (d) returns the resolved **first input** (the repo
  workDir), whose own subtree stays reachable — strictly better than the bare
  `rootOf(first)`, which would reach nothing.

Real linked-worktree inputs always land on the main branch (same root, ≥1 shared
segment → a proper directory below the volume root), so production containment is
never bare-root.

### Consumer

`src/index.node.ts` `makeWorktreeFs` (L86–87) is unchanged under Decision (e)
option 1 (default param) — the call site
`commonAncestor([layout.workDir, ...worktreePaths])` keeps working, defaulting to
`nativePolicy`, which is the same policy the sibling
`new NodeFileSystem(root)` defaults to. Under Decision (e) option 2 (required
param) the call site threads an explicit `nativePolicy` into **both**
`commonAncestor(…, nativePolicy)` and `new NodeFileSystem(root, nativePolicy)`,
making the "one policy governs both the root shape and the containment
comparison" coupling visible and desync-proof.

### Edge-behaviour matrix

| Input (policy) | Today | After fix | Note |
|---|---|---|---|
| `['/tmp/repo','/tmp/repo-wt']` (posix) | `/tmp` | `/tmp` | preserved |
| `['/a/b','/a/b/c/d']` (posix) | `/a/b` | `/a/b` | preserved (descendant) |
| `['/a/x','/b/y']` (posix) | `/` | `/` | preserved (no shared prefix) |
| `['/a/b/c']` (posix) | `/a/b/c` | `/a/b/c` | preserved (single) |
| `[]` (posix) | `/` | `/` | preserved (empty → `policy.sep`) |
| `['C:\repo','C:\repo\wt']` (win) | `/` ✗ | `C:\repo` ✓ | the fix |
| `['C:\Users\me\repo','C:\Users\me\feature']` (win) | `/` ✗ | `C:\Users\me` ✓ | sibling |
| `['C:\repo','c:\Repo\wt']` (win) | `/` ✗ | `C:\repo` ✓ | case-insensitive |
| `['C:/Users/me/repo','C:\Users\me\repo\wt']` (win) | `/` ✗ | `C:\Users\me\repo` ✓ | mixed sep → resolve |
| `['C:\a','D:\b']` (win) | `/` ✗ | `C:\a` (Decision d) | cross-drive: no common dir → first input; `D:\b` unreachable |
| `['\\srv\share\repo','\\srv\share\repo\wt']` (win) | `/` ✗ | `\\srv\share\repo` ✓ | UNC (Decision c) |

### Pin matrix (empirically recorded)

Faithfulness here is the **path algebra**, not a git-binary byte comparison (git
supports linked worktrees on every platform; we cannot run Windows in this
environment). Two things are pinnable and were pinned on this host:

**(A) Real `git worktree` sibling layout** — `git init` + `commit` +
`git worktree add ../feature` in a `mktemp -d` throwaway (isolated `HOME`,
`GIT_CONFIG_NOSYSTEM=1`, `GIT_*` scrubbed, signing off):

| Fact | Pinned value |
|---|---|
| main workdir (realpath) | `<tmp>/repo` |
| linked worktree (realpath) | `<tmp>/feature` — a **sibling outside** workDir |
| `<tmp>/feature/.git` (gitfile) | `gitdir: <tmp>/repo/.git/worktrees/feature` |
| `…/worktrees/feature/gitdir` | `<tmp>/feature/.git` |
| `…/worktrees/feature/commondir` | `../..` |

Confirms the inputs `makeWorktreeFs` receives: `layout.workDir` (`<tmp>/repo`) and
a sibling worktree path (`<tmp>/feature`) whose common ancestor is `<tmp>` — the
POSIX case the existing tests already lock, unchanged by this fix.

**(B) `node:path.win32` primitives** the algorithm relies on (run via `node -e`
on this POSIX host — `path.win32` is available on every platform, so this is a
legitimate empirical pin of the Windows path grammar):

| Call | Result |
|---|---|
| `win32.sep` | `"\\"` |
| `win32.parse("C:\\Users\\me\\repo").root` | `"C:\\"` |
| `win32.parse("C:/Users/me/repo").root` | `"C:/"` — **keeps the foreign slash** |
| `win32.resolve("C:\\Users\\me\\repo")` | `"C:\\Users\\me\\repo"` |
| `win32.resolve("C:/Users/me/repo")` | `"C:\\Users\\me\\repo"` — **normalises** `/`→`\` |
| `win32.resolve("c:\\Users\\me\\Repo\\wt")` | `"c:\\Users\\me\\Repo\\wt"` — case preserved, not folded |
| `win32.parse("C:\\a").root` vs `…("D:\\b").root` | `"C:\\"` vs `"D:\\"` — distinct drives |
| UNC `rootOf` (documented) | `"\\\\server\\share\\"` (path-policy.ts L57) |

The `resolve` vs `rootOf` separator divergence (row 2 vs 3, row 5) is the
empirical justification for resolving **before** taking `rootOf`/splitting
(Decision b).

## Decision candidates

The user decides each of these in the ADR phase (next free ADR: **495**). This
fix extends/completes [ADR-298](../adr/298-worktree-fs-containment-escape.md).

| # | Choice | Alternatives (≤3) | Recommendation | Why |
|---|---|---|---|---|
| a | Drive-letter compare & emit | (1) compare via `normalizeForCompare` (case-insensitive), emit first input's original case; (2) compare case-sensitively; (3) lowercase-normalise the emitted root too | **(1)** | Git treats `C:`/`c:` as one drive; containment case-folds both sides so emitted casing is verdict-neutral; preserving caller casing keeps outputs least-surprising and matches `realpath` casing. |
| b | Mixed `/` and `\` in inputs | (1) `policy.resolve` each input, then `rootOf`+split on `policy.sep`; (2) split on both separators (`/[/\\]/`) then rejoin native; (3) assume inputs are already native-sep (no normalisation) | **(1)** | Empirically required: `rootOf` keeps a foreign `/` (pin B row 3) but `resolve` normalises it (pin B row 5); resolving makes the output identical in shape to what the raw adapter's own `checkContainment` computes for children, eliminating separator-mismatch denials by construction, and reuses an existing policy primitive (no new regex). Option 3 is unsafe against the mixed-sep contract `checkContainment` explicitly tolerates. |
| c | UNC paths (`\\server\share\…`) | (1) in scope, handled uniformly by `rootOf` (share is the root), unit-tested via `windowsPolicy`, flagged not-live-Windows-verified; (2) out of scope, documented limitation; (3) detect and throw on UNC | **(1)** | The `rootOf`-based algorithm already treats `\\server\share\` as the volume root, so same-share worktrees get a correct common ancestor for free; different shares fall to Decision (d). Cost is a couple of unit cases; no live-Windows-UNC host exists to pin against, so it's flagged rather than claimed byte-faithful. |
| d | No common ancestor (different Windows drives / UNC shares) | (1) return the resolved **first input** (`first`, i.e. the repo workDir); (2) throw a typed `TsgitError`; (3) return `rootOf(first)` (bare volume root) | **(1)** | A single-root raw adapter inherently cannot reach two drives, so cross-drive linked worktrees are an out-of-scope documented limitation regardless; returning `first` keeps the function total and keeps the **repo** subtree reachable (its own dir contains itself + children under `containedByPrefix`), while the multi-root validator still gates. Option 3 is a trap: a bare volume root contains *nothing but itself* under the containment check (§ Design, bare-root pathology), so the repo would be unreachable too. POSIX never triggers this branch (always shares `/`). Throwing would break `openRepository` for a case the repo side still works in. |
| e | Policy injection shape | (1) default param `policy: PathPolicy = nativePolicy` (runtime `nativePolicy` value import into `repository/`; zero call-site change); (2) required param `policy: PathPolicy`, `index.node.ts` threads `nativePolicy` into both `commonAncestor` and the sibling `NodeFileSystem`; (3) default param, but source `nativePolicy` through a port/composition seam | **(2)** | Mirrors find-layout.ts's required-param, type-only-import precedent and keeps `repository/` free of runtime adapter edges; makes the "one policy governs BOTH the root's separator shape and the containment comparison" coupling explicit and desync-proof. Option 1 is lowest-diff and boundary-check-legal but adds the first `repository/ → adapters/` runtime edge and leaves the coupling implicit. |
| f | Property-test sibling (see § Test strategy) | (1) add `common-ancestor.properties.test.ts` (lens-2 aggregator invariants, oracle = the independently-tested `pathContains`); (2) example tests only | **(1)** | `commonAncestor` is a compositional aggregator (CLAUDE.md lens 2) with clean invariants provable without re-implementing its loop; the containment invariant reuses `pathContains` as an independent oracle. |

## Test strategy

### Unit — example (`test/unit/repository/common-ancestor.test.ts`, extend)

- **Preserve** all 5 existing POSIX cases verbatim; add `posixPolicy` explicitly
  passed to at least one to prove the injected-POSIX path equals the default.
- **Add Windows cases via `windowsPolicy`** (imported from
  `../../../src/adapters/node/path-policy.js`, matching `path-policy.test.ts`),
  one `describe('Given …')`/`When`/`Then` per row of the Windows edge matrix:
  sibling under a drive, descendant, case-insensitive drive+segment, mixed
  `/`+`\` inputs, cross-drive (Decision d), UNC same-share (Decision c),
  single-path identity, and empty→`policy.sep`.
- Assertions are exact-string (`toBe('C:\\Users\\me')`), not shape checks —
  StringLiteral / separator mutants must die.

### Unit — re-enable the skipped probe (`test/unit/index.node.test.ts` L274–317)

- Remove `it.skipIf(process.platform === 'win32')` → plain `it`. Rewrite the
  "POSIX-only" comment block to state the probe now runs on every platform
  because `commonAncestor` roots at the native common ancestor. Keep the
  L87-`ArrayDeclaration`-mutant rationale (empty array → `commonAncestor([])` →
  `policy.sep` → a pathological root that rejects the real in-repo probe → mutant
  killed on Linux/macOS/Windows alike).

### Unit — property sibling (Decision f) `test/unit/repository/common-ancestor.properties.test.ts`

Shared generators in a new `test/unit/repository/arbitraries.ts` (per-directory
convention), mirroring `test/unit/adapters/node/node-file-system.properties.test.ts`
(`arbSegment`, `arbPolicy = constantFrom(posixPolicy, windowsPolicy)`,
`buildPath(policy, root, segments)`). **Every generator fixes a single root per
generated family** (`'/'` for `posixPolicy`, a constant `'C:\\'` for
`windowsPolicy`) so all inputs share one volume — the cross-root Decision-(d)
branch is *outside* the property domain (it is not an aggregation and obeys none
of these invariants) and is covered by exact example tests instead. Lens-2
invariants (default `numRuns` 100; these are invariant, not round-trip):

1. **Containment (primary, independent oracle):** for a same-root family with **at
   least one shared leading segment** (so the result is a proper directory, never
   a bare volume root), every input `p` satisfies
   `pathContains(commonAncestor(inputs, policy), policy.resolve(p), policy)` —
   oracle is the independently-tested `pathContains` from `node-file-system.js`,
   **not** a re-implementation of the segment loop. The generator prefixes every
   path with one common first segment; the bare-root degenerate cases (`'/'`,
   `'C:\'`) are excluded by construction (a bare volume root is a pathological
   containment parent — § Design, bare-root pathology) and are exact-example-tested.
2. **Single-element identity:** `commonAncestor([p], policy)` equals
   `policy.resolve(p)` (holds for any single absolute path, bare root included).
3. **Monotone depth:** appending any same-root sibling never *deepens* the result.
   Expressed as a segment **count** computed in-test on the returned string
   (`result.slice(policy.rootOf(result).length).split(policy.sep).filter(Boolean).length`,
   not the module-private `segmentsOf`):
   `count(commonAncestor([...inputs, sib])) ≤ count(commonAncestor(inputs))`. The
   count may reach 0 (bare root) — no containment is asserted here, so the
   pathology is harmless. Same-root constraint is essential: a cross-root append
   hits Decision (d) and returns the full first input, which is *deeper*.
4. **Append-a-descendant is a no-op:** appending any same-root path built by
   extending `commonAncestor(inputs)` with more segments leaves the result
   unchanged.

No seed committed; failures shrink to a local counterexample.

### Faithfulness

POSIX behaviour is pinned against real `git worktree add` sibling layout (§ Pin
matrix A) — unchanged by this fix. Windows path grammar is pinned against
`node:path.win32` primitives (§ Pin matrix B). No new `test/integration/*-interop`
test is warranted: there is no git-binary byte surface here to compare (the
worktree admin-file layout is already covered by the worktree feature's interop
tests), and the fix is pure path algebra exercised by injected-policy unit tests.

## Out of scope

- **Cross-drive / cross-share linked worktrees** (`C:\repo` + `D:\wt`): a
  single-root raw adapter cannot reach two volumes; documented limitation
  (Decision d). The repo side stays reachable.
- **Live-Windows byte verification of UNC**: no Windows/UNC host in this
  environment; UNC is covered by injected-`windowsPolicy` unit tests against the
  documented `rootOf` contract, flagged not-live-verified (Decision c).
- **The multi-root validator / `wrapFsValidator`** (ADR-298): unchanged — it
  remains the real containment gate; this fix only corrects the raw adapter's
  root width.
- **`NodeFileSystem` containment logic**: unchanged. The fix makes
  `commonAncestor` emit a root the *existing* containment already accepts; no
  change to `checkContainment`/`containmentVerdict`/`pathContains`.
- **Any rendered/stdout surface** (ADR-249): `commonAncestor` returns a path
  string consumed internally, not displayed.
