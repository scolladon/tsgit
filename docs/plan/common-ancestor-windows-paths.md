# Plan — commonAncestor: Windows-correct path algebra for linked-worktree FS rooting

> Source: design doc `docs/design/common-ancestor-windows-paths.md` · ADRs `495`
> The plan is the implementation script AND the knowledge handoff. Part agents start
> with zero context: whatever a part block omits is paid later as agent rediscovery.
> `plan-lint.sh` enforces the schema below — the plan phase cannot close without it.

## Sizing rules

This change is small and cohesive, and it lands as **one part**. The two source files
are inseparable: the moment `commonAncestor` gains its required `policy` parameter
(Decision e-2), the sole call site in `src/index.node.ts` fails `check:types` unless it
threads a policy in the same commit — so the source rewrite and the consumer threading
must land together. All test changes exercise exactly that rewritten source: the example
suite (POSIX + Windows) drives `common-ancestor.ts`; the re-enabled `index.node` probe is
*enabled by* the fix (it is not a test-only change — it rides with the code that makes it
pass on Windows); the property sibling + its `arbitraries.ts` prove the same function's
invariants. Nothing here is a pure test pass over already-landed code, and there is no
standalone test-infra part to carve out — the property suite folds into the implementation
part whose `src/` delta it exercises. Hence: **1 part**.

**Surface decision (settled, up front):** `commonAncestor` is and stays **internal** —
it is imported only by `src/index.node.ts` (a value import) and by its own unit tests;
it is re-exported from no barrel / package entry and appears nowhere in `reports/api.json`
(verified: `grep -c commonAncestor reports/api.json` → 0). The new
`test/unit/repository/arbitraries.ts` is a test fixture, not an export. Therefore **no
public-surface gates apply** — no error-union / exhaustiveness edit, no Tier-1 barrel /
facade / `check:doc-coverage` / `audit-browser-surface` row, no README count bump, no
`reports/api.json` regeneration. The signature change stays type-internal to `src/`.

**Architecture:** `common-ancestor.ts` imports `PathPolicy` as `import type` only
(mirroring `src/repository/find-layout.ts` line 1), so it adds **no** runtime
`repository/ → adapters/` edge; `.dependency-cruiser.cjs` has no such rule anyway, so
`check:architecture` stays green either way.

## Part 1 — commonAncestor: policy-driven cross-platform path algebra + re-enabled worktree probe

### Context

**Goal.** Rewrite `commonAncestor` so it computes the deepest containing directory using
an injected `PathPolicy` (drive-letter, backslash, and UNC aware), keeping POSIX output
byte-identical; thread `nativePolicy` from the Node shim into both `commonAncestor` and
the sibling raw `NodeFileSystem`; and re-enable the `index.node` raw-adapter probe on every
platform. All five settled decisions (a–f) are already fixed by ADR-495 — implement them,
do not re-open them.

**Files to touch (exact paths, all under the working directory):**

1. `src/repository/common-ancestor.ts` — the whole 24-line file. Rewrite.
2. `src/index.node.ts` — add one import (line ~20 region) and rewrite the `makeWorktreeFs`
   call site (currently lines 86–87).
3. `test/unit/repository/common-ancestor.test.ts` — update the 5 existing POSIX calls and
   add Windows example cases.
4. `test/unit/index.node.test.ts` — the `describe('Node shim — worktreeFs raw adapter
   root')` block at lines 274–317: remove the `it.skipIf` and rewrite its comment.
5. `test/unit/repository/arbitraries.ts` — **new** shared generator module.
6. `test/unit/repository/common-ancestor.properties.test.ts` — **new** property sibling.

**Current source (`src/repository/common-ancestor.ts`, verbatim):**

```ts
/** Split an absolute path into its non-empty segments. */
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

The module doc-comment at the top calls the inputs "absolute POSIX paths" — update it in
REFACTOR to state the algebra is now policy-driven (native separator, drive/UNC aware);
keep it a "why" comment.

**Target signature and import (Decision e-2 = REQUIRED param, no default; b-1 = resolve-first):**

```ts
import type { PathPolicy } from '../adapters/node/path-policy.js';

