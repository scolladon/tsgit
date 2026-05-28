# ADR-168: Canonical headers for binary, mode, rename, type-change

## Status

Accepted (at `<sha-after-merge>`)

## Context

The unified-diff serializer must emit canonical `git diff` headers for
five non-trivial file-class shapes:

- Binary file with differing content
- Mode change (executable bit toggled) with or without content change
- Pure rename (exact-id match, no content change)
- Rename + mode change
- Type change (e.g., regular ↔ symlink ↔ gitlink)

Downstream parsers (e.g. `patch(1)`, `git apply`, GitHub UI, IDE diff
viewers) expect byte-identical output to `git diff`. Three sub-decisions
make or break that compatibility:

1. **Binary patch encoding.** Git supports `--binary` (base85-encoded
   full patch). Without `--binary`, git emits `Binary files a/X and
   b/Y differ`. Which do we ship?
2. **`index` line content when `old mode`/`new mode` are present.** Git
   *omits* the trailing mode suffix on the `index` line when dedicated
   `old mode`/`new mode` lines are present. We must match exactly.
3. **Pure-rename hunk emission.** Git emits no `--- a` / `+++ b` /
   hunks for a 100%-similarity rename — only the rename headers. We
   must match exactly.

## Decision

### Binary

Emit `Binary files a/<path> and b/<path> differ`. Do NOT ship
`--binary` (base85). Rationale:

- 99% of binary use cases are "show me which binary files changed,"
  not "let me apply this patch." `Binary files … differ` covers that.
- `--binary` is opt-in even in upstream git (`git diff` default does
  not emit it). A future enhancement can add a `binary?: 'omit' |
  'base85'` option to the patch serializer.

For binary `add` / `delete`: substitute `/dev/null` on the matching
side: `Binary files /dev/null and b/<path> differ`. Matches git.

### Mode change

When `oldMode !== newMode`, emit:

```
old mode <oldMode>
new mode <newMode>
index <oldShortOid>..<newShortOid>
```

The `index` line carries NO trailing mode suffix in this case. When
modes match, the `index` line carries the trailing mode suffix:
`index <oldOid>..<newOid> <mode>`.

### Pure rename (similarity 100%)

When `change.type === 'rename'` (the existing exact-id detect produces
only 100%-similarity entries), emit:

```
diff --git a/<oldPath> b/<newPath>
similarity index 100%
rename from <oldPath>
rename to <newPath>
```

No `index`, no `---`, no `+++`, no hunks. When the rename also flips
mode (a future `RenameChange` may carry `oldMode !== newMode`; today's
type system does not enforce this but the serializer must be prepared),
insert `old mode <m>` + `new mode <m>` between `similarity index` and
`rename from`. Matches git.

### Type change

Emit `old mode` + `new mode` + `index` + content hunks. The content of
both sides participates in the hunk body — symlink targets are
strings, gitlinks are 40-hex commit ids treated as text. Matches git's
`type-changed` block.

## Consequences

### Positive

- Output is byte-identical to `git diff` for every shape covered by
  the existing `DiffChange` discriminated union.
- Downstream tooling (`patch(1)`, `git apply`, code-review UIs) works
  out of the box.
- The trailing-mode-suffix-on-`index` rule is the most common foot-gun
  for ad-hoc emitters — capturing it in an ADR + test fixtures means
  the next person editing the serializer can't break it accidentally.

### Negative

- Skipping `--binary` ships a known capability gap. Programmatic
  callers that want a round-trippable binary patch must wait for a
  follow-up. Documented in the design's "Out of scope" section.
- Type-change rendering with one binary side: today's code emits the
  `Binary files … differ` block (binary detector wins). This is
  technically a divergence — git renders the textual side and degrades
  the other. Low-likelihood corner case; documented in the test
  fixtures; an explicit `unknown` literal could be added later.

### Neutral

- Pure-rename short-circuit means the serializer never tries to load
  blob bytes for renamed files. Saves I/O.
- The mode constants come from the existing `FILE_MODE` enum in
  `domain/objects/file-mode.ts`. No new constants land in 20.3.

## Alternatives considered

- **Always emit `--binary` (base85).** Rejected: 99% of users want
  human-readable patches; base85 is opt-in even in upstream. Ship the
  default first, add the flag later.
- **Emit pure renames with empty hunks (`@@ -0,0 +0,0 @@`).** Rejected:
  diverges from `git diff`, breaks downstream parsers that key on the
  absence of `@@` for similarity-100 entries.
