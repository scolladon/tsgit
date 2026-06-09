# ADR-302: `.gitattributes` parsing and attribute resolution

## Status

Accepted (at `e9a15c7d`)

## Context

Custom merge drivers select a driver per path via the `merge` attribute in
`.gitattributes`. `.gitattributes` parsing is net-new — only `.gitignore` exists today
(14.3). We must decide how much of git's attribute system to build now, since the merge
feature only consumes a single attribute (`merge`) but the parsing/resolution substrate is
reusable by future features (diff drivers, `clean`/`smudge` filters, `text`/`eol`).

Git resolves an attribute by consulting several files in precedence order (highest first):
`$GIT_DIR/info/attributes`, then `.gitattributes` from the path's directory up to the
worktree root (closer = higher), then global `core.attributesFile`, then system-wide
`$(prefix)/etc/gitattributes`, then built-in macros. Within a file the **last** matching
line wins for a given attribute; the first source that assigns it wins overall. Git also
supports **macros** (`[attr]<name> <attrs...>`), of which `binary = -diff -merge -text` is
built in — so the ubiquitous `*.bin binary` line turns merging *off* for those paths.

Patterns use `.gitignore` glob syntax (fnmatch, leading-`/` anchor, `**`, trailing-`/`
dir-only) **except negation (`!`) is forbidden**. Attribute tokens take four forms: `name`
(set→true), `-name` (unset→false), `!name` (unspecified), `name=value` (string).

## Decision

Parse and resolve attributes with a model that **mirrors the existing `.gitignore` (14.3)
source model** and reuses `domain/pathspec` `compileGlob` for pattern matching.

**Sources honoured (highest→lowest precedence):**
1. `$GIT_DIR/info/attributes`
2. worktree `.gitattributes` — path's directory, then each parent up to the root
3. global `core.attributesFile` (`~`-expanded via `layout.homeDir`, like `core.excludesFile`)
4. built-in macros

Merge reads from the **worktree** (the checked-out `.gitattributes`), matching git and the
`read-gitignore` infrastructure.

**Macros:** the built-in `binary` macro is auto-registered; user `[attr]` macro definitions
are honoured. Macro expansion feeds attribute resolution so `*.bin binary` faithfully
resolves `merge` to unset.

**Storage:** the parser stores **all** attribute tokens generically (`Map<name,
AttributeValue>` per rule, `AttributeValue = true | false | 'unspecified' | { set: string }`)
so future attributes extend without a re-parse — but **this feature reads only `merge`**.

**System-wide `/etc/gitattributes` is NOT supported** — tsgit has no system-config layer
anywhere (no system `config`, no system `gitignore`); adding one only here would be out of
step. Parked as a backlog follow-up if community traction warrants it.

## Consequences

### Positive

- Faithful resolution for the realistic source set, including the `binary` macro that the
  most common attributes line depends on.
- One pattern engine shared with `.gitignore`; one source model the team already knows.
- Generic storage makes diff-driver / filter / `text` follow-ups cheap (parse once, add a
  consumer).

### Negative

- More than the merge feature strictly needs (4 sources + macros vs. worktree-only).
- System-wide attributes silently absent — a divergence from git on hosts that set one
  (documented; parked).

### Neutral

- Resolution returns a 4-way `AttributeValue`; only `merge` is mapped to a driver today.
