# ADR-045: Separator normalisation policy at the `NodeFileSystem` boundary — accept mixed, emit platform-native; domain `\` rejection unchanged

## Status

Accepted (at `963a72b`)

## Context

The repo has three layers of path normalisation, each with different
rules:

| Layer                                      | Input separator                  | Internal form          |
|--------------------------------------------|----------------------------------|------------------------|
| `validateWorkingTreePath` (domain)         | POSIX `/` only; `\` rejected     | POSIX `/`              |
| `wrapFsValidator.isContainedIn` (adapter wrapper) | Either `/` or `\` (normalises) | POSIX `/` for compare  |
| `NodeFileSystem` (adapter)                 | Either `/` or `\` (passes to Node) | Platform-native        |

Phase 14.4 surfaced one extra constraint: the contract test fixtures
build paths with `${env.rootDir}/X`, which on Windows produces a
mixed-separator absolute (`C:\…\rootDir/X`). `fsPromises.realpath` is
forgiving and Node generally accepts mixed separators, but the
containment check ends up comparing mixed-form `real` against
platform-native `rootDir`, producing false negatives intermittently.

Three policy options:

1. **Reject mixed separators at the adapter boundary.** Throws on any
   `\` in input on POSIX or on any `/` mixed with `\` on Windows. Too
   strict — real-world tooling (`mkdtemp`, `path.resolve`, IDE
   integrations) produces mixed forms and users would not understand
   why they're being rejected.
2. **Normalise everything to POSIX inside the adapter.** Convert `\` to
   `/` on entry, then call Node APIs with POSIX-style paths. Works on
   POSIX. On Windows, some Node APIs (e.g., `realpath`) work with `/`
   but many tools and Win32 calls expect `\` — and emitting `/` from
   `realpath` would cause downstream mismatches with `nodePath.sep`.
3. **Accept either, emit platform-native via `nodePath.resolve` /
   `nodePath.join`.** The adapter MAY receive mixed-separator input;
   normalising via `nodePath.resolve` produces platform-native output.
   All subsequent Node calls (realpath, lstat, open, …) receive a
   platform-native path. The domain validator keeps its strict POSIX
   rule because domain paths never see the adapter directly — they
   flow through `validatePath` first.

Option 3 matches the existing behaviour and just clarifies the
contract. The contract test fixture change in Phase 14.4 (§3.5)
implements the same policy at the test layer: tests build paths via
`nodePath.join` so test inputs come out platform-native.

## Decision

Codify the existing implicit policy:

1. `validateWorkingTreePath` (domain) — POSIX `/` only; `\` rejected.
   No change.
2. `wrapFsValidator.isContainedIn` (adapter wrapper) — normalise both
   sides via `\` → `/` for the prefix comparison. No change (shipped
   in Phase 11).
3. `NodeFileSystem` (adapter) — accept either separator on input;
   internally use `nodePath.resolve` to produce platform-native paths;
   ALL containment comparisons happen on `realpath`-normalised,
   case-folded-on-Windows forms (per ADR-042).
4. Test fixtures (`test/unit/ports/file-system.contract.ts`) — use
   `nodePath.join` to construct paths. NEVER concatenate with literal
   `/`. This guarantees test inputs are platform-native and matches
   what real callers produce.

## Consequences

### Positive

- POSIX behaviour is unchanged.
- Windows behaviour gets the consistency it was missing — every path
  comparison runs on platform-native, canonical, case-folded strings.
- The domain validator's `\` rejection stays in place — defending
  against confused-deputy attacks where a caller smuggles a Windows
  path into a POSIX-only field.

### Negative

- Three normalisation layers means three places to read when debugging
  a path issue. The doc (§3.2) calls them out together.

### Neutral

- Future Windows-only quirks (UNC paths, extended-length `\\?\`
  prefixes) can extend the same policy in the adapter without
  touching the domain rules.
