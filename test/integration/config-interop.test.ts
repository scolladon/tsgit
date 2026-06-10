/**
 * Cross-tool interop — git-config readback. tsgit's `updateConfigEntries`
 * writes `.git/config` text; canonical `git config --list -z` parses it
 * and surfaces the key/value pairs. The write-parity group additionally
 * compares raw bytes — tsgit's written entry must be byte-identical to
 * git's for every special-character value in the matrix.
 *
 * @proves
 *   surface:        config
 *   bucket:         cross-tool-interop
 *   unique:         .git/config readable by git config --list with matching keys; quoted-value bytes + refusal
 *   interopSurface: config
 */
import { readFile, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createNodeContext } from '../../src/adapters/node/node-adapter.js';
import { readConfig } from '../../src/application/primitives/config-read.js';
import { getConfigValue } from '../../src/application/primitives/config-scoped-read.js';
import {
  setConfigEntry,
  updateConfigEntries,
} from '../../src/application/primitives/update-config.js';
import { TsgitError } from '../../src/domain/error.js';
import {
  GIT_AVAILABLE,
  initBothRepos,
  makePeerPair,
  type PeerPair,
  runGit,
  tryRunGit,
} from './interop-helpers.js';

const parseGitConfigList = (raw: string): ReadonlyMap<string, ReadonlyArray<string>> => {
  // `git config --list -z` emits NUL-terminated entries, each newline-
  // separated into "<key>\n<value>". The final entry has no trailing NUL
  // in some git versions, so we filter empties.
  const out = new Map<string, string[]>();
  for (const entry of raw.split('\0').filter((s) => s.length > 0)) {
    const nl = entry.indexOf('\n');
    if (nl === -1) continue;
    const key = entry.slice(0, nl);
    const value = entry.slice(nl + 1);
    const existing = out.get(key);
    if (existing === undefined) out.set(key, [value]);
    else existing.push(value);
  }
  return out;
};

/**
 * Extract the text that starts at the `[test]` section header in a git
 * config file — i.e., everything from `[test]` onward. This lets the
 * byte comparison ignore the differing `[core]` preambles produced by
 * tsgit and canonical git while still being byte-exact for the entry.
 */
const extractTestSection = (content: string): string => {
  const idx = content.indexOf('[test]');
  if (idx === -1) return '';
  return content.slice(idx);
};

