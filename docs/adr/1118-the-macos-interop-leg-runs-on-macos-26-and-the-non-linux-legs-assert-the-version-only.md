---
subjects:
  - .github/workflows/ci.yml
  - .github/actions/setup-git
---
# 1118 — the macOS interop leg runs on macos-26, and the non-Linux legs assert the version only

- **Status:** accepted
- **Date:** 2026-10-29
- **Design:** docs/design/fsck-pack-entry-crc-git-256.md (CI pin, D-CI2) · **Supersedes/Refines:** refines ADR-1117

## Context

`posix-integration` runs its macOS leg on `macos-latest`, which resolves to macos-15 and ships git
2.55.0; the macos-26 image ships 2.56.0. `win-integration` runs on `windows-latest`, which is
windows-2025 and ships 2.56.0.windows.2. Neither leg installs git today. The runner-images READMEs
on 2026-10-29 are the evidence; the CI part re-verifies them before it edits the matrix.

## Options considered

1. **Move the macOS leg to `macos-26` and assert only; Windows asserts only** — pros: no install
   step on either OS, the image label is the pin and the assert catches image drift / cons: the
   macOS label is pinned to an image generation.
2. **Keep `macos-latest`, `brew install git` then assert; Windows asserts only** — pros: no label
   change / cons: brew's update time on every run, and the formula floats.
3. **Assert only everywhere, keeping `macos-latest`** — pros: smallest change / cons: red on day
   one, because macos-15 ships 2.55.0.

## Decision

**User-ratified: option 1.** The `posix-integration` matrix names `macos-26` instead of
`macos-latest`. On macOS and Windows the setup-git action installs nothing and runs the version
assert alone (ADR-1119).

## Consequences

- A future macOS image bump is a one-line label change, made when its git matches the pin.
- Should a Windows image ever ship a different minor, the assert fails and an install step is
  added then, not speculatively now.