export const commonAncestor = (paths: ReadonlyArray<string>, policy: PathPolicy): string => { … };
```

`import type` only — mirrors `find-layout.ts`. Do **not** import the `nativePolicy` value
here (that was option-1, rejected). There is **no default parameter**.

**Target algorithm (from design §Algorithm — implement exactly):**

```
commonAncestor(paths, policy):
  resolved  = paths.map(policy.resolve)           # native-sep, canonical
  first     = resolved[0]
  if first === undefined:                          # empty input (never in prod)
    return policy.sep                              # '/' on posix, '\' on windows
  firstRoot = policy.rootOf(first)                 # '/', 'C:\', '\\srv\share\'
  if resolved.some(r => norm(rootOf(r)) !== norm(firstRoot)):
    return first                                    # Decision (d): resolved first input
  shared = []
  for segment of segmentsOf(first, policy):
    if !rest.every(list => segEq(list[shared.length], segment, policy)): break
    shared.push(segment)
  return firstRoot + shared.join(policy.sep)        # firstRoot already ends in sep
```

where `norm(x) = policy.normalizeForCompare(x)` and `rest = resolved.slice(1).map(r =>
segmentsOf(r, policy))`.

**Two helpers (exact):**

```ts
const segmentsOf = (resolved: string, policy: PathPolicy): ReadonlyArray<string> =>
  resolved.slice(policy.rootOf(resolved).length).split(policy.sep).filter(Boolean);

const segEq = (a: string | undefined, b: string, policy: PathPolicy): boolean =>
  a !== undefined &&
  policy.normalizeForCompare(a) === policy.normalizeForCompare(b);
