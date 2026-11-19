---
subjects:
  - src/application/commands/mv.ts
---
# 1226 — mv refuses a destination beyond a symbolic link as git does

- **Status:** accepted
- **Date:** 2026-11-19
- **Design:** docs/design/mv-directory-one-rename.md · **Supersedes/Refines:** applies ADR-226 and DOCTRINE D-4

## Context

With a tracked symlink `lnk -> .git`, tsgit `mv(['dir'], 'lnk/hooks/x')` moves the directory into
`.git/hooks/x` and records `lnk/hooks/x/f`. git 2.56.0 checks every destination entry for a
symbolic link in a leading component and refuses: `fatal: destination is beyond a symbolic link,
source=dir/f, destination=lnk/hooks/x/f`, exit 128, nothing changed. Under `-k` (pinned 2/2) git
skips each refused entry, so a file source moves nothing, but a directory source is still renamed
through the link (`.git/hooks/<name>` receives it) while its members' index entries stay under the
source.

## Options considered

1. Skip the whole pair under `skipErrors` and write nothing — a divergence that never writes
   through the link.
2. **Copy git exactly**: refuse without `skipErrors`; under it, skip each refused member in the
   index and still rename the directory itself through the link.
3. Refuse even under `skipErrors`.

## Decision

Option 2, ratified by the user against the session's recommendation (option 1), under DOCTRINE D-4,
after being shown that git's `-k` arm writes into the repository's administrative directory.

## Consequences

Without `skipErrors`, the refusal is a new `MV_DESTINATION_BEYOND_SYMLINK { source, destination }`
naming the member's source and destination, raised at planning before anything moves
(adopted-as-recommended — ADR-202's granular `MV_*` family; the existing `PATHSPEC_BEYOND_SYMLINK`
carries only `path`). Under `skipErrors`, a directory source whose destination lies beyond a
symbolic link is renamed as git renames it, and its members stay in the index under the source; the
work tree then lacks them, as git's does. `skipped` holds one
`{ source: <member>, reason: 'destination-beyond-symlink' }` per member, git's granularity, and the
renamed directory appears in neither `moved` nor `skipped` (adopted-as-recommended — ADR-1223, no
trade-off).
