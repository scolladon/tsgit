/**
 * Regression tripwire for the interop spawn env. Proves that `git` spawned
 * through the shared helper reads NO ambient config across all three vectors
 * the helper closes — the developer's global `~/.gitconfig`, system config,
 * and the XDG config root.
 *
 * Each vector is guarded independently so dropping any one of the helper's
 * isolation keys (`HOME`, `GIT_CONFIG_NOSYSTEM`, `XDG_CONFIG_HOME`) trips a
 * test. Behaviour probes assert ABSENCE, never a specific leaked value (a
 * leaked value only ever passes on one author's machine); the system probe
 * injects its own config so it proves the closure on any machine, not only
 * one that happens to carry an ambient system setting.
 */
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GIT_AVAILABLE, runGitEnv, tryRunGit } from './interop-helpers.js';

describe.skipIf(!GIT_AVAILABLE)('interop-env-hardening', () => {
  describe('Given the hardened interop spawn env', () => {
    describe('When git probes a key a developer commonly sets in global config', () => {
      it('Then no value resolves (the global ~/.gitconfig is not read)', () => {
        // Arrange
        const sut = tryRunGit;

        // Act
        const result = sut(['config', '--get', 'merge.conflictStyle']);

        // Assert
        expect(result.ok).toBe(false);
        expect(result.stdout).toBe('');
      });
    });

    describe('When a system config carrying a sentinel is injected via GIT_CONFIG_SYSTEM', () => {
      let systemConfig: string;
      let systemConfigDir: string;

      beforeAll(async () => {
        systemConfigDir = await mkdtemp(path.join(os.tmpdir(), 'tsgit-interop-env-sys-'));
        systemConfig = path.join(systemConfigDir, 'config');
        await writeFile(systemConfig, '[credential]\n\thelper = sentinel-should-not-be-read\n');
      });

      afterAll(async () => {
        await rm(systemConfigDir, { recursive: true, force: true });
      });

      it('Then GIT_CONFIG_NOSYSTEM keeps it unread (system vector closed)', () => {
        // Arrange
        const sut = tryRunGit;

        // Act
        const result = sut(['config', '--get', 'credential.helper'], {
          env: { ...runGitEnv(), GIT_CONFIG_SYSTEM: systemConfig },
        });

        // Assert
        expect(result.ok).toBe(false);
        expect(result.stdout).toBe('');
      });
    });

    describe('When inspecting the spawn env HOME', () => {
      it('Then it points at a non-existent path under the tmp dir (global vector closed)', () => {
        // Arrange
        const sut = runGitEnv;

        // Act
        const home = sut().HOME;

        // Assert
        expect(home).toBeDefined();
        expect(home?.startsWith(os.tmpdir())).toBe(true);
        expect(existsSync(home as string)).toBe(false);
      });
    });

    describe('When inspecting the spawn env XDG config root', () => {
      it('Then it is redirected under the isolated HOME (XDG vector closed)', () => {
        // Arrange
        const sut = runGitEnv;

        // Act
        const env = sut();

        // Assert
        expect(env.XDG_CONFIG_HOME).toBe(path.join(env.HOME as string, '.config'));
      });
    });
  });
});