```

**The `a !== undefined` guard is LOAD-BEARING — do not drop or simplify it.** A rest-path
that is a strict *ancestor* of the first input is shorter than `first`, so
`list[shared.length]` is `undefined`; `windowsPolicy.normalizeForCompare(undefined)` calls
`undefined.toLowerCase()` and **throws**. The guard must short-circuit before that call and
break the loop. (On `posixPolicy`, `normalizeForCompare` is the identity and would not
throw, but the guard is still needed for correctness — `undefined` must not equal any real
segment.) A dedicated Windows example test (ancestor listed *after* its descendant) pins
this; without the guard that test throws → the mutant that removes it is killed.

**Why resolve-first is mandatory (design §Pin matrix B, empirically re-confirmed on this
host via `node -e`):** on `win32`, `parse("C:/Users/me/repo").root === "C:/"` (keeps the
**foreign** slash) but `resolve("C:/Users/me/repo") === "C:\\Users\\me\\repo"` (normalises
`/`→`\`). Taking `rootOf`/splitting a raw mixed-separator input would emit a `/`-bearing
root that fails the containment `startsWith(root + sep)` in the raw adapter. Resolving
first makes every root and every segment separator-clean and native, so the emitted root is
byte-shaped exactly like what `NodeFileSystem.checkContainment` computes for a child under
it — no spurious `PERMISSION_DENIED`.

**Host-determinism of the Windows cases:** `windowsPolicy.resolve` is `path.win32.resolve`,
available on every host. Because **all** W-inputs are absolute (drive-letter or UNC),
`win32.resolve` never consults the POSIX host's `cwd`, so the simulated-Windows outputs are
deterministic on the Linux/macOS CI host (verified via `node -e`:
`win32.resolve('C:/Users/me/repo') === 'C:\\Users\\me\\repo'`). Do not feed relative inputs.

**POSIX invariance (Requirement 1):** on `posixPolicy`, `resolve` is identity on the
already-absolute test inputs, `rootOf` is `'/'`, `normalizeForCompare` is identity, and
`sep` is `'/'`, so every step degenerates to today's behaviour and all five example
*results* are byte-identical.

**Consumer — `src/index.node.ts` (Decision e-2 threading):**

- `commonAncestor` is imported today at line 20:
  `import { commonAncestor } from './repository/common-ancestor.js';`
- `nativePolicy` is **NOT** currently imported here (verified). Add:
  `import { nativePolicy } from './adapters/node/path-policy.js';` (a value import — this is
  a node-shim edge, legitimate, not a `repository/` edge).
- `NodeFileSystem`'s constructor is `(rootDir, pathPolicy = nativePolicy, fsOps = realFsOps)`
  — the second arg is the policy.
- Rewrite `makeWorktreeFs` (lines 86–87) to thread the **same** policy into both calls so
  the root's separator shape and the containment comparison are governed by one policy:

  ```ts
  makeWorktreeFs: (worktreePaths: ReadonlyArray<string>): NodeFileSystem =>
    new NodeFileSystem(
      commonAncestor([layout.workDir, ...worktreePaths], nativePolicy),
      nativePolicy,
    ),
  ```

  Do **not** touch the other `new NodeFileSystem(layout.workDir)` at line 61 — it is a
  separate raw fs and is out of scope for this change.

**Path-policy facts (`src/adapters/node/path-policy.ts`, for reference — do not edit):**
`PathPolicy` exposes `sep: '\\'|'/'`, `caseInsensitive`, `resolve`, `join`, `dirname`,
`basename`, `isAbsolute`, `rootOf(p) = parse(p).root`, `normalizeForCompare(p)`
(case-fold + strip `\\?\` on case-insensitive platforms, **identity** on POSIX). Singletons:
`posixPolicy` (caseInsensitive:false), `windowsPolicy` (caseInsensitive:true), `nativePolicy`.

**Containment oracle for the property test (`src/adapters/node/node-file-system.ts`):**
`export function pathContains(parent, child, policy = nativePolicy): boolean` (line 131) —
`true` iff `child === parent` (case-folded) or `child` is strictly inside `parent`. This is
the **independently-tested** oracle for the containment invariant — do NOT re-implement the
segment loop as the oracle.

**Property-test conventions (mirror `test/unit/adapters/node/node-file-system.properties.test.ts`):**
it defines `arbSegmentChar` (a–z, A–Z, 0–9), `arbSegment` (`minLength:1,maxLength:8`),
`arbPolicy = fc.constantFrom(posixPolicy, windowsPolicy)`, and
`buildPath(policy, root, segments) = segments.reduce((acc, seg) => acc + policy.sep + seg, root)`,
with `INVARIANT_NUM_RUNS = 100`. The repository arbitraries differ in one way: they fix a
**bare volume root per family** (`'/'` for posix, `'C:\\'` for windows), so `buildPath` must
be **bare-root-aware** — `root + segments.join(policy.sep)` (root already ends in `sep`,
so the reduce form would double it: `'C:\\' + '\\' + 'a'` = malformed `'C:\\\\a'`). 28
sibling `arbitraries.ts` files establish the per-directory naming convention.

**Edge matrix — exact-string expected outputs (design §Edge-behaviour matrix; JS literals,
`\\` is one backslash):**

| # | Input (policy) | Expected | Isolates |
|---|---|---|---|
| P1 | `['/tmp/repo','/tmp/repo-wt']` (posix) | `'/tmp'` | sibling (existing) |
| P2 | `['/a/b','/a/b/c/d']` (posix) | `'/a/b'` | descendant (existing) |
| P3 | `['/a/x','/b/y']` (posix) | `'/'` | no shared prefix (existing) |
| P4 | `['/a/b/c']` (posix) | `'/a/b/c'` | single (existing) |
| P5 | `[]` (posix) | `'/'` | empty → `policy.sep` (existing) |
| W1 | `['C:\\repo','C:\\repo\\wt']` (win) | `'C:\\repo'` | drive sibling |
| W2 | `['C:\\Users\\me\\repo','C:\\Users\\me\\feature']` (win) | `'C:\\Users\\me'` | deeper sibling (kills the mismatch-branch-negation mutant) |
| W3 | `['C:\\a\\b','C:\\a\\b\\c\\d']` (win) | `'C:\\a\\b'` | descendant |
| W4 | `['C:\\a\\b\\c','C:\\a\\b']` (win) | `'C:\\a\\b'` | **ancestor after descendant — kills the `a !== undefined` guard mutant (throws without it)** |
| W5 | `['C:\\Repo','c:\\repo\\wt']` (win) | `'C:\\Repo'` | case-insensitive compare + **emits first's original casing** (kills a lowercase-the-output mutant) |
| W6 | `['C:/Users/me/repo','C:\\Users\\me\\repo\\wt']` (win) | `'C:\\Users\\me\\repo'` | mixed sep → resolve normalises |
| W7 | `['C:\\a','D:\\b']` (win) | `'C:\\a'` | cross-drive Decision (d): returns resolved first input, not `'C:\\'` (kills the mismatch-branch-removal mutant) |
| W8 | `['\\\\srv\\share\\repo','\\\\srv\\share\\repo\\wt']` (win) | `'\\\\srv\\share\\repo'` | UNC same-share (Decision c) |
| W9 | `['C:\\a\\b\\c']` (win) | `'C:\\a\\b\\c'` | single-path identity |
| W10 | `[]` (win) | `'\\'` | empty → `policy.sep` (kills a hardcoded-`'/'` mutant on the empty branch) |

Optional-but-recommended UNC cross-share Decision-(d) case:
`['\\\\srv\\a\\x','\\\\srv\\b\\y']` (win) → `'\\\\srv\\a\\x'`.

### TDD steps

**RED**

1. `test/unit/repository/common-ancestor.test.ts`: import `posixPolicy` and `windowsPolicy`
   from `../../../src/adapters/node/path-policy.js`. Add the **required** `posixPolicy`
   argument to each of the 5 existing calls (`commonAncestor(sut, posixPolicy)`), keeping
   every input and every `expect(result).toBe(...)` expected value byte-for-byte (this is
   what "preserve verbatim" means under the required-param decision — the assertions are
   unchanged; only the explicit policy arg is added, proving injected-POSIX == today's
   behaviour). Then add one Given/When/Then `describe` block per Windows row **W1–W10**
   (plus the optional cross-share), each an exact-string `toBe` assertion, `sut` = the input
   array, `windowsPolicy` passed explicitly.
   *Expected failure:* `check:types` fails (`commonAncestor` still takes 1 arg → "Expected 1
   arguments, but got 2"); at runtime every W-case fails by assertion because today's
   `split('/')` returns `'/'` for every `C:\…` input (including W4, which asserts
   `'C:\\a\\b'` but gets `'/'`). W4's throw-protection is not observed in RED (the old code
   never calls `normalizeForCompare`); it is a **mutation** property of the GREEN code —
   removing the `a !== undefined` guard makes W4 throw at runtime, killing that mutant.
2. `test/unit/repository/arbitraries.ts` (new): export `arbSegment` (alphanumeric,
   `minLength:1,maxLength:8`, via an `arbSegmentChar` mirroring the node-file-system
   sibling), `arbRootedPolicy` = `fc.constantFrom({ policy: posixPolicy, root: '/' }, {
   policy: windowsPolicy, root: 'C:\\' })`, and the **bare-root-aware**
   `buildPath(policy, root, segments) = root + segments.join(policy.sep)`.
3. `test/unit/repository/common-ancestor.properties.test.ts` (new): import `fc`,
   `describe`/`it` from vitest, `commonAncestor` from
   `../../../src/repository/common-ancestor.js`, `pathContains` from
   `../../../src/adapters/node/node-file-system.js`, and the generators from
   `./arbitraries.js`. `INVARIANT_NUM_RUNS = 100`. Write the four lens-2 invariants (design
   §Test strategy / Decision f), each Given/When/Then + AAA:
   - **Containment (primary):** a non-empty family (inputs `minLength:1`) each built as
     `buildPath(policy, root, [head, ...extra])` sharing one common `head` segment (so the
     result is a proper directory, never a bare volume root). Assert, for every input `p`:
     `pathContains(commonAncestor(inputs, policy), policy.resolve(p), policy) === true`.
     Oracle is `pathContains` — **not** a re-implemented segment loop.
   - **Single-element identity:** `commonAncestor([p], policy) === policy.resolve(p)` for any
     single absolute `p` (allow bare-root, `segments` `minLength:0`).
   - **Monotone depth:** appending any same-root sibling never deepens the result — with
     `depth(s) = s.slice(policy.rootOf(s).length).split(policy.sep).filter(Boolean).length`
     computed in-test on the returned string,
     `depth(commonAncestor([...inputs, sib], policy)) <= depth(commonAncestor(inputs, policy))`
     (inputs `minLength:1`; may reach depth 0 — no containment asserted here).
   - **Append-a-descendant no-op:** for a shared-`head` family, extending
     `base = commonAncestor(inputs, policy)` with `extra` (`minLength:1`, so the descendant is
     strictly deeper) — `descendant = base + policy.sep + extra.join(policy.sep)` — and
     appending it leaves the result unchanged:
     `commonAncestor([...inputs, descendant], policy) === base`.
   *Expected failure:* `check:types` (2-arg call) + runtime — windows families collapse to
   `'/'` today so the containment invariant is false.
4. `test/unit/index.node.test.ts` (lines 274–317): change `it.skipIf(process.platform ===
   'win32')(` to `it(` and rewrite the "POSIX-only" comment block to state the probe now
   runs on **every** platform because `commonAncestor` roots the raw adapter at the *native*
   common ancestor; keep the L87-`ArrayDeclaration`-mutant rationale (`[] → commonAncestor([],
   nativePolicy) → policy.sep → pathological root that rejects the real in-repo probe →
   mutant killed on Linux/macOS/Windows alike). *No new local RED on this POSIX host — the
   probe already ran under `skipIf` and still passes; this change lets it run on Windows CI
   too and rides with the fix that keeps it green there.*

**GREEN**

5. Rewrite `src/repository/common-ancestor.ts` to the target signature, algorithm, and two
   helpers above (`import type { PathPolicy }`; resolve-first; `rootOf`-mismatch → return
   `first`; longest common segment prefix via `segEq`; return `firstRoot +
   shared.join(policy.sep)`; empty → `policy.sep`). Keep every function `<20` lines, early
   returns, no magic values.
6. `src/index.node.ts`: add `import { nativePolicy } from './adapters/node/path-policy.js';`
   and rewrite `makeWorktreeFs` to thread `nativePolicy` into both `commonAncestor([...],
   nativePolicy)` and `new NodeFileSystem(root, nativePolicy)` (leave line 61 untouched).
7. Run the gate → the 5 POSIX cases pass unchanged, W1–W10 pass, the properties pass,
   `index.node` probe green, `check:types` green.

**REFACTOR**

8. Update the `common-ancestor.ts` module doc-comment: the inputs are absolute paths in any
   policy's form; the algebra is native-separator, drive-letter and UNC aware, driven by the
   injected `PathPolicy`; keep the "wide enough to reach both, multi-root validator narrows
   back down" rationale in **prose** ("why", not "what"). **The current doc-comment's
   literal `(ADR-298)` reference must NOT be carried into the rewrite** — the no-provenance-refs
   rule forbids ADR/phase/backlog numbers in source or test, and the rewrite touches this
   line. Likewise, the plan's pseudocode comments (`# Decision (d)…`) are for this document
   only — source/test comments explain the "why" in prose and never cite decision letters or
   ADR numbers.
9. Confirm no suppression directives, no swallowed errors, immutable style (no mutation of
   inputs — `shared` is a fresh local array, acceptable). Re-run the gate; it must be green
   before the commit.

### Gate

```
npx vitest run test/unit/repository/common-ancestor.test.ts test/unit/repository/common-ancestor.properties.test.ts test/unit/index.node.test.ts \
  && npm run check:types \
  && ./node_modules/.bin/biome check src/repository/common-ancestor.ts src/index.node.ts test/unit/repository/common-ancestor.test.ts test/unit/repository/common-ancestor.properties.test.ts test/unit/repository/arbitraries.ts test/unit/index.node.test.ts
```

### Commit

```
fix(repository): drive-letter and UNC aware commonAncestor for worktree fs
```
