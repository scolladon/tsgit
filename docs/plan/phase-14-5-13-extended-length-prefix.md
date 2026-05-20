# Plan — 14.5.13 Strip Windows `\\?\` extended-length prefix

Derived from `docs/design/phase-14-5-followups.md` §2.13. Implements the one
remaining open §14.5 sub-item: Windows `normalizeForCompare` must strip a
leading extended-length prefix before case-folding, so device-namespace paths
(`\\?\C:\…`, `\\?\UNC\server\share\…`) compare equal to their plain forms in
containment checks. Today they spuriously deny in `lstat` / creation modes.

## Background

`normalizeForCompare` is the case-folding step behind `pathContains`. Both the
memoised `normalizedRootDir` / `normalizedCanonicalRoot` and every candidate
`child` flow through it. A `realpath` result carrying a `\\?\` prefix that is
compared against a plain-form sibling fails the prefix test even though the
two name the same location — a false out-of-tree denial.

The strip shipped once in the §14.5 bundle, was reverted while bisecting an
unrelated Windows-CI failure (root cause was 14.5.3), and is reintroduced here
on its own.

## Scope decisions

- **Strip site:** inside `normalizeForCompare`, gated by `caseInsensitive`.
  POSIX paths never carry the prefix, so the POSIX arm stays identity.
- **Helper placement:** module-private pure `const stripWinExtendedPrefix` at
  module scope — defined once, not per-policy; reachable for coverage through
  the public `windowsPolicy.normalizeForCompare`. Not exported.
- **Two prefix forms:** `\\?\UNC\server\share\…` → `\\server\share\…`;
  `\\?\C:\…` → `C:\…`. Order matters — the UNC test must precede the bare
  `\\?\` test since the bare form is a prefix of the UNC form.

## Files

| File | Change |
|------|--------|
| `src/adapters/node/path-policy.ts` | Add `stripWinExtendedPrefix`; wire into `makePolicy`'s `normalizeForCompare`. |
| `test/unit/adapters/node/path-policy.test.ts` | Add `windowsPolicy.normalizeForCompare` prefix cases + POSIX no-strip case. |
| `docs/BACKLOG.md` | Flip `14.5.13` `[ ]` → `[x]`; refresh the `14.5` parent summary line. |

## Steps (TDD)

### Step 1 — `windowsPolicy.normalizeForCompare` strips `\\?\C:\…`

- **Test first:** `windowsPolicy.normalizeForCompare('\\\\?\\C:\\Users\\Foo')`
  → `'c:\\users\\foo'`. Fails today (prefix retained, lowercased).
- **Implement:** add `stripWinExtendedPrefix` with the bare-`\\?\` arm;
  `normalizeForCompare: caseInsensitive ? stripWinExtendedPrefix(path).toLowerCase() : path`.
- **Verify:** test goes green.

### Step 2 — strips the `\\?\UNC\…` form

- **Test first:** `windowsPolicy.normalizeForCompare('\\\\?\\UNC\\Server\\Share\\f')`
  → `'\\\\server\\share\\f'`.
- **Implement:** prepend the UNC arm (`startsWith('\\\\?\\UNC\\')`) ahead of
  the bare arm.
- **Verify:** both prefix tests green; the bare-form test must stay green
  (proves arm ordering).

### Step 3 — non-prefixed Windows path is untouched

- **Test first:** `windowsPolicy.normalizeForCompare('C:\\Users\\Foo')`
  → `'c:\\users\\foo'` (the existing test already covers this — assert it
  still passes; add an explicit "no `\\?\`" case if the existing one is
  ambiguous). Guards the `return p` fall-through arm.
- **Implement:** none — fall-through already returns `p`.
- **Verify:** green.

### Step 4 — POSIX policy never strips

- **Test first:** `posixPolicy.normalizeForCompare('\\\\?\\C:\\X')` returns the
  input unchanged (identity arm — POSIX is case-sensitive, no strip).
- **Implement:** none — `caseInsensitive` is `false` for POSIX.
- **Verify:** green. Pins the `caseInsensitive` guard against a
  ConditionalExpression mutant that would route POSIX through the strip.

### Step 5 — harness + mutation

- `npm run validate` — full gate incl. 100% coverage.
- `stryker run` scoped to `path-policy.ts` — kill every mutant. Expected
  mutation surface: the two `startsWith` literals, the two `slice` offsets
  (4 and 8), the `'\\\\'` concat literal, the `caseInsensitive` ternary.

### Step 6 — docs + PR

- Flip `docs/BACKLOG.md` `14.5.13`; update the `14.5` parent line
  (`12 of 14` → `13 of 14`, drop "14.5.13 deferred").
- Open PR; squash-merge on green.

## Dependencies

Steps 1→2 are ordered (arm precedence). Steps 3-4 are independent of each
other but follow 1-2. Steps 5-6 are terminal.
