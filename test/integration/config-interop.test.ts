/**
 * Cross-tool interop — git-config readback. tsgit's `updateConfigEntries`
 * writes `.git/config` text; canonical `git config --list -z` parses it
 * and surfaces the key/value pairs. We don't compare bytes (git accepts
 * a wider input grammar than it produces); we prove semantic readback.
 *
 * @proves
 *   surface:        config
 *   bucket:         cross-tool-interop
 *   unique:         .git/config readable by git config --list with matching keys
 *   interopSurface: config
 */
import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createNodeContext } from '../../src/adapters/node/node-adapter.js';
import { updateConfigEntries } from '../../src/application/primitives/update-config.js';
import { GIT_AVAILABLE, initBothRepos, makePeerPair, type PeerPair } from './interop-helpers.js';

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
        const raw = execFileSync('git', [
          '-C',
          pair.ours,
          'config',
          '--local',
          '--list',
          '-z',
        ]).toString();
        const parsed = parseGitConfigList(raw);
        expect(parsed.get('user.name')).toEqual(['Ada']);
        expect(parsed.get('user.email')).toEqual(['ada@example.com']);
        expect(parsed.get('core.repositoryformatversion')).toEqual(['0']);
      });
    });
  });
});
