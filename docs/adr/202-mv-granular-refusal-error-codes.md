# ADR-202: `mv` uses granular per-reason refusal error codes

## Status

Accepted (at `a7e54c4`)

## Context

`git mv` refuses a move for seven distinct reasons, each with its own message:
not-under-version-control, bad source, destination exists, can-not-move-into-
itself, destination-is-not-a-directory, destination-directory-does-not-exist,
and multiple-sources-for-the-same-target. tsgit surfaces refusals as
`TsgitError` with a `data.code` that callers match on.

Two models were considered:

1. **Consolidated** — one `MV_REFUSED` code with a `reason` discriminator
   (mirroring the existing `CONFIG_KEY_INVALID { reason: … }` precedent). Keeps
   the `CommandError` union compact.
2. **Granular** — one distinct code per reason (`MV_DESTINATION_EXISTS`,
   `MV_BAD_SOURCE`, …). Grows the union by seven but lets callers `switch` on a
   single `code` and lets each refusal be matched/handled independently without
   a nested `reason` check.

The design doc recommended (1) for union compactness. The user chose (2).

## Decision

Use granular `CommandError` codes — one per refusal. Most carry `source` and
`destination` (`FilePath`):

- `MV_SOURCE_NOT_TRACKED` — git "not under version control"
- `MV_BAD_SOURCE` — git "bad source"
- `MV_DESTINATION_EXISTS` — git "destination exists"
- `MV_INTO_SELF` — git "can not move directory into itself"
- `MV_DESTINATION_NOT_DIRECTORY` — git "destination 'X' is not a directory"
- `MV_DESTINATION_DIRECTORY_MISSING` — git "destination directory does not exist"
- `MV_MULTIPLE_SOURCES_SAME_TARGET` — git "multiple sources for the same target"
- `MV_OVERLAPPING_SOURCES` — git "cannot move both 'a/b' and its parent directory 'a'" (carries `child`/`parent` instead of `source`/`destination`)

The first four are *per-source* and skippable under `skipErrors` (mapped into
`MvResult.skipped[].reason`); the last three are *structural* and always thrown.

## Consequences

### Positive

- Callers match a single `code` per refusal — no nested `reason` narrowing.
- Each code is independently greppable across the codebase and tests.
- Mutation tests attribute each refusal's literal to its own code arm, making
  StringLiteral mutants easy to kill per reason.

### Negative

- Grows the `CommandError` union and the `extractDetail` message switch by seven
  arms — more surface than the consolidated form.
- Diverges from the `CONFIG_*` consolidation pattern, so the codebase now has
  two conventions for multi-reason error families.

### Neutral

- `MvResult.skipped[].reason` stays a small kebab-case string union
  (`'source-not-tracked' | 'bad-source' | 'destination-exists' | 'into-self'`)
  rather than reusing the SCREAMING_SNAKE codes — result *data* and error
  *codes* keep their own vocabularies, as elsewhere in the codebase.
