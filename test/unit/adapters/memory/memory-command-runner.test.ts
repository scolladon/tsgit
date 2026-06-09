import { describe, expect, it } from 'vitest';

import { MemoryCommandRunner } from '../../../../src/adapters/memory/memory-command-runner.js';
import type { CommandRequest } from '../../../../src/ports/command-runner.js';

const request: CommandRequest = {
  command: 'driver %A',
  cwd: '/repo',
  env: { GIT_DIR: '/repo/.git' },
};

describe('MemoryCommandRunner', () => {
  describe('Given the default behaviour', () => {
    describe('When run', () => {
      it('Then resolves with exit code 0', async () => {
        // Arrange
        const sut = new MemoryCommandRunner();

        // Act
        const result = await sut.run(request);

        // Assert
        expect(result).toEqual({ exitCode: 0 });
      });
    });
  });

  describe('Given a custom behaviour returning a non-zero code', () => {
    describe('When run', () => {
      it('Then resolves with that code and records the request', async () => {
        // Arrange
        const sut = new MemoryCommandRunner(() => 1);

        // Act
        const result = await sut.run(request);

        // Assert
        expect(result).toEqual({ exitCode: 1 });
        expect(sut.calls).toEqual([request]);
      });
    });
  });

  describe('Given an async behaviour', () => {
    describe('When run', () => {
      it('Then awaits the behaviour before resolving', async () => {
        // Arrange
        const sut = new MemoryCommandRunner((req) =>
          Promise.resolve(req.command === 'driver %A' ? 3 : 0),
        );

        // Act
        const result = await sut.run(request);

        // Assert
        expect(result).toEqual({ exitCode: 3 });
      });
    });
  });
});
