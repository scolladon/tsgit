# ADR-053: Abandon the skip-`resolve` containment optimization (§14.5.3)

## Status

Accepted (at `50e6eed`)

## Context

BACKLOG §14.5.3 proposed a perf optimization: `NodeFileSystem`'s
`checkContainment` (and `exists`) call `pathPolicy.resolve(...)` on
every filesystem operation, and the §14.4 review's perf pass flagged
this as a MEDIUM cost — `resolve` "touches `process.cwd()` and
re-walks the string even when the input is already a clean absolute
path". The proposal: gate the `resolve` call behind a cheap probe so
clean absolute paths skip it.

The implementation added a `containsRelativeSegment(p)` probe — a
regex matching `.` / `..` as complete path segments — and only called
`resolve` when the probe returned true.

This shipped in the §14.5 bundle and **broke 37 contract tests on the
`windows-latest` CI cell**. The root cause:

`pathPolicy.resolve` does not only collapse `.` / `..` segments. It
also **normalises foreign separators** — a `/` inside a Windows path
is rewritten to `\` — and collapses duplicate / trailing separators.
ADR-045 (separator normalisation policy) explicitly makes this part
of the adapter's contract:

> The adapter MAY receive mixed-separator input; normalising via
> `nodePath.resolve` produces platform-native output.

The Windows contract suite exercises exactly that: it passes paths
like `C:\Users\…\tsgit-XYZ/file.bin` (a `/` before the leaf). The
`containsRelativeSegment` probe saw no `.` / `..` segment, returned
false, and the un-normalised mixed-separator path flowed straight
into the containment prefix-check — which compares against a
`\`-separated `rootDir`. The `/` ≠ `\` mismatch failed the
`startsWith` check, and every happy-path operation spuriously threw
`PERMISSION_DENIED`.

Three ways forward were considered:

1. **Broaden the probe.** Make `containsRelativeSegment` detect
   everything `resolve` would change: relative segments, foreign
   separators, duplicate separators, trailing separators. Rejected —
   the probe becomes a hand-written mirror of Node's `path.resolve`
   normalisation rules, coupled to internals that vary across Node
   versions and interact subtly with the legal leading `\\` of UNC
   paths. A probe that is "almost right" silently re-breaks
   containment, which is a security invariant. The §14.5.3 bug is
   itself the proof: a probe that looked correct missed a whole class
   of inputs.

2. **Compare `resolve`'s output to its input and branch on that.**
   This is correct but pays the `resolve` call anyway — it saves
   nothing.

3. **Abandon the optimization.** Always call `resolve`, exactly as
   the code did before §14.5.3 and as it has on `main` for the
   adapter's whole history.

Re-examining the original perf finding weakens its premise: Node's
`path.resolve` consults `process.cwd()` **only when the accumulated
path is not absolute**. `checkContainment` feeds `resolve` the output
of `toAbsolute(...)`, which is always absolute — so `cwd` is never
read on this path. The remaining cost is pure in-memory string
normalisation, on the order of microseconds. The MEDIUM finding
overstated the cost it was chasing.

## Decision

Abandon §14.5.3. `checkContainment` and `exists` call
`pathPolicy.resolve(toAbsolute(...))` unconditionally, as on `main`.
The `containsRelativeSegment` helper and its unit tests are removed.

There is no cheap, correct gate: any probe must reproduce Node's
full `path.resolve` normalisation surface (relative segments + foreign
separators + duplicate/trailing separators + UNC-prefix handling),
and the cost being skipped is microsecond-scale string work that does
not touch the filesystem or `process.cwd()`. The optimization is not
worth a fragile coupling to a security-critical code path.

## Consequences

### Positive

- Containment correctly normalises mixed-separator input on every
  platform, honouring the ADR-045 contract.
- No hand-written probe to keep in sync with Node's `path.resolve`
  semantics across versions.
- The containment path — a Phase 11 security invariant — has one
  fewer conditional branch and one fewer way to be subtly wrong.

### Negative

- Every `checkContainment` / `exists` call pays one `path.resolve`
  on an already-absolute path. Measured cost: microsecond-scale
  string normalisation, no syscall, no `cwd` access. Accepted.

### Neutral

- §14.5 ships 13 of its 14 sub-items. §14.5.3 is recorded under the
  BACKLOG's "Abandoned" section, linking this ADR, rather than left
  as an open `[ ]` item (which would imply it is still queued).
- If a future profiling pass (§15.3) shows `resolve` is a real
  bottleneck, the correct optimization is to make the *fast path a
  property of `PathPolicy`* — e.g., a `policy.resolveAbsolute(p)`
  that the policy implementation can shortcut — not a caller-side
  probe. That would be a new backlog item, not a revival of §14.5.3.
