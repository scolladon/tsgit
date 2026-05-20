/**
 * Bench scenario: walk N commits from HEAD via `repo.log()` versus
 * `isomorphic-git.log()`. Both libraries see the same on-disk repo.
 */
import * as fs from 'node:fs';

import * as git from 'isomorphic-git';
import { afterAll } from 'vitest';

import { openRepository } from '../../src/index.node.js';
import { setupSmallRepo } from './fixtures.js';
import { benchScenario } from './support/bench-dsl.js';

const COMMITS = 50;

benchScenario(
  `Given a ${COMMITS}-commit repo`,
  'When log() walks every commit, Then compare tsgit against isomorphic-git',
  async () => {
    const fixture = await setupSmallRepo({ commits: COMMITS });
    const repo = await openRepository({ cwd: fixture.cwd });
    afterAll(async () => {
      await repo.dispose();
      await fixture.cleanup();
    });

    const sut = async (): Promise<void> => {
      await repo.log();
    };
    return {
      sut,
      baseline: async (): Promise<void> => {
        await git.log({ fs, dir: fixture.cwd, depth: COMMITS });
      },
    };
  },
);
