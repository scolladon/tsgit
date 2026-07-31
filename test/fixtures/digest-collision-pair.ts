/**
 * Two DISTINCT 144-byte lines that collide on the line digest: same length,
 * same terminator flag, and the same folded hash. Built by a Joux-style
 * multicollision over the narrow FNV lanes — the whole point is that a drop
 * verdict must NOT rest on digest evidence, so this pair is the adversary the
 * exact confirmation exists to defeat.
 *
 * Properties the callers rely on: both are plain `[0-9A-Za-z]` (no NUL, so
 * neither side sniffs binary; no LF, so each is exactly one line; no
 * space/tab/CR, so every `WhitespaceMode` normalizes them to their own raw
 * bytes and the collision survives every mode).
 *
 * Not regenerated, not randomised: a found collision is a fixed artefact, and
 * pinning these exact bytes is what makes the regression test reproducible.
 */
export const DIGEST_COLLISION_LINE_A =
  'Pcn0pwbyrupuhcT81A7q5u1Q3QH2jKh8duLAb8DczyBUryt2BsFwfe9AROxGZ4Z6JG50Tk1GJAHUxyPc9oZGdUBSZcvCR456Fyl2jU1knWjYN0JeTiHYf8NqdSlw1e3i7Q9wpEBEdiDkP4rM';

export const DIGEST_COLLISION_LINE_B =
  'Pcn0pwbyhiJqpO3a1A7q5u1Q9wLEpwNc3mzcdGTwzyBUryt2BsFwfe9AROxGZ4Z6JG50Tk1Gls7Ez8JO9oZGdUBSZcvCR456vE1EryT0VK9AFWPULmr6jYjAdSlw1e3iPU7U3ktIdiDkP4rM';
