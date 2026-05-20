# ADR-057: GitHub Action SHA pinning + Dependabot grouping

## Status

Accepted (at `52809f6`)

## Context

Every workflow in the repo references actions by mutable tag
(`uses: actions/checkout@v4`, `uses: oxsecurity/megalinter@v8`, …). A tag is a
movable pointer: if an action's maintainer account is compromised and the tag
re-pointed, every workflow run silently executes attacker-controlled code with
the run's `GITHUB_TOKEN`. This is not theoretical — the `tj-actions/changed-files`
compromise (2025) did exactly this across thousands of repos.

The Phase 11 security review flagged this as MEDIUM and the backlog deferred
the fix to Phase 16.1 / 16.2. Two questions must be answered:

1. **Scope** — pin only non-GitHub third-party actions, or `actions/*` too?
2. **Refresh** — pinned SHAs go stale (security patches in the action itself
   are missed). The backlog text says "group with `update-strategy:
   lockfile-only`", but `update-strategy` is an **npm-ecosystem-only**
   Dependabot option; the `github-actions` ecosystem does not accept it.

## Decision

**Pin every external action to a 40-char commit SHA, including `actions/*`.**
GitHub's own `actions/checkout@v4` tag is as mutable as any other; a uniform
"all external actions pinned" rule is simpler to audit and reason about than a
GitHub-vs-third-party split, and it costs nothing extra. The repo-local
composite action `./.github/actions/setup` is not a tag reference and is left
as-is.

Each pin carries a trailing `# <version>` comment:

```yaml
- uses: actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5 # v4.3.1
```

**Keep the pins fresh with a Dependabot `groups:` block, not
`update-strategy`.** The existing `github-actions` ecosystem entry gains:

```yaml
    groups:
      github-actions:
        patterns: ["*"]
```

All action updates then arrive as one weekly PR (Dependabot rewrites both the
SHA and the `# version` comment). This delivers the backlog's intent — a
single low-noise refresh PR — using the option that the `github-actions`
ecosystem actually supports.

## Consequences

### Positive

- A moved/compromised tag can no longer alter what a workflow run executes —
  the SHA is content-addressed and immutable.
- Uniform rule (every external action pinned) is trivial to audit:
  `grep -rhE 'uses: [^.]' .github | grep -vE '@[0-9a-f]{40}'` must be empty.
- Dependabot still tracks upstream releases via the `# version` comment, so
  pinning does not freeze the repo on stale, unpatched action code.
- Action updates land as one grouped PR per week instead of ~10 separate PRs.

### Negative

- A grouped Dependabot PR bundles unrelated action bumps; a single bad bump
  blocks the whole group until split or skipped. Acceptable — the alternative
  (ungrouped) trades that for ~10× the PR noise.
- Pinned SHAs are opaque; the `# version` comment is the only human-readable
  cue, and it is only as accurate as Dependabot's last rewrite.

### Neutral

- Functionally a no-op at pin time: each SHA is the current tip of the tag it
  replaces, so the workflows run identical action code.
- Nothing *enforces* future pins — a new `uses: foo@v1` could be added
  unpinned. A CI lint rule for that is a noted Phase 16 follow-up.

## Alternatives considered

- **Pin only non-GitHub actions, trust `actions/*` tags** — rejected: GitHub
  org tags are mutable too, and a split rule is harder to audit than "all
  pinned".
- **`update-strategy: lockfile-only`** (the backlog's wording) — rejected: not
  a valid option for the `github-actions` ecosystem; it is npm-only.
- **No Dependabot refresh, pin and forget** — rejected: pinned SHAs would
  silently miss security fixes shipped in the actions themselves.
- **A CI step that enforces SHA pins** — deferred: 16.1/16.2 establish the
  pinned state and the refresh loop; enforcement is a separate follow-up.
