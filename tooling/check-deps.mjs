#!/usr/bin/env node
/**
 * Wrapper around `npm outdated --json` that filters known false-positive
 * packages before deciding the exit code. The intent: a real outdated
 * package fails the build, but a publisher-side `v`-prefix bug (e.g.
 * `@ls-lint/ls-lint` 2.3.1 vs v2.3.1 — see project memory
 * `project_ls_lint_outdated_flake.md`) does not.
 *
 * Failure-mode contract: exit 0 when only false positives remain;
 * exit 1 (printing the offenders) when a real upgrade is available.
 */
import { spawn } from 'node:child_process';

const FLAKY_PACKAGES = new Set([
  // Known publisher-side mismatch: package.json pins 2.3.1, registry
  // tagged v2.3.1, `npm outdated` flags them as different strings.
  '@ls-lint/ls-lint',
]);

const result = await new Promise((resolve) => {
  const child = spawn('npm', ['outdated', '--json'], { stdio: ['ignore', 'pipe', 'inherit'] });
  let stdout = '';
  child.stdout.on('data', (chunk) => {
    stdout += chunk.toString();
  });
  child.on('close', (code) => resolve({ stdout, code: code ?? 0 }));
});

// `npm outdated` exits 0 when everything is fresh; non-zero with JSON
// output when at least one package is outdated. Empty stdout = nothing
// outdated.
if (result.stdout.trim() === '') {
  process.exit(0);
}

let parsed;
try {
  parsed = JSON.parse(result.stdout);
} catch (err) {
  console.error('check-deps: failed to parse `npm outdated --json` output');
  console.error(result.stdout);
  process.exit(1);
}

const real = Object.fromEntries(
  Object.entries(parsed).filter(([name, info]) => {
    if (FLAKY_PACKAGES.has(name)) return false;
    // Belt-and-braces: when `current === wanted === latest`, it is the
    // same flake under a different shape; skip.
    return !(info.current === info.wanted && info.wanted === info.latest);
  }),
);

if (Object.keys(real).length === 0) {
  process.exit(0);
}

console.error('Outdated packages:');
console.error(JSON.stringify(real, null, 2));
process.exit(1);
