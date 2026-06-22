# 407 — driver execution: separate resolvers over one CommandRunner port extended for stdin/stdout

- **Status:** accepted
- **Date:** 2026-06-22
- **Design:** docs/design/lfs-filter-driver-port.md · **Relates:** ADR-304 (CommandRunner / merge-driver), ADR-302 (attribute resolution), ADR-406 (v1 scope)
- **Decision class:** D-EXEC user-ratified; D-PORTBOUND adopted-as-recommended

## Context

textconv and clean/smudge communicate over **stdio** — textconv: git writes the blob to a
temp file, passes its path as `argv[1]`, reads **stdout**; clean/smudge: content on **stdin**,
result on **stdout** (pinned T-EXEC and §3.4). The existing `CommandRunner.run` surfaces only
`exitCode` because a merge driver writes its output to a file (`%A`, in-place). Two coupled
choices: how many resolvers/ports model the two mechanisms (D-PORTBOUND), and how the driver's
stdin/stdout is bridged (D-EXEC).

## Options considered

**D-PORTBOUND:** (a) separate textconv and filter resolvers/primitives sharing one
`CommandRunner`; (b) one combined "content driver" port; (c) fold into the merge-driver primitive.

**D-EXEC:** (a) extend `CommandRunner` with optional stdin input + stdout capture; (b) file-based
orchestration in a new primitive (temp files + shell redirect), port unchanged; (c) a new
dedicated `FilterRunner` port.

## Decision

- **D-PORTBOUND (adopted):** **separate** textconv (`diff=`) and filter (`clean/smudge`)
  resolvers/primitives, each mirroring `resolve-merge-driver`, both sharing the **one**
  `CommandRunner` port. The two are genuinely different git mechanisms (read-side/both-sides/
  stdout vs write-side/paired/stdin→stdout) — one abstraction would leak both shapes; folding
  into the merge driver (three-way, in-place `%A`) is the wrong shape.
- **D-EXEC (user-ratified):** **extend the `CommandRunner` port** — `run` accepts optional
  `stdin?: Uint8Array`; `CommandResult` gains optional captured `stdout?: Uint8Array`;
  `NodeCommandRunner` captures stdout (instead of `stdio:'ignore'`). The merge-driver caller is
  unaffected (it keeps reading its `%A` output file and ignoring stdout). One port carries two
  output conventions, selected by the caller. Chosen over the file-based primitive because it is
  closer to git's own mechanism and the cleanest fit now that clean/smudge (stdin→stdout) ships
  in v1 (ADR-406).

## Consequences

- A single, additive `CommandRunner` port change (optional stdin + optional stdout capture) +
  the `NodeCommandRunner` binding; no new port. The merge-driver path is byte-unchanged.
- Both the textconv and filter orchestration primitives consume the extended port; the
  memory/browser binding is ADR-408.
- The contract delta (stdin/stdout vs merge's in-place `%A`) is documented so reviewers do not
  mistake the dual output convention for a leak.