describe.skipIf(!GIT_AVAILABLE)('config interop', () => {
  let pair: PeerPair;

  beforeEach(async () => {
    pair = await makePeerPair('config');
    initBothRepos(pair.peer, pair.ours);
  });

  afterEach(async () => {
    await pair.dispose();
  });

  describe('Given several config entries (single + multi-value)', () => {
    describe('When tsgit writes the config and canonical git reads it back', () => {
      it('Then git config --list surfaces every key with the expected value(s)', async () => {
        // Arrange
        const sut = createNodeContext({ workDir: pair.ours });

        // Act
        await updateConfigEntries(sut, [
          { section: 'user', key: 'name', value: 'Ada' },
          { section: 'user', key: 'email', value: 'ada@example.com' },
          { section: 'core', key: 'repositoryformatversion', value: '0' },
        ]);

        // Assert — readback agrees on every key
        // `--local` scopes readback to .git/config; otherwise the user's
        // global config bleeds into the result on developer machines.
        const raw = runGit(['-C', pair.ours, 'config', '--local', '--list', '-z']);
        const parsed = parseGitConfigList(raw);
        expect(parsed.get('user.name')).toEqual(['Ada']);
        expect(parsed.get('user.email')).toEqual(['ada@example.com']);
        expect(parsed.get('core.repositoryformatversion')).toEqual(['0']);
      });
    });
  });

  // Values that exercise every branch of git's write_pair grammar:
  // ';', '#', leading space, trailing space, '"', '\', LF, TAB, CR, \x01, combo.
  const WRITE_PARITY_MATRIX: ReadonlyArray<{ label: string; value: string }> = [
    { label: 'semicolon', value: 'a;b' },
    { label: 'hash', value: 'a#b' },
    { label: 'leading space', value: ' a' },
    { label: 'trailing space', value: 'a ' },
    { label: 'double-quote', value: 'a"b' },
    { label: 'backslash', value: 'a\\b' },
    { label: 'LF', value: 'a\nb' },
    { label: 'TAB', value: 'a\tb' },
    { label: 'CR', value: 'a\rb' },
    { label: 'x01', value: 'a\x01b' },
    { label: 'combo (;, space-edges, quote, backslash)', value: 'a; b"c\\d ' },
  ];

  describe('Given a special-character value from the write_pair matrix', () => {
    describe('When tsgit and canonical git each write test.v into their own repo', () => {
      it.each(
        WRITE_PARITY_MATRIX,
      )('Then the [test] section bytes are identical for value "$label"', async ({ value }) => {
        // Arrange
        const ctx = createNodeContext({ workDir: pair.ours });

        // Act
        await setConfigEntry({ ctx, key: 'test.v', value });
        runGit(['-C', pair.peer, 'config', '--local', 'test.v', value]);

        // Assert — byte-identical [test] section in both repos
        const oursConfig = await readFile(path.join(pair.ours, '.git', 'config'), 'utf8');
        const peerConfig = await readFile(path.join(pair.peer, '.git', 'config'), 'utf8');
        expect(extractTestSection(oursConfig)).toBe(extractTestSection(peerConfig));

        // Assert — git reads tsgit's written file back to the original value
        const readback = runGit(['-C', pair.ours, 'config', '--local', '--get', 'test.v']);
        expect(readback).toBe(`${value}\n`);
      });
    });
  });

  describe('Given a hand-written exotic config in a fresh repo', () => {
    describe('When both tsgit and git read each key', () => {
      it('Then getConfigValue matches git config --get byte-for-byte per key', async () => {
        // Arrange — write an exotic config covering quote toggling, backspace escape,
        // continuation with preserved leading ws, escaped-backslash-at-EOL, CRLF, VT.
        // VT = \x0b; CRLF uses \r\n in the raw string.
        const configContent = `${[
          '[core]',
          '\trepositoryformatversion = 0',
          '[test]',
          '\tv1 = a" b "c',
          '\tv2 = a\\"b',
          '\tv3 = a\\bb',
          '\tv4 = a\\',
          '   b',
          '\tv5 = a\\\\',
          '\tv6 = ab\r',
          '\tv7 = a\x0b',
        ].join('\n')}\n`;

        await writeFile(path.join(pair.ours, '.git', 'config'), configContent, 'utf8');

        // Act + Assert — per key, tsgit value equals git value (strip one trailing LF from git)
        const keys = ['test.v1', 'test.v2', 'test.v3', 'test.v4', 'test.v5', 'test.v6', 'test.v7'];
        for (const key of keys) {
          const ctx = createNodeContext({ workDir: pair.ours });
          const gitResult = tryRunGit(['-C', pair.ours, 'config', '--local', '--get', key]);
          expect(gitResult.ok, `git rejected key ${key}: ${gitResult.stderr}`).toBe(true);
          // Strip exactly one trailing LF (git appends it); do NOT trim other whitespace.
          const gitValue = gitResult.stdout.endsWith('\n')
            ? gitResult.stdout.slice(0, -1)
            : gitResult.stdout;

          const tsgitResult = await getConfigValue({ ctx, key, scope: 'local' });
          expect(tsgitResult.value, `tsgit value for ${key}`).toBe(gitValue);
        }
      });
    });
  });

  describe('Given a config file with a malformed value line', () => {
    describe('When git and tsgit parse the file', () => {
      it('Then both refuse with the same physical line number for an unknown escape', async () => {
        // Arrange — line 1: [core], line 2: \trepositoryformatversion = 0,
        // line 3: [test], line 4: \tv = a\xb  (unknown escape → bad config line 4)
        const configContent = '[core]\n\trepositoryformatversion = 0\n[test]\n\tv = a\\xb\n';
        await writeFile(path.join(pair.ours, '.git', 'config'), configContent, 'utf8');

        // Act — canonical git
        const gitResult = tryRunGit(['-C', pair.ours, 'config', '--local', '--get', 'test.v']);

        // Assert — git exits non-zero with bad config line N
        expect(gitResult.ok).toBe(false);
        const lineMatch = /bad config line (\d+)/i.exec(gitResult.stderr);
        expect(lineMatch, `expected 'bad config line N' in: ${gitResult.stderr}`).not.toBeNull();
        const gitLine = Number((lineMatch as RegExpExecArray)[1]);

        // Act — tsgit (fresh context to bypass cache)
        const ctx = createNodeContext({ workDir: pair.ours });
        let tsgitError: TsgitError | undefined;
        try {
          await readConfig(ctx);
        } catch (err) {
          if (err instanceof TsgitError) tsgitError = err;
          else throw err;
        }

        // Assert — tsgit throws CONFIG_PARSE_ERROR with the same line number
        expect(tsgitError, 'expected tsgit to throw TsgitError').not.toBeUndefined();
        const data = (tsgitError as TsgitError).data;
        expect(data.code).toBe('CONFIG_PARSE_ERROR');
        if (data.code === 'CONFIG_PARSE_ERROR') {
          expect(data.line).toBe(gitLine);
        }
      });

      it('Then both refuse with the same physical line number for an unclosed quote', async () => {
        // Arrange — line 1: [core], line 2: \trepositoryformatversion = 0,
        // line 3: [test], line 4: \tv = "a  (unclosed quote → bad config line 4)
        const configContent = '[core]\n\trepositoryformatversion = 0\n[test]\n\tv = "a\n';
        await writeFile(path.join(pair.ours, '.git', 'config'), configContent, 'utf8');

        // Act — canonical git
        const gitResult = tryRunGit(['-C', pair.ours, 'config', '--local', '--get', 'test.v']);

        // Assert — git exits non-zero with bad config line N
        expect(gitResult.ok).toBe(false);
        const lineMatch = /bad config line (\d+)/i.exec(gitResult.stderr);
        expect(lineMatch, `expected 'bad config line N' in: ${gitResult.stderr}`).not.toBeNull();
        const gitLine = Number((lineMatch as RegExpExecArray)[1]);

        // Act — tsgit (fresh context to bypass cache)
        const ctx = createNodeContext({ workDir: pair.ours });
        let tsgitError: TsgitError | undefined;
        try {
          await readConfig(ctx);
        } catch (err) {
          if (err instanceof TsgitError) tsgitError = err;
          else throw err;
        }

        // Assert — tsgit throws CONFIG_PARSE_ERROR with the same line number
        expect(tsgitError, 'expected tsgit to throw TsgitError').not.toBeUndefined();
        const data = (tsgitError as TsgitError).data;
        expect(data.code).toBe('CONFIG_PARSE_ERROR');
        if (data.code === 'CONFIG_PARSE_ERROR') {
          expect(data.line).toBe(gitLine);
        }
      });
    });
  });
});
