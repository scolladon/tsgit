---
subjects:
  - .github/actions/setup-git
  - .github/workflows/ci.yml
---
# 1117 — CI installs git from the git-core PPA and asserts 2.56.x on Linux

- **Status:** accepted
- **Date:** 2026-10-29
- **Design:** docs/design/fsck-pack-entry-crc-git-256.md (CI pin, D-CI1) · **Supersedes/Refines:** none

## Context

The interop suites pin tsgit against one git version, and every git-spawning job
(`integration`, `posix-integration`, `win-integration`) runs whatever git the runner image ships.
The last green `main` run used an ubuntu-24.04 image with git 2.55.0; the image's current README
lists 2.56.0, so the next rollout changes the oracle under the suites with no code change, which
is how #311 arose. The git-core PPA for noble publishes exactly one build of the current release
(`1:2.56.0-0ppa1~ubuntu24.04.2` on 2026-10-29) and drops it on republish.

## Options considered

1. **Add the git-core PPA, install its latest git, then assert `2.56.x`** — pros: the PPA is the
   canonical Ubuntu channel; the assert enforces the minor and turns red the day the PPA moves to
   2.57, which is the wanted signal / cons: not deterministic to the patch level.
2. **An exact `apt-get install git=1:2.56.0-0ppa1~ubuntu24.04.2`** — pros: deterministic / cons:
   red for a packaging reason as soon as the PPA republishes the same git.
3. **Build from source at tag v2.56.0, cached on the tag** — pros: independent of any channel /
   cons: a build on every cache miss and more workflow code; the fallback if the PPA moves ahead
   of tsgit.

## Decision

**User-ratified: option 1.** A composite action, `.github/actions/setup-git`, runs right after
`.github/actions/setup` in every git-spawning job. On Linux it adds `ppa:git-core/ppa`, installs
git, then asserts the version (ADR-1119). The expected `major.minor` lives in one place, the
action's `version` input default; jobs do not pass it.

## Consequences

- Bumping the pinned git is one constant plus the re-pinned rows, in one PR.
- When the PPA moves to the next minor before tsgit does, the job fails loudly and option 3 is the
  documented escape.
