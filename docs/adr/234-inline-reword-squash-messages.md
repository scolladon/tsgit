# ADR-234: reword/squash messages are supplied inline, not via a message-editing stop

## Status

Accepted (at `2e17819f`)

## Context

`git rebase -i` opens `$EDITOR` a *second* time for each `reword` and `squash`
(to write the new / combined message). `fixup`, `pick`, `edit`, and `drop` never
prompt for a message. With no editor (ADR-233), tsgit can either:

1. **Inline** — carry the message on the instruction (`{ action, oid, message }`);
   the engine never stops for a message.
2. **Stop-to-edit** — `reword`/`squash` stop like `edit` and resume via
   `continue` once the caller supplies the message.

`edit` is inherently a stop (its git semantics are "stop for amending"), so a
stop machine exists regardless. The question is only whether *message* editing
should also be a stop.

## Decision

**Option 1 — inline messages.**

- `reword` **requires** `message` (the new message). A reword with the original
  message is just a `pick`; omitting it is rejected (`INVALID_OPTION`).
- `squash` takes an **optional** `message` (the combined message). When omitted,
  the engine uses git's default: the `# This is a combination of N commits.`
  template reduced by stripping comment lines — byte-equivalent to a user saving
  git's editor buffer unedited.
- `fixup`/`pick`/`edit`/`drop` ignore `message`.

This keeps every reword/squash deterministic and round-trip-free, reserves the
stop machine for `edit` and genuine conflicts only, and matches how the inline
todo (ADR-233) already front-loads all caller intent.

## Consequences

### Positive

- No extra round-trips for the common reword/squash; the whole edit is one call.
- The combined-message default is computed faithfully from git's template, so an
  omitted `squash` message still matches `git rebase -i`.

### Negative

- The caller cannot "see git's proposed combined message, then edit it" in one
  flow — they either accept the default or pass their own. (A future helper could
  expose the proposed template.)

### Neutral

- The message-cleaning logic (`stripspace`/comment-strip of the combination
  template) lives in `domain/rebase/squash-message`, reused by both the explicit
  and defaulted paths and by faithful chain accumulation (ADR-237).
