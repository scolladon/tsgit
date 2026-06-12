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
import {
  configGetRegexp,
  configList,
  configRemoveSection,
  configRenameSection as configRenameSectionCmd,
  configSet,
  configUnset,
  configUnsetAll,
} from '../../src/application/commands/config.js';
import { remoteAdd } from '../../src/application/commands/remote.js';
import { readConfig } from '../../src/application/primitives/config-read.js';
import { getConfigValue } from '../../src/application/primitives/config-scoped-read.js';
import {
  type ConfigOperation,
  renameConfigSection,
  setConfigEntry,
  unsetConfigEntry,
  updateConfigEntries,
  updateConfigOperations,
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

/**
 * Extract the text that starts at the first `[test ` (with a space, i.e.
 * a subsectioned `[test "..."]` header) in a git config file. Used by the
 * subsection write-parity matrix to ignore the differing preambles while
 * still being byte-exact for the subsectioned section.
 */
const extractSubsectionedTestSection = (content: string): string => {
  const idx = content.indexOf('[test "');
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

  const SUBSECTION_WRITE_MATRIX: ReadonlyArray<{
    label: string;
    subsection: string;
  }> = [
    { label: 'double-quote', subsection: 'a"b' },
    { label: 'backslash', subsection: 'a\\b' },
    { label: 'bracket', subsection: 'a]b' },
    { label: 'hash', subsection: 'a#b' },
    { label: 'space', subsection: 'a b' },
    { label: 'CR', subsection: 'a\rb' },
    { label: 'combo (quote, backslash, bracket)', subsection: 'a"b\\c]d' },
  ];

  describe('Given a subsection name from the write-parity matrix', () => {
    describe('When tsgit and canonical git each write test.<sub>.v into their own repo', () => {
      it.each(
        SUBSECTION_WRITE_MATRIX,
      )('Then the [test "..."] section bytes are identical for subsection "$label"', async ({
        subsection,
      }) => {
        // Arrange
        const ctx = createNodeContext({ workDir: pair.ours });

        // Act — tsgit writes via updateConfigEntries (section/subsection split
        // avoids parseConfigKey rejection of dots/special chars in the key string)
        await updateConfigEntries(ctx, [{ section: 'test', subsection, key: 'v', value: 'v' }]);

        // Act — canonical git writes to its own repo
        runGit(['-C', pair.peer, 'config', '--local', `test.${subsection}.v`, 'v']);

        // Assert — byte-identical [test "..."] section in both repos
        const { oursConfig, peerConfig } = await readTwinConfigs(pair);
        expect(extractSubsectionedTestSection(oursConfig)).toBe(
          extractSubsectionedTestSection(peerConfig),
        );

        // Assert — git reads tsgit's written file back to the expected value
        const getKey = `test.${subsection}.v`;
        const readback = runGit(['-C', pair.ours, 'config', '--local', '--get', getKey]);
        expect(readback).toBe('v\n');
      });
    });
  });

  // Hand-written configs for read parity: each has a single subsectioned
  // [test "..."] header followed by `k = v`. The subsection names exercise
  // different decode paths: \t → t (no named escapes), \" → ", literal ].
  const SUBSECTION_READ_MATRIX: ReadonlyArray<{
    label: string;
    // Raw bytes for the header line (placed in the config file as-is)
    headerLine: string;
    // The subsection as decoded by git (used as the middle segment of the key)
    decodedSubsection: string;
  }> = [
    {
      label: 'backslash-t decoded to t (no named escapes)',
      headerLine: '[test "a\\tb"]',
      decodedSubsection: 'atb',
    },
    {
      label: 'escaped double-quote decoded to "',
      headerLine: '[test "a\\"b"]',
      decodedSubsection: 'a"b',
    },
    {
      label: 'literal bracket inside quotes',
      headerLine: '[test "a]b"]',
      decodedSubsection: 'a]b',
    },
  ];

  describe('Given a hand-written config with an exotic subsection header', () => {
    describe('When both tsgit and git read each key', () => {
      it.each(
        SUBSECTION_READ_MATRIX,
      )('Then getConfigValue matches git config --get for subsection "$label"', async ({
        headerLine,
        decodedSubsection,
      }) => {
        // Arrange — place the config with the exotic header in ours
        const configContent = `[core]\n\trepositoryformatversion = 0\n${headerLine}\n\tk = v\n`;
        await writeFile(path.join(pair.ours, '.git', 'config'), configContent, 'utf8');
        const getKey = `test.${decodedSubsection}.k`;

        // Act — canonical git
        const gitResult = tryRunGit(['-C', pair.ours, 'config', '--local', '--get', getKey]);
        expect(gitResult.ok, `git rejected key ${getKey}: ${gitResult.stderr}`).toBe(true);
        const gitValue = gitResult.stdout.endsWith('\n')
          ? gitResult.stdout.slice(0, -1)
          : gitResult.stdout;

        // Act — tsgit (fresh context to bypass cache)
        const ctx = createNodeContext({ workDir: pair.ours });
        const sut = await getConfigValue({ ctx, key: getKey, scope: 'local' });

        // Assert
        expect(sut.value, `tsgit value for ${getKey}`).toBe(gitValue);
      });
    });
  });

  // Malformed header forms that git refuses on read with "bad config line N".
  // Each config is: line 1 = [core], line 2 = \trepositoryformatversion = 0,
  // line 3 = <malformed header> — so the expected line number is always 3.
  const MALFORMED_HEADER_READ_MATRIX: ReadonlyArray<{
    label: string;
    configContent: string;
  }> = [
    {
      label: '[s "a" x] — trailing garbage after closing quote',
      configContent: '[core]\n\trepositoryformatversion = 0\n[s "a" x]\n\tk = v\n',
    },
    {
      label: '[s "a" ] — space before closing bracket',
      configContent: '[core]\n\trepositoryformatversion = 0\n[s "a" ]\n\tk = v\n',
    },
    {
      label: '[s"a"] — no space before opening quote',
      configContent: '[core]\n\trepositoryformatversion = 0\n[s"a"]\n\tk = v\n',
    },
    {
      label: '[s "a — unclosed quote',
      configContent: '[core]\n\trepositoryformatversion = 0\n[s "a\n\tk = v\n',
    },
    {
      label: '[s "ab\\ — backslash at end of line',
      configContent: '[core]\n\trepositoryformatversion = 0\n[s "ab\\\n\tk = v\n',
    },
  ];

  describe('Given a config file with a malformed subsection header', () => {
    describe('When git and tsgit parse the file', () => {
      it.each(
        MALFORMED_HEADER_READ_MATRIX,
      )('Then both refuse with the same physical line number for "$label"', async ({
        configContent,
      }) => {
        // Arrange — place the malformed config in ours
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

  // Write-refusal parity: git config --file (not --local) is used because the
  // --local path reads all config layers and surfaces "bad config line N" before
  // the write machinery runs; --file on a standalone config file hits git's
  // "invalid section name '<partial>'" write refusal directly (exit 3).
  const WRITE_REFUSAL_BAD_HEADER_MATRIX: ReadonlyArray<{
    label: string;
    configContent: string;
    // The partial section name git reports in "invalid section name '<partial>'"
    expectedPartial: string;
  }> = [
    {
      label: '[s "a" x] — trailing garbage',
      configContent: '[s "a" x]\n\tk = val\n',
      expectedPartial: 's.a',
    },
    {
      label: '[s "a] — unclosed quote',
      configContent: '[s "a]\n\tk = val\n',
      expectedPartial: 's.a]',
    },
  ];

  describe('Given a standalone config file with a malformed subsection header', () => {
    describe('When git config --file and tsgit setConfigEntry try to write', () => {
      it.each(
        WRITE_REFUSAL_BAD_HEADER_MATRIX,
      )('Then both refuse with the same partial section name for "$label"', async ({
        configContent,
        expectedPartial,
      }) => {
        // Arrange — write the malformed config into ours .git/config
        const oursConfigPath = path.join(pair.ours, '.git', 'config');
        await writeFile(oursConfigPath, configContent, 'utf8');

        // Act — canonical git via --file (avoids --local stack-parse masking)
        const gitResult = tryRunGit(['config', '--file', oursConfigPath, 'x.y', 'z']);

        // Assert — git exits non-zero with "invalid section name '<partial>'"
        expect(gitResult.ok).toBe(false);
        const partialMatch = /invalid section name '([^']+)'/i.exec(gitResult.stderr);
        expect(
          partialMatch,
          `expected 'invalid section name ...' in: ${gitResult.stderr}`,
        ).not.toBeNull();
        const gitPartial = (partialMatch as RegExpExecArray)[1];
        expect(gitPartial).toBe(expectedPartial);

        // Act — tsgit (fresh context); place same config bytes into ours
        await writeFile(oursConfigPath, configContent, 'utf8');
        const ctx = createNodeContext({ workDir: pair.ours });
        let tsgitError: TsgitError | undefined;
        try {
          await setConfigEntry({ ctx, key: 'x.y', value: 'z' });
        } catch (err) {
          if (err instanceof TsgitError) tsgitError = err;
          else throw err;
        }

        // Assert — tsgit throws CONFIG_INVALID_FILE with matching sectionName
        expect(tsgitError, 'expected tsgit to throw TsgitError').not.toBeUndefined();
        const data = (tsgitError as TsgitError).data;
        expect(data.code).toBe('CONFIG_INVALID_FILE');
        if (data.code === 'CONFIG_INVALID_FILE') {
          expect(data.sectionName).toBe(gitPartial);
        }
      });

      it('Then both refuse with the same line number when the file has a bad value', async () => {
        // Arrange — bad value line: line 1 = [core], line 2 = \tv = a\xb (unknown escape)
        const configContent = '[core]\n\tv = a\\xb\n';
        const oursConfigPath = path.join(pair.ours, '.git', 'config');
        await writeFile(oursConfigPath, configContent, 'utf8');

        // Act — canonical git via --file
        const gitResult = tryRunGit(['config', '--file', oursConfigPath, 'x.y', 'z']);

        // Assert — git exits non-zero with bad config line N
        expect(gitResult.ok).toBe(false);
        const lineMatch = /bad config line (\d+)/i.exec(gitResult.stderr);
        expect(lineMatch, `expected 'bad config line N' in: ${gitResult.stderr}`).not.toBeNull();
        const gitLine = Number((lineMatch as RegExpExecArray)[1]);

        // Act — tsgit (fresh context; same config bytes)
        await writeFile(oursConfigPath, configContent, 'utf8');
        const ctx = createNodeContext({ workDir: pair.ours });
        let tsgitError: TsgitError | undefined;
        try {
          await setConfigEntry({ ctx, key: 'x.y', value: 'z' });
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

  describe('Given a config file with a malformed header plus a well-formed section', () => {
    // The starting bytes: a malformed [s "a" x] block and a well-formed [t "x"] block.
    // git config --file is used because git config --local reads all config layers and
    // hits "bad config line N" before the rename machinery can run.
    const startingConfigBytes = '[s "a" x]\n\tw = bad\n[t "x"]\n\tq = 1\n';

    describe('When git config --file and tsgit renameConfigSection rename t.x to t.y', () => {
      it('Then both succeed and produce byte-identical configs', async () => {
        // Arrange — write the same starting bytes into both repos
        const { peerConfigPath } = await seedTwinConfigs(pair, startingConfigBytes);

        // Act — canonical git (--file is lenient on malformed headers; --local is not)
        const gitResult = tryRunGit([
          'config',
          '--file',
          peerConfigPath,
          '--rename-section',
          't.x',
          't.y',
        ]);
        expect(gitResult.ok, `git rename-section failed: ${gitResult.stderr}`).toBe(true);

        // Act — tsgit (writes ours config)
        const ctx = createNodeContext({ workDir: pair.ours });
        await renameConfigSection({ ctx, oldName: 't.x', newName: 't.y' });

        // Assert — byte-identical resulting configs
        const { oursConfig, peerConfig } = await readTwinConfigs(pair);
        expect(oursConfig).toBe(peerConfig);
      });

      it('Then both refuse when the rename source is the malformed section', async () => {
        // Arrange — write starting bytes (malformed [s "a" x] is the rename source)
        const { peerConfigPath } = await seedTwinConfigs(pair, startingConfigBytes);

        // Act — canonical git: s.a is a malformed section → no such section
        const gitResult = tryRunGit([
          'config',
          '--file',
          peerConfigPath,
          '--rename-section',
          's.a',
          's.b',
        ]);
        expect(gitResult.ok).toBe(false);
        expect(gitResult.stderr).toMatch(/no such section/i);

        // Act — tsgit
        const ctx = createNodeContext({ workDir: pair.ours });
        let tsgitError: TsgitError | undefined;
        try {
          await renameConfigSection({ ctx, oldName: 's.a', newName: 's.b' });
        } catch (err) {
          if (err instanceof TsgitError) tsgitError = err;
          else throw err;
        }

        // Assert — tsgit throws CONFIG_SECTION_NOT_FOUND
        expect(tsgitError, 'expected tsgit to throw TsgitError').not.toBeUndefined();
        const data = (tsgitError as TsgitError).data;
        expect(data.code).toBe('CONFIG_SECTION_NOT_FOUND');
      });
    });
  });

  describe('Given a config with an existing escaped subsection header [test "a\\"b"]', () => {
    describe('When tsgit and git each set a second key under that subsection', () => {
      it('Then both land in the existing section (single header, no duplicate)', async () => {
        // Arrange — hand-write the same starting bytes into both repos
        // The subsection `a"b` is stored as `[test "a\"b"]` on disk.
        const startingBytes = '[core]\n\trepositoryformatversion = 0\n[test "a\\"b"]\n\tk = v\n';
        await seedTwinConfigs(pair, startingBytes);

        // Act — tsgit sets k2 = v2 under subsection a"b (explicit split to avoid
        // parseConfigKey handling of " in the key string)
        const ctx = createNodeContext({ workDir: pair.ours });
        await updateConfigEntries(ctx, [
          { section: 'test', subsection: 'a"b', key: 'k2', value: 'v2' },
        ]);

        // Act — canonical git sets the same key in peer
        runGit(['-C', pair.peer, 'config', '--local', 'test.a"b.k2', 'v2']);

        // Assert — single [test "a\"b"] header in each repo (no duplicate introduced)
        const { oursConfig, peerConfig } = await readTwinConfigs(pair);
        const oursHeaders = oursConfig.match(/\[test "a\\"b"\]/g) ?? [];
        expect(oursHeaders).toHaveLength(1);
        const peerHeaders = peerConfig.match(/\[test "a\\"b"\]/g) ?? [];
        expect(peerHeaders).toHaveLength(1);

        // Assert — git reads both keys from tsgit's file
        const k1Readback = runGit(['-C', pair.ours, 'config', '--local', '--get', 'test.a"b.k']);
        const k2Readback = runGit(['-C', pair.ours, 'config', '--local', '--get', 'test.a"b.k2']);
        expect(k1Readback).toBe('v\n');
        expect(k2Readback).toBe('v2\n');
      });
    });
  });

  /**
   * Extract the text that starts at the first `[a]` section header.
   * Used by valueless write-parity tests to ignore differing preambles
   * while still comparing section bytes exactly.
   */
  const extractASection = (content: string): string => {
    const idx = content.indexOf('[a]');
    if (idx === -1) return '';
    return content.slice(idx);
  };

  // Refusal parity matrix: each bad line placed at physical line 2 inside [a].
  // git exits 128 with "bad config line 2 in file ..."; tsgit throws CONFIG_PARSE_ERROR
  // with data.line === 2.
  const VALUELESS_REFUSAL_MATRIX: ReadonlyArray<{ label: string; badLine: string }> = [
    { label: 'key ; c — inline comment after valueless key', badLine: 'key ; c' },
    { label: 'key # c — hash comment after valueless key', badLine: 'key # c' },
    { label: 'bad!key — exclamation in key name', badLine: 'bad!key' },
    { label: '9key — key starting with digit', badLine: '9key' },
    { label: 'under_score — underscore in key name', badLine: 'under_score' },
  ];

  describe('Given a config file with a valueless key (no `=` line)', () => {
    describe('When tsgit and git read --list', () => {
      it('Then the reconstructed --list stdout matches git byte-for-byte', async () => {
        // Arrange — write the fixture into ours .git/config
        // Line 1: [a], line 2: \tkey, line 3: \tempty =, line 4: \tother = v
        const configContent = '[a]\n\tkey\n\tempty =\n\tother = v\n';
        const oursConfigPath = path.join(pair.ours, '.git', 'config');
        await writeFile(oursConfigPath, configContent, 'utf8');

        // Act — canonical git --list (scoped to file, not --local, because the
        // preamble written by initBothRepos is not in our fixture)
        const gitResult = tryRunGit(['config', '--file', oursConfigPath, '--list']);
        expect(gitResult.ok, `git --list failed: ${gitResult.stderr}`).toBe(true);
        const gitStdout = gitResult.stdout;

        // Act — tsgit configList (local scope, fresh context)
        const ctx = createNodeContext({ workDir: pair.ours });
        const result = await configList(ctx, { scope: 'local' });

        // Reconstruct git's --list stdout from structured entries:
        //   value === null  → bare key line ("a.key\n")
        //   value === ''    → "a.key=\n"
        //   value           → "a.key=value\n"
        const reconstructed = result.entries
          .map((e) => (e.value === null ? `${e.key}\n` : `${e.key}=${e.value}\n`))
          .join('');

        // Assert — byte-identical reconstruction
        expect(reconstructed).toBe(gitStdout);
      }, 60_000);
    });
  });

  describe('Given a repo with `bare` as a valueless entry appended to [core]', () => {
    describe('When git and tsgit both evaluate core.bare', () => {
      it('Then git reports bare=true and tsgit returns value: null (null → true)', async () => {
        // Arrange — append a bare valueless line to ours [core] section
        // initBothRepos already wrote [core] with bare = false; we replace
        // the whole config with a minimal one that has bare as valueless.
        const oursConfigPath = path.join(pair.ours, '.git', 'config');
        const configContent =
          '[core]\n\trepositoryformatversion = 0\n\tfilemode = true\n\tlogallrefupdates = true\n\tbare\n';
        await writeFile(oursConfigPath, configContent, 'utf8');

        // Act — canonical git: rev-parse --is-bare-repository
        const gitResult = tryRunGit(['-C', pair.ours, 'rev-parse', '--is-bare-repository']);
        expect(gitResult.ok, `git rev-parse failed: ${gitResult.stderr}`).toBe(true);
        const gitBare = gitResult.stdout.trim();

        // Act — tsgit getConfigValue for core.bare
        const ctx = createNodeContext({ workDir: pair.ours });
        const result = await getConfigValue({ ctx, key: 'core.bare', scope: 'local' });

        // Assert — git sees bare=true
        expect(gitBare).toBe('true');

        // Assert — tsgit surfaces value: null (git's internal NULL); narrow the
        // discriminated union before accessing .value to satisfy the type checker
        expect(result.value, 'core.bare should be found').not.toBeUndefined();
        const found = result as { value: string | null };
        expect(found.value).toBeNull();

        // Assert — boolean reconstruction: null → true (agrees with git)
        const boolReconstruction = found.value === null || found.value.toLowerCase() === 'true';
        expect(boolReconstruction).toBe(true);
      }, 60_000);
    });
  });

  describe('Given a config file with a bad no-`=` line from the refusal matrix', () => {
    describe('When git and tsgit parse the file', () => {
      it.each(
        VALUELESS_REFUSAL_MATRIX,
      )('Then both refuse with data.line === 2 for "$label"', async ({ badLine }) => {
        // Arrange — [a] on line 1, bad line on line 2
        const configContent = `[a]\n\t${badLine}\n`;
        const oursConfigPath = path.join(pair.ours, '.git', 'config');
        await writeFile(oursConfigPath, configContent, 'utf8');

        // Act — canonical git
        const gitResult = tryRunGit(['config', '--file', oursConfigPath, '--list']);

        // Assert — git exits non-zero with bad config line 2
        expect(gitResult.ok).toBe(false);
        const lineMatch = /bad config line (\d+)/i.exec(gitResult.stderr);
        expect(lineMatch, `expected 'bad config line N' in: ${gitResult.stderr}`).not.toBeNull();
        const gitLine = Number((lineMatch as RegExpExecArray)[1]);
        expect(gitLine).toBe(2);

        // Act — tsgit (fresh context to bypass cache)
        const ctx = createNodeContext({ workDir: pair.ours });
        let tsgitError: TsgitError | undefined;
        try {
          await readConfig(ctx);
        } catch (err) {
          if (err instanceof TsgitError) tsgitError = err;
          else throw err;
        }

        // Assert — tsgit throws CONFIG_PARSE_ERROR with matching line number
        expect(tsgitError, 'expected tsgit to throw TsgitError').not.toBeUndefined();
        const data = (tsgitError as TsgitError).data;
        expect(data.code).toBe('CONFIG_PARSE_ERROR');
        if (data.code === 'CONFIG_PARSE_ERROR') {
          expect(data.line).toBe(gitLine);
        }
      }, 60_000);
    });
  });

  describe('Given twin repos with a valueless entry `[a]\\n\\tkey\\n`', () => {
    describe('When git and tsgit each set a.key to "replaced"', () => {
      it('Then the resulting [a] section bytes are identical', async () => {
        // Arrange — same starting bytes in both repos
        const startingBytes = '[core]\n\trepositoryformatversion = 0\n[a]\n\tkey\n';
        const { peerConfigPath } = await seedTwinConfigs(pair, startingBytes);

        // Act — canonical git sets a.key via --file
        const gitResult = tryRunGit(['config', '--file', peerConfigPath, 'a.key', 'replaced']);
        expect(gitResult.ok, `git config set failed: ${gitResult.stderr}`).toBe(true);

        // Act — tsgit configSet on ours
        const ctx = createNodeContext({ workDir: pair.ours });
        await configSet(ctx, { key: 'a.key', value: 'replaced', scope: 'local' });

        // Assert — byte-identical [a] section
        const { oursConfig, peerConfig } = await readTwinConfigs(pair);
        expect(extractASection(oursConfig)).toBe(extractASection(peerConfig));
      }, 60_000);
    });

    describe('When git and tsgit each unset a.key', () => {
      it('Then the resulting [a] section bytes are identical', async () => {
        // Arrange — same starting bytes in both repos (key + adjacent entry)
        const startingBytes = '[core]\n\trepositoryformatversion = 0\n[a]\n\tkey\n\tother = v\n';
        const { peerConfigPath } = await seedTwinConfigs(pair, startingBytes);

        // Act — canonical git unsets a.key via --file
        const gitResult = tryRunGit(['config', '--file', peerConfigPath, '--unset', 'a.key']);
        expect(gitResult.ok, `git config --unset failed: ${gitResult.stderr}`).toBe(true);

        // Act — tsgit configUnset on ours
        const ctx = createNodeContext({ workDir: pair.ours });
        const result = await configUnset(ctx, { key: 'a.key', scope: 'local' });

        // Assert — unset reports the valueless entry as removed with null previousValue
        expect(result.removed).toBe(true);
        if (result.removed) {
          expect(result.previousValue).toBeNull();
        }

        // Assert — byte-identical [a] section
        const { oursConfig, peerConfig } = await readTwinConfigs(pair);
        expect(extractASection(oursConfig)).toBe(extractASection(peerConfig));
      }, 60_000);
    });

    describe('When git and tsgit each rename subsection a.x to a.y', () => {
      it('Then the valueless body lines are preserved byte-for-byte in the renamed section', async () => {
        // Arrange — same starting bytes in both repos (subsectioned [a "x"] with
        // a valueless key; renaming to [a "y"] must preserve the body verbatim)
        const startingBytes =
          '[core]\n\trepositoryformatversion = 0\n[a "x"]\n\tkey\n\tother = v\n';
        const { peerConfigPath } = await seedTwinConfigs(pair, startingBytes);

        // Act — canonical git --rename-section a.x → a.y via --file
        const gitResult = tryRunGit([
          'config',
          '--file',
          peerConfigPath,
          '--rename-section',
          'a.x',
          'a.y',
        ]);
        expect(gitResult.ok, `git rename-section failed: ${gitResult.stderr}`).toBe(true);

        // Act — tsgit configRenameSection (section.subsection format) on ours
        const ctx = createNodeContext({ workDir: pair.ours });
        await configRenameSectionCmd(ctx, { oldName: 'a.x', newName: 'a.y', scope: 'local' });

        // Assert — byte-identical content from the renamed [a "y"] section onward
        const { oursConfig, peerConfig } = await readTwinConfigs(pair);
        const extractAYSection = (c: string): string => {
          const idx = c.indexOf('[a "y"]');
          return idx === -1 ? '' : c.slice(idx);
        };
        expect(extractAYSection(oursConfig)).toBe(extractAYSection(peerConfig));
      }, 60_000);
    });
  });

  describe('Given a config file with valueless and valued entries under [a]', () => {
    describe('When tsgit and git both run get-regexp against all keys', () => {
      it('Then the reconstructed --get-regexp stdout matches git byte-for-byte', async () => {
        // Arrange — write the fixture into ours .git/config
        const configContent = '[a]\n\tkey\n\tempty =\n\tother = v\n';
        const oursConfigPath = path.join(pair.ours, '.git', 'config');
        await writeFile(oursConfigPath, configContent, 'utf8');

        // Act — canonical git --get-regexp '.*' (scoped to file)
        const gitResult = tryRunGit(['config', '--file', oursConfigPath, '--get-regexp', '.*']);
        expect(gitResult.ok, `git --get-regexp failed: ${gitResult.stderr}`).toBe(true);
        const gitStdout = gitResult.stdout;

        // Act — tsgit configGetRegexp (local scope, key-pattern matches all)
        const ctx = createNodeContext({ workDir: pair.ours });
        const result = await configGetRegexp(ctx, {
          keyPattern: /.*/,
          scope: 'local',
        });

        // Reconstruct git's --get-regexp stdout:
        //   value === null  → "key\n"         (bare, no space)
        //   value === ''    → "key \n"         (key + space + empty)
        //   value           → "key value\n"
        const reconstructed = result.entries
          .map((e) => (e.value === null ? `${e.key}\n` : `${e.key} ${e.value}\n`))
          .join('');

        // Assert — byte-identical reconstruction
        expect(reconstructed).toBe(gitStdout);
      }, 60_000);

      it('Then value-pattern ^$ matches both the valueless entry and the empty-string entry', async () => {
        // Arrange — write the fixture
        const configContent = '[a]\n\tkey\n\tempty =\n\tother = v\n';
        const oursConfigPath = path.join(pair.ours, '.git', 'config');
        await writeFile(oursConfigPath, configContent, 'utf8');

        // Act — canonical git --get-regexp '.*' '^$' (value-pattern)
        const gitResult = tryRunGit([
          'config',
          '--file',
          oursConfigPath,
          '--get-regexp',
          '.*',
          '^$',
        ]);
        expect(gitResult.ok, `git --get-regexp value-pattern failed: ${gitResult.stderr}`).toBe(
          true,
        );
        const gitMatched = gitResult.stdout
          .split('\n')
          .filter((l) => l.length > 0)
          .map((l) => l.split(' ')[0]);

        // Act — tsgit configGetRegexp with valuePattern /^$/
        const ctx = createNodeContext({ workDir: pair.ours });
        const result = await configGetRegexp(ctx, {
          keyPattern: /.*/,
          valuePattern: /^$/,
          scope: 'local',
        });
        const tsgitMatched = result.entries.map((e) => e.key);

        // Assert — same matched key set (order and count)
        expect(tsgitMatched).toEqual(gitMatched);
      }, 60_000);
    });
  });

  // ---------------------------------------------------------------------------
  // Multi-line surgery interop twins — span-aware set/unset/add byte parity
  // ---------------------------------------------------------------------------

  /**
   * Extract text from the first `[a]` header onward, used by the multi-line
   * surgery interop twins to skip differing preambles while comparing exactly.
   */
  const extractFromA = (content: string): string => {
    const idx = content.indexOf('[a]');
    if (idx === -1) throw new Error('marker [a] not found in config content');
    return content.slice(idx);
  };

  /**
   * Extract text from the first `[remote "o"]` header onward.
   */
  const extractRemoteO = (content: string): string => {
    const idx = content.indexOf('[remote "o"]');
    if (idx === -1) throw new Error('marker [remote "o"] not found in config content');
    return content.slice(idx);
  };

  /** Twin `.git/config` paths for a peer pair. */
  const twinConfigPaths = (p: PeerPair): { oursConfigPath: string; peerConfigPath: string } => ({
    oursConfigPath: path.join(p.ours, '.git', 'config'),
    peerConfigPath: path.join(p.peer, '.git', 'config'),
  });

  /** Seed both twin configs with the same starting bytes; returns the paths. */
  const seedTwinConfigs = async (
    p: PeerPair,
    bytes: string,
  ): Promise<{ oursConfigPath: string; peerConfigPath: string }> => {
    const paths = twinConfigPaths(p);
    await writeFile(paths.oursConfigPath, bytes, 'utf8');
    await writeFile(paths.peerConfigPath, bytes, 'utf8');
    return paths;
  };

  /** Read back both twin configs for byte comparison. */
  const readTwinConfigs = async (
    p: PeerPair,
  ): Promise<{ oursConfig: string; peerConfig: string }> => {
    const { oursConfigPath, peerConfigPath } = twinConfigPaths(p);
    return {
      oursConfig: await readFile(oursConfigPath, 'utf8'),
      peerConfig: await readFile(peerConfigPath, 'utf8'),
    };
  };

  describe('Given twin repos with a multi-line entry `[a]\\n\\tkey = one\\\\\\n   two\\n\\tother = x\\n`', () => {
    describe('When git and tsgit each set a.key to "newval" (row A)', () => {
      it('Then the [a] section bytes are identical — replace removes the full span', async () => {
        // Arrange — row A: set replaces all physical lines of the spanned entry
        const startingBytes =
          '[core]\n\trepositoryformatversion = 0\n[a]\n\tkey = one\\\n   two\n\tother = x\n';
        const { peerConfigPath } = await seedTwinConfigs(pair, startingBytes);

        // Act — canonical git
        const gitResult = tryRunGit(['config', '--file', peerConfigPath, 'a.key', 'newval']);
        expect(gitResult.ok, `git config set failed: ${gitResult.stderr}`).toBe(true);

        // Act — tsgit
        const ctx = createNodeContext({ workDir: pair.ours });
        await configSet(ctx, { key: 'a.key', value: 'newval', scope: 'local' });

        // Assert — byte-identical [a]-onward content
        const { oursConfig, peerConfig } = await readTwinConfigs(pair);
        expect(extractFromA(oursConfig)).toBe(extractFromA(peerConfig));
      }, 60_000);
    });
  });

  describe('Given twin repos with a multi-line entry `[a]\\n\\tkey = one\\\\\\n   two\\n\\tother = x\\n`', () => {
    describe('When git and tsgit each unset a.key (row B)', () => {
      it('Then the [a] section bytes are identical — unset removes the whole span', async () => {
        // Arrange — row B: unset removes all physical lines of the continuation span
        const startingBytes =
          '[core]\n\trepositoryformatversion = 0\n[a]\n\tkey = one\\\n   two\n\tother = x\n';
        const { peerConfigPath } = await seedTwinConfigs(pair, startingBytes);

        // Act — canonical git
        const gitResult = tryRunGit(['config', '--file', peerConfigPath, '--unset', 'a.key']);
        expect(gitResult.ok, `git --unset failed: ${gitResult.stderr}`).toBe(true);

        // Act — tsgit
        const ctx = createNodeContext({ workDir: pair.ours });
        await configUnset(ctx, { key: 'a.key', scope: 'local' });

        // Assert
        const { oursConfig, peerConfig } = await readTwinConfigs(pair);
        expect(extractFromA(oursConfig)).toBe(extractFromA(peerConfig));
      }, 60_000);
    });
  });

  describe('Given twin repos with multiple multi-line and single-line key occurrences (row F)', () => {
    describe('When git and tsgit each unset-all a.key', () => {
      it("Then the [a] section bytes are identical — every occurrence's full span is removed", async () => {
        // Arrange — row F: unset-all removes every occurrence, single- and multi-line
        const startingBytes =
          '[core]\n\trepositoryformatversion = 0\n' +
          '[a]\n\tkey = one\\\n   two\n\tmid = m\n\tkey = three\n\tkey = four\\\n   five\n';
        const { peerConfigPath } = await seedTwinConfigs(pair, startingBytes);

        // Act — canonical git
        const gitResult = tryRunGit(['config', '--file', peerConfigPath, '--unset-all', 'a.key']);
        expect(gitResult.ok, `git --unset-all failed: ${gitResult.stderr}`).toBe(true);

        // Act — tsgit
        const ctx = createNodeContext({ workDir: pair.ours });
        await configUnsetAll(ctx, { key: 'a.key', scope: 'local' });

        // Assert
        const { oursConfig, peerConfig } = await readTwinConfigs(pair);
        expect(extractFromA(oursConfig)).toBe(extractFromA(peerConfig));
      }, 60_000);
    });
  });

  describe('Given twin repos with `[remote "o"]` having url, fetch, push (row J)', () => {
    describe('When git and tsgit each append remote.o.fetch = B', () => {
      it('Then the [remote "o"] section bytes are identical — appended entry lands at the end of the section', async () => {
        // Arrange — row J: --add places the new entry at the end of the section
        const startingBytes =
          '[core]\n\trepositoryformatversion = 0\n[remote "o"]\n\turl = u\n\tfetch = A\n\tpush = p\n';
        const { peerConfigPath } = await seedTwinConfigs(pair, startingBytes);

        // Act — canonical git
        const gitResult = tryRunGit([
          'config',
          '--file',
          peerConfigPath,
          '--add',
          'remote.o.fetch',
          'B',
        ]);
        expect(gitResult.ok, `git --add failed: ${gitResult.stderr}`).toBe(true);

        // Act — tsgit via updateConfigOperations appendEntry op
        const ctx = createNodeContext({ workDir: pair.ours });
        const ops: ReadonlyArray<ConfigOperation> = [
          { kind: 'appendEntry', section: 'remote', subsection: 'o', key: 'fetch', value: 'B' },
        ];
        await updateConfigOperations(ctx, ops);

        // Assert
        const { oursConfig, peerConfig } = await readTwinConfigs(pair);
        expect(extractRemoteO(oursConfig)).toBe(extractRemoteO(peerConfig));
      }, 60_000);
    });
  });

  describe('Given twin repos with `[remote "o"]` having a multi-line fetch entry (row J2)', () => {
    describe('When git and tsgit each append remote.o.fetch = B', () => {
      it('Then the [remote "o"] section bytes are identical — appended entry lands after the multi-line tail', async () => {
        // Arrange — row J2: append after a multi-line entry
        const startingBytes =
          '[core]\n\trepositoryformatversion = 0\n[remote "o"]\n\tfetch = A\\\n   tail\n';
        const { peerConfigPath } = await seedTwinConfigs(pair, startingBytes);

        // Act — canonical git
        const gitResult = tryRunGit([
          'config',
          '--file',
          peerConfigPath,
          '--add',
          'remote.o.fetch',
          'B',
        ]);
        expect(gitResult.ok, `git --add failed: ${gitResult.stderr}`).toBe(true);

        // Act — tsgit
        const ctx = createNodeContext({ workDir: pair.ours });
        const ops: ReadonlyArray<ConfigOperation> = [
          { kind: 'appendEntry', section: 'remote', subsection: 'o', key: 'fetch', value: 'B' },
        ];
        await updateConfigOperations(ctx, ops);

        // Assert
        const { oursConfig, peerConfig } = await readTwinConfigs(pair);
        expect(extractRemoteO(oursConfig)).toBe(extractRemoteO(peerConfig));
      }, 60_000);
    });
  });

  describe('Given twin repos where [a] has one entry followed by [b] (row I1)', () => {
    describe('When git and tsgit each set a.other to "val"', () => {
      it('Then the [a] section bytes are identical — new key is inserted at the end of the section, not after the header', async () => {
        // Arrange — row I1: new key lands after the last entry, not right after the header
        const startingBytes =
          '[core]\n\trepositoryformatversion = 0\n[a]\n\tkey = one\n[b]\n\tk = v\n';
        const { peerConfigPath } = await seedTwinConfigs(pair, startingBytes);

        // Act — canonical git
        const gitResult = tryRunGit(['config', '--file', peerConfigPath, 'a.other', 'val']);
        expect(gitResult.ok, `git config set failed: ${gitResult.stderr}`).toBe(true);

        // Act — tsgit
        const ctx = createNodeContext({ workDir: pair.ours });
        await configSet(ctx, { key: 'a.other', value: 'val', scope: 'local' });

        // Assert
        const { oursConfig, peerConfig } = await readTwinConfigs(pair);
        expect(extractFromA(oursConfig)).toBe(extractFromA(peerConfig));
      }, 60_000);
    });
  });

  describe('Given twin repos where [a] has an entry then a blank then a comment then [b] (row I2)', () => {
    describe('When git and tsgit each set a.other to "val"', () => {
      it('Then the [a] section bytes are identical — new key is inserted after the last entry, before trailing blank/comment', async () => {
        // Arrange — row I2: insertion after the last entry token, before trailing blank+comment
        const startingBytes =
          '[core]\n\trepositoryformatversion = 0\n[a]\n\tkey = one\n\n# trailing comment\n[b]\n\tk = v\n';
        const { peerConfigPath } = await seedTwinConfigs(pair, startingBytes);

        // Act — canonical git
        const gitResult = tryRunGit(['config', '--file', peerConfigPath, 'a.other', 'val']);
        expect(gitResult.ok, `git config set failed: ${gitResult.stderr}`).toBe(true);

        // Act — tsgit
        const ctx = createNodeContext({ workDir: pair.ours });
        await configSet(ctx, { key: 'a.other', value: 'val', scope: 'local' });

        // Assert
        const { oursConfig, peerConfig } = await readTwinConfigs(pair);
        expect(extractFromA(oursConfig)).toBe(extractFromA(peerConfig));
      }, 60_000);
    });
  });

  describe('Given twin repos with two [a] blocks and new key targeting [a] (row I4 + last-empty-block)', () => {
    describe('When git and tsgit each set a.new to "val"', () => {
      it('Then the [a] section bytes are identical — new key lands in the last matching block', async () => {
        // Arrange — row I4: the last matching block (empty) receives the new key;
        // also pins the composed corner: last block empty while an earlier one has entries.
        const startingBytes =
          '[core]\n\trepositoryformatversion = 0\n[a]\n\tk1 = x\n[b]\n\tk = v\n[a]\n';
        const { peerConfigPath } = await seedTwinConfigs(pair, startingBytes);

        // Act — canonical git
        const gitResult = tryRunGit(['config', '--file', peerConfigPath, 'a.new', 'val']);
        expect(gitResult.ok, `git config set failed: ${gitResult.stderr}`).toBe(true);

        // Act — tsgit
        const ctx = createNodeContext({ workDir: pair.ours });
        await configSet(ctx, { key: 'a.new', value: 'val', scope: 'local' });

        // Assert
        const { oursConfig, peerConfig } = await readTwinConfigs(pair);
        expect(extractFromA(oursConfig)).toBe(extractFromA(peerConfig));
      }, 60_000);
    });
  });

  describe('Given twin repos where [a] has a multi-line entry and unset removes the only entry (row D)', () => {
    describe('When git and tsgit each unset a.key', () => {
      it('Then the [a] block is removed entirely — empty-block pruning applies', async () => {
        // Arrange — row D: removing the only entry prunes the section header too
        const startingBytes =
          '[core]\n\trepositoryformatversion = 0\n[a]\n\tkey = one\\\n   two\n[b]\n\tk = v\n';
        const { peerConfigPath } = await seedTwinConfigs(pair, startingBytes);

        // Act — canonical git
        const gitResult = tryRunGit(['config', '--file', peerConfigPath, '--unset', 'a.key']);
        expect(gitResult.ok, `git --unset failed: ${gitResult.stderr}`).toBe(true);

        // Act — tsgit
        const ctx = createNodeContext({ workDir: pair.ours });
        await configUnset(ctx, { key: 'a.key', scope: 'local' });

        // Assert — full file byte compare (preamble is identical, [a] block gone)
        const { oursConfig, peerConfig } = await readTwinConfigs(pair);
        expect(oursConfig).toBe(peerConfig);
      }, 60_000);
    });
  });

  describe('Given twin repos where [a] has a comment then a multi-line entry (row D4)', () => {
    describe('When git and tsgit each unset a.key', () => {
      it('Then the comment keeps the header — only the entry span is removed', async () => {
        // Arrange — row D4: a comment in the block keeps the header (and the comment)
        const startingBytes =
          '[core]\n\trepositoryformatversion = 0\n[a]\n\t# keep me\n\tkey = one\\\n   two\n[b]\n\tk = v\n';
        const { peerConfigPath } = await seedTwinConfigs(pair, startingBytes);

        // Act — canonical git
        const gitResult = tryRunGit(['config', '--file', peerConfigPath, '--unset', 'a.key']);
        expect(gitResult.ok, `git --unset failed: ${gitResult.stderr}`).toBe(true);

        // Act — tsgit
        const ctx = createNodeContext({ workDir: pair.ours });
        await configUnset(ctx, { key: 'a.key', scope: 'local' });

        // Assert
        const { oursConfig, peerConfig } = await readTwinConfigs(pair);
        expect(oursConfig).toBe(peerConfig);
      }, 60_000);
    });
  });

  describe('Given twin repos where [a] has key, blank, and a comment before [b] (row D8)', () => {
    describe('When git and tsgit each unset a.key', () => {
      it('Then the comment keeps the header, blank, and comment — only the entry span is removed', async () => {
        // Arrange — row D8: comment present → header, blank, and comment all kept
        const startingBytes =
          '[core]\n\trepositoryformatversion = 0\n[a]\n\tkey = one\n\n# c\n[b]\n\tk = v\n';
        const { peerConfigPath } = await seedTwinConfigs(pair, startingBytes);

        // Act — canonical git
        const gitResult = tryRunGit(['config', '--file', peerConfigPath, '--unset', 'a.key']);
        expect(gitResult.ok, `git --unset failed: ${gitResult.stderr}`).toBe(true);

        // Act — tsgit
        const ctx = createNodeContext({ workDir: pair.ours });
        await configUnset(ctx, { key: 'a.key', scope: 'local' });

        // Assert
        const { oursConfig, peerConfig } = await readTwinConfigs(pair);
        expect(oursConfig).toBe(peerConfig);
      }, 60_000);
    });
  });

  describe('Given twin repos with [a] whose continuation tail looks like a key (row K)', () => {
    describe('When git and tsgit each set a.url to "NEW"', () => {
      it('Then the [a] section bytes are identical — the lookalike tail is never matched', async () => {
        // Arrange — row K: `note = first\` continues to `url = fake` on the next
        // line; the real `url = real` entry follows. Set must target the real entry.
        const startingBytes =
          '[core]\n\trepositoryformatversion = 0\n[a]\n\tnote = first\\\n\turl = fake\n\turl = real\n';
        const { peerConfigPath } = await seedTwinConfigs(pair, startingBytes);

        // Act — canonical git
        const gitResult = tryRunGit(['config', '--file', peerConfigPath, 'a.url', 'NEW']);
        expect(gitResult.ok, `git config set failed: ${gitResult.stderr}`).toBe(true);

        // Act — tsgit
        const ctx = createNodeContext({ workDir: pair.ours });
        await configSet(ctx, { key: 'a.url', value: 'NEW', scope: 'local' });

        // Assert
        const { oursConfig, peerConfig } = await readTwinConfigs(pair);
        expect(extractFromA(oursConfig)).toBe(extractFromA(peerConfig));
      }, 60_000);
    });
  });

  describe('Given twin repos with [a] whose continuation tail looks like a section header (row L)', () => {
    describe('When git and tsgit each set a.key to "NEW"', () => {
      it('Then the [a] section bytes are identical — the lookalike header tail does not end the section on the set path', async () => {
        // Arrange — row L: `note = v\` continues to `[x]` on the next line; the
        // section continues past it and `key = old` is the real entry.
        const startingBytes =
          '[core]\n\trepositoryformatversion = 0\n[a]\n\tnote = v\\\n[x]\n\tkey = old\n';
        const { peerConfigPath } = await seedTwinConfigs(pair, startingBytes);

        // Act — canonical git
        const gitResult = tryRunGit(['config', '--file', peerConfigPath, 'a.key', 'NEW']);
        expect(gitResult.ok, `git config set failed: ${gitResult.stderr}`).toBe(true);

        // Act — tsgit
        const ctx = createNodeContext({ workDir: pair.ours });
        await configSet(ctx, { key: 'a.key', value: 'NEW', scope: 'local' });

        // Assert
        const { oursConfig, peerConfig } = await readTwinConfigs(pair);
        expect(extractFromA(oursConfig)).toBe(extractFromA(peerConfig));
      }, 60_000);
    });
  });

  describe('Given twin repos with a sole [a] entry (no trailing LF) and a missing-EOF-newline corner', () => {
    describe('When git and tsgit each set a.other to "val"', () => {
      it('Then the resulting bytes are identical — git adds the missing trailing newline and then the new entry', async () => {
        // Arrange — S2 corner: the file has no trailing LF; git repairs it when
        // inserting a new entry. tsgit's `idx === lines.length` branch does the same.
        const startingBytes = '[core]\n\trepositoryformatversion = 0\n[a]\n\tk = v';
        const { peerConfigPath } = await seedTwinConfigs(pair, startingBytes);

        // Act — canonical git
        const gitResult = tryRunGit(['config', '--file', peerConfigPath, 'a.other', 'val']);
        expect(gitResult.ok, `git config set failed: ${gitResult.stderr}`).toBe(true);

        // Act — tsgit
        const ctx = createNodeContext({ workDir: pair.ours });
        await configSet(ctx, { key: 'a.other', value: 'val', scope: 'local' });

        // Assert — full file byte compare
        const { oursConfig, peerConfig } = await readTwinConfigs(pair);
        expect(oursConfig).toBe(peerConfig);
      }, 60_000);
    });
  });

  describe('Given twin repos whose last entry sits at EOF without a trailing newline', () => {
    describe('When git and tsgit each replace that entry', () => {
      it('Then the resulting bytes are identical — the rewritten entry is newline-terminated', async () => {
        // Arrange — the replaced span reaches EOF of a no-final-LF file
        const startingBytes = '[core]\n\trepositoryformatversion = 0\n[a]\n\tk = old';
        const { peerConfigPath } = await seedTwinConfigs(pair, startingBytes);

        // Act — canonical git
        const gitResult = tryRunGit(['config', '--file', peerConfigPath, 'a.k', 'new']);
        expect(gitResult.ok, `git config set failed: ${gitResult.stderr}`).toBe(true);

        // Act — tsgit
        const ctx = createNodeContext({ workDir: pair.ours });
        await configSet(ctx, { key: 'a.k', value: 'new', scope: 'local' });

        // Assert — full file byte compare
        const { oursConfig, peerConfig } = await readTwinConfigs(pair);
        expect(oursConfig).toBe(peerConfig);
      }, 60_000);
    });
  });

  describe('Given twin repos whose trailing [a] block ends a file without a final newline', () => {
    describe('When git and tsgit each unset the only a.key entry', () => {
      it('Then the resulting bytes are identical — the kept prefix stays newline-terminated', async () => {
        // Arrange — pruning the trailing block must keep the newline that
        // followed the last kept line
        const startingBytes = '[core]\n\trepositoryformatversion = 0\n[a]\n\tkey = one';
        const { peerConfigPath } = await seedTwinConfigs(pair, startingBytes);

        // Act — canonical git
        const gitResult = tryRunGit(['config', '--file', peerConfigPath, '--unset', 'a.key']);
        expect(gitResult.ok, `git config unset failed: ${gitResult.stderr}`).toBe(true);

        // Act — tsgit
        const ctx = createNodeContext({ workDir: pair.ours });
        await configUnset(ctx, { key: 'a.key', scope: 'local' });

        // Assert — full file byte compare
        const { oursConfig, peerConfig } = await readTwinConfigs(pair);
        expect(oursConfig).toBe(peerConfig);
      }, 60_000);
    });
  });

  describe('Given twin repos where a sole [a] section is removed after unsetting its only key', () => {
    describe('When git and tsgit each unset a.key', () => {
      it('Then the [a] block vanishes entirely — empty-section pruning in situ', async () => {
        // Arrange — sole-section variant: starting bytes include [core] preamble
        // plus [a] with one entry. Unsetting a.key must leave an empty file for [a].
        const startingBytes = '[core]\n\trepositoryformatversion = 0\n[a]\n\tkey = v\n';
        const { peerConfigPath } = await seedTwinConfigs(pair, startingBytes);

        // Act — canonical git
        const gitResult = tryRunGit(['config', '--file', peerConfigPath, '--unset', 'a.key']);
        expect(gitResult.ok, `git --unset failed: ${gitResult.stderr}`).toBe(true);

        // Act — tsgit
        const ctx = createNodeContext({ workDir: pair.ours });
        await configUnset(ctx, { key: 'a.key', scope: 'local' });

        // Assert — [a] block is gone in both
        const { oursConfig, peerConfig } = await readTwinConfigs(pair);
        expect(oursConfig).toBe(peerConfig);
        expect(oursConfig).not.toContain('[a]');
      }, 60_000);
    });
  });

  describe('Given twin repos where git remote add writes url then fetch', () => {
    describe('When git and tsgit each add a remote named "o"', () => {
      it('Then the [remote "o"] section bytes are identical — url appears before fetch', async () => {
        // Arrange — remote add flow: canonical git writes url then fetch refspec;
        // tsgit must emit the same order (pins the end-of-section insertion fix).
        // Both repos already have a clean [core] preamble from initBothRepos.

        // Act — canonical git
        const gitResult = tryRunGit(['-C', pair.peer, 'remote', 'add', 'o', 'https://e.com/r.git']);
        expect(gitResult.ok, `git remote add failed: ${gitResult.stderr}`).toBe(true);

        // Act — tsgit
        const ctx = createNodeContext({ workDir: pair.ours });
        await remoteAdd(ctx, { name: 'o', url: 'https://e.com/r.git' });

        // Assert — byte-identical [remote "o"] section
        const oursConfig = await readFile(path.join(pair.ours, '.git', 'config'), 'utf8');
        const peerConfig = await readFile(path.join(pair.peer, '.git', 'config'), 'utf8');
        expect(extractRemoteO(oursConfig)).toBe(extractRemoteO(peerConfig));
      }, 60_000);
    });
  });

  // ---------------------------------------------------------------------------
  // Rename/remove-section span-unawareness (N1/N2/N3) — both tools "corrupt" identically
  // ---------------------------------------------------------------------------

  describe('Given twin repos with a lookalike-tail followed by a real [b "s"] block (row N1)', () => {
    describe('When git and tsgit each rename-section b.s to b.t', () => {
      it('Then the full-file bytes are identical — the lookalike tail is renamed too (span-unaware, intended)', async () => {
        // Arrange — row N1: `[a]` has `key = one\` then `[b "s"]` (lookalike tail).
        // Both git and tsgit rename the lookalike tail alongside the real header.
        const startingBytes =
          '[core]\n\trepositoryformatversion = 0\n[a]\n\tkey = one\\\n[b "s"]\n[b "s"]\n\tk = v\n';
        const { peerConfigPath } = await seedTwinConfigs(pair, startingBytes);

        // Act — canonical git
        const gitResult = tryRunGit([
          'config',
          '--file',
          peerConfigPath,
          '--rename-section',
          'b.s',
          'b.t',
        ]);
        expect(gitResult.ok, `git --rename-section failed: ${gitResult.stderr}`).toBe(true);

        // Act — tsgit configRenameSection
        const ctx = createNodeContext({ workDir: pair.ours });
        await configRenameSectionCmd(ctx, { oldName: 'b.s', newName: 'b.t', scope: 'local' });

        // Assert — byte-identical content from first [a] header onward
        const { oursConfig, peerConfig } = await readTwinConfigs(pair);
        expect(extractFromA(oursConfig)).toBe(extractFromA(peerConfig));
      }, 60_000);
    });
  });

  describe('Given twin repos with [a "s"] having a plain continuation body tail (row N2)', () => {
    describe('When git and tsgit each rename-section a.s to a.t', () => {
      it('Then the full-file bytes are identical — body tails pass through verbatim', async () => {
        // Arrange — row N2: the continuation tail `   two` does not look like a
        // section header so it passes through rename unchanged (span-unaware, faithful).
        const startingBytes =
          '[core]\n\trepositoryformatversion = 0\n[a "s"]\n\tkey = one\\\n   two\n[b]\n\tk = v\n';
        const { peerConfigPath } = await seedTwinConfigs(pair, startingBytes);

        // Act — canonical git
        const gitResult = tryRunGit([
          'config',
          '--file',
          peerConfigPath,
          '--rename-section',
          'a.s',
          'a.t',
        ]);
        expect(gitResult.ok, `git --rename-section failed: ${gitResult.stderr}`).toBe(true);

        // Act — tsgit
        const ctx = createNodeContext({ workDir: pair.ours });
        await configRenameSectionCmd(ctx, { oldName: 'a.s', newName: 'a.t', scope: 'local' });

        // Assert — full file compare (preamble identical, only the header changes)
        const { oursConfig, peerConfig } = await readTwinConfigs(pair);
        expect(oursConfig).toBe(peerConfig);
      }, 60_000);
    });
  });

  describe('Given twin repos with [a] having a lookalike-tail followed by two [b "s"] blocks (row N3)', () => {
    describe('When git and tsgit each remove-section b.s', () => {
      it('Then the full-file bytes are identical — both lookalike tail and real blocks are removed (span-unaware, intended)', async () => {
        // Arrange — row N3: removing b.s hits the lookalike tail plus both real blocks,
        // corrupting a.key's value. Replicating this byte-for-byte is intended.
        const startingBytes =
          '[core]\n\trepositoryformatversion = 0\n[a]\n\tkey = one\\\n[b "s"]\n\tinside = t\n[b "s"]\n\tk = v\n[d]\n\te = f\n';
        const { peerConfigPath } = await seedTwinConfigs(pair, startingBytes);

        // Act — canonical git
        const gitResult = tryRunGit([
          'config',
          '--file',
          peerConfigPath,
          '--remove-section',
          'b.s',
        ]);
        expect(gitResult.ok, `git --remove-section failed: ${gitResult.stderr}`).toBe(true);

        // Act — tsgit configRemoveSection
        const ctx = createNodeContext({ workDir: pair.ours });
        await configRemoveSection(ctx, { name: 'b.s', scope: 'local' });

        // Assert
        const { oursConfig, peerConfig } = await readTwinConfigs(pair);
        expect(oursConfig).toBe(peerConfig);
      }, 60_000);
    });
  });

  // ---------------------------------------------------------------------------
  // Subsection identity interop — [s] vs [s ""] are distinct (Slice 2 matrix)
  // ---------------------------------------------------------------------------

  /**
   * Extract from the first `[s` header onward, skipping the differing [core]
   * preambles produced by tsgit and canonical git.
   */
  const extractFromS = (content: string): string => {
    const idx = content.indexOf('[s');
    if (idx === -1) return content;
    return content.slice(idx);
  };

  // Fixtures (verbatim from the pinned bytes table)
  const BOTH_CONF = '[core]\n\trepositoryformatversion = 0\n[s]\n\tk = a\n[s ""]\n\tk = b\n';
  const REV_CONF = '[core]\n\trepositoryformatversion = 0\n[s ""]\n\tk = b\n[s]\n\tk = a\n';
  const EMPTY_ONLY_CONF = '[core]\n\trepositoryformatversion = 0\n[s ""]\n\tk = b\n';
  const PLAIN_ONLY_CONF = '[core]\n\trepositoryformatversion = 0\n[s]\n\tk = a\n';

  describe('Given both.conf seeded ([s] k=a and [s ""] k=b)', () => {
    describe('When git and tsgit each set s.k to v (target = plain)', () => {
      it('Then [s] k is replaced, [s ""] k=b preserved (row 1)', async () => {
        // Arrange
        const { peerConfigPath } = await seedTwinConfigs(pair, BOTH_CONF);

        // Act — canonical git
        const gitResult = tryRunGit(['config', '--file', peerConfigPath, 's.k', 'v']);
        expect(gitResult.ok, `git config set failed: ${gitResult.stderr}`).toBe(true);

        // Act — tsgit
        const ctx = createNodeContext({ workDir: pair.ours });
        await configSet(ctx, { key: 's.k', value: 'v', scope: 'local' });

        // Assert — byte-identical [s]-onward content
        const { oursConfig, peerConfig } = await readTwinConfigs(pair);
        expect(extractFromS(oursConfig)).toBe(extractFromS(peerConfig));
      }, 60_000);
    });
  });

  describe('Given both.conf seeded ([s] k=a and [s ""] k=b)', () => {
    describe('When git and tsgit each set s..k to v (target = empty subsection)', () => {
      it('Then [s ""] k is replaced, [s] k=a preserved (row 2)', async () => {
        // Arrange
        const { peerConfigPath } = await seedTwinConfigs(pair, BOTH_CONF);

        // Act — canonical git
        const gitResult = tryRunGit(['config', '--file', peerConfigPath, 's..k', 'v']);
        expect(gitResult.ok, `git config set failed: ${gitResult.stderr}`).toBe(true);

        // Act — tsgit (key '..k' parses as section='', subsection=''; use via setConfigEntry)
        const ctx = createNodeContext({ workDir: pair.ours });
        await setConfigEntry({ ctx, key: 's..k', value: 'v', scope: 'local' });

        // Assert
        const { oursConfig, peerConfig } = await readTwinConfigs(pair);
        expect(extractFromS(oursConfig)).toBe(extractFromS(peerConfig));
      }, 60_000);
    });
  });

  describe('Given rev.conf seeded ([s ""] k=b then [s] k=a)', () => {
    describe('When git and tsgit each set s.k to v (target = plain)', () => {
      it('Then [s] k is replaced in place, [s ""] k=b preserved (row 3)', async () => {
        // Arrange
        const { peerConfigPath } = await seedTwinConfigs(pair, REV_CONF);

        // Act — canonical git
        const gitResult = tryRunGit(['config', '--file', peerConfigPath, 's.k', 'v']);
        expect(gitResult.ok, `git config set failed: ${gitResult.stderr}`).toBe(true);

        // Act — tsgit
        const ctx = createNodeContext({ workDir: pair.ours });
        await configSet(ctx, { key: 's.k', value: 'v', scope: 'local' });

        // Assert
        const { oursConfig, peerConfig } = await readTwinConfigs(pair);
        expect(extractFromS(oursConfig)).toBe(extractFromS(peerConfig));
      }, 60_000);
    });
  });

  describe('Given rev.conf seeded ([s ""] k=b then [s] k=a)', () => {
    describe('When git and tsgit each set s..k to v (target = empty subsection)', () => {
      it('Then [s ""] k is replaced in place, [s] k=a preserved (row 4)', async () => {
        // Arrange
        const { peerConfigPath } = await seedTwinConfigs(pair, REV_CONF);

        // Act — canonical git
        const gitResult = tryRunGit(['config', '--file', peerConfigPath, 's..k', 'v']);
        expect(gitResult.ok, `git config set failed: ${gitResult.stderr}`).toBe(true);

        // Act — tsgit
        const ctx = createNodeContext({ workDir: pair.ours });
        await setConfigEntry({ ctx, key: 's..k', value: 'v', scope: 'local' });

        // Assert
        const { oursConfig, peerConfig } = await readTwinConfigs(pair);
        expect(extractFromS(oursConfig)).toBe(extractFromS(peerConfig));
      }, 60_000);
    });
  });

  describe('Given empty-only.conf seeded ([s ""] k=b only)', () => {
    describe('When git and tsgit each set s.k to v (target = plain)', () => {
      it('Then [s ""] unchanged and a new [s] k=v is appended (row 5)', async () => {
        // Arrange
        const { peerConfigPath } = await seedTwinConfigs(pair, EMPTY_ONLY_CONF);

        // Act — canonical git
        const gitResult = tryRunGit(['config', '--file', peerConfigPath, 's.k', 'v']);
        expect(gitResult.ok, `git config set failed: ${gitResult.stderr}`).toBe(true);

        // Act — tsgit
        const ctx = createNodeContext({ workDir: pair.ours });
        await configSet(ctx, { key: 's.k', value: 'v', scope: 'local' });

        // Assert
        const { oursConfig, peerConfig } = await readTwinConfigs(pair);
        expect(extractFromS(oursConfig)).toBe(extractFromS(peerConfig));
      }, 60_000);
    });
  });

  describe('Given plain-only.conf seeded ([s] k=a only)', () => {
    describe('When git and tsgit each set s..k to v (target = empty subsection)', () => {
      it('Then [s] unchanged and a new [s ""] k=v is appended (row 6)', async () => {
        // Arrange
        const { peerConfigPath } = await seedTwinConfigs(pair, PLAIN_ONLY_CONF);

        // Act — canonical git
        const gitResult = tryRunGit(['config', '--file', peerConfigPath, 's..k', 'v']);
        expect(gitResult.ok, `git config set failed: ${gitResult.stderr}`).toBe(true);

        // Act — tsgit
        const ctx = createNodeContext({ workDir: pair.ours });
        await setConfigEntry({ ctx, key: 's..k', value: 'v', scope: 'local' });

        // Assert
        const { oursConfig, peerConfig } = await readTwinConfigs(pair);
        expect(extractFromS(oursConfig)).toBe(extractFromS(peerConfig));
      }, 60_000);
    });
  });

  describe('Given an empty file and key "..k"', () => {
    describe('When git and tsgit each set ..k to v', () => {
      it('Then the file is [ ""]\\n\\tk = v\\n (row: empty-name set)', async () => {
        // Arrange
        const emptyConf = '[core]\n\trepositoryformatversion = 0\n';
        const { peerConfigPath } = await seedTwinConfigs(pair, emptyConf);

        // Act — canonical git
        const gitResult = tryRunGit(['config', '--file', peerConfigPath, '..k', 'v']);
        expect(gitResult.ok, `git config set failed: ${gitResult.stderr}`).toBe(true);

        // Act — tsgit
        const ctx = createNodeContext({ workDir: pair.ours });
        await setConfigEntry({ ctx, key: '..k', value: 'v', scope: 'local' });

        // Assert — byte comparison from the empty-name section header onward
        const { oursConfig, peerConfig } = await readTwinConfigs(pair);
        const extractFromEmpty = (content: string): string => {
          const idx = content.indexOf('[ "');
          return idx === -1 ? content : content.slice(idx);
        };
        expect(extractFromEmpty(oursConfig)).toBe(extractFromEmpty(peerConfig));
      }, 60_000);
    });
  });

  describe('Given both.conf seeded ([s] k=a and [s ""] k=b)', () => {
    describe('When git and tsgit each unset s.k (target = plain)', () => {
      it('Then [s] entry removed (block pruned), [s ""] k=b preserved (unset row 1)', async () => {
        // Arrange
        const { peerConfigPath } = await seedTwinConfigs(pair, BOTH_CONF);

        // Act — canonical git
        const gitResult = tryRunGit(['config', '--file', peerConfigPath, '--unset', 's.k']);
        expect(gitResult.ok, `git --unset failed: ${gitResult.stderr}`).toBe(true);

        // Act — tsgit
        const ctx = createNodeContext({ workDir: pair.ours });
        await unsetConfigEntry({ ctx, key: 's.k', scope: 'local' });

        // Assert
        const { oursConfig, peerConfig } = await readTwinConfigs(pair);
        expect(extractFromS(oursConfig)).toBe(extractFromS(peerConfig));
      }, 60_000);
    });
  });

  describe('Given both.conf seeded ([s] k=a and [s ""] k=b)', () => {
    describe('When git and tsgit each unset s..k (target = empty subsection)', () => {
      it('Then [s ""] entry removed (block pruned), [s] k=a preserved (unset row 2)', async () => {
        // Arrange
        const { peerConfigPath } = await seedTwinConfigs(pair, BOTH_CONF);

        // Act — canonical git
        const gitResult = tryRunGit(['config', '--file', peerConfigPath, '--unset', 's..k']);
        expect(gitResult.ok, `git --unset failed: ${gitResult.stderr}`).toBe(true);

        // Act — tsgit
        const ctx = createNodeContext({ workDir: pair.ours });
        await unsetConfigEntry({ ctx, key: 's..k', scope: 'local' });

        // Assert
        const { oursConfig, peerConfig } = await readTwinConfigs(pair);
        expect(extractFromS(oursConfig)).toBe(extractFromS(peerConfig));
      }, 60_000);
    });
  });

  describe('Given empty-only.conf seeded ([s ""] k=b only), GET s.k', () => {
    describe('When git and tsgit each read s.k', () => {
      it('Then git exits 1 with no output; tsgit returns value: undefined', async () => {
        // Arrange
        const { peerConfigPath } = await seedTwinConfigs(pair, EMPTY_ONLY_CONF);

        // Act — canonical git (exit 1 means key not found)
        const gitResult = tryRunGit(['config', '--file', peerConfigPath, '--get', 's.k']);
        expect(gitResult.ok).toBe(false);
        expect(gitResult.stdout.trim()).toBe('');

        // Act — tsgit
        const ctx = createNodeContext({ workDir: pair.ours });
        const result = await getConfigValue({ ctx, key: 's.k', scope: 'local' });

        // Assert — tsgit also sees no value for the plain s.k key
        expect(result.value).toBeUndefined();
      }, 60_000);
    });
  });

  describe('Given both.conf seeded and GET s.k vs s..k', () => {
    describe('When git and tsgit each read s.k and s..k', () => {
      it('Then s.k=a and s..k=b regardless of block order', async () => {
        // Arrange
        const { peerConfigPath } = await seedTwinConfigs(pair, BOTH_CONF);

        // Act — canonical git GET
        const gitSK = tryRunGit(['config', '--file', peerConfigPath, '--get', 's.k']);
        expect(gitSK.ok, `git --get s.k failed: ${gitSK.stderr}`).toBe(true);
        expect(gitSK.stdout.trim()).toBe('a');

        const gitSEK = tryRunGit(['config', '--file', peerConfigPath, '--get', 's..k']);
        expect(gitSEK.ok, `git --get s..k failed: ${gitSEK.stderr}`).toBe(true);
        expect(gitSEK.stdout.trim()).toBe('b');

        // Act — tsgit
        const ctx = createNodeContext({ workDir: pair.ours });
        const resultSK = await getConfigValue({ ctx, key: 's.k', scope: 'local' });
        const resultSEK = await getConfigValue({ ctx, key: 's..k', scope: 'local' });

        // Assert
        expect(resultSK.value).toBe('a');
        expect(resultSEK.value).toBe('b');
      }, 60_000);
    });
  });

  describe('Given name-mix.conf seeded ([ ""] k=e · [s] k=a · [s ""] k=b)', () => {
    describe('When git and tsgit each --list and reconstruct key=value lines', () => {
      it('Then the reconstructed key=value lines match for ..k, s.k, and s..k', async () => {
        // Arrange — name-mix.conf: empty-name section plus two [s] variants
        const nameMixConf =
          '[core]\n\trepositoryformatversion = 0\n[ ""]\n\tk = e\n[s]\n\tk = a\n[s ""]\n\tk = b\n';
        const { peerConfigPath } = await seedTwinConfigs(pair, nameMixConf);

        // Act — canonical git --list (no -z for human-readable key=value)
        const gitResult = tryRunGit(['config', '--file', peerConfigPath, '--list']);
        expect(gitResult.ok, `git --list failed: ${gitResult.stderr}`).toBe(true);
        const gitLines = gitResult.stdout
          .split('\n')
          .filter((l) => l.startsWith('..k') || l.startsWith('s.k') || l.startsWith('s..k'));

        // Act — tsgit configList
        const ctx = createNodeContext({ workDir: pair.ours });
        const listResult = await configList(ctx, { scope: 'local' });
        const tsgitLines = listResult.entries
          .filter((e) => e.key === '..k' || e.key === 's.k' || e.key === 's..k')
          .map((e) => `${e.key}=${e.value ?? ''}`);

        // Assert — same key=value pairs (order-independent via sort)
        expect([...tsgitLines].sort()).toEqual([...gitLines].sort());
      }, 60_000);
    });
  });
});
